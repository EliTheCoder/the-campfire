import { World, unkey } from '../shared/world.js';
import { ITEMS, BUILDINGS, FEATURES, RECIPES, MULTIBLOCKS, FIRE_STAGES, FEEDS, FUEL_NAMES, BLUEPRINTS } from '../shared/defs.js';
import { FIRE, TORCH, COLD_GRACE, REACH, PLAYER_SPEED, PLAYER_HALF, PACKET_SPEED, DEFAULT_PORT, HOTBAR, FIRE_TIERS } from '../shared/constants.js';
import { countItem, hasAll } from '../shared/inventory.js';
import { makeSprites, FLAME_PALETTES } from './sprites.js';
import { createRenderer } from './render.js';
import { createAudio } from './audio.js';
import { buildWiki, WIKI_CATS, wikiIdFor } from './wiki.js';
import { chunkOf } from '../shared/worldgen.js';

const $ = (id) => document.getElementById(id);
const S = makeSprites();
const iconURL = {};
for (const [k, c] of Object.entries(S.icon)) iconURL[k] = c.toDataURL();

const R = createRenderer($('gl'), $('overlay'), S);
if (import.meta.env?.DEV) window.__campfire = { get st() { return st; }, R, get audio() { return audio; } };
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
      if (!localStorage.getItem('campfire.helpSeen')) { openWiki('guide:start'); localStorage.setItem('campfire.helpSeen', '1'); }
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
      if (m.B && invOpen()) renderCraft();
      if ((m.B || m.F) && contOpen()) renderInv();
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
const DEFAULT_BINDS = {
  up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD',
  inventory: 'KeyI', craft: 'KeyC', help: 'KeyH', drop: 'KeyQ', revive: 'KeyR', chat: 'Enter',
  graphics: 'F2', fullscreen: 'KeyF', palette: 'KeyP', mute: 'KeyM', uiDown: 'Minus', uiUp: 'Equal',
};
const BIND_NAMES = {
  up: 'Move up', left: 'Move left', down: 'Move down', right: 'Move right', inventory: 'Inventory', craft: 'Crafting',
  help: 'Wiki', drop: 'Drop item (Shift: stack)', revive: 'Revive a friend', chat: 'Chat', graphics: 'Toggle low graphics', fullscreen: 'Fullscreen',
  palette: 'Palette mode', mute: 'Mute', uiDown: 'UI smaller', uiUp: 'UI larger',
};
const BINDS = { ...DEFAULT_BINDS };
try { Object.assign(BINDS, JSON.parse(localStorage.getItem('campfire.binds') || '{}')); } catch {}
const saveBinds = () => { try { localStorage.setItem('campfire.binds', JSON.stringify(BINDS)); } catch {} };
let layoutMap = null;
const CODE_LABELS = { Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Backquote: '`', Space: 'Space', NumpadEnter: 'Num Enter' };
function keyLabel(code) {
  const l = layoutMap?.get(code);
  if (l) return l.length === 1 ? l.toUpperCase() : l;
  return CODE_LABELS[code] ?? code.replace(/^Key|^Digit/, '').replace(/^Arrow/, '').replace(/(Left|Right)$/, ' $1').trim();
}
const K = (action) => keyLabel(BINDS[action]);
function refreshKeyLabels() {
  for (const el of document.querySelectorAll('[data-key]')) el.textContent = el.dataset.key.split(',').map((c) => keyLabel(BINDS[c] || c)).join(el.dataset.sep ?? '');
}
navigator.keyboard?.getLayoutMap?.().then((m) => { layoutMap = m; refreshKeyLabels(); renderBinds(); }).catch(() => {});
refreshKeyLabels();

const PANELS = ['inv-panel', 'cont-panel', 'wiki-panel', 'menu-panel', 'settings-panel', 'controls-panel', 'credits-panel'];
const keys = new Set();
let mouse = { x: 0, y: 0, l: false };

// Rebinding: the next key press goes to the action being rebound (captured before anything else).
let rebinding = null;
addEventListener('keydown', (e) => {
  if (!rebinding) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.code !== 'Escape') {
    const other = Object.keys(BINDS).find((a) => a !== rebinding && BINDS[a] === e.code);
    if (other) BINDS[other] = BINDS[rebinding]; // taken: swap
    BINDS[rebinding] = e.code;
    saveBinds();
    refreshKeyLabels();
  }
  rebinding = null;
  renderBinds();
}, true);

