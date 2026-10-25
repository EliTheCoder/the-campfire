import { World, unkey } from '../shared/world.js';
import { ITEMS, BUILDINGS, FEATURES, RECIPES, MULTIBLOCKS, FIRE_STAGES, FEEDS, FUEL_NAMES, BLUEPRINTS } from '../shared/defs.js';
import { FIRE, TORCH, COLD_GRACE, REACH, PLAYER_SPEED, PLAYER_HALF, PACKET_SPEED, DEFAULT_PORT, HOTBAR, FIRE_TIERS } from '../shared/constants.js';
import { countItem, hasAll } from '../shared/inventory.js';
import { makeSprites, FLAME_PALETTES } from './sprites.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { chunkOf } from '../shared/worldgen.js';

const $ = (id) => document.getElementById(id);
const S = makeSprites();
const iconURL = {};
for (const [k, c] of Object.entries(S.icon)) iconURL[k] = c.toDataURL();

const R = createRenderer($('gl'), $('overlay'), S);
if (import.meta.env?.DEV) window.__campfire = { get st() { return st; }, R };
const audio = createAudio();

// HUD scale follows window height; -/= nudge it and the choice is remembered.
let uiNudge = 1;
try { uiNudge = Number(localStorage.getItem('campfire.ui')) || 1; } catch {}
function applyUIScale() {
  const ui = Math.max(1, Math.min(3, (innerHeight / 740) * uiNudge));
  document.documentElement.style.setProperty('--ui', ui.toFixed(3));
  R.ui = ui;
}
applyUIScale();
addEventListener('resize', () => { R.resize(); applyUIScale(); });

const st = {
  ws: null, myId: 0, world: null, players: new Map(), inv: [], known: new Set(),
  weather: { s: 'clear', t: 0 }, packets: [], over: false, sel: 0,
  me: { x: 0.5, y: 2.5, f: 1, m: false, dead: false, held: 0, cold: 0, freezing: false },
  hover: null, harvest: null, uiBlocking: false, pick: -1,
};

// ---------------- networking ----------------
function send(o) { if (st.ws?.readyState === 1) st.ws.send(JSON.stringify(o)); }

function playerToken() {
  let t = null;
  try { t = localStorage.getItem('campfire.token'); } catch {}
  if (!t) {
    t = (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));
    try { localStorage.setItem('campfire.token', t); } catch {}
  }
  return t;
}

function connect(url, name) {
  $('connect-err').textContent = 'Connecting...';
  const ws = new WebSocket(url);
  st.ws = ws;
  ws.onopen = () => send({ t: 'join', name, token: playerToken() });
  ws.onerror = () => { $('connect-err').textContent = "Couldn't reach the game server. Is it running?"; };
  ws.onclose = () => {
    if (st.world) { log('Disconnected from server.', '#e0705a'); $('connect').hidden = false; $('hud').hidden = true; $('connect-err').textContent = 'Disconnected.'; }
    st.world = null;
  };
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
}

function onMsg(m) {
  switch (m.t) {
    case 'welcome': {
      const w = new World(m.seed);
      w.time = m.time;
      for (const [k, v] of m.feat) w.feat.set(k, v);
      for (const [k, v] of m.bld) w.bld.set(k, v);
      for (const [k, v] of m.drops) w.drops.set(k, v);
      Object.assign(w.fire, m.fire);
      w.lightDirty = w.rootDirty = true;
      st.world = w;
      st.myId = m.id;
      st.known = new Set(m.known);
      st.weather = m.weather;
      st.inv = m.inv;
      st.over = m.over;
      st.players.clear();
      Object.assign(st.me, { x: m.x, y: m.y, dead: false, held: 0, cold: 0 });
      $('connect').hidden = true; $('hud').hidden = false;
      $('over-screen').hidden = !m.over;
      renderInv();
      if (R.software && !R.low && !st.softwareHinted) st.softwareHinted = true, log('Your browser is drawing WebGL in software, which is slow. Press [F2] for low graphics, or enable hardware acceleration.', '#ffcc66');
      if (!localStorage.getItem('campfire.helpSeen')) { $('help-panel').hidden = false; localStorage.setItem('campfire.helpSeen', '1'); }
      break;
    }
    case 'snap': {
      const w = st.world;
      if (!w) return;
      w.time = m.time;
      w.setFuel(m.fire.fuel);
      Object.assign(w.fire, m.fire);
      if (m.weather.s !== st.weather.s) { if (m.weather.s === 'rain_warn') audio.synth('thunder'); if (m.weather.s === 'wind_warn' || m.weather.s === 'wind') audio.synth('gust'); }
      st.weather = m.weather;
      w.weatherWind = m.weather.s === 'wind';
      const seen = new Set();
      for (const p of m.players) {
        seen.add(p.id);
        let q = st.players.get(p.id);
        if (!q) { q = { ...p, rx: p.x, ry: p.y }; st.players.set(p.id, q); }
        Object.assign(q, p);
        if (p.id === st.myId) {
          const wasDead = st.me.dead, wasHeld = st.me.held;
          if (wasHeld <= 0 && p.held > 0 && !w.sharedLit(Math.floor(st.me.x), Math.floor(st.me.y))) audio.synth('torchLight');
          if (wasHeld > 0 && p.held <= 0 && !p.dead && !w.sharedLit(Math.floor(st.me.x), Math.floor(st.me.y))) audio.synth('torchOut');
          st.me.dead = p.dead; st.me.held = p.held; st.me.cold = p.cold;
          if (p.dead && !wasDead) st.harvest = null;
        }
      }
      for (const id of st.players.keys()) if (!seen.has(id)) st.players.delete(id);
      if (m.F) for (const [k, v] of m.F) w.feat.set(k, v);
      if (m.B) for (const [k, v] of m.B) { const [x, y] = unkey(k); w.setB(x, y, v); }
      if (m.D) for (const [k, v] of m.D) { if (v?.length) w.drops.set(k, v); else w.drops.delete(k); }
      st.packets = m.pk.map(([id, x, y, nx, ny, p, item]) => ({ id, x, y, nx, ny, p, item }));
      if (m.fx) for (const e of m.fx) { R.fx(e, w); audio.fx(e); }
      if (m.B && !$('craft-panel').hidden) renderCraft();
      break;
    }
    case 'inv': st.inv = m.inv; renderInv(); break;
    case 'known': st.known = new Set(m.known); renderCraft(); audio.synth('learn'); break;
    case 'msg': log(m.text, m.c); break;
    case 'tp': st.me.x = m.x; st.me.y = m.y; break;
    case 'over':
      st.over = true;
      $('over-screen').hidden = false;
      $('over-time').textContent = `You kept it burning for ${fmtTime(m.time)}.`;
      break;
  }
  if (m.t === 'welcome' && !m.over) $('over-screen').hidden = true;
}

