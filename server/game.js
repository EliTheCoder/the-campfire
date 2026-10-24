import { World, key, unkey, N4, N8 } from '../shared/world.js';
import { ITEMS, BUILDINGS, FEATURES, RECIPES } from '../shared/defs.js';
import { FIRE, TORCH, COLD_GRACE, REACH, PLAYER_COLORS, PACKET_SPEED, SNAP_EVERY, PLAYER_HALF } from '../shared/constants.js';
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
    case 'sprouter': return { t, water: 0, p: 0, out: {} };
    case 'rot_pit': return { t, in: 0, p: 0, out: {} };
    case 'kiln': return { t, in: 0, p: 0, out: {}, ok: false, conn: false };
    default: return { t };
  }
}

// Compact signature of a building's visible state so we only resend it when it visibly changes.
function sig(b) {
  let s = '';
  for (const k in b) {
    if (k === 'cd') continue;
    const v = b[k];
    if (typeof v === 'number') s += k + (v > 2 ? Math.round(v / 5) : Math.round(v * 10)) + ';';
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
    this.fx = [];
    for (const p of this.players.values()) { this.resetPlayer(p); this.welcome(p); }
    this.log?.(`World reset. Seed ${this.seed}`);
  }

  // ---------- players ----------
  resetPlayer(p) {
    p.x = 0.5; p.y = 2.5;
    p.inv = newInv();
    addItem(p.inv, 'torch', 2);
    p.held = 0; p.cold = 0; p.dead = false; p.invDirty = true;
    p.face = 1; p.moving = false;
  }

  join(ws, name) {
    const id = this.nextId++;
    const p = { id, ws, name: String(name || 'Wanderer').slice(0, 16), color: PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length] };
    this.resetPlayer(p);
    this.players.set(id, p);
    this.welcome(p);
    this.say(`${p.name} joined the fire.`, p.color);
    return p;
  }

  leave(p) {
    if (!this.players.has(p.id)) return;
    if (!p.dead) this.dropAll(p);
    this.players.delete(p.id);
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
    p.dead = true; p.held = 0; p.cold = 0;
    this.say(`${p.name} was taken by ${why}. Revive them at the fire (R).`, '#e07a6a');
  }

  revive(p) {
    const w = this.world;
    w.setFuel(w.fire.fuel - FIRE.reviveCost);
    p.dead = false; p.cold = 0; p.held = 0;
    p.x = 0.5; p.y = 1.6;
    addItem(p.inv, 'torch', 1);
    p.invDirty = true;
    this.send(p.ws, { t: 'tp', x: p.x, y: p.y });
    this.fx.push(['revive', 0, 0]);
    this.say(`${p.name} rises from the embers. The fire weakens...`, '#f0b060');
    if (w.fire.fuel <= 0) this.gameOver();
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
    w.setFuel(Math.min(FIRE.maxFuel, f.fuel + v));
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
        if (s && !p.dead) { this.addDrop(Math.floor(p.x), Math.floor(p.y), s.item, s.n); p.inv[m.slot | 0] = null; p.invDirty = true; }
        break;
      }
      case 'swap': {
        const a = m.a | 0, b = m.b | 0;
        if (p.inv[a] !== undefined && p.inv[b] !== undefined) { [p.inv[a], p.inv[b]] = [p.inv[b], p.inv[a]]; p.invDirty = true; }
        break;
      }
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
      case 'ruin': {
        let best = null;
        for (let cy = -5; cy <= 5; cy++) for (let cx = -5; cx <= 5; cx++) {
          const r = this.world.gen.ruin(cx, cy);
          if (r && (a !== 'eternal' || r.eternal) && (!best || Math.hypot(r.x, r.y) < Math.hypot(best.x, best.y))) best = r;
        }
        if (best) { p.x = best.x + 0.5; p.y = best.y + 1.5; this.send(p.ws, { t: 'tp', x: p.x, y: p.y }); }
        break;
      }
      default: this.tell(p, 'cheats: /give item n, /weather rain|wind|clear, /fuel n, /time min, /tp x y, /ruin [eternal]');
    }
  }

  harvest(p, x, y) {
    if (!this.inReach(p, x, y)) return;
    const w = this.world;
    const b = w.getB(x, y);
    if (b) {
      this.give(p, BUILDINGS[b.t].item, 1);
      for (const [it, n] of Object.entries(b.out || {})) if (n > 0) this.give(p, it, n);
      if (b.in) this.give(p, b.t === 'kiln' ? 'log' : 'leaf', b.in);
      this.setB(x, y, null);
      this.fx.push(['break', x, y]);
      return;
    }
    const f = w.getFeature(x, y);
    if (!f) return;
    const axe = countItem(p.inv, 'axe') > 0;
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
      case 'bush':
        this.give(p, 'leaf', 3); if (rnd < 0.25) this.give(p, 'seed', 1);
        this.setF(x, y, { t: 'picked_bush', regrow: w.time + 120 });
        break;
      case 'rock': {
        const n = (f.n ?? 3) - 1;
        this.give(p, 'stone', 2);
        this.setF(x, y, n <= 0 ? null : { t: 'rock', n });
        break;
      }
      case 'rubble': this.give(p, 'stone', 1); this.setF(x, y, null); break;
      default:
        if (FEATURES[f.t]?.loose) { this.give(p, FEATURES[f.t].loose, 1); this.setF(x, y, null); }
        else return;
    }
    this.fx.push(['harvest', x, y, f.t]);
  }

  findKilnCore(x, y) {
    for (const [dx, dy] of N8) {
      const b = this.world.getB(x + dx, y + dy);
      if (b?.t === 'kiln') return [x + dx, y + dy, b];
    }
    return null;
  }

  click(p, x, y, slot, shift) {
    if (!this.inReach(p, x, y)) return;
    const w = this.world;
    const s = p.inv[slot];
    const it = s && ITEMS[s.item];

    if (it?.learn) {
      if (!this.known.has(it.learn)) {
        this.known.add(it.learn);
        this.broadcast({ t: 'known', known: [...this.known] });
        this.say(`${p.name} deciphered a blueprint: ${ITEMS[it.learn].name}! (Workbench)`, '#9fd8ff');
      } else this.tell(p, 'Everyone already knows this one.');
      removeItem(p.inv, s.item, 1); p.invDirty = true;
      return;
    }

    if (x === 0 && y === 0) {
      if (!it?.fuel) { this.tell(p, s ? "That won't burn." : 'Select fuel in your hotbar, then right-click the fire.'); return; }
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
      if (b.t === 'brick') { const core = this.findKilnCore(x, y); if (core) { [x, y, b] = core; } }
      const amt = (cap, have) => Math.max(0, Math.min(shift ? s.n : 1, cap - have));
      if (b.t === 'torch' && it?.fuel) {
        b.fuel = Math.min(TORCH.placedFuel, b.fuel + it.fuel.value * 2);
        w.lightDirty = true;
        removeItem(p.inv, s.item, 1); p.invDirty = true;
        this.dB.add(key(x, y));
        return;
      }
      if (b.t === 'rot_pit' && s?.item === 'leaf') {
        const n = amt(20, b.in);
        if (n) { b.in += n; removeItem(p.inv, 'leaf', n); p.invDirty = true; }
        return;
      }
      if (b.t === 'kiln' && s?.item === 'log') {
        const n = amt(10, b.in);
        if (n) { b.in += n; removeItem(p.inv, 'log', n); p.invDirty = true; }
        return;
      }
      if (b.out && Object.values(b.out).some((n) => n > 0)) {
        for (const [item, n] of Object.entries(b.out)) if (n > 0) this.give(p, item, n);
        b.out = {};
        return;
      }
      return;
    }

    const f = w.getFeature(x, y);
    if (f?.t === 'chest') {
      for (const [item, n] of w.gen.loot(x, y)) this.give(p, item, n);
      this.setF(x, y, { t: 'chest_open' });
      this.fx.push(['chest', x, y]);
      this.say(`${p.name} pried open an old chest.`, '#e0c070');
      return;
    }
    if (f?.t === 'eternal') { this.tell(p, 'The eternal flame. It will never go out. Torches relight here.', '#9fe8d8'); return; }
    if (it?.place) this.place(p, x, y, s);
  }

  place(p, x, y, s) {
    const w = this.world;
    const type = ITEMS[s.item].place;
    if (w.ground(x, y) === 'water' || w.getB(x, y) || (x === 0 && y === 0)) return;
    const f = w.getFeature(x, y);
    if (f && !FEATURES[f.t]?.loose) { this.tell(p, 'Something is in the way.'); return; }
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    if (!w.sharedLit(x, y) && Math.max(Math.abs(x - tx), Math.abs(y - ty)) > 1) { this.tell(p, 'Too dark to build there.'); return; }
    if (BUILDINGS[type].solid) {
      for (const q of this.players.values()) {
        if (q.dead) continue;
        if (q.x + PLAYER_HALF > x && q.x - PLAYER_HALF < x + 1 && q.y + PLAYER_HALF > y && q.y - PLAYER_HALF < y + 1) { this.tell(p, 'Someone is standing there.'); return; }
      }
    }
    if (type === 'root') {
      const ok = N4.some(([dx, dy]) => (x + dx === 0 && y + dy === 0) || w.getB(x + dx, y + dy)?.t === 'root');
      if (!ok) { this.tell(p, 'Ember roots must grow out of the fire or another root.', '#f0a060'); return; }
    }
    if ((type === 'kindling' || type === 'sapling') && w.ground(x, y) === 'floor') { this.tell(p, 'Nothing grows on stone.'); return; }
    if (f) { this.give(p, FEATURES[f.t].loose, 1); this.setF(x, y, null); }
    this.setB(x, y, newBuilding(type));
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
    if (!this.over) {
      const w = this.world;
      w.time += dt;
      this.tickWeather(dt);
      const rain = this.weather.s === 'rain';

      const f = w.fire, min = w.time / 60;
      f.demand = Math.min(FIRE.maxDemand, Math.floor(min / FIRE.demandEveryMin));
      f.temp += (Math.min(1, f.temp) - f.temp) * dt * 0.004;
      const base = FIRE.baseBurn * (1 + min * FIRE.hungerPerMin) * (1 - 0.08 * w.hearthCount())
        * (rain ? FIRE.rainMult : 1) * (f.temp >= f.demand + 1 ? FIRE.hotBonus : 1);

      this.tickPlayers(dt, rain);
      this.draw = 0;
      this.tickBuildings(dt, rain);
      this.tickPackets(dt);
      f.burn = base + this.draw / dt;
      w.setFuel(f.fuel - base * dt - this.draw);
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
        case 'rain_warn': W.s = 'rain'; W.t = 60 + Math.random() * 40; this.say('Rain! Flames burn faster - but plants and sprouters drink it up.', '#8fb8e0'); break;
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
      if (w.sharedLit(tx, ty)) {
        p.cold = 0;
        // Torches are lit from existing flames; stowed while you're in light.
        if (p.held <= 0 && countItem(p.inv, 'torch') > 0) { removeItem(p.inv, 'torch', 1); p.held = TORCH.heldFuel; p.invDirty = true; }
      } else if (p.held > 0) {
        p.held = Math.max(0, p.held - dt * (rain ? TORCH.heldRainMult : 1));
        if (p.held === 0) this.tell(p, 'Your torch sputters out! Get to light, fast!', '#e07a6a');
      } else {
        p.cold += dt;
        if (p.cold >= COLD_GRACE) { this.kill(p, 'the cold dark'); continue; }
      }
      // pickups
      const f = w.getFeature(tx, ty);
      if (f && FEATURES[f.t]?.loose) { this.give(p, FEATURES[f.t].loose, 1); this.setF(tx, ty, null); this.fx.push(['pickup', tx, ty]); }
      const k = key(tx, ty), d = w.drops.get(k);
      if (d) {
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
    // Nobody left to tend the fire: everyone rises after a moment, at a cost.
    if (this.players.size && !alive) {
      if (!this.autoRevive) this.autoRevive = w.time + 5;
      else if (w.time >= this.autoRevive) {
        this.autoRevive = 0;
        for (const p of this.players.values()) if (p.dead && !this.over) this.revive(p);
      }
    } else this.autoRevive = 0;
  }

  // Where a building can hand things off: its 4 neighbours (kilns use the edge of their 3x3).
  outlets(x, y, b) {
    if (b.t !== 'kiln') return N4.map(([dx, dy]) => [x + dx, y + dy, x, y]);
    const out = [];
    for (let i = -1; i <= 1; i++) {
      out.push([x + i, y - 2, x + i, y - 1], [x + i, y + 2, x + i, y + 1], [x - 2, y + i, x - 1, y + i], [x + 2, y + i, x + 1, y + i]);
    }
    return out;
  }

  deliver(x, y, b, item) {
    const w = this.world;
    const outs = this.outlets(x, y, b);
    for (const [nx, ny] of outs) {
      let nb = w.getB(nx, ny);
      if (nb?.t === 'brick') nb = this.findKilnCore(nx, ny)?.[2];
      if (!nb || nb === b) continue;
      if (nb.t === 'rot_pit' && item === 'leaf' && nb.in < 20) { nb.in++; return true; }
      if (nb.t === 'kiln' && item === 'log' && nb.in < 10) { nb.in++; return true; }
    }
    if (!ITEMS[item].fuel) return false;
    for (const [nx, ny] of outs) if (nx === 0 && ny === 0 && w.fire.fuel > 0) { this.feedFire(item); return true; }
    let best = null, bd = Infinity;
    for (const [nx, ny, ox, oy] of outs) {
      if (!w.rootPowered(nx, ny)) continue;
      const d = w.rootDistAt(nx, ny);
      if (d < bd) { bd = d; best = [nx, ny, ox, oy]; }
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
          const conn = w.connected(x, y);
          const wasLit = b.fuel > 0;
          if (conn) {
            b.fuel = TORCH.placedFuel;
            this.draw += dt * TORCH.networkCost * (rain ? TORCH.rainMult : 1);
          } else if (b.fuel > 0) b.fuel = Math.max(0, b.fuel - dt * (rain ? TORCH.rainMult : 1));
          if (wasLit !== b.fuel > 0) w.lightDirty = true;
          b.conn = conn;
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
        case 'sprouter':
          if (rain) b.water = Math.min(100, b.water + dt * 4);
          if (b.water >= 10 && (b.p += dt / 4 * (rain ? 1.5 : 1)) >= 1) { b.p = 0; b.water -= 10; addOut(b, 'stick'); }
          break;
        case 'rot_pit':
          if (b.in >= 4 && (b.p += dt / (rain ? 10 : 20)) >= 1) { b.p = 0; b.in -= 4; addOut(b, 'peat'); }
          break;
        case 'kiln': {
          b.ok = w.kilnComplete(x, y);
          b.conn = b.ok && this.outlets(x, y, b).some(([nx, ny]) => w.rootPowered(nx, ny) || (nx === 0 && ny === 0 && w.fire.fuel > 0));
          if (b.ok && b.conn && b.in >= 2) {
            this.draw += dt * 0.25;
            if ((b.p += dt / 15) >= 1) { b.p = 0; b.in -= 2; addOut(b, 'charcoal'); }
          }
          break;
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

  tickPackets(dt) {
    const w = this.world;
    const keep = [];
    for (const pk of this.packets) {
      pk.p += dt * PACKET_SPEED;
      let alive = true;
      while (pk.p >= 1) {
        pk.p -= 1;
        pk.x = pk.nx; pk.y = pk.ny;
        if (pk.x === 0 && pk.y === 0) { this.feedFire(pk.item); alive = false; break; }
        const d = w.rootDistAt(pk.x, pk.y);
        if (d === undefined || !w.rootPowered(pk.x, pk.y)) { this.addDrop(pk.x, pk.y, pk.item, 1); alive = false; break; }
        if (d === 1) { pk.nx = 0; pk.ny = 0; continue; }
        const next = N4.find(([dx, dy]) => w.rootDistAt(pk.x + dx, pk.y + dy) === d - 1);
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
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, x: r2(p.x), y: r2(p.y), f: p.face, m: p.moving, dead: p.dead, held: r1(p.held), cold: r2(p.cold) })),
      pk: this.packets.map((k) => [k.id, k.x, k.y, k.nx, k.ny, r2(k.p), k.item]),
    };
    if (this.fx.length) { msg.fx = this.fx; this.fx = []; }
    if (this.dF.size) { msg.F = [...this.dF]; this.dF.clear(); }
    if (this.dB.size) { msg.B = [...this.dB].map((k) => [k, w.bld.get(k) ?? null]); this.dB.clear(); }
    if (this.dD.size) { msg.D = [...this.dD].map((k) => [k, w.drops.get(k) ?? null]); this.dD.clear(); }
    this.broadcast(msg);
  }
}
