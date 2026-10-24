import { World, unkey } from '../shared/world.js';
import { ITEMS, BUILDINGS, FEATURES, RECIPES } from '../shared/defs.js';
import { FIRE, TORCH, COLD_GRACE, REACH, PLAYER_SPEED, PLAYER_HALF, PACKET_SPEED, DEFAULT_PORT, HOTBAR, FIRE_TIERS } from '../shared/constants.js';
import { countItem, hasAll } from '../shared/inventory.js';
import { makeSprites, FLAME_PALETTES } from './sprites.js';
import { createRenderer } from './render.js';

const $ = (id) => document.getElementById(id);
const S = makeSprites();
const iconURL = {};
for (const [k, c] of Object.entries(S.icon)) iconURL[k] = c.toDataURL();

const R = createRenderer($('gl'), $('overlay'), S);
if (import.meta.env?.DEV) window.__campfire = { get st() { return st; }, R };
addEventListener('resize', () => R.resize());

const st = {
  ws: null, myId: 0, world: null, players: new Map(), inv: [], known: new Set(),
  weather: { s: 'clear', t: 0 }, packets: [], over: false, sel: 0,
  me: { x: 0.5, y: 2.5, f: 1, m: false, dead: false, held: 0, cold: 0, freezing: false },
  hover: null, harvest: null, uiBlocking: false, pick: -1,
};

// ---------------- networking ----------------
function send(o) { if (st.ws?.readyState === 1) st.ws.send(JSON.stringify(o)); }