// ---------------- connect screen ----------------
$('name').value = localStorage.getItem('campfire.name') || '';
// The game server lives at the same address as the page (/ws). ?server=ws://... overrides it
// for testing; with no host (e.g. a packaged app) it falls back to a local server.
const serverUrl = new URLSearchParams(location.search).get('server')
  || (location.host ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` : `ws://localhost:${DEFAULT_PORT}`);
$('join').onclick = () => {
  const name = $('name').value.trim() || 'Wanderer';
  localStorage.setItem('campfire.name', name);
  audio.init();
  connect(serverUrl, name);
};
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
$('restart').onclick = () => send({ t: 'restart' });

// ---------------- input ----------------
// All binds are physical key positions (e.code). Labels show what that key types on the
// player's layout (e.g. KeyC reads "J" on Dvorak), like Minecraft does.
const BINDS = {
  up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD',
  inventory: 'KeyI', craft: 'KeyC', help: 'KeyH', drop: 'KeyQ', revive: 'KeyR',
  palette: 'KeyP', mute: 'KeyM', uiDown: 'Minus', uiUp: 'Equal',
};
let layoutMap = null;
function keyLabel(code) {
  const l = layoutMap?.get(code);
  if (l) return l.length === 1 ? l.toUpperCase() : l;
  return code.replace(/^Key|^Digit/, '').replace('Minus', '-').replace('Equal', '=');
}
const K = (action) => keyLabel(BINDS[action]);
function refreshKeyLabels() {
  for (const el of document.querySelectorAll('[data-key]')) el.textContent = el.dataset.key.split(',').map((c) => keyLabel(BINDS[c] || c)).join(el.dataset.sep ?? '');
}
navigator.keyboard?.getLayoutMap?.().then((m) => { layoutMap = m; refreshKeyLabels(); }).catch(() => {});
refreshKeyLabels();

const PANELS = ['inv-panel', 'craft-panel', 'help-panel', 'menu-panel'];
const keys = new Set();
let mouse = { x: 0, y: 0, l: false };

addEventListener('keydown', (e) => {
  if (!st.world) return;
  const chat = $('chat');
  if (document.activeElement === chat) {
    if (e.key === 'Enter') { const t = chat.value.trim(); if (t) send({ t: 'chat', text: t }); chat.value = ''; chat.hidden = true; chat.blur(); }
    if (e.key === 'Escape') { chat.value = ''; chat.hidden = true; chat.blur(); }
    return;
  }
  const c = e.code;
  keys.add(c);
  if (c === 'Enter' || c === 'NumpadEnter') { chat.hidden = false; chat.focus(); e.preventDefault(); return; }
  const digit = /^Digit([1-8])$/.exec(c);
  if (digit) { st.sel = Number(digit[1]) - 1; renderInv(); audio.play('tick', { vol: 0.4 }); }
  if (c === BINDS.mute) log(audio.toggleMute() ? `Sound muted. [${K('mute')}] to unmute.` : 'Sound on.', '#aaa');
  if (c === BINDS.uiDown || c === BINDS.uiUp) { uiNudge = Math.max(0.6, Math.min(2, uiNudge * (c === BINDS.uiDown ? 0.9 : 1.1))); try { localStorage.setItem('campfire.ui', uiNudge); } catch {} applyUIScale(); }
  if (c === 'Tab' || c === BINDS.inventory) { e.preventDefault(); toggle('inv-panel'); }
  if (c === BINDS.craft) toggle('craft-panel');
  if (c === BINDS.help) toggle('help-panel');
  if (c === 'Escape') {
    const open = PANELS.filter((id) => !$(id).hidden);
    if (open.length && !(open.length === 1 && open[0] === 'menu-panel')) for (const id of PANELS) $(id).hidden = true;
    else toggle('menu-panel');
  }
  if (c === BINDS.drop) send({ t: 'drop', slot: st.sel, all: e.shiftKey, x: st.hover?.x, y: st.hover?.y });
  if (c === BINDS.revive) send({ t: 'revive' });
  if (c === 'F2') { e.preventDefault(); R.setLow(!R.low); log(`Graphics: ${R.low ? 'low (2D, fastest)' : 'full (WebGL effects)'}. [F2] to switch.`, '#aaa'); }
  if (c === BINDS.palette) { R.palette = !R.palette; log(`Palette mode ${R.palette ? 'on' : 'off'}.`, '#aaa'); }
  st.uiBlocking = PANELS.some((id) => !$(id).hidden);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); mouse.l = false; });

function toggle(id) {
  const el = $(id);
  el.hidden = !el.hidden;
  audio.play(el.hidden ? 'close' : 'open', { vol: 0.45 });
  if (id === 'craft-panel' && !el.hidden) renderCraft();
  if (id === 'menu-panel' && !el.hidden) renderMenu();
  for (const u of scrollUpdaters) u();
  if (id === 'inv-panel') { st.pick = -1; renderInv(); }
  st.uiBlocking = PANELS.some((id) => !$(id).hidden);
}

