import { FIRE, TORCH, ETERNAL_RADIUS } from './constants.js';
import { BUILDINGS, FEATURES } from './defs.js';
import { makeGen } from './worldgen.js';

export const key = (x, y) => x + ',' + y;
export const unkey = (k) => k.split(',').map(Number);
export const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const N8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

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
    this.rootDist = new Map();
    this.rootDirty = true;
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
    if (t === 'torch') this.lightDirty = true;
    if (t === 'root') this.rootDirty = true;
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

  rebuildLight() {
    this.light.clear();
    const add = (cx, cy, r) => {
      for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) this.light.set(key(x, y), 1);
    };
    if (this.fire.fuel > 0) add(0, 0, FIRE.radius);
    for (const [k, b] of this.bld) {
      if (b.t === 'torch' && b.fuel > 0) { const [x, y] = unkey(k); add(x, y, TORCH.placedRadius); }
    }
    this.lightDirty = false;
  }

  // "Shared" light: anyone can walk here.
  sharedLit(x, y) {
    if (this.lightDirty) this.rebuildLight();
    if (this.light.has(key(x, y))) return true;
    const r = this.gen.ruinAt(x, y);
    return !!(r && r.eternal && Math.max(Math.abs(x - r.x), Math.abs(y - r.y)) <= ETERNAL_RADIUS);
  }

  rebuildRoots() {
    this.rootDist.clear();
    const q = [[0, 0, 0]];
    const seen = new Set(['0,0']);
    while (q.length) {
      const [x, y, d] = q.shift();
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy, k = key(nx, ny);
        if (seen.has(k)) continue;
        const b = this.bld.get(k);
        if (!b || b.t !== 'root' || b.g < 1) continue;
        seen.add(k);
        this.rootDist.set(k, d + 1);
        q.push([nx, ny, d + 1]);
      }
    }
    this.rootDirty = false;
  }

  // How far (in root tiles) the fire can push heat. Weak fire => roots go dark from the tips.
  rootReach() { return this.fire.fuel <= 0 ? 0 : 6 + (this.fire.fuel / FIRE.maxFuel) * 54; }

  rootDistAt(x, y) {
    if (this.rootDirty) this.rebuildRoots();
    return this.rootDist.get(key(x, y));
  }
  rootPowered(x, y) {
    const d = this.rootDistAt(x, y);
    return d !== undefined && d <= this.rootReach();
  }

  // A building is connected if it touches the fire or a powered root.
  connected(x, y) {
    if (this.fire.fuel <= 0) return false;
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      if (nx === 0 && ny === 0) return true;
      if (this.rootPowered(nx, ny)) return true;
    }
    return false;
  }

  hearthCount() {
    let n = 0;
    for (const [dx, dy] of N8) if (this.getB(dx, dy)?.t === 'hearth') n++;
    return Math.min(4, n);
  }

  // Kiln multiblock: 8 bricks around the core
  kilnComplete(x, y) {
    for (const [dx, dy] of N8) if (this.getB(x + dx, y + dy)?.t !== 'brick') return false;
    return true;
  }
}