addEventListener('keydown', (e) => {
  if (!st.world) {
    // main menu: Esc backs out of panels; ' and / mustn't open Firefox's Quick Find
    if (document.activeElement?.tagName !== 'INPUT' && ['Quote', 'Slash'].includes(e.code)) e.preventDefault();
    if (e.code === 'Escape') closePanel(PANELS.find((id) => !$(id).hidden));
    if (e.code === BINDS.fullscreen && document.activeElement?.tagName !== 'INPUT') toggleFullscreen();
    return;
  }
  const chat = $('chat');
  const typing = document.activeElement?.tagName === 'INPUT' && document.activeElement !== chat;
  if (typing) { if (e.code === 'Escape') document.activeElement.blur(); return; }
  if (document.activeElement === chat) {
    if (e.key === 'Enter') { const t = chat.value.trim(); if (t) send({ t: 'chat', text: t }); chat.value = ''; chat.hidden = true; chat.blur(); }
    if (e.key === 'Escape') { chat.value = ''; chat.hidden = true; chat.blur(); }
    return;
  }
  const c = e.code;
  keys.add(c);
  if (Object.values(BINDS).includes(c) || /^Digit[1-8]$/.test(c) || ['Tab', 'Escape', 'Quote', 'Slash', 'Space'].includes(c)) e.preventDefault();
  if (c === BINDS.chat || (BINDS.chat === 'Enter' && c === 'NumpadEnter')) { chat.hidden = false; chat.focus(); e.preventDefault(); return; }
  const digit = /^Digit([1-8])$/.exec(c);
  if (digit) {
    const k = Number(digit[1]) - 1;
    const ref = screenOpen() ? refAt(document.elementFromPoint(mouse.x, mouse.y)) : null;
    if (ref?.src === 'cont') { send({ t: 'ctake', x: st.cont.x, y: st.cont.y, ci: ref.i, n: stackAt(ref)?.n ?? 1, slot: k }); cursor = null; }
    else if (ref && ref.i !== k) { send({ t: 'swap', a: ref.i, b: k }); cursor = null; }
    else st.sel = k;
    renderInv(); audio.play('tick', { vol: 0.4 });
  }
  if (c === BINDS.mute) log(audio.toggleMute() ? `Sound muted. [${K('mute')}] to unmute.` : 'Sound on.', '#aaa');
  if (c === BINDS.uiDown || c === BINDS.uiUp) { uiNudge = Math.max(0.6, Math.min(2, uiNudge * (c === BINDS.uiDown ? 0.9 : 1.1))); try { localStorage.setItem('campfire.ui', uiNudge); } catch {} applyUIScale(); }
  if ((c === 'Tab' || c === BINDS.inventory) && contOpen()) closeContainer();
  else if (c === 'Tab' || c === BINDS.inventory) toggle('inv-panel');
  if (c === BINDS.craft) toggle('inv-panel');
  if (c === BINDS.help) toggleWiki();
  if (c === 'Escape' && contOpen()) { closeContainer(); audio.play('close', { vol: 0.45 }); }
  else if (c === 'Escape') {
    const open = PANELS.filter((id) => !$(id).hidden);
    const sub = open.find((id) => $(id).dataset.back);
    if (sub) closePanel(sub);
    else if (open.length && !(open.length === 1 && open[0] === 'menu-panel')) { for (const id of PANELS) $(id).hidden = true; cursor = null; drag = null; audio.play('close', { vol: 0.45 }); }
    else toggle('menu-panel');
  }
  if (c === BINDS.drop) send({ t: 'drop', slot: st.sel, all: e.shiftKey, x: st.hover?.x, y: st.hover?.y });
  if (c === BINDS.revive) send({ t: 'revive' });
  if (c === BINDS.graphics) { e.preventDefault(); R.setLow(!R.low); log(`Graphics: ${R.low ? 'low (2D, fastest)' : 'full (WebGL effects)'}. [${K('graphics')}] to switch.`, '#aaa'); }
  if (c === BINDS.fullscreen) toggleFullscreen();
  if (c === BINDS.palette) { R.palette = !R.palette; log(`Palette mode ${R.palette ? 'on' : 'off'}.`, '#aaa'); }
  st.uiBlocking = PANELS.some((id) => !$(id).hidden);
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); mouse.l = false; });

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  // Chromium can keep Esc for the game while fullscreen (hold Esc to leave); Firefox can't.
  else document.documentElement.requestFullscreen?.().then(() => navigator.keyboard?.lock?.(['Escape'])).catch(() => {});
}

function toggle(id) {
  const el = $(id);
  el.hidden = !el.hidden;
  audio.play(el.hidden ? 'close' : 'open', { vol: 0.45 });
  if (id === 'inv-panel') { cursor = null; drag = null; }
  if (id === 'menu-panel' && !el.hidden) renderMenu();
  for (const u of scrollUpdaters) u();
  if (id === 'inv-panel') renderInv();
  st.uiBlocking = PANELS.some((id) => !$(id).hidden);
}