// Game input lives on whichever canvas is showing (WebGL, or the low-graphics 2D one).
for (const cv of [$('gl'), $('lo')]) {
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll / paste on middle click
    if (!st.world || st.me.dead) return;
    if (e.button === 1) { pickBlock(); return; }
    if (e.button === 0) mouse.l = true;
    if (e.button === 2 && st.hover) send({ t: 'click', x: st.hover.x, y: st.hover.y, slot: st.sel, shift: e.shiftKey || e.ctrlKey });
  });
  cv.addEventListener('wheel', (e) => { st.sel = (st.sel + (e.deltaY > 0 ? 1 : HOTBAR - 1)) % HOTBAR; renderInv(); audio.play('tick', { vol: 0.3 }); });
}
addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

// Middle click, Minecraft-style: select the item for what you're pointing at. If it's in the
// hotbar, select that slot; if it's only in your inventory, swap it into the current slot.
function pickBlock() {
  const h = st.hover, w = st.world;
  if (!h) return;
  const b = w.getB(h.x, h.y), f = w.getFeature(h.x, h.y);
  const item = b ? BUILDINGS[b.t].item : f && FEATURES[f.t]?.loose;
  if (!item) return;
  const idx = st.inv.findIndex((s) => s?.item === item);
  if (idx < 0) return;
  if (idx < HOTBAR) st.sel = idx;
  else send({ t: 'swap', a: st.sel, b: idx });
  renderInv();
  audio.play('tick', { vol: 0.4 });
}
addEventListener('mouseup', (e) => { if (e.button === 0) { mouse.l = false; st.harvest = null; } });

// ---------------- movement (client-predicted) ----------------
function walkable(w, tx, ty) {
  if (w.isSolid(tx, ty)) return 'solid';
  if (w.sharedLit(tx, ty)) return true;
  const mx = Math.floor(st.me.x), my = Math.floor(st.me.y);
  if (st.me.held > 0 && countItem(st.inv, 'torch') > 0 && Math.max(Math.abs(tx - mx), Math.abs(ty - my)) <= TORCH.heldRadius) return true;
  if (st.me.freezing) return true; // stumbling blindly toward safety
  return 'dark';
}
function canOccupy(w, x, y) {
  const me = st.me;
  for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const tx = Math.floor(x + ox * PLAYER_HALF), ty = Math.floor(y + oy * PLAYER_HALF);
    const r = walkable(w, tx, ty);
    // Never trap a player inside something solid they already overlap (e.g. spawned on a building).
    if (r === 'solid' && Math.abs(tx + 0.5 - me.x) <= 0.5 + PLAYER_HALF && Math.abs(ty + 0.5 - me.y) <= 0.5 + PLAYER_HALF) continue;
    if (r !== true) return r;
  }
  return true;
}
let lastDarkMsg = 0, stepAcc = 0;
function move(dt) {
  const w = st.world, me = st.me;
  me.freezing = !me.dead && !w.sharedLit(Math.floor(me.x), Math.floor(me.y)) && (me.held <= 0 || !countItem(st.inv, 'torch'));
  if (me.dead || st.over || document.activeElement === $('chat')) { me.m = false; return; }
  let dx = 0, dy = 0;
  // Physical key positions (e.code), so WASD works on Dvorak/AZERTY/etc.
  if (keys.has(BINDS.left) || keys.has('ArrowLeft')) dx--;
  if (keys.has(BINDS.right) || keys.has('ArrowRight')) dx++;
  if (keys.has(BINDS.up) || keys.has('ArrowUp')) dy--;
  if (keys.has(BINDS.down) || keys.has('ArrowDown')) dy++;
  me.m = !!(dx || dy);
  if (!me.m) return;
  const len = Math.hypot(dx, dy);
  const sp = PLAYER_SPEED * (me.freezing ? 0.55 : 1) * dt;
  if (dx) me.f = dx;
  let blockedDark = false;
  const nx = me.x + (dx / len) * sp;
  const rx = canOccupy(w, nx, me.y);
  if (rx === true) me.x = nx; else if (rx === 'dark') blockedDark = true;
  const ny = me.y + (dy / len) * sp;
  const ry = canOccupy(w, me.x, ny);
  if (ry === true) me.y = ny; else if (ry === 'dark') blockedDark = true;
  stepAcc += sp;
  if (stepAcc > 0.85) {
    stepAcc = 0;
    audio.play(w.ground(Math.floor(me.x), Math.floor(me.y)) === 'floor' ? 'step_stone' : 'step_grass', { vol: me.freezing ? 0.25 : 0.35, rate: me.freezing ? 0.8 : 1 });
  }
  if (blockedDark && performance.now() - lastDarkMsg > 2500) {
    lastDarkMsg = performance.now();
    audio.play('bump', { vol: 0.5, rate: 0.7 });
    R.float(countItem(st.inv, 'torch') ? 'Too dark...' : 'Too dark - you need a torch', me.x, me.y - 1, '#bcd4ff');
  }
}

// ---------------- harvest / hover ----------------
const hasTool = (t) => countItem(st.inv, t) > 0;
function harvestTime(w, x, y) {
  const b = w.getB(x, y);
  if (b) return MULTIBLOCKS[b.t] || w.formedCoreAt(x, y) ? 1.0 : 0.6;
  const f = w.getFeature(x, y);
  if (!f) return 0;
  const d = FEATURES[f.t];
  if (d.loose) return 0.25;
  if (d.tool && !hasTool(d.tool)) return 0;
  if (f.t === 'tree' && hasTool('axe')) return 1.1;
  if (f.t === 'rock' && hasTool('pickaxe')) return 0.7;
  return d.time || 0;
}

