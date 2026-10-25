import { FIRE, TORCH, ETERNAL_ROOT_REACH } from './constants.js';
import { BUILDINGS, FEATURES, MULTIBLOCKS, WALL_OF, FIRE_STAGES, RING_BLOCKS, FEEDS } from './defs.js';
import { makeGen } from './worldgen.js';

export const key = (x, y) => x + ',' + y;
export const unkey = (k) => k.split(',').map(Number);
export const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

const LIGHT_BUILDINGS = new Set(['torch', 'glowmoss', 'watchfire']);

// World state shared by server (authoritative) and client (mirror).
export class World {
  constructor(seed) {
    this.seed = seed;
    this.gen = makeGen(seed);
    this.feat = new Map(); // overrides of generated features (value may be null)
    this.bld = new Map(); // player-built things
    this.drops = new Map(); // key -> [[item, n], ...]
    this.time = 0;
    this.fire = { fuel: FIRE.startFuel, temp: 1, demand: 0, burn: 1 };
    this.light = new Map();
    this.lightDirty = true;
    this.rootNet = new Map(); // key -> { net: 'fire' | 'e:x,y', d }
    this.rootDirty = true;
    this._stage = 0;
    this.stageDirty = true;
  }

  getFeature(x, y) {
    const k = key(x, y);
    let f = this.feat.has(k) ? this.feat.get(k) : this.gen.feature(x, y);
    if (f && f.t === 'picked_bush' && this.time >= f.regrow) f = { t: 'bush' };
    return f;
  }
  setFeature(x, y, f) { this.feat.set(key(x, y), f); }
  ground(x, y) { return this.gen.ground(x, y); }

  getB(x, y) { return this.bld.get(key(x, y)); }
  setB(x, y, b) {
    const k = key(x, y);
    const prev = this.bld.get(k);
    if (b) this.bld.set(k, b); else this.bld.delete(k);
    const t = b?.t ?? prev?.t;
    if (LIGHT_BUILDINGS.has(t) || prev?.t !== b?.t) this.lightDirty = true;
    if (t === 'root' || RING_BLOCKS.has(t)) this.rootDirty = true;
    if (RING_BLOCKS.has(t)) { this.stageDirty = true; this.lightDirty = true; }
  }
  setFuel(fuel) {
    if ((fuel > 0) !== (this.fire.fuel > 0)) this.lightDirty = true;
    this.fire.fuel = fuel;
  }

  isSolid(x, y) {
    if (x === 0 && y === 0) return true; // the campfire
    if (this.ground(x, y) === 'water') return true;
    const f = this.getFeature(x, y);
    if (f && FEATURES[f.t]?.solid) return true;
    const b = this.getB(x, y);
    if (b && BUILDINGS[b.t]?.solid) return true;
    if (b && b.t === 'sapling' && b.g >= 1) return true;
    return false;
  }

  // ---------- the campfire's stage (rings of blocks around it) ----------
  stage() {
    if (this.stageDirty) {
      let s = 0;
      for (let i = 1; i < FIRE_STAGES.length; i++) {
        const { ring, block } = FIRE_STAGES[i];
        let ok = true;
        for (let y = -ring; y <= ring && ok; y++) for (let x = -ring; x <= ring; x++) {
          if (Math.max(Math.abs(x), Math.abs(y)) !== ring) continue;
          if (this.getB(x, y)?.t !== block) { ok = false; break; }
        }
        if (!ok) break;
        s = i;
      }
      this._stage = s;
      this.stageDirty = false;
    }
    return this._stage;
  }
  maxFuel() { return FIRE_STAGES[this.stage()].maxFuel; }
  fireRadius() { return FIRE_STAGES[this.stage()].radius; }