// Game input lives on whichever canvas is showing (WebGL, or the low-graphics 2D one).
for (const cv of [$('gl'), $('lo')]) {
  cv.addEventListener('contextmenu', (e) => e.preventDefault());
  cv.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll / paste on middle click
    if (!st.world || st.me.dead) return;
    if (e.button === 1) { pickBlock(); return; }
    // Holding ember roots: press and drag (either button) to lay a line of them.
    if ((e.button === 0 || e.button === 2) && st.inv[st.sel]?.item === 'ember_root' && st.hover) {
      st.rootDrag = { x: st.hover.x, y: st.hover.y };
      send({ t: 'click', x: st.hover.x, y: st.hover.y, slot: st.sel, shift: false });
      return;
    }
    if (e.button === 0) mouse.l = true;
    if (e.button === 2 && st.hover) {
      const held = st.inv[st.sel] && ITEMS[st.inv[st.sel].item];
      const b = st.world.getB(st.hover.x, st.hover.y);
      // right-click opens anything that holds items (a torch with fuel in hand still refuels)
      if (!(b?.t === 'torch') && !(held?.use === 'flare') && !held?.learn && openContainerAt(st.hover.x, st.hover.y)) return;
      send({ t: 'click', x: st.hover.x, y: st.hover.y, slot: st.sel, shift: e.shiftKey || e.ctrlKey });
    }
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
addEventListener('mouseup', (e) => { st.rootDrag = null; if (e.button === 0) { mouse.l = false; st.harvest = null; } });

// ---------------- movement (client-predicted) ----------------
// The dark isn't a wall: you can walk into it, but without a lit torch the cold starts killing you.
function walkable(w, tx, ty) {
  return w.isSolid(tx, ty) ? 'solid' : true;
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
let stepAcc = 0, lastDir = '';
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
  if (!me.m) { lastDir = ''; return; }
  const len = Math.hypot(dx, dy);
  const sp = PLAYER_SPEED * (me.freezing ? 0.75 : 1) * dt;
  if (dx) me.f = dx;
  // When the direction changes, snap to the pixel grid. Moving diagonally, both axes then cross
  // pixel boundaries on the same frame, so the view steps diagonally instead of in a staircase.
  const dir = dx + ',' + dy;
  if (dir !== lastDir) { me.x = Math.round(me.x * 16) / 16; me.y = Math.round(me.y * 16) / 16; lastDir = dir; }
  const nx = me.x + (dx / len) * sp;
  if (canOccupy(w, nx, me.y) === true) me.x = nx;
  const ny = me.y + (dy / len) * sp;
  if (canOccupy(w, me.x, ny) === true) me.y = ny;
  stepAcc += sp;
  if (stepAcc > 0.85) {
    stepAcc = 0;
    audio.play(w.ground(Math.floor(me.x), Math.floor(me.y)) === 'floor' ? 'step_stone' : 'step_grass', { vol: me.freezing ? 0.25 : 0.35, rate: me.freezing ? 0.8 : 1 });
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
  // Root dragging: fill every tile between the last one and the cursor, 4-connected so the
  // line is continuous (roots only join up/down/left/right).
  const drag = st.rootDrag;
  if (drag && (drag.x !== tx || drag.y !== ty)) {
    if (st.inv[st.sel]?.item !== 'ember_root') st.rootDrag = null;
    else {
      let { x, y } = drag;
      while (x !== tx || y !== ty) {
        if (Math.abs(tx - x) >= Math.abs(ty - y)) x += Math.sign(tx - x); else y += Math.sign(ty - y);
        send({ t: 'click', x, y, slot: st.sel, shift: false });
      }
      st.rootDrag = { x: tx, y: ty };
    }
  }
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
  html += `<br><span class="dim">[${K('help')}] wiki</span>`;
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
  if (cursor) { tip.hidden = true; return; }
  if (slotEl) {
    const s = slotEl.dataset.c != null ? openContainer()?.slots[Number(slotEl.dataset.c)]?.s : st.inv[Number(slotEl.dataset.slot)];
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
      return '<br>It never goes out.' + (store.length ? '<br>' + TEAL(`Cache: ${store.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')}`) + '<br>RMB: open the cache' : '<br>' + DIM('Ember roots touching it grow teal. Buildings on teal roots send their output here.'));
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
  return e.length ? `<br>Holding: ${e.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')} ${DIM('(RMB: open)')}` : '';
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
      return `Leaves: ${b.in}/20 ${DIM('(RMB: open)')}<br>Rotting: ${pct(b.p)}<br>${feeders}<br>${feeding() ?? link}${outStr(b)}`;
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
      return (e.length ? `Holding ${total}/400: ${e.map(([i, n]) => `${n} ${ITEMS[i].name}`).join(', ')}` : DIM('Empty')) + '<br>' + DIM('Buildings beside it store their output here instead of the roots.') + '<br>' + DIM('RMB: open');
    }
  }
  const m = MULTIBLOCKS[b.t];
  if (m) {
    if (!b.ok) {
      const missing = w.mbTiles(x, y, b.t).filter(([tx, ty]) => (tx !== x || ty !== y) && w.getB(tx, ty)?.t !== m.wall).length;
      return AMBER(`Needs ${missing} more ${ITEMS[m.wall].name}${missing > 1 ? 's' : ''} around it (${m.size}x${m.size})`);
    }
    const lines = [];
    if (m.in) lines.push(`${ITEMS[m.in[0]].name}: ${b.in}/${m.in[1]} ${DIM('(RMB: open)')}`);
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

// ---------------- inventory & containers (Minecraft-style) ----------------
// Two "slot screens": the inventory, and an open container (crate, building, eternal cache)
// shown above your inventory. A stack can ride on the cursor: `cursor` is
// { src: 'inv' | 'cont', i, n, item } - n items still sitting in that slot on the server until
// they're put down. Press-drag-release onto another slot is drag-and-drop; press-release on the
// same slot leaves the stack on the cursor.
let cursor = null, drag = null;
st.cont = null; // { x, y } of the open container
const invOpen = () => !$('inv-panel').hidden;
const contOpen = () => !$('cont-panel').hidden;
const screenOpen = () => invOpen() || contOpen();
const openContainer = () => (st.cont && st.world ? st.world.containerAt(st.cont.x, st.cont.y) : null);

function stackHTML(item, n, faded) {
  return `<img src="${iconURL[item]}"${faded ? ' style="opacity:0.3"' : ''}>${n > 1 ? `<span class="n">${n}</span>` : ''}`;
}
function slotEl(i, big) {
  const s = st.inv[i];
  const d = document.createElement('div');
  d.className = 'slot' + (i === st.sel && big ? ' sel' : '');
  d.dataset.slot = i;
  const lifted = cursor && cursor.src === 'inv' && cursor.i === i ? cursor.n : 0;
  if (s) d.innerHTML = s.n - lifted > 0 ? stackHTML(s.item, s.n - lifted) : stackHTML(s.item, 0, true);
  if (i < HOTBAR) d.insertAdjacentHTML('beforeend', `<span class="k">${i + 1}</span>`);
  return d;
}
function contSlotEl(c, ci) {
  const slot = c.slots[ci];
  const d = document.createElement('div');
  d.className = 'slot cslot ' + slot.role;
  d.dataset.c = ci;
  const lifted = cursor && cursor.src === 'cont' && cursor.i === ci ? cursor.n : 0;
  if (slot.s) d.innerHTML = slot.s.n - lifted > 0 ? stackHTML(slot.s.item, slot.s.n - lifted) : stackHTML(slot.s.item, 0, true);
  else if (slot.role === 'in') d.innerHTML = stackHTML(slot.item, 0, true); // shows what it takes
  if (slot.role !== 'store') d.insertAdjacentHTML('beforeend', `<span class="k">${slot.role}</span>`);
  return d;
}
// The stack a ref points at, or null.
function stackAt(ref) {
  if (ref.src === 'inv') return st.inv[ref.i] || null;
  return openContainer()?.slots[ref.i]?.s || null;
}
function renderInv() {
  // drop a cursor stack the server no longer backs (e.g. the slot changed under us)
  if (cursor) { const s = stackAt(cursor); if (!s || s.item !== cursor.item) cursor = null; else cursor.n = Math.min(cursor.n, s.n); }
  const fill = (id, from, to, big) => { const el = $(id); el.replaceChildren(); for (let i = from; i < to; i++) el.append(slotEl(i, big)); };
  fill('hotbar', 0, HOTBAR, true);
  if (invOpen()) { fill('inv-grid', HOTBAR, st.inv.length); fill('inv-hotbar', 0, HOTBAR, true); renderCraft(); }
  if (contOpen()) {
    fill('cont-inv', HOTBAR, st.inv.length); fill('cont-hotbar', 0, HOTBAR, true);
    renderCont();
  }
  const cs = $('cursor-stack');
  cs.hidden = !cursor;
  if (cursor) {
    cs.querySelector('img').src = iconURL[cursor.item];
    cs.querySelector('.n').textContent = cursor.n > 1 ? cursor.n : '';
    placeCursor();
  }
}
function renderCont() {
  const c = openContainer();
  if (!c) { closeContainer(); return; }
  $('cont-title').textContent = c.title;
  let info = '';
  if (c.kind === 'crate') info = `${c.slots.filter((d) => d.s).length}/${c.slots.length} slots used. Buildings beside it store their output here.`;
  else if (c.kind === 'eternal') info = 'Buildings on its teal roots send their output here. Take what you need.';
  else {
    const b = c.b, m = MULTIBLOCKS[b.t];
    const making = m?.make?.[1] ?? (b.t === 'rot_pit' ? 'peat' : m?.grows?.[0]);
    info = b.on || (b.t === 'rot_pit' && b.in >= 4) ? `Making ${ITEMS[making]?.name ?? '...'}: ${Math.round((b.p || 0) * 100)}%`
      : c.slots[0]?.role === 'in' ? `Put ${ITEMS[c.slots[0].item].name} in to start.` : 'Its output collects here until something takes it.';
  }
  $('cont-info').textContent = info;
  const grid = $('cont-grid');
  grid.replaceChildren();
  grid.style.gridTemplateColumns = `repeat(${Math.min(8, Math.max(c.slots.length, 1))}, 48px)`;
  if (!c.slots.length) grid.innerHTML = '<span class="small dim">Empty.</span>';
  for (let ci = 0; ci < c.slots.length; ci++) grid.append(contSlotEl(c, ci));
}
function openContainerAt(x, y) {
  const c = st.world.containerAt(x, y);
  if (!c) return false;
  if (Math.hypot(c.x + 0.5 - st.me.x, c.y + 0.5 - st.me.y) > REACH + 1.5) { R.float('Too far away', c.x + 0.5, c.y, '#bcd4ff'); return true; }
  for (const id of PANELS) $(id).hidden = true;
  st.cont = { x: c.x, y: c.y };
  cursor = null;
  $('cont-panel').hidden = false;
  audio.play('open', { vol: 0.45 });
  st.uiBlocking = true;
  renderInv();
  return true;
}
function closeContainer() {
  $('cont-panel').hidden = true;
  st.cont = null;
  cursor = null;
  st.uiBlocking = PANELS.some((id) => !$(id).hidden);
}
function placeCursor() {
  const z = R.ui || 1;
  $('cursor-stack').style.left = (mouse.x - 22 * z) / z + 'px';
  $('cursor-stack').style.top = (mouse.y - 22 * z) / z + 'px';
}
// Which slot (inventory or container) an element is, if any.
function refAt(target) {
  const el = target?.closest?.('#inv-panel .slot, #cont-panel .slot');
  if (!el) return null;
  return el.dataset.c != null ? { src: 'cont', i: Number(el.dataset.c) } : { src: 'inv', i: Number(el.dataset.slot) };
}
const slotUnder = (target) => { const r = refAt(target); return r?.src === 'inv' ? r.i : -1; };
// Put n of the cursor stack into the slot `to`.
function putDown(to, n) {
  const from = cursor;
  if (to.src === from.src && to.i === from.i) { if (n >= from.n) cursor = null; return; }
  const c = st.cont;
  if (from.src === 'inv' && to.src === 'inv') send({ t: 'move', a: from.i, b: to.i, n });
  else if (from.src === 'inv') send({ t: 'cput', x: c.x, y: c.y, slot: from.i, n, ci: to.i });
  else if (to.src === 'inv') send({ t: 'ctake', x: c.x, y: c.y, ci: from.i, n, slot: to.i });
  else send({ t: 'cmove', x: c.x, y: c.y, a: from.i, b: to.i, n });
  audio.play('tick', { vol: 0.35, rate: 1.3 });
  if (n >= from.n) cursor = null; else from.n -= n;
}
// Shift-click: send a stack across (inventory <-> container), or hotbar <-> bag.
function quickMove(ref) {
  const s = stackAt(ref);
  if (!s) return;
  const c = st.cont;
  if (ref.src === 'cont') send({ t: 'ctake', x: c.x, y: c.y, ci: ref.i, n: s.n });
  else if (contOpen()) send({ t: 'cput', x: c.x, y: c.y, slot: ref.i, n: s.n });
  else send({ t: 'quick', a: ref.i });
  audio.play('tick', { vol: 0.35 });
}
function throwCursor() {
  if (cursor.src === 'inv') send({ t: 'drop', slot: cursor.i, n: cursor.n, x: st.hover?.x, y: st.hover?.y });
  cursor = null;
  renderInv();
}
document.addEventListener('pointerdown', (e) => {
  if (!screenOpen()) {
    // HUD hotbar: click to select
    const el = e.target.closest?.('#hotbar .slot');
    if (el) { e.stopPropagation(); st.sel = Number(el.dataset.slot); renderInv(); audio.play('tick', { vol: 0.3 }); }
    return;
  }
  const ref = refAt(e.target);
  if (!ref) {
    if (e.target.closest('#inv-panel, #cont-panel')) return;
    // outside the window: throw what you're carrying (from your inventory), or close a container
    e.preventDefault(); e.stopPropagation();
    if (cursor) throwCursor();
    else if (contOpen()) closeContainer();
    return;
  }
  e.preventDefault(); e.stopPropagation();
  const s = stackAt(ref);
  if (e.button === 0) {
    if (!cursor) {
      if (s && e.shiftKey) quickMove(ref);
      else if (s) { cursor = { ...ref, n: s.n, item: s.item }; drag = ref; audio.play('pluck', { vol: 0.35 }); }
    } else putDown(ref, cursor.n);
  } else if (e.button === 2) {
    if (!cursor) { if (s) { cursor = { ...ref, n: Math.ceil(s.n / 2), item: s.item }; audio.play('pluck', { vol: 0.35 }); } }
    else putDown(ref, 1);
  }
  renderInv();
}, true);
document.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const ref = refAt(document.elementFromPoint(e.clientX, e.clientY));
  if (cursor && ref && !(ref.src === drag.src && ref.i === drag.i)) putDown(ref, cursor.n);
  drag = null;
  renderInv();
});
for (const id of ['inv-panel', 'cont-panel']) $(id).addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('mousemove', () => { if (cursor) placeCursor(); });

function nearStation(type) {
  const tx = Math.floor(st.me.x), ty = Math.floor(st.me.y);
  for (let y = ty - 4; y <= ty + 4; y++) for (let x = tx - 4; x <= tx + 4; x++) if (st.world.getB(x, y)?.t === type) return true;
  return false;
}

// Crafting: what you can make right now first, then what you're short of, then bench-only.
function renderCraft() {
  if (!st.world) return;
  const list = $('craft-list');
  const keepScroll = list.scrollTop;
  list.replaceChildren();
  const bench = nearStation('workbench');
  const station = $('craft-station');
  station.textContent = bench ? 'at a Workbench' : 'no Workbench nearby - basic recipes only';
  station.classList.toggle('on', bench);
  const rank = (r) => (r.station && !bench ? 2 : hasAll(st.inv, r.in) ? 0 : 1);
  const recipes = RECIPES.filter((r) => !r.requires || st.known.has(r.requires)).sort((a, b) => rank(a) - rank(b));
  for (const r of recipes) {
    const can = rank(r) === 0;
    const row = document.createElement('div');
    row.className = 'recipe' + (can ? ' can' : '') + (rank(r) === 2 ? ' locked' : '');
    const it = ITEMS[r.out[0]];
    const chips = Object.entries(r.in).map(([i, n]) => {
      const have = countItem(st.inv, i);
      return `<span class="chip ${have >= n ? '' : 'miss'}" title="${ITEMS[i].name}"><img src="${iconURL[i]}">${have}/${n}</span>`;
    }).join('');
    row.innerHTML = `<img src="${iconURL[r.out[0]]}" title="${it.desc ?? ''}"><div><div class="name">${it.name}${r.out[1] > 1 ? ` <span class="x">x${r.out[1]}</span>` : ''}</div><div class="ings">${chips}</div>${r.station && !bench ? '<div class="note">needs a Workbench nearby</div>' : ''}</div>`;
    const btn = document.createElement('button');
    btn.textContent = 'Craft';
    btn.title = 'Shift-click to craft up to 10';
    btn.disabled = !can;
    btn.dataset.recipe = r.id;
    row.append(btn);
    list.append(row);
  }
  const unknown = Object.keys(BLUEPRINTS).filter((id) => !st.known.has(id)).length;
  if (unknown) list.insertAdjacentHTML('beforeend', `<p class="small dim">${unknown} design${unknown > 1 ? 's' : ''} still lost to the dark. Search ruins, dead campfires, mines and shrines for blueprints - the best lie farthest out.</p>`);
  list.scrollTop = keepScroll;
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
    bar.style.left = el.offsetLeft + el.offsetWidth - 14 + 'px';
    bar.style.right = 'auto';
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
  const r = RECIPES.find((x) => x.id === btn.dataset.recipe);
  let times = 1;
  if (e.shiftKey) times = Math.min(10, ...Object.entries(r.in).map(([i, n]) => Math.floor(countItem(st.inv, i) / n)));
  for (let k = 0; k < times; k++) send({ t: 'craft', id: btn.dataset.recipe });
  audio.play('craft', { vol: 0.5 });
});