function updateHover(dt) {
  const w = st.world;
  const [tx, ty] = R.toTile(mouse.x, mouse.y);
  st.hover = { x: tx, y: ty };
  const inReach = Math.hypot(tx + 0.5 - st.me.x, ty + 0.5 - st.me.y) <= REACH + 0.75;
  if (mouse.l && inReach && !st.me.dead && !st.uiBlocking) {
    const time = harvestTime(w, tx, ty);
    if (!time) { st.harvest = null; }
    else {
      if (!st.harvest || st.harvest.x !== tx || st.harvest.y !== ty) st.harvest = { x: tx, y: ty, p: 0 };
      st.harvest.p += dt / time;
      if (st.harvest.p >= 1) { send({ t: 'harvest', x: tx, y: ty }); st.harvest.p = 0; }
    }
  } else st.harvest = null;
  updateTooltip(tx, ty, inReach);
}

function itemTooltip(s) {
  const it = ITEMS[s.item];
  let html = `<b>${it.name}</b>${s.n > 1 ? ` <span class="dim">x${s.n}</span>` : ''}`;
  if (it.desc) html += `<br>${it.desc}`;
  if (it.fuel) {
    const demand = st.world.fire.demand;
    html += `<br><span style="color:#ffb070">Fuel ${it.fuel.value} · heat tier ${it.fuel.heat + 1} (${FUEL_NAMES[it.fuel.heat]})</span>`;
    if (it.fuel.heat < demand) html += `<br><span style="color:#e0705a">Too weak for the fire right now - mostly ash</span>`;
    html += '<br><span class="dim">RMB the fire to feed (Ctrl: whole stack)</span>';
  }
  if (it.place) html += '<br><span class="dim">RMB a tile to place</span>';
  if (it.learn) html += `<br><span class="dim">RMB anywhere to read${st.known.has(it.learn) ? ' (already known)' : ''}</span>`;
  return html;
}

function placeTip(tip, html) {
  tip.innerHTML = html;
  tip.hidden = false;
  const z = R.ui || 1;
  const w = tip.offsetWidth * z, h = tip.offsetHeight * z;
  const left = Math.min(innerWidth - w - 8, mouse.x + 18);
  const top = mouse.y + 18 + h > innerHeight ? mouse.y - h - 10 : mouse.y + 18;
  tip.style.left = left / z + 'px';
  tip.style.top = top / z + 'px';
}

function updateTooltip(x, y, inReach) {
  const w = st.world, tip = $('tooltip');
  // Hovering an inventory/hotbar slot takes priority over the world.
  const slotEl = document.elementFromPoint(mouse.x, mouse.y)?.closest?.('.slot');
  if (slotEl) {
    const s = st.inv[Number(slotEl.dataset.slot)];
    if (s) placeTip(tip, itemTooltip(s)); else tip.hidden = true;
    return;
  }
  if (st.uiBlocking) { tip.hidden = true; return; }
  let html = '';
  if (x === 0 && y === 0) {
    const stg = w.stage(), next = FIRE_STAGES[stg + 1];
    html = `<b>The ${FIRE_STAGES[stg].name}</b><br>RMB with fuel: feed it (Ctrl: whole stack)<br>Holds ${w.maxFuel()} fuel · lights ${w.fireRadius() * 2 + 1}x${w.fireRadius() * 2 + 1}`;
    if (next) html += `<br><span class="dim">Grow it into a ${next.name}: ring it with ${next.ring * 8} ${ITEMS[next.block].name}s${next.ring > 1 ? ' (outside the ' + FIRE_STAGES[stg].name + ' ring)' : ''}</span>`;
  } else {
    const b = w.getB(x, y);
    const f = w.getFeature(x, y);
    const d = w.drops.get(`${x},${y}`);
    const core = b && w.formedCoreAt(x, y);
    if (core && core[2] !== b) html = `<b>${BUILDINGS[core[2].t].name}</b><br>${buildingInfo(w, core[2], core[0], core[1])}`;
    else if (b) html = `<b>${BUILDINGS[b.t].name}</b><br>${buildingInfo(w, b, x, y)}${MULTIBLOCKS[b.t] && b.ok ? '' : '<br><span class="dim">Hold LMB: pick up</span>'}`;
    else if (f) html = `<b>${FEATURES[f.t].name}</b>${featureHint(w, f, x, y)}`;
    else if (d?.length) html = `<b>Dropped items</b><br>${d.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')}<br><span class="dim">Walk over to pick up</span>`;
    else {
      const sel = st.inv[st.sel], it = sel && ITEMS[sel.item];
      if (it?.place && FEEDS[it.place] && w.ground(x, y) !== 'water') html = `<span class="dim">RMB: place ${it.name}</span>${placeHint(w, it.place, x, y)}`;
    }
  }
  if (!html) { tip.hidden = true; return; }
  if (!inReach) html += '<br><span class="dim">(out of reach)</span>';
  placeTip(tip, html);
}

const AMBER = (s) => `<span style="color:#ffb070">${s}</span>`;
const TEAL = (s) => `<span style="color:#7af0d8">${s}</span>`;
const RED = (s) => `<span style="color:#e0705a">${s}</span>`;
const DIM = (s) => `<span class="dim">${s}</span>`;
const nameOf = (t) => BUILDINGS[t]?.name ?? t;
// Preview what a building would feed if placed here.
function placeHint(w, type, x, y) {
  const want = FEEDS[type];
  if (w.feedTargets(x, y, type).length) return '<br>' + AMBER(`Will feed the ${nameOf(want)} beside it`);
  return '<br>' + DIM(`Tip: place it right beside a ${nameOf(want)} to feed it automatically`);
}
// Producers feeding this building (via its edge for multiblocks).
function countFeeders(w, x, y, b) {
  const seen = new Set();
  for (const [nx, ny] of w.outlets(x, y, b)) {
    const c = w.mbCoreFor(nx, ny) ?? (w.getB(nx, ny) ? [nx, ny, w.getB(nx, ny)] : null);
    if (c && FEEDS[c[2].t] === b.t) seen.add(c[2]);
  }
  return seen.size;
}
const FEEDER_OF = Object.fromEntries(Object.entries(FEEDS).map(([a, b]) => [b, a]));

