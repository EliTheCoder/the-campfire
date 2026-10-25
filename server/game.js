import { World, key, unkey, N4, N8, crateSlots, CRATE_SLOTS } from '../shared/world.js';
import { ITEMS, BUILDINGS, FEATURES, RECIPES, MULTIBLOCKS, BLUEPRINTS, NEW_BLUEPRINT_WEIGHT, FIRE_STAGES, stackMax } from '../shared/defs.js';
import { NOTES } from '../shared/worldgen.js';
import { FIRE, TORCH, COLD_GRACE, REACH, PLAYER_COLORS, PACKET_SPEED, SNAP_EVERY, PLAYER_HALF, HOTBAR } from '../shared/constants.js';
import { newInv, addItem, removeItem, countItem, hasAll } from '../shared/inventory.js';

const OUT_CAP = 8;
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function newBuilding(t) {
  switch (t) {
    case 'torch': return { t, fuel: TORCH.placedFuel, conn: false };
    case 'root': return { t, g: 0 };
    case 'kindling': return { t, g: 0, p: 0, out: {} };
    case 'sapling': return { t, g: 0, p: 0, q: 0, out: {} };
    case 'rot_pit': return { t, in: 0, p: 0, out: {} };
    case 'resin_tap': return { t, p: 0, out: {} };
    case 'crate': return { t, slots: new Array(CRATE_SLOTS).fill(null) };
    case 'heart_seed': return { t, g: 0, p: 0, out: {}, ok: false };
    case 'watchfire': return { t, ok: false, lit: false };
    default: return MULTIBLOCKS[t] ? { t, in: 0, p: 0, out: {}, ok: false } : { t };
  }
}

// Compact signature of a building's visible state so we only resend it when it visibly changes.
function sig(b) {
  let s = '';
  for (const k in b) {
    if (k === 'cd') continue;
    const v = b[k];
    // Each band gets its own prefix so values can't collide (e.g. 3 leaves vs 0 leaves, or 0.05s
    // vs burnt out). Counts are exact; fractions are bucketed; 0 and 1 (done) are always distinct.
    if (typeof v === 'number') s += k + (Number.isInteger(v) ? 'i' + v : v > 2 ? 'a' + Math.floor(v / 5) : 'b' + Math.floor(v * 10)) + ';';
    else if (typeof v === 'object') s += k + JSON.stringify(v) + ';';
    else s += k + v + ';';
  }
  return s;
}

export class Game {
  constructor({ seed, send, broadcast, log, cheats = false }) {
    this.cheats = cheats;
    this.send = send;
    this.broadcast = broadcast;
    this.log = log;
    this.players = new Map();
    this.offline = new Map(); // token -> player who disconnected; restored as-is on rejoin
    this.nextId = 1;
    this.tickN = 0;
    this.reset(seed);
  }

  reset(seed) {
    this.seed = seed ?? Math.floor(Math.random() * 1e9);
    this.world = new World(this.seed);
    this.packets = [];
    this.packetId = 1;
    this.weather = { s: 'clear', t: 150 + Math.random() * 90 };
    this.windAcc = 0;
    this.known = new Set();
    this.over = false;
    this.autoRevive = 0;
    this.draw = 0;
    this.dF = new Map();
    this.dB = new Set();
    this.dD = new Set();
    this.sigs = new Map();
    this.dropLocks = new Map(); // tile -> id of the player who threw it (they can't re-grab it until they step off)
    this.fx = [];
    this.offline.clear();
    for (const p of this.players.values()) { this.resetPlayer(p); this.welcome(p); }
    this.log?.(`World reset. Seed ${this.seed}`);
    this.onReset?.();
  }

  // ---------- saving ----------
  // Everything needed to resume a world. Generated terrain comes back from the seed; only
  // changes to it (feature overrides), buildings, drops and players are stored.
  serialize() {
    const w = this.world;
    const pl = (p) => ({
      id: p.id, token: p.token, name: p.name, color: p.color, x: p.x, y: p.y, inv: p.inv,
      dead: p.dead, burn: p.burn, lit: p.lit, cold: p.cold, face: p.face,
    });
    return {
      version: 1, savedAt: new Date().toISOString(),
      seed: this.seed, time: w.time, fire: w.fire, over: this.over,
      weather: this.weather, known: [...this.known], nextId: this.nextId,
      feat: [...w.feat], bld: [...w.bld], drops: [...w.drops],
      players: [...this.players.values(), ...this.offline.values()].filter((p) => p.token).map(pl),
    };
  }

  load(d) {
    this.reset(d.seed);
    const w = this.world;
    w.time = d.time;
    Object.assign(w.fire, d.fire);
    this.over = !!d.over;
    this.weather = d.weather ?? this.weather;
    this.known = new Set(d.known);
    this.nextId = Math.max(this.nextId, d.nextId ?? 1);
    for (const [k, v] of d.feat) w.feat.set(k, v);
    for (const [k, v] of d.bld) w.bld.set(k, v);
    for (const [k, v] of d.drops) w.drops.set(k, v);
    w.lightDirty = w.rootDirty = w.stageDirty = true;
    // everyone comes back as "offline" and is restored when their browser reconnects
    for (const p of d.players ?? []) {
      this.offline.set(p.token, { ...p, held: 0, moving: false, invDirty: true, ws: null });
      this.nextId = Math.max(this.nextId, p.id + 1);
    }
  }

  // ---------- players ----------
  resetPlayer(p) {
    [p.x, p.y] = this.spawnPoint();
    p.inv = newInv();
    addItem(p.inv, 'torch', 2);
    p.held = 0; p.burn = 0; p.lit = false; p.cold = 0; p.dead = false; p.invDirty = true;
    p.face = 1; p.moving = false;
  }