// ---------------- panels shared by the main menu and the Esc menu ----------------
// A panel opened from another panel remembers it (data-back) and returns to it on Back/Esc.
function openPanel(id, from) {
  const el = $(id);
  if (from) { $(from).hidden = true; el.dataset.back = from; } else delete el.dataset.back;
  el.hidden = false;
  if (id === 'settings-panel') renderSettings();
  if (id === 'controls-panel') renderBinds();
  if (id === 'wiki-panel') renderWiki();
  for (const u of scrollUpdaters) u();
  audio.play('open', { vol: 0.45 });
  st.uiBlocking = PANELS.some((p) => !$(p).hidden);
}
function closePanel(id) {
  if (!id) return;
  const el = $(id);
  el.hidden = true;
  rebinding = null;
  if (el.dataset.back) { const back = el.dataset.back; delete el.dataset.back; $(back).hidden = false; if (back === 'menu-panel') renderMenu(); }
  audio.play('close', { vol: 0.45 });
  st.uiBlocking = PANELS.some((p) => !$(p).hidden);
}
// Clicking outside a menu-style panel closes it (inventory/crafting stay open so the hotbar
// still works). The click is swallowed so it doesn't also act on the world behind it.
const CLOSE_ON_OUTSIDE = ['wiki-panel', 'settings-panel', 'controls-panel', 'credits-panel', 'menu-panel'];
document.addEventListener('pointerdown', (e) => {
  const open = CLOSE_ON_OUTSIDE.filter((id) => !$(id).hidden);
  if (!open.length || e.target.closest('.panel')) return;
  e.preventDefault(); e.stopPropagation();
  for (const id of open) {
    if (id === 'menu-panel') toggle('menu-panel'); else closePanel(id);
  }
}, true);
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) openPanel(open.dataset.open, open.closest('.panel')?.id);
  const close = e.target.closest('[data-close]');
  if (close) closePanel(close.closest('.panel').id);
});