function connect(url, name) {
  $('connect-err').textContent = 'Connecting...';
  const ws = new WebSocket(url);
  st.ws = ws;
  ws.onopen = () => send({ t: 'join', name });
  ws.onerror = () => { $('connect-err').textContent = `Couldn't reach ${url}. Is the server running?`; };
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
      if (!localStorage.getItem('campfire.helpSeen')) { $('help-panel').hidden = false; localStorage.setItem('campfire.helpSeen', '1'); }
      break;
    }
    case 'snap': {
      const w = st.world;
      if (!w) return;
      w.time = m.time;
      w.setFuel(m.fire.fuel);
      Object.assign(w.fire, m.fire);
      st.weather = m.weather;
      w.weatherWind = m.weather.s === 'wind';
      const seen = new Set();
      for (const p of m.players) {
        seen.add(p.id);
        let q = st.players.get(p.id);
        if (!q) { q = { ...p, rx: p.x, ry: p.y }; st.players.set(p.id, q); }
        Object.assign(q, p);
        if (p.id === st.myId) {
          const wasDead = st.me.dead;
          st.me.dead = p.dead; st.me.held = p.held; st.me.cold = p.cold;
          if (p.dead && !wasDead) st.harvest = null;
        }
      }
      for (const id of st.players.keys()) if (!seen.has(id)) st.players.delete(id);
      if (m.F) for (const [k, v] of m.F) w.feat.set(k, v);
      if (m.B) for (const [k, v] of m.B) { const [x, y] = unkey(k); w.setB(x, y, v); }
      if (m.D) for (const [k, v] of m.D) { if (v?.length) w.drops.set(k, v); else w.drops.delete(k); }
      st.packets = m.pk.map(([id, x, y, nx, ny, p, item]) => ({ id, x, y, nx, ny, p, item }));
      if (m.fx) for (const e of m.fx) R.fx(e, w);
      if (m.B && !$('craft-panel').hidden) renderCraft();
      break;
    }
    case 'inv': st.inv = m.inv; renderInv(); break;
    case 'known': st.known = new Set(m.known); renderCraft(); break;
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
const defaultServer = location.host ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` : `ws://localhost:${DEFAULT_PORT}`;
$('server').value = (location.protocol !== 'https:' && localStorage.getItem('campfire.server')) || defaultServer;
$('join').onclick = () => {
  const name = $('name').value.trim() || 'Wanderer';
  const url = $('server').value.trim();
  localStorage.setItem('campfire.name', name);
  localStorage.setItem('campfire.server', url);
  connect(url, name);
};
for (const id of ['name', 'server']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join').click(); });
$('restart').onclick = () => send({ t: 'restart' });

// ---------------- input ----------------
const keys = new Set();
let mouse = { x: 0, y: 0, l: false };
let lastG = 0;

addEventListener('keydown', (e) => {
  if (!st.world) return;
  const chat = $('chat');
  if (document.activeElement === chat) {
    if (e.key === 'Enter') { const t = chat.value.trim(); if (t) send({ t: 'chat', text: t }); chat.value = ''; chat.hidden = true; chat.blur(); }
    if (e.key === 'Escape') { chat.value = ''; chat.hidden = true; chat.blur(); }
    return;
  }
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'enter') { chat.hidden = false; chat.focus(); e.preventDefault(); return; }
  if (k >= '1' && k <= '8') { st.sel = Number(k) - 1; renderInv(); }
  if (k === 'tab' || k === 'i') { e.preventDefault(); toggle('inv-panel'); }
  if (k === 'c') toggle('craft-panel');
  if (k === 'h') toggle('help-panel');
  if (k === 'escape') for (const id of ['inv-panel', 'craft-panel', 'help-panel']) $(id).hidden = true;
  if (k === 'q') send({ t: 'drop', slot: st.sel });
  if (k === 'r') send({ t: 'revive' });
  if (k === 'p') { R.palette = !R.palette; log(`Palette mode ${R.palette ? 'on' : 'off'}.`, '#aaa'); }
  if (k === 'g') {
    const now = performance.now();
    if (now - lastG < 1500) { send({ t: 'giveup' }); lastG = 0; } else { lastG = now; log('Press G again to give in to the dark (drops your items).', '#aaa'); }
  }
  st.uiBlocking = !$('inv-panel').hidden || !$('craft-panel').hidden || !$('help-panel').hidden;
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => { keys.clear(); mouse.l = false; });

function toggle(id) {
  const el = $(id);
  el.hidden = !el.hidden;
  if (id === 'craft-panel' && !el.hidden) renderCraft();
  if (id === 'inv-panel') { st.pick = -1; renderInv(); }
  st.uiBlocking = !$('inv-panel').hidden || !$('craft-panel').hidden || !$('help-panel').hidden;
}

const gl = $('gl');
gl.addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
gl.addEventListener('mousedown', (e) => {
  if (!st.world || st.me.dead) return;
  if (e.button === 0) mouse.l = true;
  if (e.button === 2 && st.hover) send({ t: 'click', x: st.hover.x, y: st.hover.y, slot: st.sel, shift: e.shiftKey });
});
addEventListener('mouseup', (e) => { if (e.button === 0) { mouse.l = false; st.harvest = null; } });
gl.addEventListener('wheel', (e) => { st.sel = (st.sel + (e.deltaY > 0 ? 1 : HOTBAR - 1)) % HOTBAR; renderInv(); });

// ---------------- movement (client-predicted) ----------------
function walkable(w, tx, ty) {
  if (w.isSolid(tx, ty)) return 'solid';
  if (w.sharedLit(tx, ty)) return true;
  const mx = Math.floor(st.me.x), my = Math.floor(st.me.y);
  if (st.me.held > 0 && Math.max(Math.abs(tx - mx), Math.abs(ty - my)) <= TORCH.heldRadius) return true;
  if (st.me.freezing) return true; // stumbling blindly toward safety
  return 'dark';
}
function canOccupy(w, x, y) {
  for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const r = walkable(w, Math.floor(x + ox * PLAYER_HALF), Math.floor(y + oy * PLAYER_HALF));
    if (r !== true) return r;
  }
  return true;
}
let lastDarkMsg = 0;
function move(dt) {
  const w = st.world, me = st.me;
  me.freezing = !me.dead && !w.sharedLit(Math.floor(me.x), Math.floor(me.y)) && me.held <= 0;
  if (me.dead || st.over || document.activeElement === $('chat')) { me.m = false; return; }
  let dx = 0, dy = 0;
  if (keys.has('a') || keys.has('arrowleft')) dx--;
  if (keys.has('d') || keys.has('arrowright')) dx++;
  if (keys.has('w') || keys.has('arrowup')) dy--;
  if (keys.has('s') || keys.has('arrowdown')) dy++;
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
  if (blockedDark && performance.now() - lastDarkMsg > 2500) {
    lastDarkMsg = performance.now();
    R.float(countItem(st.inv, 'torch') ? 'Too dark...' : 'Too dark - you need a torch', me.x, me.y - 1, '#bcd4ff');
  }
}