  // Players are identified by a per-browser token, so reconnecting restores you exactly
  // (inventory, position, death) instead of handing out a fresh starter kit.
  join(ws, name, token) {
    name = String(name || 'Wanderer').slice(0, 16);
    token = typeof token === 'string' ? token.slice(0, 64) : null;
    let p = token && [...this.players.values()].find((q) => q.token === token);
    if (p) {
      // Same browser connected again (refresh / second tab): take over the live player.
      const old = p.ws;
      p.ws = ws; p.name = name;
      try { old.close(); } catch {}
      this.welcome(p);
      return p;
    }
    p = token && this.offline.get(token);
    if (p) {
      this.offline.delete(token);
      p.ws = ws; p.name = name; p.invDirty = true;
      this.players.set(p.id, p);
      this.welcome(p);
      this.say(`${p.name} returned to the fire.`, p.color);
      return p;
    }
    const id = this.nextId++;
    p = { id, ws, token, name, color: PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length] };
    this.resetPlayer(p);
    this.players.set(id, p);
    this.welcome(p);
    this.say(`${p.name} joined the fire.`, p.color);
    return p;
  }

  leave(p, ws) {
    if (!this.players.has(p.id) || (ws && p.ws !== ws)) return; // a newer connection took over
    this.players.delete(p.id);
    if (p.token) this.offline.set(p.token, p);
    else if (!p.dead) this.dropAll(p);
    this.say(`${p.name} left.`, '#888');
  }

  welcome(p) {
    const w = this.world;
    this.send(p.ws, {
      t: 'welcome', id: p.id, seed: this.seed, time: w.time,
      feat: [...w.feat], bld: [...w.bld], drops: [...w.drops],
      known: [...this.known], fire: w.fire, weather: this.weather, over: this.over,
      x: p.x, y: p.y, inv: p.inv,
    });
    p.invDirty = false;
  }

  say(text, c = '#ddd') { this.broadcast({ t: 'msg', text, c }); }
  tell(p, text, c = '#ddd') { this.send(p.ws, { t: 'msg', text, c }); }

  // Move n items from slot a to slot b: into an empty slot, onto a matching stack (up to its
  // limit), or - when moving a whole stack onto a different item - swap the two.
  invMove(p, a, b, n) {
    const inv = p.inv;
    if (a === b || inv[a] === undefined || inv[b] === undefined || !inv[a]) return;
    const A = inv[a], B = inv[b];
    n = Math.max(1, Math.min(n || A.n, A.n));
    if (!B) { inv[b] = { item: A.item, n }; A.n -= n; }
    else if (B.item === A.item) { const k = Math.min(n, stackMax(A.item) - B.n); B.n += k; A.n -= k; }
    else if (n === A.n) { inv[a] = B; inv[b] = A; }
    if (inv[a] && inv[a].n <= 0) inv[a] = null;
    p.invDirty = true;
  }

  // Shift-click: send a stack between the hotbar and the backpack (merging first).
  invQuick(p, a) {
    const inv = p.inv, s = inv[a];
    if (!s) return;
    const range = a < HOTBAR ? [HOTBAR, inv.length] : [0, HOTBAR];
    for (let i = range[0]; i < range[1] && s.n > 0; i++) {
      const t = inv[i];
      if (t && t.item === s.item) { const k = Math.min(s.n, stackMax(s.item) - t.n); t.n += k; s.n -= k; }
    }
    for (let i = range[0]; i < range[1] && s.n > 0; i++) if (!inv[i]) { inv[i] = { item: s.item, n: s.n }; s.n = 0; }
    if (s.n <= 0) inv[a] = null;
    p.invDirty = true;
  }

  give(p, item, n) {
    const left = addItem(p.inv, item, n);
    if (left) this.addDrop(Math.floor(p.x), Math.floor(p.y), item, left);
    p.invDirty = true;
  }

  dropAll(p) {
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    for (const s of p.inv) if (s) this.addDrop(tx, ty, s.item, s.n);
    p.inv = newInv();
    p.invDirty = true;
  }

  kill(p, why = 'the dark') {
    if (p.dead) return;
    this.fx.push(['death', r1(p.x), r1(p.y)]);
    this.dropAll(p);
    p.dead = true; p.held = 0; p.burn = 0; p.lit = false; p.cold = 0;
    this.say(`${p.name} was taken by ${why}. Revive them at the fire (R).`, '#e07a6a');
  }

  revive(p) {
    const w = this.world;
    w.setFuel(w.fire.fuel - FIRE.reviveCost);
    p.dead = false; p.cold = 0; p.held = 0; p.burn = 0; p.lit = false;
    [p.x, p.y] = this.spawnPoint();
    addItem(p.inv, 'torch', 1);
    p.invDirty = true;
    this.send(p.ws, { t: 'tp', x: p.x, y: p.y });
    this.fx.push(['revive', 0, 0]);
    this.say(`${p.name} rises from the embers. The fire weakens...`, '#f0b060');
    if (w.fire.fuel <= 0) this.gameOver();
  }

  // Nearest free tile by the fire, starting just south of it.
  spawnPoint() {
    const w = this.world;
    for (let r = 0; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = dx, y = 2 + dy;
        if (!w.isSolid(x, y)) return [x + 0.5, y + 0.5];
      }
    }
    return [0.5, 2.5];
  }

  nearLitPlayer(p) {
    for (const q of this.players.values()) {
      if (q !== p && !q.dead && q.held > 0 && Math.hypot(q.x - p.x, q.y - p.y) <= 2) return true;
    }
    return false;
  }

  inReach(p, x, y) {
    return !p.dead && Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y) <= REACH + 0.75;
  }

  // ---------- world mutation (tracked for sync) ----------
  setF(x, y, f) { this.world.setFeature(x, y, f); this.dF.set(key(x, y), f); }
  setB(x, y, b) { this.world.setB(x, y, b); this.dB.add(key(x, y)); this.sigs.delete(key(x, y)); }
  addDrop(x, y, item, n) {
    const k = key(x, y);
    const arr = this.world.drops.get(k) || [];
    const s = arr.find((e) => e[0] === item);
    if (s) s[1] += n; else arr.push([item, n]);
    this.world.drops.set(k, arr);
    this.dD.add(k);
  }

  feedFire(item) {
    const fu = ITEMS[item]?.fuel;
    if (!fu) return false;
    const w = this.world, f = w.fire;
    const diff = f.demand - fu.heat;
    const v = fu.value * (diff > 0 ? Math.pow(FIRE.belowHeatPenalty, diff) : 1);
    w.setFuel(Math.min(w.maxFuel(), f.fuel + v));
    f.temp += (fu.heat - f.temp) * Math.min(0.5, fu.value / 150);
    this.fx.push(['feed', item, diff > 0 ? 1 : 0]);
    return true;
  }

  // ---------- messages ----------
  handle(p, m) {
    if (m.t === 'restart') { if (this.over) this.reset(); return; }
    if (m.t === 'chat' && this.cheats && String(m.text).startsWith('/')) { this.cheat(p, String(m.text).slice(1).split(/\s+/)); return; }
    if (m.t === 'chat') { const text = String(m.text || '').slice(0, 200); if (text) this.broadcast({ t: 'msg', text: `${p.name}: ${text}`, c: p.color }); return; }
    if (this.over) return;
    switch (m.t) {
      case 'pos':
        if (!p.dead && Number.isFinite(m.x) && Number.isFinite(m.y)) { p.x = m.x; p.y = m.y; p.face = m.f; p.moving = !!m.m; }
        break;
      case 'harvest': this.harvest(p, m.x | 0, m.y | 0); break;
      case 'click': this.click(p, m.x | 0, m.y | 0, m.slot | 0, !!m.shift); break;
      case 'craft': this.craft(p, m.id); break;
      case 'drop': {
        const s = p.inv[m.slot | 0];
        if (!s || p.dead) break;
        let tx = Math.floor(p.x), ty = Math.floor(p.y);
        if (Number.isInteger(m.x) && Number.isInteger(m.y) && this.inReach(p, m.x, m.y) && !this.world.isSolid(m.x, m.y)) { tx = m.x; ty = m.y; }
        const n = m.all ? s.n : Math.max(1, Math.min(s.n, m.n | 0 || 1));
        this.addDrop(tx, ty, s.item, n);
        this.dropLocks.set(key(tx, ty), p.id);
        s.n -= n;
        if (s.n <= 0) p.inv[m.slot | 0] = null;
        p.invDirty = true;
        this.fx.push(['drop', tx, ty]);
        break;
      }
      case 'swap': {
        const a = m.a | 0, b = m.b | 0;
        if (p.inv[a] !== undefined && p.inv[b] !== undefined) { [p.inv[a], p.inv[b]] = [p.inv[b], p.inv[a]]; p.invDirty = true; }
        break;
      }
      case 'move': this.invMove(p, m.a | 0, m.b | 0, m.n | 0); break;
      case 'ctake': this.contTake(p, m.x | 0, m.y | 0, m.ci | 0, m.n | 0, Number.isInteger(m.slot) ? m.slot : undefined); break;
      case 'cput': this.contPut(p, m.x | 0, m.y | 0, m.slot | 0, m.n | 0, Number.isInteger(m.ci) ? m.ci : undefined); break;
      case 'cmove': this.contMove(p, m.x | 0, m.y | 0, m.a | 0, m.b | 0, m.n | 0); break;
      case 'quick': this.invQuick(p, m.a | 0); break;
      case 'revive': {
        if (p.dead || Math.hypot(p.x - 0.5, p.y - 0.5) > 5) return;
        const target = [...this.players.values()].find((q) => q.dead && (m.id == null || q.id === m.id));
        if (target) this.revive(target);
        break;
      }
      case 'giveup': if (!p.dead) this.kill(p, 'despair'); break;
    }
  }

  // Dev-only chat commands (server started with --cheats).
  cheat(p, [cmd, a, b]) {
    const W = this.weather;
    switch (cmd) {
      case 'give': if (ITEMS[a]) this.give(p, a, Number(b) || 10); break;
      case 'weather': if (a === 'rain') { W.s = 'rain_warn'; W.t = 0; } else if (a === 'wind') { W.s = 'wind_warn'; W.t = 0; } else { W.s = 'rain'; W.t = 0; } break;
      case 'fuel': this.world.setFuel(Number(a)); break;
      case 'time': this.world.time = Number(a) * 60; break;
      case 'tp': p.x = Number(a) + 0.5; p.y = Number(b) + 0.5; this.send(p.ws, { t: 'tp', x: p.x, y: p.y }); break;
      case 'site': case 'ruin': {
        // /site [ruin|eternal|dead_fire|shrine|mine|grove]: teleport to the nearest one
        const want = cmd === 'ruin' ? (a === 'eternal' ? 'eternal' : 'ruin') : a;
        let best = null;
        for (let cy = -8; cy <= 8; cy++) for (let cx = -8; cx <= 8; cx++) {
          const st = this.world.gen.site(cx, cy);
          if (!st) continue;
          const ok = !want || st.type === want || (want === 'eternal' && st.type === 'ruin' && st.eternal);
          if (ok && (!best || st.d < best.d)) best = st;
        }
        if (best) { p.x = best.x + 0.5; p.y = best.y + best.R + 1.5; this.send(p.ws, { t: 'tp', x: p.x, y: p.y }); this.tell(p, `${best.type} at ${best.x},${best.y}${best.blueprint ? ' (' + best.blueprint + ')' : ''}`); }
        break;
      }
      case 'learn': for (const id of Object.keys(BLUEPRINTS)) this.known.add(id); this.broadcast({ t: 'known', known: [...this.known] }); break;
      default: this.tell(p, 'cheats: /give item n, /weather rain|wind|clear, /fuel n, /time min, /tp x y, /site [type], /learn');
    }
  }

  harvest(p, x, y) {
    if (!this.inReach(p, x, y)) return;
    const w = this.world;
    const b = w.getB(x, y);
    if (b?.t === 'torch') {
      if (b.fuel <= 0) this.give(p, 'charred_stick', 1);
      else {
        // Keep total fuel honest: the used part of this torch is added to your current burn.
        this.give(p, 'torch', 1);
        p.burn = (p.burn || 0) + (1 - b.fuel / TORCH.placedFuel) * TORCH.heldFuel;
        if (p.burn >= TORCH.heldFuel) { p.burn -= TORCH.heldFuel; removeItem(p.inv, 'torch', 1); this.give(p, 'charred_stick', 1); }
      }
      this.setB(x, y, null);
      this.fx.push(['break', x, y]);
      return;
    }
    // A fused multiblock is one structure: breaking any part of it breaks all of it.
    const core = b && w.mbCoreFor(x, y);
    if (core && core[2].ok && MULTIBLOCKS[core[2].t].fuse) { this.shatter(core[0], core[1], core[2]); return; }
    if (b) {
      this.give(p, BUILDINGS[b.t].item, 1);
      for (const [it, n] of Object.entries(b.out || {})) if (n > 0) this.give(p, it, n);
      if (b.t === 'crate') for (const s of crateSlots(b)) if (s) this.give(p, s.item, s.n);
      const inItem = b.t === 'rot_pit' ? 'leaf' : MULTIBLOCKS[b.t]?.in?.[0];
      if (b.in && inItem) this.give(p, inItem, b.in);
      this.setB(x, y, null);
      this.fx.push(['break', x, y]);
      return;
    }
    const f = w.getFeature(x, y);
    if (!f) return;
    const has = (t) => countItem(p.inv, t) > 0;
    const need = FEATURES[f.t]?.tool;
    if (need && !has(need)) { this.tell(p, `You need a ${ITEMS[need].name} for that.`); return; }
    const axe = has('axe');
    const rnd = Math.random();
    switch (f.t) {
      case 'tree':
        if (axe) { this.give(p, 'log', 3); this.give(p, 'stick', 1); if (rnd < 0.4) this.give(p, 'sapling', 1); this.setF(x, y, { t: 'stump' }); }
        else {
          const n = (f.n ?? 3) - 1;
          this.give(p, 'stick', rnd < 0.5 ? 2 : 1);
          this.setF(x, y, n <= 0 ? { t: 'bare_tree' } : { t: 'tree', n });
        }
        break;
      case 'bare_tree':
        if (!axe) { this.tell(p, 'This tree is bare. You need an axe to chop it.'); return; }
        this.give(p, 'log', 2); if (rnd < 0.3) this.give(p, 'sapling', 1);
        this.setF(x, y, { t: 'stump' });
        break;
      case 'stump': this.give(p, 'stick', 1); this.setF(x, y, null); break;
      case 'picked_bush': this.give(p, 'stick', 1); this.setF(x, y, null); break;
      case 'bush':
        this.give(p, 'leaf', 3); if (rnd < 0.25) this.give(p, 'seed', 1);
        this.setF(x, y, { t: 'picked_bush', regrow: w.time + 120 });
        break;
      case 'rock': {
        const n = (f.n ?? 3) - 1;
        this.give(p, 'stone', has('pickaxe') ? 3 : 2);
        this.setF(x, y, n <= 0 ? null : { t: 'rock', n });
        break;
      }
      case 'rubble': this.give(p, 'stone', 1); this.setF(x, y, null); break;
      case 'cave_wall': this.give(p, 'stone', 1); this.setF(x, y, null); break;
      case 'coal_seam': {
        const n = (f.n ?? 3) - 1;
        this.give(p, 'coal', rnd < 0.4 ? 2 : 1);
        this.setF(x, y, n <= 0 ? null : { t: 'coal_seam', n });
        break;
      }
      case 'geode':
        this.give(p, 'crystal_geode', 1); this.setF(x, y, null);
        this.say(`${p.name} pried a Crystal Geode out of the rock!`, '#ff9ad8');
        break;
      case 'ancient_tree':
        this.give(p, 'heartwood', 3); this.give(p, 'log', 4); this.give(p, 'heart_seed', 1);
        this.setF(x, y, { t: 'ancient_stump' });
        this.say(`${p.name} felled an Ancient Tree. Its heart is still warm.`, '#9fe8a8');
        break;
      case 'glowmoss': this.give(p, 'glowmoss', 1); this.setF(x, y, null); break;
      case 'bedroll': this.give(p, 'leaf', 3); this.give(p, 'stick', 1); this.setF(x, y, null); break;
      case 'dead_fire': this.give(p, 'charcoal', 1); this.give(p, 'charred_stick', 2); this.setF(x, y, { t: 'rubble' }); break;
      default:
        if (FEATURES[f.t]?.loose) { this.give(p, FEATURES[f.t].loose, 1); this.setF(x, y, null); }
        else return;
    }
    this.fx.push(['harvest', x, y, f.t]);
  }

  shatter(x, y, b) {
    const w = this.world, m = MULTIBLOCKS[b.t];
    for (const [tx, ty] of w.mbTiles(x, y, b.t)) {
      if (tx === x && ty === y) continue;
      this.setB(tx, ty, null);
      this.addDrop(tx, ty, m.wall, 1);
    }
    this.setB(x, y, null);
    this.addDrop(x, y, BUILDINGS[b.t].item, 1);
    if (b.in && m.in) this.addDrop(x, y, m.in[0], b.in);
    for (const [it, n] of Object.entries(b.out || {})) if (n > 0) this.addDrop(x, y, it, n);
    this.fx.push(['shatter', x, y, m.size]);
  }

  // Put n of an item into a crate (merging, then empty slots). Returns how many fit.
  crateAdd(cr, item, n) {
    const slots = crateSlots(cr), max = stackMax(item);
    let left = n;
    for (const s of slots) if (left && s && s.item === item && s.n < max) { const k = Math.min(left, max - s.n); s.n += k; left -= k; }
    for (let i = 0; i < slots.length && left; i++) if (!slots[i]) { const k = Math.min(left, max); slots[i] = { item, n: k }; left -= k; }
    return n - left;
  }

  // ---------- containers: crates, buildings' input/output, eternal caches ----------
  // Take n from container slot ci into inventory slot `slot` (or anywhere, if undefined).
  contTake(p, x, y, ci, n, slot) {
    const w = this.world, c = w.containerAt(x, y);
    if (!c || !this.inReach(p, c.x, c.y)) return;
    const d = c.slots[ci];
    if (!d?.s) return;
    const item = d.s.item;
    n = Math.max(1, Math.min(n || d.s.n, d.s.n));
    let taken = 0;
    const inv = p.inv;
    if (Number.isInteger(slot) && inv[slot] !== undefined) {
      const t = inv[slot];
      if (!t) { inv[slot] = { item, n }; taken = n; }
      else if (t.item === item) { taken = Math.min(n, stackMax(item) - t.n); t.n += taken; }
      else if (c.kind === 'crate' && n === d.s.n) { c.b.slots[ci] = t; inv[slot] = { item, n }; p.invDirty = true; this.dB.add(key(c.x, c.y)); return; }
    } else taken = n - addItem(inv, item, n);
    if (!taken) return;
    if (c.kind === 'crate') { d.s.n -= taken; if (d.s.n <= 0) c.b.slots[ci] = null; }
    else if (c.kind === 'building') { if (d.role === 'in') c.b.in -= taken; else c.b.out[item] -= taken; }
    else { const store = { ...c.f.store }; store[item] -= taken; this.setF(c.x, c.y, { t: 'eternal', store }); }
    this.dB.add(key(c.x, c.y));
    p.invDirty = true;
  }

  // Put n from inventory slot `slot` into container slot ci (or anywhere it fits, if undefined).
  contPut(p, x, y, slot, n, ci) {
    const w = this.world, c = w.containerAt(x, y), s = p.inv[slot];
    if (!c || !s || !this.inReach(p, c.x, c.y)) return;
    n = Math.max(1, Math.min(n || s.n, s.n));
    let put = 0;
    if (c.kind === 'crate') {
      const slots = c.b.slots;
      if (Number.isInteger(ci) && slots[ci] !== undefined) {
        const t = slots[ci];
        if (!t) { slots[ci] = { item: s.item, n }; put = n; }
        else if (t.item === s.item) { put = Math.min(n, stackMax(s.item) - t.n); t.n += put; }
        else if (n === s.n) { slots[ci] = s; p.inv[slot] = t; p.invDirty = true; this.dB.add(key(c.x, c.y)); return; }
      } else put = this.crateAdd(c.b, s.item, n);
    } else if (c.kind === 'building') {
      const inSlot = c.slots[0];
      if (inSlot?.role !== 'in' || inSlot.item !== s.item) return; // buildings only take their input
      put = Math.min(n, inSlot.cap - (c.b.in || 0));
      c.b.in = (c.b.in || 0) + put;
    } else return; // an eternal cache is take-only
    if (!put) return;
    s.n -= put;
    if (s.n <= 0) p.inv[slot] = null;
    this.dB.add(key(c.x, c.y));
    p.invDirty = true;
  }

  // Move within a crate.
  contMove(p, x, y, a, b2, n) {
    const c = this.world.containerAt(x, y);
    if (!c || c.kind !== 'crate' || !this.inReach(p, c.x, c.y)) return;
    const slots = c.b.slots, A = slots[a], B = slots[b2];
    if (a === b2 || !A || B === undefined) return;
    n = Math.max(1, Math.min(n || A.n, A.n));
    if (!B) { slots[b2] = { item: A.item, n }; A.n -= n; }
    else if (B.item === A.item) { const k = Math.min(n, stackMax(A.item) - B.n); B.n += k; A.n -= k; }
    else if (n === A.n) { slots[a] = B; slots[b2] = A; }
    if (slots[a] && slots[a].n <= 0) slots[a] = null;
    this.dB.add(key(c.x, c.y));
  }

  storeEternal(x, y, item, n = 1) {
    const f = this.world.getFeature(x, y);
    const store = { ...(f?.store || {}) };
    const total = Object.values(store).reduce((a, v) => a + v, 0);
    if (total >= 300) return false;
    store[item] = (store[item] || 0) + n;
    this.setF(x, y, { t: 'eternal', store });
    return true;
  }

  // Weighted pick that favours designs nobody has found yet (read, or carried unread), while
  // still letting duplicates turn up.
  pickBlueprint(pool) {
    const held = new Set();
    for (const q of this.players.values()) for (const s of q.inv) if (s && ITEMS[s.item]?.learn) held.add(ITEMS[s.item].learn);
    const wt = pool.map((id) => (this.known.has(id) || held.has(id) ? 1 : NEW_BLUEPRINT_WEIGHT));
    let r = Math.random() * wt.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) if ((r -= wt[i]) < 0) return pool[i];
    return pool[pool.length - 1];
  }

  click(p, x, y, slot, shift) {
    const w = this.world;
    const s = p.inv[slot];
    const it = s && ITEMS[s.item];
    // Flares fire straight up wherever you aim; everyone sees where they came from.
    if (it?.use === 'flare' && !p.dead) {
      removeItem(p.inv, 'flare', 1); p.invDirty = true;
      this.fx.push(['flare', r2(p.x), r2(p.y), p.name, p.color]);
      this.say(`${p.name} fired a flare!`, p.color);
      return;
    }
    if (!this.inReach(p, x, y)) return;

    if (it?.learn) {
      if (!this.known.has(it.learn)) {
        this.known.add(it.learn);
        this.broadcast({ t: 'known', known: [...this.known] });
        this.say(`${p.name} deciphered a blueprint: ${BLUEPRINTS[it.learn]}! (Workbench)`, '#ffd27a');
      } else this.tell(p, 'Everyone already knows this one.');
      removeItem(p.inv, s.item, 1); p.invDirty = true;
      return;
    }

    if (x === 0 && y === 0) {
      if (!it?.fuel) { this.tell(p, s ? "That won't burn." : 'Select fuel in your hotbar, then right-click the fire.'); return; }
      if (w.fire.fuel >= w.maxFuel() - 1) { this.tell(p, `The ${FIRE_STAGES[w.stage()].name} can't hold any more. Grow it to hold more.`, '#ffb070'); return; }
      const n = shift ? s.n : 1;
      const item = s.item;
      for (let i = 0; i < n; i++) this.feedFire(item);
      removeItem(p.inv, item, n);
      p.invDirty = true;
      if (w.fire.demand > it.fuel.heat) this.tell(p, `The fire is too hungry for ${it.name.toLowerCase()} - it mostly turns to ash.`, '#c9a27a');
      return;
    }

    let b = w.getB(x, y);
    if (b) {
      const core = w.mbCoreFor(x, y);
      if (core) [x, y, b] = core;
      if (b.t === 'torch' && it?.fuel) {
        b.fuel = Math.min(TORCH.placedFuel, b.fuel + it.fuel.value * 2);
        w.lightDirty = true;
        removeItem(p.inv, s.item, 1); p.invDirty = true;
        this.dB.add(key(x, y));
        return;
      }
      return; // containers are opened (and emptied/filled) through the container ops
    }

    const f = w.getFeature(x, y);
    switch (f?.t) {
      case 'chest':
        const loot = w.gen.loot(x, y);
        for (const [item, n] of loot) this.give(p, item, n);
        if (loot.blueprints) this.give(p, 'bp_' + this.pickBlueprint(loot.blueprints), 1);
        this.setF(x, y, { t: 'chest_open' });
        this.fx.push(['chest', x, y]);
        this.say(`${p.name} pried open an old chest.`, '#e0c070');
        return;
      case 'eternal': return; // opened as a container (its cache)
      case 'note': this.tell(p, `"${NOTES[f.n ?? 0]}"`, '#d8c8a8'); return;
      case 'dead_fire': this.tell(p, 'Cold ashes. Whoever kept this fire is gone.', '#a8a0a0'); return;
      case 'shrine': {
        const site = w.gen.siteAt(x, y);
        const bp = site?.band ? this.pickBlueprint(site.band) : site?.blueprint ?? 'kiln';
        this.give(p, 'bp_' + bp, 1);
        this.setF(x, y, { t: 'shrine_empty' });
        this.fx.push(['chest', x, y]);
        this.say(`${p.name} took a blueprint from a shrine: ${BLUEPRINTS[bp]}.`, '#ffd27a');
        return;
      }
      case 'shrine_empty': this.tell(p, 'The pedestal is bare now.'); return;
    }
    if (it?.place) this.place(p, x, y, s);
  }

  place(p, x, y, s) {
    const w = this.world;
    const type = ITEMS[s.item].place;
    if (w.ground(x, y) === 'water' || w.getB(x, y) || (x === 0 && y === 0)) return;
    const f = w.getFeature(x, y);
    if (f && !FEATURES[f.t]?.loose) { this.tell(p, 'Something is in the way.'); return; }
    if (BUILDINGS[type].solid) {
      for (const q of this.players.values()) {
        if (q.dead) continue;
        if (q.x + PLAYER_HALF > x && q.x - PLAYER_HALF < x + 1 && q.y + PLAYER_HALF > y && q.y - PLAYER_HALF < y + 1) { this.tell(p, 'Someone is standing there.'); return; }
      }
    }
    if (type === 'root') {
      // The campfire's (orange) and eternal flames' (teal) networks never mix.
      const nets = [...w.netsAround(x, y)];
      const eternals = nets.filter((n) => n !== 'fire');
      if ((nets.includes('fire') && eternals.length) || eternals.length > 1) {
        this.tell(p, 'Those roots carry different flames. Orange and teal roots can never meet.', '#9fe8d8');
        return;
      }
    }
    if ((type === 'kindling' || type === 'sapling' || type === 'heart_seed') && ['floor', 'cave'].includes(w.ground(x, y))) { this.tell(p, 'Nothing grows on stone.'); return; }
    if (f) { this.give(p, FEATURES[f.t].loose, 1); this.setF(x, y, null); }
    const b = newBuilding(type);
    if (type === 'torch' && p.lit && countItem(p.inv, 'torch') === 1) { b.fuel = TORCH.placedFuel * (1 - p.burn / TORCH.heldFuel); p.burn = 0; }
    this.setB(x, y, b);
    removeItem(p.inv, s.item, 1);
    p.invDirty = true;
    this.fx.push(['place', x, y]);
  }

  craft(p, id) {
    const r = RECIPES.find((r) => r.id === id);
    if (!r || p.dead) return;
    if (r.requires && !this.known.has(r.requires)) return;
    if (r.station) {
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      let near = false;
      for (let y = ty - 4; y <= ty + 4 && !near; y++) for (let x = tx - 4; x <= tx + 4; x++) if (this.world.getB(x, y)?.t === r.station) { near = true; break; }
      if (!near) { this.tell(p, 'You need to be near a Workbench.'); return; }
    }
    if (!hasAll(p.inv, r.in)) return;
    for (const [item, n] of Object.entries(r.in)) removeItem(p.inv, item, n);
    this.give(p, r.out[0], r.out[1]);
  }

  gameOver() {
    if (this.over) return;
    this.over = true;
    this.world.setFuel(0);
    this.broadcast({ t: 'over', time: this.world.time });
    this.log?.(`The fire went out after ${Math.floor(this.world.time / 60)}m ${Math.floor(this.world.time % 60)}s.`);
  }

  // ---------- simulation ----------
  tick(dt) {
    // Nobody at the fire: the world holds its breath (no burning, no growth, no weather).
    if (!this.players.size) return;
    if (!this.over) {
      const w = this.world;
      w.time += dt;
      this.tickWeather(dt);
      const rain = this.weather.s === 'rain';

      const f = w.fire, min = w.time / 60;
      f.demand = Math.min(FIRE.maxDemand, Math.floor(min / FIRE.demandEveryMin));
      f.temp += (Math.min(1, f.temp) - f.temp) * dt * 0.004;
      // It never stops getting hungrier: linear growth times a slow exponential.
      const crowd = 1 + FIRE.perExtraPlayer * (this.players.size - 1); // more mouths, more hunger
      const base = FIRE.baseBurn * crowd * (1 + min * FIRE.hungerPerMin) * Math.pow(FIRE.hungerGrowth, min)
        * (rain ? FIRE.rainMult : 1) * (f.temp >= f.demand + 1 ? FIRE.hotBonus : 1);

      this.tickPlayers(dt, rain);
      this.draw = 0;
      this.tickBuildings(dt, rain);
      this.tickPackets(dt);
      f.burn = base + this.draw / dt;
      w.setFuel(Math.min(w.maxFuel(), f.fuel - base * dt - this.draw));
      if (f.fuel <= 0) this.gameOver();
    }
    if (++this.tickN % SNAP_EVERY === 0) this.snapshot();
  }

  tickWeather(dt) {
    const W = this.weather;
    W.t -= dt;
    if (W.t <= 0) {
      switch (W.s) {
        case 'clear':
          if (Math.random() < 0.7) { W.s = 'rain_warn'; W.t = 15; this.say('The air grows heavy and damp... rain is coming.', '#8fb8e0'); }
          else { W.s = 'wind_warn'; W.t = 8; this.say('The old trees begin to creak... a windfall is coming.', '#c8d890'); }
          break;
        case 'rain_warn': W.s = 'rain'; W.t = 60 + Math.random() * 40; this.say('Rain! Flames burn faster - but plants grow faster and rot pits work quicker.', '#8fb8e0'); break;
        case 'wind_warn': W.s = 'wind'; W.t = 25; this.say('WINDFALL! Branches are crashing down everywhere - go gather!', '#c8d890'); break;
        default: W.s = 'clear'; W.t = 150 + Math.random() * 150; this.say('The weather calms.', '#aaa');
      }
    }
    if (W.s === 'wind') {
      this.windAcc += dt;
      const living = [...this.players.values()].filter((p) => !p.dead);
      while (this.windAcc > 0.3) {
        this.windAcc -= 0.3;
        let cx = 0, cy = 0;
        if (living.length && Math.random() < 0.5) { const p = living[Math.floor(Math.random() * living.length)]; cx = Math.floor(p.x); cy = Math.floor(p.y); }
        const x = cx + Math.floor((Math.random() - 0.5) * 50), y = cy + Math.floor((Math.random() - 0.5) * 50);
        if (!this.world.isSolid(x, y)) this.addDrop(x, y, Math.random() < 0.72 ? 'stick' : 'log', 1);
      }
    }
  }

  tickPlayers(dt, rain) {
    const w = this.world;
    let alive = 0;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      alive++;
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      // Your carried light IS the torches in your inventory. They're lit at any flame (or from a
      // friend's lit torch), put away while you're in light, and burn one at a time in the dark.
      let torches = countItem(p.inv, 'torch');
      if (!torches) { p.lit = false; p.burn = 0; }
      if (w.sharedLit(tx, ty)) {
        p.cold = 0;
        if (torches) p.lit = true;
      } else {
        if (torches && !p.lit && this.nearLitPlayer(p)) { p.lit = true; this.tell(p, 'Your torch catches from a friend\'s flame.', '#ffb070'); }
        if (p.lit && torches) {
          p.cold = 0;
          p.burn += dt * (rain ? TORCH.heldRainMult : 1);
          if (p.burn >= TORCH.heldFuel) {
            p.burn = 0;
            removeItem(p.inv, 'torch', 1);
            this.give(p, 'charred_stick', 1);
            torches--;
            if (!torches) { p.lit = false; this.tell(p, 'Your last torch burns out! Get to light, fast!', '#e07a6a'); }
            else this.tell(p, `A torch burns out. You light the next from its embers. (${torches} left)`, '#c9a27a');
          }
        } else {
          p.cold += dt;
          if (p.cold >= COLD_GRACE) { this.kill(p, 'the cold dark'); continue; }
        }
      }
      p.held = p.lit && torches ? TORCH.heldFuel - p.burn : 0;
      // pickups
      const f = w.getFeature(tx, ty);
      if (f && FEATURES[f.t]?.loose) { this.give(p, FEATURES[f.t].loose, 1); this.setF(tx, ty, null); this.fx.push(['pickup', tx, ty]); }
      const k = key(tx, ty), d = w.drops.get(k);
      if (d && this.dropLocks.get(k) !== p.id) {
        const rest = [];
        for (const [item, n] of d) { const left = addItem(p.inv, item, n); if (left) rest.push([item, left]); }
        if (rest.length) w.drops.set(k, rest); else w.drops.delete(k);
        this.dD.add(k); p.invDirty = true;
        this.fx.push(['pickup', tx, ty]);
      }
    }
    for (const p of this.players.values()) {
      if (p.invDirty) { this.send(p.ws, { t: 'inv', inv: p.inv }); p.invDirty = false; }
    }
    for (const [k, id] of this.dropLocks) {
      const q = this.players.get(id);
      if (!q || q.dead || key(Math.floor(q.x), Math.floor(q.y)) !== k || !w.drops.has(k)) this.dropLocks.delete(k);
    }
    // Nobody left to tend the fire: everyone rises after a moment, at a cost.
    if (this.players.size && !alive) {
      if (!this.autoRevive) this.autoRevive = w.time + 5;
      else if (w.time >= this.autoRevive) {
        this.autoRevive = 0;
        for (const p of this.players.values()) if (p.dead && !this.over) this.revive(p);
      }
    } else this.autoRevive = 0;
  }

  // Hand an item onward: a neighbouring building that takes it, else straight into a flame it
  // touches, else down the best powered root (orange roots only carry fuel to the fire; teal
  // roots carry anything to their eternal flame's cache).
  deliver(x, y, b, item) {
    const w = this.world;
    const outs = w.outlets(x, y, b);
    for (const [nx, ny, ox, oy] of outs) {
      const c = w.mbCoreFor(nx, ny) ?? (w.getB(nx, ny) ? [nx, ny, w.getB(nx, ny)] : null);
      if (!c || c[2] === b) continue;
      const cb = c[2], m = MULTIBLOCKS[cb.t];
      const ok = (cb.t === 'rot_pit' && item === 'leaf' && cb.in < 20) || (m?.in?.[0] === item && cb.ok && cb.in < m.in[1]);
      if (ok) { cb.in++; this.fx.push(['hop', ox, oy, nx, ny, item]); return true; }
    }
    for (const [nx, ny, ox, oy] of outs) {
      const cr = w.getB(nx, ny);
      if (cr?.t === 'crate' && this.crateAdd(cr, item, 1)) { this.dB.add(key(nx, ny)); this.fx.push(['hop', ox, oy, nx, ny, item]); return true; }
    }
    const fuel = !!ITEMS[item].fuel;
    for (const [nx, ny] of outs) {
      const n = w.rootNodeAt(nx, ny);
      if (n?.d === 0 && n.net === 'fire' && fuel && w.fire.fuel > 0) { this.feedFire(item); return true; }
      if (n?.d === 0 && n.net !== 'fire' && this.storeEternal(nx, ny, item)) return true;
      if (!n && w.getFeature(nx, ny)?.t === 'eternal' && this.storeEternal(nx, ny, item)) return true;
    }
    let best = null, bd = Infinity;
    for (const [nx, ny, ox, oy] of outs) {
      const n = w.rootNodeAt(nx, ny);
      if (!n || n.d === 0 || !w.rootPowered(nx, ny) || (n.net === 'fire' && !fuel)) continue;
      if (n.d < bd) { bd = n.d; best = [nx, ny, ox, oy]; }
    }
    if (!best) return false;
    this.packets.push({ id: this.packetId++, x: best[2], y: best[3], nx: best[0], ny: best[1], p: 0, item });
    return true;
  }

  tickBuildings(dt, rain) {
    const w = this.world;
    const grow = rain ? 2 : 1;
    const addOut = (b, item) => {
      const total = Object.values(b.out).reduce((a, n) => a + n, 0);
      if (total < OUT_CAP) b.out[item] = (b.out[item] || 0) + 1;
    };
    for (const [k, b] of w.bld) {
      const [x, y] = unkey(k);
      switch (b.t) {
        case 'torch': {
          const net = w.connected(x, y);
          const wasLit = b.fuel > 0;
          if (net) {
            b.fuel = TORCH.placedFuel;
            if (net === 'fire') this.draw += dt * TORCH.networkCost * (rain ? TORCH.rainMult : 1);
          } else if (b.fuel > 0) b.fuel = Math.max(0, b.fuel - dt * (rain ? TORCH.rainMult : 1));
          if (wasLit !== b.fuel > 0) w.lightDirty = true;
          b.conn = !!net;
          b.net = net ? (net === 'fire' ? 'f' : 'e') : '';
          break;
        }
        case 'root':
          if (b.g < 1) { b.g = Math.min(1, b.g + dt / 2); if (b.g >= 1) w.rootDirty = true; }
          break;
        case 'kindling':
          if (w.sharedLit(x, y)) {
            if (b.g < 1) b.g = Math.min(1, b.g + dt / 45 * grow);
            else if ((b.p += dt / 7 * grow) >= 1) { b.p = 0; addOut(b, 'leaf'); }
          }
          break;
        case 'sapling':
          if (w.sharedLit(x, y)) {
            if (b.g < 1) b.g = Math.min(1, b.g + dt / 90 * grow);
            else {
              if ((b.p += dt / 14 * grow) >= 1) { b.p = 0; addOut(b, 'stick'); }
              if ((b.q += dt / 50 * grow) >= 1) { b.q = 0; addOut(b, 'log'); }
            }
          }
          break;
        case 'rot_pit':
          if (b.in >= 4 && (b.p += dt / (rain ? 10 : 20)) >= 1) { b.p = 0; b.in -= 4; addOut(b, 'peat'); }
          break;
        case 'resin_tap': {
          // drips from a living grove tree or (twice as fast) a heart tree beside it
          let rate = 0;
          for (const [dx, dy] of N4) {
            const nb = w.getB(x + dx, y + dy);
            if (nb?.t === 'sapling' && nb.g >= 1) rate = Math.max(rate, 1 / 30);
            const c = w.mbCoreFor(x + dx, y + dy);
            if (c?.[2].t === 'heart_seed' && c[2].ok && c[2].g >= 1) rate = 1 / 15;
          }
          b.on = rate > 0;
          if (rate && (b.p += dt * rate * (rain ? 1.5 : 1)) >= 1) { b.p = 0; addOut(b, 'resin'); }
          break;
        }
        default: {
          const m = MULTIBLOCKS[b.t];
          if (m) this.tickMultiblock(x, y, b, m, dt, grow, addOut);
        }
      }
      if (b.out) {
        b.cd = (b.cd || 0) - dt;
        if (b.cd <= 0) {
          for (const item in b.out) {
            if (b.out[item] > 0 && this.deliver(x, y, b, item)) { b.out[item]--; b.cd = 0.35; break; }
          }
        }
      }
      const s = sig(b);
      if (this.sigs.get(k) !== s) { this.sigs.set(k, s); this.dB.add(k); }
    }
  }

  tickMultiblock(x, y, b, m, dt, grow, addOut) {
    const w = this.world;
    const was = b.ok;
    b.ok = w.mbComplete(x, y, b.t);
    if (b.ok && !was) {
      this.fx.push(['forge', x, y, m.size]);
      this.say(`The ${BUILDINGS[b.t].name} takes shape!`, '#ffb070');
    }
    const net = b.ok && m.heat ? w.heatNet(w.mbTiles(x, y, b.t)) : null;
    b.net = net ? (net === 'fire' ? 'f' : 'e') : '';
    b.on = false;
    if (m.make && b.ok && (!m.heat || net) && b.in >= m.make[0]) {
      b.on = true;
      if (net === 'fire') this.draw += dt * m.draw;
      if ((b.p += dt / m.make[2]) >= 1) { b.p = 0; b.in -= m.make[0]; addOut(b, m.make[1]); }
    }
    if (m.grows && b.ok) {
      b.on = true;
      if (b.g < 1) b.g = Math.min(1, b.g + dt / m.growTime * grow);
      else if ((b.p += dt / m.grows[1] * grow) >= 1) { b.p = 0; addOut(b, m.grows[0]); }
    }
    if (m.light) {
      const lit = b.ok && !!net;
      if (lit !== !!b.lit) { b.lit = lit; w.lightDirty = true; }
      if (lit && net === 'fire') this.draw += dt * m.draw;
    }
  }

  tickPackets(dt) {
    const w = this.world;
    const keep = [];
    for (const pk of this.packets) {
      pk.p += dt * PACKET_SPEED;
      let alive = true;
      while (pk.p >= 1) {
        pk.p -= 1;
        pk.x = pk.nx; pk.y = pk.ny;
        const n = w.rootNodeAt(pk.x, pk.y);
        if (n?.d === 0) {
          // reached the source: the campfire (or its ring) or an eternal flame's cache
          if (n.net === 'fire') { if (ITEMS[pk.item].fuel) this.feedFire(pk.item); }
          else if (!this.storeEternal(pk.x, pk.y, pk.item)) this.addDrop(pk.x, pk.y, pk.item, 1);
          alive = false;
          break;
        }
        if (!n || !w.rootPowered(pk.x, pk.y)) { this.addDrop(pk.x, pk.y, pk.item, 1); alive = false; break; }
        const next = N4.find(([dx, dy]) => { const m = w.rootNodeAt(pk.x + dx, pk.y + dy); return m && m.net === n.net && m.d < n.d; });
        if (!next) { this.addDrop(pk.x, pk.y, pk.item, 1); alive = false; break; }
        pk.nx = pk.x + next[0]; pk.ny = pk.y + next[1];
      }
      if (alive) keep.push(pk);
    }
    this.packets = keep;
  }

  snapshot() {
    const w = this.world;
    const msg = {
      t: 'snap', time: r1(w.time),
      fire: { fuel: r1(w.fire.fuel), temp: r2(w.fire.temp), demand: w.fire.demand, burn: r2(w.fire.burn) },
      weather: { s: this.weather.s, t: Math.round(this.weather.t) },
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, x: r2(p.x), y: r2(p.y), f: p.face, m: p.moving, dead: p.dead, held: p.held > 0 ? Math.max(0.1, r1(p.held)) : 0, cold: r2(p.cold) })),
      pk: this.packets.map((k) => [k.id, k.x, k.y, k.nx, k.ny, r2(k.p), k.item]),
    };
    if (this.fx.length) { msg.fx = this.fx; this.fx = []; }
    if (this.dF.size) { msg.F = [...this.dF]; this.dF.clear(); }
    if (this.dB.size) { msg.B = [...this.dB].map((k) => [k, w.bld.get(k) ?? null]); this.dB.clear(); }
    if (this.dD.size) { msg.D = [...this.dD].map((k) => [k, w.drops.get(k) ?? null]); this.dD.clear(); }
    this.broadcast(msg);
  }
}