// ---------------- Esc menu ----------------
let giveupArmed = 0;
function renderMenu() {
  const g = $('m-giveup');
  const armed = performance.now() - giveupArmed < 3000;
  g.textContent = st.me.dead ? 'You are already gone...' : armed ? 'Click again to confirm' : 'Give in to the dark';
  g.classList.toggle('confirm', armed);
  g.disabled = st.me.dead;
}
$('m-resume').onclick = () => toggle('menu-panel');
$('m-giveup').onclick = () => {
  if (performance.now() - giveupArmed < 3000) { send({ t: 'giveup' }); giveupArmed = 0; toggle('menu-panel'); }
  else { giveupArmed = performance.now(); setTimeout(renderMenu, 3050); }
  renderMenu();
};
$('m-leave').onclick = () => { for (const id of PANELS) $(id).hidden = true; st.ws?.close(); };

// ---------------- settings ----------------
let shakeOn = true;
try { shakeOn = localStorage.getItem('campfire.shake') !== '0'; R.palette = localStorage.getItem('campfire.palette') === '1'; } catch {}
R.shakeOn = shakeOn;
const onOff = (v) => (v ? 'On' : 'Off');
function renderSettings() {
  $('s-gfx').textContent = R.low ? 'Low (fast)' : 'Full';
  $('s-palette').textContent = onOff(R.palette);
  $('s-shake').textContent = onOff(R.shakeOn);
  $('s-mute').textContent = audio.muted ? 'Muted' : 'Off';
  $('s-ui').value = Math.round(uiNudge * 100);
  $('s-ui-v').textContent = Math.round(uiNudge * 100) + '%';
  for (const k of ['master', 'sfx', 'amb', 'music']) {
    $('s-vol-' + k).value = Math.round(audio.vol[k] * 100);
    document.querySelector(`.val[data-for="s-vol-${k}"]`).textContent = Math.round(audio.vol[k] * 100);
  }
}
$('s-gfx').onclick = () => { R.setLow(!R.low); renderSettings(); };
$('s-palette').onclick = () => { R.palette = !R.palette; try { localStorage.setItem('campfire.palette', R.palette ? '1' : '0'); } catch {} renderSettings(); };
$('s-shake').onclick = () => { R.shakeOn = !R.shakeOn; try { localStorage.setItem('campfire.shake', R.shakeOn ? '1' : '0'); } catch {} renderSettings(); };
$('s-mute').onclick = () => { audio.toggleMute(); renderSettings(); };
$('s-ui').oninput = (e) => { uiNudge = Number(e.target.value) / 100; try { localStorage.setItem('campfire.ui', uiNudge); } catch {} applyUIScale(); $('s-ui-v').textContent = e.target.value + '%'; };
for (const k of ['master', 'sfx', 'amb', 'music']) {
  $('s-vol-' + k).oninput = (e) => { audio.setVolume(k, Number(e.target.value) / 100); document.querySelector(`.val[data-for="s-vol-${k}"]`).textContent = e.target.value; };
  $('s-vol-' + k).onchange = () => { if (k === 'sfx') audio.play('pluck', { vol: 0.6 }); };
}