function featureHint(w, f, x, y) {
  const axe = hasTool('axe'), pick = hasTool('pickaxe');
  switch (f.t) {
    case 'tree': return axe ? '<br>Hold LMB: chop for logs' : '<br>Hold LMB: shake for sticks<br>' + DIM('An axe would get logs.');
    case 'bare_tree': return axe ? '<br>Hold LMB: chop for logs' : '<br>' + DIM('Needs an axe.');
    case 'stump': return '<br>Hold LMB: pry up a stick';
    case 'bush': return '<br>Hold LMB: gather leaves';
    case 'picked_bush': return '<br>' + DIM('Regrowing...') + '<br>Hold LMB: clear it away';
    case 'rock': return '<br>Hold LMB: gather stone' + (pick ? '' : '<br>' + DIM('A pickaxe gets more, faster.'));
    case 'rubble': return '<br>Hold LMB: gather stone';
    case 'chest': return '<br>RMB: open';
    case 'eternal': {
      const store = Object.entries(f.store || {}).filter(([, n]) => n > 0);
      return '<br>It never goes out.' + (store.length ? '<br>' + TEAL(`Cache: ${store.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')}`) + '<br>RMB: collect it all' : '<br>' + DIM('Ember roots touching it grow teal. Machines on teal roots send their output here.'));
    }
    case 'brazier': return '<br>' + DIM('Cold and dead.');
    case 'dead_fire': return '<br>' + DIM('Someone else\'s fire. It went out.') + '<br>Hold LMB: sift the ashes';
    case 'bedroll': return '<br>Hold LMB: scavenge it';
    case 'note': return '<br>RMB: read';
    case 'shrine': return '<br>A blueprint rests on the pedestal.<br>RMB: take it';
    case 'shrine_empty': return '<br>' + DIM('The pedestal is bare.');
    case 'cave_wall': return pick ? '<br>Hold LMB: mine it' : '<br>' + DIM('Needs a pickaxe.');
    case 'coal_seam': return pick ? '<br>Hold LMB: mine coal' : '<br>' + RED('Needs a pickaxe.');
    case 'geode': return pick ? '<br>Hold LMB: pry out the geode' : '<br>' + RED('Needs a pickaxe.');
    case 'ancient_tree': return axe ? '<br>Hold LMB: fell it (heartwood + a Heartwood Seed)' : '<br>' + RED('Needs an axe.');
    case 'ancient_stump': return '<br>' + DIM('Its heart has been taken.');
    case 'glowmoss': return '<br>Hold LMB: gather it';
    default: return FEATURES[f.t].loose ? '<br>Walk over or hold LMB to pick up' : '';
  }
}

function pct(v) { return Math.round(v * 100) + '%'; }
function outStr(b) {
  const e = Object.entries(b.out || {}).filter(([, n]) => n > 0);
  return e.length ? `<br>Holding: ${e.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')} ${DIM('(RMB: take)')}` : '';
}
function netLabel(net) {
  return net === 'fire' ? AMBER('Connected to the campfire') : net ? TEAL('Connected to an eternal flame (output goes to its cache)') : null;
}
function buildingInfo(w, b, x, y) {
  const net = w.connected(x, y);
  const link = netLabel(net) ?? DIM('Not connected: needs an ember root directly beside it (up/down/left/right). Output stays here.');
  const feeding = () => { const t = w.feedTargets(x, y, b.t); return t.length ? AMBER(`Feeding the ${nameOf(t[0][2].t)} beside it`) : null; };
  switch (b.t) {
    case 'torch': return b.fuel > 0 ? (b.conn ? (b.net === 'e' ? 'Fed by teal roots - burns forever' : 'Fed by the roots - burns forever') : `Fuel: ${Math.ceil(b.fuel)}s ${DIM('(RMB with fuel to top up)')}`) : 'Burnt out. RMB with fuel to relight, or pick up the charred stick.';
    case 'root': {
      const node = w.rootNodeAt(x, y);
      if (b.g < 1) return `Growing... ${pct(b.g)}`;
      if (w.rootPowered(x, y)) return node.net === 'fire' ? 'Glowing with the campfire\'s heat' : TEAL('Glowing with an eternal flame\'s heat');
      if (!node) return RED('Not connected - link it back to the fire or an eternal flame');
      return RED('Dark - the fire is too weak to reach this far');
    }
    case 'kindling': case 'sapling': {
      const grow = b.g < 1 ? `Growing ${pct(b.g)} (needs light)` : b.t === 'kindling' ? 'Sheds leaves' : 'Sheds sticks and the odd log';
      const fed = feeding();
      return grow + '<br>' + (fed ? fed + (b.t === 'sapling' ? '<br>' + link : '') : link) + outStr(b);
    }
    case 'rot_pit': {
      const n = countFeeders(w, x, y, b);
      const feeders = n ? AMBER(`Fed by ${n} Kindling Bush${n > 1 ? 'es' : ''} beside it`) : DIM('Plant Kindling Seeds right beside it and they feed it leaves');
      return `Leaves: ${b.in}/20 ${DIM('(RMB with leaves)')}<br>Rotting: ${pct(b.p)}<br>${feeders}<br>${feeding() ?? link}${outStr(b)}`;
    }
    case 'resin_tap': return (b.on ? 'Dripping resin' : RED('Needs a grown grove tree or heart tree beside it')) + `<br>${link}${outStr(b)}`;
    case 'glowmoss': return 'A faint 3x3 light.' + DIM('<br>Ring a Heartwood Seed with 8 of these to grow a Heart Grove.');
    case 'hearth': case 'fire_brick': case 'ember_stone': {
      const ringOf = FIRE_STAGES.find((f) => f.block === b.t);
      const onRing = ringOf && Math.max(Math.abs(x), Math.abs(y)) === ringOf.ring;
      let s = onRing ? (w.stage() >= FIRE_STAGES.indexOf(ringOf) ? AMBER(`Part of the ${ringOf.name} ring`) : `Part of an unfinished ${ringOf.name} ring`) : DIM(`${ringOf.ring * 8} of these ${ringOf.ring} tile${ringOf.ring > 1 ? 's' : ''} from the fire make it a ${ringOf.name}`);
      const core = b.t === 'fire_brick' && w.mbCoreFor(x, y);
      if (core) s = `Part of a ${nameOf(core[2].t)} wall`;
      return s;
    }
    case 'workbench': return 'Stand nearby to craft advanced things';
    case 'crate': {
      const e = Object.entries(b.store || {}).filter(([, n]) => n > 0);
      const total = e.reduce((a, [, n]) => a + n, 0);
      return (e.length ? `Holding ${total}/400: ${e.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')}` : DIM('Empty')) + '<br>' + DIM('Machines beside it store their output here instead of the roots.') + '<br>' + DIM('RMB: take all · RMB with items: store them');
    }
  }
  const m = MULTIBLOCKS[b.t];
  if (m) {
    if (!b.ok) {
      const missing = w.mbTiles(x, y, b.t).filter(([tx, ty]) => (tx !== x || ty !== y) && w.getB(tx, ty)?.t !== m.wall).length;
      return AMBER(`Needs ${missing} more ${ITEMS[m.wall].name}${missing > 1 ? 's' : ''} around it (${m.size}x${m.size})`);
    }
    const lines = [];
    if (m.in) lines.push(`${ITEMS[m.in[0]].name}: ${b.in}/${m.in[1]} ${DIM(`(RMB with ${ITEMS[m.in[0]].name.toLowerCase()})`)}`);
    if (m.make) lines.push(b.on ? `Making ${ITEMS[m.make[1]].name}: ${pct(b.p)}` : m.heat && !b.net ? RED('Needs an ember root touching its walls') : DIM(`Waiting for ${m.make[0]} ${ITEMS[m.in[0]].name.toLowerCase()}`));
    if (m.grows) lines.push(b.g < 1 ? `Growing ${pct(b.g)}` : `Growing ${ITEMS[m.grows[0]].name}: ${pct(b.p)}`);
    if (m.light) lines.push(b.lit ? `Lighting ${m.light * 2 + 1}x${m.light * 2 + 1} for everyone` : RED('Needs an ember root touching its walls to burn'));
    if (m.heat && b.net) lines.push(b.net === 'e' ? TEAL('Heated by an eternal flame (free)') : AMBER(`Heated by the campfire (costs ${m.draw}/s)`));
    const feederType = FEEDER_OF[b.t];
    if (feederType) { const n = countFeeders(w, x, y, b); lines.push(n ? AMBER(`Fed by ${n} ${nameOf(feederType)}${n > 1 ? 's' : ''} beside it`) : DIM(`A ${nameOf(feederType)} placed beside it will feed it automatically`)); }
    const fed = feeding();
    if (fed) lines.push(fed);
    else if (m.make || m.grows) lines.push(netLabel(w.heatNet(w.mbTiles(x, y, b.t))) ?? DIM('Put an ember root beside it to send its output away'));
    if (m.fuse) lines.push(DIM('Hold LMB: break it (drops every block)'));
    return lines.join('<br>') + outStr(b);
  }
  const wallOf = w.mbCoreFor(x, y);
  if (wallOf && wallOf[2] !== b) return `Part of a ${nameOf(wallOf[2].t)} wall`;
  return '';
}