  // ---------- light ----------
  rebuildLight() {
    this.light.clear();
    const add = (cx, cy, r) => {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) this.light.set(key(x, y), 1);
    };
    if (this.fire.fuel > 0) add(0, 0, this.fireRadius());
    for (const [k, b] of this.bld) {
      const [x, y] = unkey(k);
      if (b.t === 'torch' && b.fuel > 0) add(x, y, TORCH.placedRadius);
      else if (b.t === 'glowmoss') add(x, y, 1);
      else if (b.t === 'watchfire' && b.lit) add(x, y, MULTIBLOCKS.watchfire.light);
    }
    this.lightDirty = false;
  }

  // Natural lights at a site (eternal flames, shrines, glowmoss) that still exist.
  siteLights(s) {
    return s.lights.filter(([lx, ly]) => FEATURES[this.getFeature(lx, ly)?.t]?.light);
  }

  // "Shared" light: anyone can walk here.
  sharedLit(x, y) {
    if (this.lightDirty) this.rebuildLight();
    if (this.light.has(key(x, y))) return true;
    const s = this.gen.siteAt(x, y);
    if (!s || !s.lights.length) return false;
    for (const [lx, ly, r] of s.lights) {
      if (Math.max(Math.abs(x - lx), Math.abs(y - ly)) <= r && FEATURES[this.getFeature(lx, ly)?.t]?.light) return true;
    }
    return false;
  }

  // ---------- ember root networks ----------
  // Orange network: grows from the campfire (through its ring blocks). Teal networks: grow from
  // eternal flames. Each node stores its network and its distance (in roots) from the source.
  rebuildRoots() {
    this.rootNet.clear();
    const isRoot = (b) => b?.t === 'root';
    const bfs = (sx, sy, net, viaRings) => {
      const q = [[sx, sy, 0]];
      this.rootNet.set(key(sx, sy), { net, d: 0 });
      while (q.length) {
        const [x, y, d] = q.shift();
        for (const [dx, dy] of N4) {
          const nx = x + dx, ny = y + dy, k = key(nx, ny);
          if (this.rootNet.has(k)) continue;
          const b = this.bld.get(k);
          if (isRoot(b)) { this.rootNet.set(k, { net, d: d + 1 }); q.push([nx, ny, d + 1]); }
          else if (viaRings && RING_BLOCKS.has(b?.t) && Math.max(Math.abs(nx), Math.abs(ny)) <= 3) {
            this.rootNet.set(k, { net, d }); q.unshift([nx, ny, d]);
          }
        }
      }
    };
    bfs(0, 0, 'fire', true);
    for (const [k, b] of this.bld) {
      if (!isRoot(b) || this.rootNet.has(k)) continue;
      const [x, y] = unkey(k);
      for (const [dx, dy] of N4) {
        if (this.getFeature(x + dx, y + dy)?.t === 'eternal' && !this.rootNet.has(key(x + dx, y + dy))) bfs(x + dx, y + dy, 'e:' + key(x + dx, y + dy), false);
      }
    }
    this.rootDirty = false;
  }

  rootNodeAt(x, y) {
    if (this.rootDirty) this.rebuildRoots();
    return this.rootNet.get(key(x, y));
  }
  rootDistAt(x, y) { return this.rootNodeAt(x, y)?.d; }

  // How far (in root tiles) the fire can push heat. Weak fire => roots go dark from the tips.
  rootReach() { return this.fire.fuel <= 0 ? 0 : 6 + (this.fire.fuel / this.maxFuel()) * 54; }

  rootPowered(x, y) {
    const n = this.rootNodeAt(x, y);
    if (!n) return false;
    const b = this.getB(x, y);
    if (b?.t === 'root' && b.g < 1) return false;
    return n.net === 'fire' ? this.fire.fuel > 0 && n.d <= this.rootReach() : n.d <= ETERNAL_ROOT_REACH;
  }
  netAt(x, y) { return this.rootPowered(x, y) ? this.rootNodeAt(x, y).net : null; }

  // Which heat network (if any) touches any of these tiles: 'fire', 'e:x,y' or null.
  heatNet(tiles) {
    for (const [x, y] of tiles) {
      for (const [dx, dy] of N4) {
        const n = this.netAt(x + dx, y + dy);
        if (n) return n;
      }
    }
    return null;
  }
  connected(x, y) { return this.heatNet([[x, y]]); }

  // Networks a new root at (x, y) would join (powered or not) - used to keep them separate.
  netsAround(x, y) {
    const nets = new Set();
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      const n = this.rootNodeAt(nx, ny);
      if (n) nets.add(n.net);
      else if (this.getFeature(nx, ny)?.t === 'eternal') nets.add('e:' + key(nx, ny));
    }
    return nets;
  }

  // ---------- multiblocks ----------
  mbComplete(x, y, t) {
    const m = MULTIBLOCKS[t], h = (m.size - 1) / 2;
    for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) {
      if ((dx || dy) && this.getB(x + dx, y + dy)?.t !== m.wall) return false;
    }
    return true;
  }
  mbTiles(x, y, t) {
    const h = (MULTIBLOCKS[t].size - 1) / 2, out = [];
    for (let dy = -h; dy <= h; dy++) for (let dx = -h; dx <= h; dx++) out.push([x + dx, y + dy]);
    return out;
  }
  // Outside neighbours of a footprint, as [nx, ny, insideX, insideY].
  mbOutlets(x, y, t) {
    const h = (MULTIBLOCKS[t].size - 1) / 2, out = [];
    for (let i = -h; i <= h; i++) {
      out.push([x + i, y - h - 1, x + i, y - h], [x + i, y + h + 1, x + i, y + h], [x - h - 1, y + i, x - h, y + i], [x + h + 1, y + i, x + h, y + i]);
    }
    return out;
  }
  // The core a wall block at (x, y) belongs to (preferring a formed one), as [cx, cy, core].
  mbCoreFor(x, y) {
    const b = this.getB(x, y);
    if (!b) return null;
    if (MULTIBLOCKS[b.t]) return [x, y, b];
    const cores = WALL_OF[b.t];
    if (!cores) return null;
    let best = null;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const c = this.getB(x + dx, y + dy);
      if (!c || !cores.includes(c.t)) continue;
      const h = (MULTIBLOCKS[c.t].size - 1) / 2;
      if (Math.abs(dx) > h || Math.abs(dy) > h) continue;
      if (!best || (c.ok && !best[2].ok)) best = [x + dx, y + dy, c];
    }
    return best;
  }
  formedCoreAt(x, y) {
    const c = this.mbCoreFor(x, y);
    return c && c[2].ok ? c : null;
  }

  // Where a building hands things off: its 4 neighbours (multiblocks use their outer edge).
  outlets(x, y, b) {
    return MULTIBLOCKS[b.t] ? this.mbOutlets(x, y, b.t) : N4.map(([dx, dy]) => [x + dx, y + dy, x, y]);
  }

  // Plants and buildings feeding a neighbouring building. Returns [cx, cy, core, edgeX, edgeY, fromX, fromY].
  feedTargets(x, y, t) {
    const want = FEEDS[t];
    if (!want) return [];
    const out = [];
    const outs = MULTIBLOCKS[t] ? this.mbOutlets(x, y, t) : N4.map(([dx, dy]) => [x + dx, y + dy, x, y]);
    for (const [nx, ny, ox, oy] of outs) {
      const c = this.mbCoreFor(nx, ny) ?? (this.getB(nx, ny) ? [nx, ny, this.getB(nx, ny)] : null);
      if (c && c[2].t === want && !out.some((o) => o[2] === c[2])) out.push([c[0], c[1], c[2], nx, ny, ox, oy]);
    }
    return out;
  }
}