// ---------------- controls (rebinding) ----------------
function renderBinds() {
  const box = $('binds');
  if (!box) return;
  box.replaceChildren();
  for (const [action, label] of Object.entries(BIND_NAMES)) {
    const row = document.createElement('div');
    row.className = 'bind';
    const btn = document.createElement('button');
    btn.className = 'alt' + (rebinding === action ? ' listening' : '');
    btn.textContent = rebinding === action ? 'Press a key...' : keyLabel(BINDS[action]);
    btn.onclick = () => { rebinding = action; renderBinds(); };
    row.append(Object.assign(document.createElement('span'), { textContent: label }), btn);
    box.append(row);
  }
}
$('binds-reset').onclick = () => { Object.assign(BINDS, DEFAULT_BINDS); saveBinds(); refreshKeyLabels(); renderBinds(); };

// Quit only makes sense in the desktop build.
if (/Electron/i.test(navigator.userAgent)) { $('quit').hidden = false; $('quit').onclick = () => window.close(); }

// ---------------- wiki ----------------
let WIKI = null, wikiCur = 'guide:start';
const wikiHist = [];
function wikiData() { return (WIKI = buildWiki(iconURL, (a) => keyLabel(BINDS[a]))); }
function renderWikiNav() {
  const q = $('wiki-search').value.trim().toLowerCase();
  const nav = $('wiki-nav');
  nav.replaceChildren();
  const seen = new Set();
  for (const cat of WIKI_CATS) {
    const list = [...WIKI.values()].filter((a) => a.cat === cat && !seen.has(a) && (!q || a.words.includes(q)) && seen.add(a));
    if (!list.length) continue;
    nav.insertAdjacentHTML('beforeend', `<div class="wcat">${cat}</div>`);
    if (cat !== 'Guides') list.sort((a, b) => a.title.localeCompare(b.title));
    for (const a of list) {
      const el = document.createElement('a');
      el.dataset.wiki = a.id;
      if (WIKI.get(wikiCur) === a) el.className = 'cur';
      el.innerHTML = `${iconURL[a.icon] ? `<img src="${iconURL[a.icon]}">` : ''}${a.title}`;
      nav.append(el);
    }
  }
}
function showWiki(id, push = true) {
  const a = WIKI.get(id) ?? WIKI.get('guide:start');
  if (push && WIKI.get(wikiCur) !== a) wikiHist.push(wikiCur);
  wikiCur = a.id;
  $('wiki-article').innerHTML = `<h2>${iconURL[a.icon] ? `<img src="${iconURL[a.icon]}">` : ''}${a.title}</h2><div class="dim small">${a.cat}</div>${a.html}`;
  $('wiki-article').scrollTop = 0;
  $('wiki-back').hidden = !wikiHist.length; // only shown once there's somewhere to go back to
  renderWikiNav();
}
function renderWiki() { wikiData(); showWiki(wikiCur, false); }
function openWiki(id) {
  if ($('wiki-panel').hidden) openPanel('wiki-panel');
  if (id) showWiki(id);
}
// The wiki key opens the page for whatever you're pointing at (a slot, or a thing in the world).
function toggleWiki() {
  if (!$('wiki-panel').hidden) { closePanel('wiki-panel'); return; }
  const slotEl = document.elementFromPoint(mouse.x, mouse.y)?.closest?.('.slot');
  const s = slotEl && st.inv[Number(slotEl.dataset.slot)];
  let id = s ? 'item:' + s.item : null;
  if (!id && st.world && st.hover && !st.uiBlocking) id = wikiIdFor(st.world, st.hover.x, st.hover.y);
  openPanel('wiki-panel');
  if (id && WIKI.has(id)) showWiki(id);
}
document.addEventListener('click', (e) => {
  const l = e.target.closest('[data-wiki]');
  if (!l || !$('wiki-panel').contains(l)) return;
  e.preventDefault();
  showWiki(l.dataset.wiki);
});
$('wiki-search').addEventListener('input', renderWikiNav);
$('wiki-search').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = $('wiki-nav').querySelector('a[data-wiki]');
  if (first) showWiki(first.dataset.wiki);
});
$('wiki-back').onclick = () => { if (wikiHist.length) showWiki(wikiHist.pop(), false); };

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
  const crowd = st.players.size;
  $('fire-burn').textContent = `Burning ${f.burn.toFixed(2)}/s${crowd > 1 ? ` · ${crowd} at the fire` : ''}`;
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

  if ((craftRefresh += dt) > 0.5 && invOpen()) { craftRefresh = 0; renderCraft(); }
  $('bottom').hidden = screenOpen(); // the inventory/container shows its own hotbar; however it was closed, bring this one back
  if (contOpen()) {
    const c = openContainer();
    if (!c || me.dead || Math.hypot(c.x + 0.5 - me.x, c.y + 0.5 - me.y) > REACH + 2) closeContainer();
  }
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
  // Music follows the fire: full and warm when it's strong, thinning to a few lonely notes
  // as it weakens or when you're out in the dark.
  const dark = outside && !me.dead;
  if (st.over) audio.setMusic({});
  else if (me.dead) audio.setMusic({ bed: 0.5, lonely: 1.6 });
  else audio.setMusic({
    bed: dark ? 0.55 : 1,
    flow: !dark && r > 0.25 ? 1 : 0,
    melody: !dark && r > 0.45 ? 1 : 0,
    lonely: dark || r < 0.25 ? 1.6 : 0,
  });
}