// ---------------- HUD ----------------
function fmtTime(s) { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

function renderInv() {
  const mk = (i, withKey) => {
    const s = st.inv[i];
    const d = document.createElement('div');
    d.className = 'slot' + (i === st.sel ? ' sel' : '') + (i === st.pick ? ' pick' : '') + (s && ITEMS[s.item].fuel ? ' fuel' : '');
    d.dataset.slot = i;
    if (s) d.innerHTML = `<img src="${iconURL[s.item]}">${s.n > 1 ? `<span class="n">${s.n}</span>` : ''}`;
    if (withKey) d.insertAdjacentHTML('beforeend', `<span class="k">${i + 1}</span>`);
    d.onmousedown = (e) => {
      e.stopPropagation();
      if (!$('inv-panel').hidden) {
        if (st.pick < 0) st.pick = i;
        else { if (st.pick !== i) send({ t: 'swap', a: st.pick, b: i }); st.pick = -1; }
      } else st.sel = i;
      renderInv();
    };
    return d;
  };
  const hb = $('hotbar'); hb.replaceChildren();
  for (let i = 0; i < HOTBAR; i++) hb.append(mk(i, true));
  const grid = $('inv-grid'); grid.replaceChildren();
  for (let i = 0; i < st.inv.length; i++) grid.append(mk(i, i < HOTBAR));
  if (!$('craft-panel').hidden) renderCraft();
}

function nearStation(type) {
  const tx = Math.floor(st.me.x), ty = Math.floor(st.me.y);
  for (let y = ty - 4; y <= ty + 4; y++) for (let x = tx - 4; x <= tx + 4; x++) if (st.world.getB(x, y)?.t === type) return true;
  return false;
}

function renderCraft() {
  if (!st.world) return;
  const list = $('craft-list'); list.replaceChildren();
  const bench = nearStation('workbench');
  for (const r of RECIPES) {
    if (r.requires && !st.known.has(r.requires)) continue;
    const ok = hasAll(st.inv, r.in) && (!r.station || bench);
    const row = document.createElement('div');
    row.className = 'recipe' + (r.station && !bench ? ' locked' : '');
    const ing = Object.entries(r.in).map(([i, n]) => { const have = countItem(st.inv, i); return `<span class="${have >= n ? 'ok' : 'miss'}">${n} ${ITEMS[i].name} (${have})</span>`; }).join(' · ');
    const it = ITEMS[r.out[0]];
    row.innerHTML = `<img src="${iconURL[r.out[0]]}"><div><div class="name">${it.name}${r.out[1] > 1 ? ' x' + r.out[1] : ''}</div><div class="ing">${ing}</div>${it.desc ? `<div class="ing">${it.desc}</div>` : ''}${r.station ? `<div class="station">${bench ? 'At Workbench' : 'Requires a nearby Workbench'}</div>` : ''}</div>`;
    const btn = document.createElement('button');
    btn.textContent = 'Craft';
    btn.disabled = !ok;
    btn.dataset.recipe = r.id;
    row.append(btn);
    list.append(row);
  }
  const unknown = Object.keys(BLUEPRINTS).filter((id) => !st.known.has(id)).length;
  if (unknown) list.insertAdjacentHTML('beforeend', `<p class="small dim">${unknown} design${unknown > 1 ? 's' : ''} still lost to the dark. Search ruins, dead campfires, mines and shrines for blueprints - the best lie farthest out.</p>`);
}

// Pixel-art scrollbar for a .scroll element inside a panel (native bars can't be styled in Firefox).
function pixelScroll(el) {
  const bar = document.createElement('div'); bar.className = 'pxbar';
  const thumb = document.createElement('div'); thumb.className = 'thumb';
  bar.append(thumb);
  el.parentElement.append(bar);
  const update = () => {
    const ratio = el.clientHeight / el.scrollHeight;
    bar.hidden = !el.clientHeight || ratio >= 1;
    if (bar.hidden) return;
    bar.style.top = el.offsetTop + 'px';
    bar.style.height = el.clientHeight + 'px';
    const track = el.clientHeight - 4;
    const th = Math.max(16, Math.round(track * ratio));
    // snap to 2px steps so it moves like pixel art
    const top = Math.round(((track - th) * el.scrollTop) / (el.scrollHeight - el.clientHeight) / 2) * 2;
    thumb.style.height = th + 'px';
    thumb.style.top = top + 'px';
  };
  el.addEventListener('scroll', update);
  new ResizeObserver(update).observe(el);
  new MutationObserver(update).observe(el, { childList: true, subtree: true });
  thumb.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    thumb.setPointerCapture(e.pointerId); thumb.classList.add('drag');
    const y0 = e.clientY, s0 = el.scrollTop, z = R.ui || 1;
    const move = (ev) => {
      const track = el.clientHeight - thumb.offsetHeight;
      el.scrollTop = s0 + ((ev.clientY - y0) / z) * ((el.scrollHeight - el.clientHeight) / track);
    };
    const up = () => { thumb.classList.remove('drag'); thumb.removeEventListener('pointermove', move); thumb.removeEventListener('pointerup', up); };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', up);
  });
  bar.addEventListener('pointerdown', (e) => {
    if (e.target !== bar) return;
    el.scrollTop += (e.offsetY < thumb.offsetTop ? -1 : 1) * el.clientHeight * 0.9;
  });
  return update;
}
const scrollUpdaters = [...document.querySelectorAll('.panel .scroll')].map(pixelScroll);