// ---------------- harvest / hover ----------------
function harvestTime(w, x, y) {
  const b = w.getB(x, y);
  if (b) return 0.6;
  const f = w.getFeature(x, y);
  if (!f) return 0;
  const d = FEATURES[f.t];
  if (d.loose) return 0.25;
  if (f.t === 'tree' && countItem(st.inv, 'axe')) return 1.1;
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

function updateTooltip(x, y, inReach) {
  const w = st.world, tip = $('tooltip');
  if (st.uiBlocking) { tip.hidden = true; return; }
  let html = '';
  const lit = w.sharedLit(x, y);
  if (x === 0 && y === 0) {
    html = `<b>The Campfire</b><br>RMB with fuel: feed it (Shift: whole stack)`;
  } else {
    const b = w.getB(x, y);
    const f = w.getFeature(x, y);
    const d = w.drops.get(`${x},${y}`);
    if (b) html = `<b>${BUILDINGS[b.t].name}</b><br>${buildingInfo(w, b, x, y)}<br><span class="dim">Hold LMB: pick up</span>`;
    else if (f) html = `<b>${FEATURES[f.t].name}</b>${featureHint(f)}`;
    else if (d?.length) html = `<b>Dropped items</b><br>${d.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')}<br><span class="dim">Walk over to pick up</span>`;
    if (!lit && !html) html = '';
  }
  if (!html) { tip.hidden = true; return; }
  if (!inReach) html += '<br><span class="dim">(out of reach)</span>';
  tip.innerHTML = html;
  tip.hidden = false;
  tip.style.left = Math.min(innerWidth - 310, mouse.x + 18) + 'px';
  tip.style.top = mouse.y + 18 + 'px';
}

function featureHint(f) {
  const axe = countItem(st.inv, 'axe') > 0;
  switch (f.t) {
    case 'tree': return axe ? '<br>Hold LMB: chop for logs' : '<br>Hold LMB: shake for sticks<br><span class="dim">An axe would get logs.</span>';
    case 'bare_tree': return axe ? '<br>Hold LMB: chop for logs' : '<br><span class="dim">Needs an axe.</span>';
    case 'stump': return '<br>Hold LMB: pry up a stick';
    case 'bush': return '<br>Hold LMB: gather leaves';
    case 'picked_bush': return '<br><span class="dim">Regrowing...</span>';
    case 'rock': return '<br>Hold LMB: gather stone';
    case 'rubble': return '<br>Hold LMB: gather stone';
    case 'chest': return '<br>RMB: open';
    case 'eternal': return '<br>It never goes out. Torches relight here.';
    case 'brazier': return '<br><span class="dim">Cold and dead.</span>';
    default: return FEATURES[f.t].loose ? '<br>Walk over or hold LMB to pick up' : '';
  }
}

function pct(v) { return Math.round(v * 100) + '%'; }
function outStr(b) {
  const e = Object.entries(b.out || {}).filter(([, n]) => n > 0);
  return e.length ? `<br>Holding: ${e.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')} <span class="dim">(RMB: take)</span>` : '';
}
function buildingInfo(w, b, x, y) {
  const conn = w.connected(x, y);
  const link = conn ? '<span style="color:#ffb070">Connected to the fire</span>' : '<span class="dim">Not on a root: output stays here</span>';
  switch (b.t) {
    case 'torch': return b.fuel > 0 ? (b.conn ? 'Fed by the roots - burns forever' : `Fuel: ${Math.ceil(b.fuel)}s <span class="dim">(RMB with fuel to top up)</span>`) : 'Burnt out. RMB with fuel to relight.';
    case 'root': return b.g < 1 ? `Growing... ${pct(b.g)}` : w.rootPowered(x, y) ? 'Glowing with the fire\'s heat' : '<span style="color:#e0705a">Dark - the fire is too weak to reach this far</span>';
    case 'kindling': return (b.g < 1 ? `Growing ${pct(b.g)} (needs light)` : 'Sheds leaves') + '<br>' + link + outStr(b);
    case 'sapling': return (b.g < 1 ? `Growing ${pct(b.g)} (needs light)` : 'Sheds sticks and the odd log') + '<br>' + link + outStr(b);
    case 'sprouter': return `Rainwater: ${Math.round(b.water)}%<br>${link}${outStr(b)}`;
    case 'rot_pit': return `Leaves: ${b.in}/20 <span class="dim">(RMB with leaves)</span><br>Rotting: ${pct(b.p)}<br>${link}${outStr(b)}`;
    case 'kiln': {
      if (!b.ok) { let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && w.getB(x + dx, y + dy)?.t !== 'brick') n++; return `<span style="color:#9fd8ff">Needs ${n} more Stone Brick${n > 1 ? 's' : ''} around it</span>`; }
      return `Logs: ${b.in}/10 <span class="dim">(RMB with logs)</span><br>${b.conn ? `Baking: ${pct(b.p)}` : '<span style="color:#e0705a">Needs an ember root touching its walls</span>'}${outStr(b)}`;
    }
    case 'hearth': return Math.max(Math.abs(x), Math.abs(y)) <= 1 ? 'Holding heat in: the fire burns slower' : '<span class="dim">Must touch the campfire</span>';
    case 'workbench': return 'Stand nearby to craft advanced things';
    case 'brick': return 'Part of a kiln wall';
  }
  return '';
}