// ---------------- main menu scene ----------------
// A little living camp behind the title: a Bonfire, root-fed torches, a working kiln,
// glowmoss, fuel travelling home along the roots, and the odd rain shower.
function makeMenuScene() {
  const w = new World(424242);
  const B = (x, y, b) => w.bld.set(`${x},${y}`, b);
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) if (x || y) B(x, y, { t: 'hearth' });
  for (let x = 2; x <= 6; x++) B(x, 0, { t: 'root', g: 1 });
  for (let x = -2; x >= -6; x--) B(x, 0, { t: 'root', g: 1 });
  for (let y = 2; y <= 4; y++) B(0, y, { t: 'root', g: 1 });
  for (const [x, y] of [[7, 0], [-7, 0], [0, 5], [6, 1]]) B(x, y, { t: 'torch', fuel: 150, conn: true, net: 'f' });
  // a formed, working kiln fed by a root, with a grove tree beside it
  for (let y = -4; y <= -2; y++) for (let x = 3; x <= 5; x++) B(x, y, x === 4 && y === -3 ? { t: 'kiln', ok: true, on: true, net: 'f', in: 6, p: 0, out: {} } : { t: 'brick' });
  B(4, -1, { t: 'root', g: 1 }); B(4, 0, { t: 'root', g: 1 });
  B(6, -3, { t: 'sapling', g: 1, out: {} });
  for (const [x, y] of [[-4, 3], [-5, 2], [-3, 4], [-6, -3]]) B(x, y, { t: 'glowmoss' });
  for (const [x, y] of [[-2, 2], [2, 3], [-3, -2]]) B(x, y, { t: 'kindling', g: 1, out: {} });
  B(-4, -4, { t: 'rot_pit', in: 6, p: 0, out: {} });
  w.fire.fuel = 1300; w.fire.temp = 2;
  w.lightDirty = w.rootDirty = w.stageDirty = true;
  return { world: w, me: { x: 0.5, y: 1, f: 1, dead: false, held: 0, cold: 0, freezing: false }, players: new Map(), inv: [], sel: 0, packets: [], weather: { s: 'clear', t: 0 }, hover: null, harvest: null, uiBlocking: true, myId: -1 };
}
const menuSt = makeMenuScene();
let menuPkAcc = 0, menuPkId = 1;
function tickMenuScene(dt, t) {
  const w = menuSt.world;
  w.time += dt;
  // A fixed camera, left of the fire so the camp frames the right side of the screen. (A slow
  // drift on the pixel grid moves in visible whole-pixel hops, so the view stays put.)
  // The fire's colour wanders through the heat tiers.
  menuSt.me.x = -5.5;
  menuSt.me.y = 0.6;
  w.fire.temp = Math.max(0, 2.2 + 2.6 * Math.sin(t * 0.035));
  const phase = t % 100;
  menuSt.weather.s = phase > 70 && phase < 72 ? 'rain_warn' : phase >= 72 && phase < 92 ? 'rain' : 'clear';
  // fuel making its way home along the roots
  if ((menuPkAcc += dt) > 1.3) {
    menuPkAcc = 0;
    const left = Math.random() < 0.5;
    menuSt.packets.push({ id: menuPkId++, x: left ? -6 : 6, y: 0, nx: left ? -5 : 5, ny: 0, p: 0, item: ['leaf', 'stick', 'log', 'charcoal'][(Math.random() * 4) | 0] });
  }
  for (const pk of menuSt.packets) {
    pk.p += dt * PACKET_SPEED;
    if (pk.p >= 1) { pk.p -= 1; pk.x = pk.nx; pk.nx += Math.sign(-pk.nx); }
  }
  menuSt.packets = menuSt.packets.filter((pk) => Math.abs(pk.x) > 1);
  if (Math.random() < dt * 0.4) R.fx(['feed', 'stick', 0], w);
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
  } else {
    // Main menu: the living camp scene, and the sound of sitting right beside it.
    tickMenuScene(dt, t);
    R.draw(menuSt, dt, t);
    audio.listener.x = 0.5; audio.listener.y = 1.2;
    audio.update({ dt, fireStage: 3, temp: menuSt.world.fire.temp, weather: menuSt.weather.s, freezing: false, cold: 0, eternalDist: 99, torchDist: 99 });
    audio.setMusic({ bed: 1, flow: 1, melody: 1 });
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Browsers only allow sound after the first interaction, so the menu fire starts crackling then.
const wakeAudio = () => { audio.init(); removeEventListener('pointerdown', wakeAudio); removeEventListener('keydown', wakeAudio); };
addEventListener('pointerdown', wakeAudio);
addEventListener('keydown', wakeAudio);