// Craft on pointerdown via delegation: the list re-renders often (every inventory change),
// so a click's mousedown and mouseup can land on different button elements and get lost.
$('craft-list').addEventListener('pointerdown', (e) => {
  const btn = e.target.closest('button[data-recipe]');
  if (!btn || btn.disabled || e.button !== 0) return;
  send({ t: 'craft', id: btn.dataset.recipe });
  audio.play('craft', { vol: 0.5 });
});

// ---------------- Esc menu ----------------
let giveupArmed = 0;
function renderMenu() {
  $('m-gfx').textContent = `Graphics: ${R.low ? 'Low (fast)' : 'Full'}`;
  $('m-sound').textContent = `Sound: ${audio.muted ? 'Off' : 'On'}`;
  const g = $('m-giveup');
  const armed = performance.now() - giveupArmed < 3000;
  g.textContent = st.me.dead ? 'You are already gone...' : armed ? 'Click again to confirm' : 'Give in to the dark';
  g.classList.toggle('confirm', armed);
  g.disabled = st.me.dead;
}
$('m-resume').onclick = () => toggle('menu-panel');
$('m-help').onclick = () => { toggle('menu-panel'); toggle('help-panel'); };
$('m-gfx').onclick = () => { R.setLow(!R.low); renderMenu(); };
$('m-sound').onclick = () => { audio.toggleMute(); renderMenu(); };
const nudgeUI = (f) => { uiNudge = Math.max(0.6, Math.min(2, uiNudge * f)); try { localStorage.setItem('campfire.ui', uiNudge); } catch {} applyUIScale(); };
$('m-ui-down').onclick = () => nudgeUI(0.9);
$('m-ui-up').onclick = () => nudgeUI(1.1);
$('m-giveup').onclick = () => {
  if (performance.now() - giveupArmed < 3000) { send({ t: 'giveup' }); giveupArmed = 0; toggle('menu-panel'); }
  else { giveupArmed = performance.now(); setTimeout(renderMenu, 3050); }
  renderMenu();
};
$('m-leave').onclick = () => { $('menu-panel').hidden = true; st.ws?.close(); };

const logEl = $('log');
function log(text, c = '#ddd') {
  const d = document.createElement('div');
  d.textContent = text;
  d.style.color = c;
  logEl.append(d);
  while (logEl.children.length > 7) logEl.firstChild.remove();
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 1000); }, 9000);
}