// ---------------- HUD ----------------
function fmtTime(s) { const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

function renderInv() {
  const mk = (i, withKey) => {
    const s = st.inv[i];
    const d = document.createElement('div');
    d.className = 'slot' + (i === st.sel ? ' sel' : '') + (i === st.pick ? ' pick' : '') + (s && ITEMS[s.item].fuel ? ' fuel' : '');
    if (s) {
      d.innerHTML = `<img src="${iconURL[s.item]}">${s.n > 1 ? `<span class="n">${s.n}</span>` : ''}`;
      d.title = ITEMS[s.item].name + (ITEMS[s.item].desc ? ' - ' + ITEMS[s.item].desc : '') + (ITEMS[s.item].fuel ? ` (fuel ${ITEMS[s.item].fuel.value}, heat ${ITEMS[s.item].fuel.heat})` : '');
    }
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
    btn.onclick = () => send({ t: 'craft', id: r.id });
    row.append(btn);
    list.append(row);
  }
  if (!st.known.has('kiln')) list.insertAdjacentHTML('beforeend', '<p class="small dim">Some designs were lost to the dark. Search ruins for blueprints.</p>');
}

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
  const ratio = Math.max(0, Math.min(1, f.fuel / FIRE.maxFuel));
  const tier = Math.max(0, Math.min(4, Math.round(f.temp)));
  const pal = FLAME_PALETTES[tier];
  $('fire-tier').textContent = f.fuel > 0 ? FIRE_TIERS[tier] : 'Out';
  $('fire-tier').style.color = pal[1];
  $('fire-time').textContent = fmtTime(w.time);
  const fill = $('fuel-fill');
  fill.style.width = ratio * 100 + '%';
  fill.style.background = `linear-gradient(${pal[0]}, ${pal[2]})`;
  fill.style.boxShadow = `0 0 12px ${pal[1]}`;
  const left = f.burn > 0 ? f.fuel / f.burn : 0;
  $('fuel-text').textContent = `${Math.ceil(f.fuel)} / ${FIRE.maxFuel}  ·  ~${fmtTime(left)} left`;
  $('fire-burn').textContent = `Burning ${f.burn.toFixed(2)}/s`;
  const needed = ['Leaves', 'Sticks', 'Logs', 'Peat', 'Charcoal'][f.demand];
  const de = $('fire-demand');
  de.textContent = f.demand > 0 ? `Hungry for ${needed}+` : 'Anything burns';
  de.className = f.demand > 0 ? 'warn' : '';

  const W = st.weather;
  $('weather').textContent = { clear: '', rain_warn: `Rain coming... ${W.t}s`, rain: `Raining (${W.t}s)`, wind_warn: `Wind rising... ${W.t}s`, wind: `WINDFALL! (${W.t}s)` }[W.s] ?? '';

  // carried torch
  const outside = !me.dead && !w.sharedLit(Math.floor(me.x), Math.floor(me.y));
  const spare = countItem(st.inv, 'torch');
  const tb = $('torch-bar');
  tb.hidden = me.dead || (me.held <= 0 && !outside && !spare);
  $('torch-fill').style.width = (me.held / TORCH.heldFuel) * 100 + '%';
  $('torch-label').textContent = me.held > 0 ? (outside ? `Torch ${Math.ceil(me.held)}s` : `Torch (stowed) · ${spare} spare`) : spare ? `${spare} torch${spare > 1 ? 'es' : ''} (lights at a flame)` : 'No torch';
  tb.classList.toggle('low', outside && me.held > 0 && me.held < 15);

  const cw = $('cold-warn');
  if (me.freezing && !me.dead) { cw.hidden = false; cw.textContent = `FREEZING! Get to light!\n${Math.max(0, COLD_GRACE - me.cold).toFixed(1)}s`; cw.style.whiteSpace = 'pre'; }
  else cw.hidden = true;

  $('dead-screen').hidden = !me.dead || st.over;
  const dead = [...st.players.values()].filter((p) => p.dead);
  const rp = $('revive-prompt');
  const nearFire = Math.hypot(me.x - 0.5, me.y - 0.5) <= 5;
  if (dead.length && !me.dead && nearFire) { rp.hidden = false; rp.textContent = `[R] Revive ${dead[0].name} (costs ${FIRE.reviveCost} fuel)`; }
  else if (dead.length && !me.dead) { rp.hidden = false; rp.textContent = `${dead.map((p) => p.name).join(', ')} ${dead.length > 1 ? 'are' : 'is'} waiting in the fire...`; }
  else rp.hidden = true;

  if ((craftRefresh += dt) > 0.5 && !$('craft-panel').hidden) { craftRefresh = 0; renderCraft(); }
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
    if ((sendAcc += dt) >= 0.05) { sendAcc = 0; if (!st.me.dead) send({ t: 'pos', x: +st.me.x.toFixed(3), y: +st.me.y.toFixed(3), f: st.me.f, m: st.me.m }); }
    updateHover(dt);
    updateHUD(dt);
    R.draw(st, dt, t);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