let craftRefresh = 0;
function updateHUD(dt) {
  const w = st.world, f = w.fire, me = st.me;
  const ratio = Math.max(0, Math.min(1, f.fuel / w.maxFuel()));
  const tier = Math.max(0, Math.min(FLAME_PALETTES.length - 1, Math.round(f.temp)));
  const pal = FLAME_PALETTES[tier];
  $('fire-tier').textContent = f.fuel > 0 ? `${FIRE_STAGES[w.stage()].name} · ${FIRE_TIERS[tier]}` : 'Out';
  $('fire-tier').style.color = pal[1];
  $('fire-time').textContent = fmtTime(w.time);
  const fill = $('fuel-fill');
  fill.style.width = ratio * 100 + '%';
  fill.style.background = `linear-gradient(${pal[0]}, ${pal[2]})`;
  fill.style.boxShadow = `0 0 12px ${pal[1]}`;
  const left = f.burn > 0 ? f.fuel / f.burn : 0;
  $('fuel-text').textContent = `${Math.ceil(f.fuel)} / ${w.maxFuel()}  ·  ~${fmtTime(left)} left`;
  $('fire-burn').textContent = `Burning ${f.burn.toFixed(2)}/s`;
  const needed = FUEL_NAMES[f.demand];
  const de = $('fire-demand');
  de.textContent = f.demand > 0 ? `Hungry for ${needed}+` : 'Anything burns';
  de.className = f.demand > 0 ? 'warn' : '';

  const W = st.weather;
  $('weather').textContent = { clear: '', rain_warn: `Rain coming... ${W.t}s`, rain: `Raining (${W.t}s)`, wind_warn: `Wind rising... ${W.t}s`, wind: `WINDFALL! (${W.t}s)` }[W.s] ?? '';

  // carried torch
  const outside = !me.dead && !w.sharedLit(Math.floor(me.x), Math.floor(me.y));
  const torches = countItem(st.inv, 'torch');
  const lit = me.held > 0 && torches > 0;
  const tb = $('torch-bar');
  tb.hidden = me.dead || (!torches && !outside);
  $('torch-fill').style.width = (lit ? me.held / TORCH.heldFuel : 0) * 100 + '%';
  const n = `${torches} torch${torches === 1 ? '' : 'es'}`;
  $('torch-label').textContent = !torches ? 'No torches' : !lit ? `${n} - unlit, reach a flame` : outside ? `Torch ${Math.ceil(me.held)}s · ${n}` : `${n} (put away)`;
  tb.classList.toggle('low', outside && me.held > 0 && me.held < 15);

  const cw = $('cold-warn');
  if (me.freezing && !me.dead) { cw.hidden = false; cw.textContent = `FREEZING! Get to light!\n${Math.max(0, COLD_GRACE - me.cold).toFixed(1)}s`; cw.style.whiteSpace = 'pre'; }
  else cw.hidden = true;

  $('dead-screen').hidden = !me.dead || st.over;
  const dead = [...st.players.values()].filter((p) => p.dead);
  const rp = $('revive-prompt');
  const nearFire = Math.hypot(me.x - 0.5, me.y - 0.5) <= 5;
  if (dead.length && !me.dead && nearFire) { rp.hidden = false; rp.textContent = `[${K('revive')}] Revive ${dead[0].name} (costs ${FIRE.reviveCost} fuel)`; }
  else if (dead.length && !me.dead) { rp.hidden = false; rp.textContent = `${dead.map((p) => p.name).join(', ')} ${dead.length > 1 ? 'are' : 'is'} waiting in the fire...`; }
  else rp.hidden = true;

  if ((craftRefresh += dt) > 0.5 && !$('craft-panel').hidden) { craftRefresh = 0; renderCraft(); }
}

// Placed torches burn down locally between server updates (which only arrive every few seconds),
// so the countdown is smooth and a torch goes dark on time even if its final update is late.
function burnTorchesLocally(dt) {
  const w = st.world;
  const mult = st.weather.s === 'rain' ? TORCH.rainMult : 1;
  for (const b of w.bld.values()) {
    if (b.t !== 'torch' || b.conn || b.fuel <= 0) continue;
    b.fuel = Math.max(0, b.fuel - dt * mult);
    if (b.fuel === 0) w.lightDirty = true;
  }
}

// ---------------- audio ----------------
function updateAudio(dt) {
  const w = st.world, me = st.me;
  audio.listener.x = me.x; audio.listener.y = me.y;
  const r = w.fire.fuel / w.maxFuel();
  const fireStage = w.fire.fuel <= 0 ? -1 : r < 0.08 ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.8 ? 3 : 4;
  let eternalDist = 99;
  for (let cy = chunkOf(me.y) - 1; cy <= chunkOf(me.y) + 1; cy++) for (let cx = chunkOf(me.x) - 1; cx <= chunkOf(me.x) + 1; cx++) {
    const site = w.gen.site(cx, cy);
    // eternal flames, shrines and glowmoss all hum softly
    if (site) for (const [lx, ly] of w.siteLights(site)) eternalDist = Math.min(eternalDist, Math.hypot(lx + 0.5 - me.x, ly + 0.5 - me.y));
  }
  let torchDist = 99;
  for (const [k, b] of w.bld) {
    if (b.t !== 'torch' || b.fuel <= 0) continue;
    const [x, y] = unkey(k);
    const d = Math.abs(x + 0.5 - me.x) + Math.abs(y + 0.5 - me.y);
    if (d < torchDist) torchDist = d;
  }
  const outside = !me.dead && !w.sharedLit(Math.floor(me.x), Math.floor(me.y));
  if (outside && me.held > 0) torchDist = 0.5;
  audio.update({ dt, fireStage, temp: w.fire.temp, weather: st.weather.s, freezing: me.freezing && !me.dead, cold: me.cold, eternalDist, torchDist });
}

// ---------------- loop ----------------
let last = performance.now(), sendAcc = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  if (st.world) {
    move(dt);
    const me = st.players.get(st.myId);
    for (const p of st.players.values()) {
      if (p.id === st.myId) { p.rx = st.me.x; p.ry = st.me.y; p.f = st.me.f; p.m = st.me.m; continue; }
      const k = Math.min(1, dt * 12);
      p.rx += (p.x - p.rx) * k; p.ry += (p.y - p.ry) * k;
    }
    for (const pk of st.packets) pk.p = Math.min(1, pk.p + dt * PACKET_SPEED);
    burnTorchesLocally(dt);
    if ((sendAcc += dt) >= 0.05) { sendAcc = 0; if (!st.me.dead) send({ t: 'pos', x: +st.me.x.toFixed(3), y: +st.me.y.toFixed(3), f: st.me.f, m: st.me.m }); }
    updateHover(dt);
    updateHUD(dt);
    updateAudio(dt);
    R.draw(st, dt, t);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
