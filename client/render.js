import { TILE, TORCH, REACH } from '../shared/constants.js';
import { FEATURES, BUILDINGS, ITEMS, MULTIBLOCKS, FIRE_STAGES } from '../shared/defs.js';
import { hash3 } from '../shared/rng.js';
import { key, N4, N8 } from '../shared/world.js';
import { chunkOf } from '../shared/worldgen.js';
import { makePost } from './post.js';
import { drawFlame, lerpPalette, ETERNAL_PALETTE, FLAME_PALETTES } from './sprites.js';

const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const TORCH_PAL = FLAME_PALETTES[1];
// Buildings a root visibly plugs into: ones that take heat or send output down roots.
const ROOT_USERS = new Set(['torch', 'kindling', 'sapling', 'rot_pit', 'resin_tap', 'kiln', 'press', 'coal_bed', 'forge_core', 'watchfire', 'heart_seed']);
function ROOT_LINKS(w, b, x, y) {
  if (ROOT_USERS.has(b.t)) return true;
  const c = w.mbCoreFor(x, y); // a wall block of a multiblock that uses heat or sends output
  return !!(c && c[2] !== b && ROOT_USERS.has(c[2].t));
}
const FLARE_TIME = 25;
const TEAL_PAL = ['#f0fff8', '#8af5d8', '#2ab8a8', '#16606a'];
// light colours for natural lights, by the feature that makes them
const SITE_LIGHT = { eternal: ['#8af5d8', 4.5, 0.7, 0.82], shrine: ['#ffd27a', 3.2, 0.5, 0.72], glowmoss: ['#6af0b0', 1.8, 0.28, 0.5], ancient_tree: ['#7af0a0', 3.5, 0.4, 0.55] };

export function createRenderer(glCanvas, overlay, S) {
  const scene = document.createElement('canvas');
  const emit = document.createElement('canvas');
  // CPU-backed 2D canvases: they're small and get uploaded to WebGL every frame, and uploading
  // a GPU-backed canvas forces a slow readback (very slow on software WebGL, e.g. Firefox on Linux).
  const sc = scene.getContext('2d', { willReadFrequently: true });
  const ec = emit.getContext('2d', { willReadFrequently: true });
  const oc = overlay.getContext('2d');
  let post = null;
  try { post = makePost(glCanvas); } catch (e) { console.error('WebGL post failed', e); }
  // Low graphics: plain 2D compositing on its own canvas (a canvas can't have both GL and 2D contexts).
  const lo = document.getElementById('lo');
  const lc = lo.getContext('2d');
  const lmc = document.createElement('canvas');
  const lmx = lmc.getContext('2d', { willReadFrequently: true });
  let lmImg = null;

  const R = { scale: 3, W: 0, H: 0, camX: 0, camY: 0, parts: [], hops: [], flares: [], flash: 0, shake: 0, palette: false, floats: [], software: !!post?.software };
  R.setLow = (v) => {
    R.low = !!v || !post;
    glCanvas.hidden = R.low; lo.hidden = !R.low;
    try { localStorage.setItem('campfire.low', R.low ? '1' : '0'); } catch {}
  };
  let savedLow = false;
  try { savedLow = localStorage.getItem('campfire.low') === '1'; } catch {}
  R.setLow(savedLow);
  let lightData = new Uint8Array(1);

  R.resize = () => {
    const dpr = window.devicePixelRatio || 1;
    R.scale = Math.max(2, Math.round((innerHeight * dpr) / 280));
    R.W = Math.ceil((innerWidth * dpr) / R.scale);
    R.H = Math.ceil((innerHeight * dpr) / R.scale);
    for (const c of [scene, emit, glCanvas, lo]) { c.width = R.W; c.height = R.H; }
    overlay.width = innerWidth * dpr; overlay.height = innerHeight * dpr;
    R.dpr = dpr;
    sc.imageSmoothingEnabled = false; ec.imageSmoothingEnabled = false;
    lc.imageSmoothingEnabled = false;
  };
  R.resize();

  // screen (CSS px) -> world tile
  R.toTile = (mx, my) => {
    const px = (mx * R.dpr) / R.scale + R.camX, py = (my * R.dpr) / R.scale + R.camY;
    return [Math.floor(px / TILE), Math.floor(py / TILE), px / TILE, py / TILE];
  };

  // ---------- particles ----------
  const P = (o) => { R.parts.push({ vx: 0, vy: 0, g: 0, size: 1, emit: false, life: 1, drag: 0, ...o, max: o.life ?? 1 }); };
  R.fx = (e, st) => {
    const [kind, a, b, c] = e;
    if (kind === 'feed') {
      const pal = lerpPalette(st.fire.temp);
      const n = { leaf: 10, stick: 16, log: 26, peat: 30, charcoal: 40 }[a] || 12;
      for (let i = 0; i < n; i++) P({ x: 8 + (Math.random() - 0.5) * 10, y: 6, vx: (Math.random() - 0.5) * 60, vy: -40 - Math.random() * 90, g: 60, life: 0.6 + Math.random() * 0.9, col: pal[(Math.random() * 3) | 0], emit: true });
      if (b) for (let i = 0; i < 14; i++) P({ x: 8 + (Math.random() - 0.5) * 10, y: 4, vx: (Math.random() - 0.5) * 20, vy: -15 - Math.random() * 20, life: 1.5 + Math.random(), col: '#77757f', size: 2, drag: 1 });
      R.flash = Math.max(R.flash, n / 400);
    } else if (kind === 'harvest' || kind === 'place' || kind === 'break') {
      const cols = { tree: ['#4f8d44', '#376d35', '#8a6440'], bush: ['#4a8840', '#c48a3a'], rock: ['#9a98a3', '#77757f'], rubble: ['#6e6b78'] }[c] || ['#8a7a60', '#6a5a48'];
      for (let i = 0; i < 9; i++) P({ x: a * 16 + 8 + (Math.random() - 0.5) * 10, y: b * 16 + 8 + (Math.random() - 0.5) * 8, vx: (Math.random() - 0.5) * 50, vy: -30 - Math.random() * 40, g: 140, life: 0.4 + Math.random() * 0.4, col: cols[(Math.random() * cols.length) | 0] });
    } else if (kind === 'pickup') {
      for (let i = 0; i < 5; i++) P({ x: a * 16 + 8 + (Math.random() - 0.5) * 8, y: b * 16 + 8, vy: -20 - Math.random() * 20, life: 0.5, col: '#fff2c0', emit: true });
    } else if (kind === 'chest') {
      for (let i = 0; i < 24; i++) P({ x: a * 16 + 8, y: b * 16 + 6, vx: (Math.random() - 0.5) * 70, vy: -30 - Math.random() * 70, g: 80, life: 0.8 + Math.random() * 0.6, col: Math.random() < 0.5 ? '#ffd870' : '#fff6d8', emit: true });
    } else if (kind === 'death') {
      for (let i = 0; i < 40; i++) P({ x: a * 16, y: b * 16, vx: (Math.random() - 0.5) * 50, vy: -10 - Math.random() * 40, life: 1 + Math.random() * 1.5, col: Math.random() < 0.5 ? '#5a6aa8' : '#9ab8ff', emit: true, drag: 1.5 });
      R.shake = 0.4;
    } else if (kind === 'flare') {
      R.flares.push({ x: a, y: b, name: c, color: e[4], t: 0, burst: false });
    } else if (kind === 'hop') {
      // an item arcing from a plant into the building beside it
      R.hops.push({ x0: a * 16 + 8, y0: b * 16 + 6, x1: c * 16 + 8, y1: e[4] * 16 + 8, item: e[5], t: 0 });
    } else if (kind === 'drop') {
      for (let i = 0; i < 5; i++) P({ x: a * 16 + 8 + (Math.random() - 0.5) * 8, y: b * 16 + 12, vx: (Math.random() - 0.5) * 30, vy: -10 - Math.random() * 15, g: 80, life: 0.35, col: '#8a7a60' });
    } else if (kind === 'forge') {
      // embers spiral in from the 3x3 and fuse
      for (let i = 0; i < 70; i++) {
        const ang = Math.random() * Math.PI * 2, d = 18 + Math.random() * 14;
        const sx = a * 16 + 8 + Math.cos(ang) * d, sy = b * 16 + 8 + Math.sin(ang) * d;
        const life = 0.5 + Math.random() * 0.4;
        P({ x: sx, y: sy, vx: (a * 16 + 8 - sx) / life, vy: (b * 16 + 8 - sy) / life, life, col: Math.random() < 0.5 ? '#ffb070' : '#ffe9a8', emit: true });
      }
      setTimeout(() => {
        for (let i = 0; i < 40; i++) P({ x: a * 16 + 8, y: b * 16 + 4, vx: (Math.random() - 0.5) * 120, vy: -20 - Math.random() * 90, g: 120, life: 0.6 + Math.random() * 0.5, col: ['#b07a5e', '#84503c', '#ffb070'][(Math.random() * 3) | 0], emit: Math.random() < 0.4 });
        R.flash = Math.max(R.flash, 0.25); R.shake = Math.max(R.shake, 0.25);
      }, 650);
    } else if (kind === 'shatter') {
      for (let i = 0; i < 60; i++) P({ x: a * 16 + 8 + (Math.random() - 0.5) * 40, y: b * 16 + 8 + (Math.random() - 0.5) * 40, vx: (Math.random() - 0.5) * 140, vy: -40 - Math.random() * 100, g: 260, life: 0.5 + Math.random() * 0.5, size: 2, col: ['#8c5440', '#5e3426', '#b07a5e', '#2e1d18'][(Math.random() * 4) | 0] });
      R.shake = Math.max(R.shake, 0.35);
    } else if (kind === 'revive') {
      for (let i = 0; i < 60; i++) P({ x: 8, y: 6, vx: (Math.random() - 0.5) * 140, vy: -20 - Math.random() * 120, g: 80, life: 0.8 + Math.random(), col: Math.random() < 0.5 ? '#9ab8ff' : '#fff6d8', emit: true });
      R.flash = 0.35;
    }
  };

  R.float = (text, x, y, col = '#fff') => R.floats.push({ text, x, y, col, life: 1.6 });

  function updateParticles(dt) {
    const keep = [];
    for (const p of R.parts) {
      p.life -= dt;
      if (p.life <= 0) {
        if (p.splash) for (let i = 0; i < 2; i++) keep.push({ x: p.x, y: p.y, vx: (i ? 1 : -1) * 15, vy: -15, g: 120, life: 0.15, max: 0.15, size: 1, col: '#9ab8d8', a: 0.5 });
        continue;
      }
      p.vy += p.g * dt;
      if (p.drag) { p.vx *= 1 - p.drag * dt; p.vy *= 1 - p.drag * dt; }
      if (p.wobble) p.vx += Math.sin(p.life * 7 + p.wobble) * p.wobbleAmt * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.grow) p.size += p.grow * dt;
      keep.push(p);
    }
    R.parts = keep.length > 2500 ? keep.slice(keep.length - 2500) : keep;
  }

  function emitAmbient(st, dt, t, view) {
    const w = st.world;
    const fuel = w.fire.fuel;
    const stage = fireStage(w);
    const pal = lerpPalette(w.fire.temp);
    const wind = st.weather.s === 'wind' ? 50 : 0;
    // fire embers + smoke
    const sg = w.stage();
    if (fuel > 0 && sg === 3 && Math.random() < dt * 20) {
      // embers swirling up around the Inferno
      const a = Math.random() * Math.PI * 2, r = 34 + Math.random() * 10;
      P({ x: 8 + Math.cos(a) * r, y: 8 + Math.sin(a) * r * 0.6, vx: -Math.sin(a) * 40, vy: -30 - Math.random() * 30, drag: 0.4, life: 1.5 + Math.random(), col: pal[1 + ((Math.random() * 2) | 0)], emit: true, wobble: Math.random() * 9, wobbleAmt: 30 });
    }
    if (fuel > 0) {
      const rate = [3, 7, 12, 18, 28][stage] * (1 + sg * 0.8);
      for (let n = rate * dt; n > 0; n--) if (Math.random() < n) P({ x: 8 + (Math.random() - 0.5) * (6 + stage * 2 + sg * 14), y: 6 - stage - sg * 6, vx: (Math.random() - 0.5) * 12 + wind * 0.5, vy: -20 - Math.random() * (20 + stage * 10), life: 0.8 + Math.random() * 1.8, col: pal[1 + ((Math.random() * 3) | 0) % 3], emit: true, wobble: Math.random() * 9, wobbleAmt: 40 });
      if (Math.random() < (2 + stage * 1.5) * dt) P({ x: 8 + (Math.random() - 0.5) * 6, y: -6 - stage * 3, vx: (Math.random() - 0.5) * 6 + wind, vy: -12 - Math.random() * 8, life: 2.5 + Math.random() * 2, col: '#4a4652', a: 0.35, size: 2, grow: 1.5 });
    }
    // torches & eternal flames on screen
    for (const [k, b] of w.bld) {
      if (b.t !== 'torch' || b.fuel <= 0) continue;
      const [x, y] = k.split(',').map(Number);
      if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
      if (Math.random() < 1.5 * dt) P({ x: x * 16 + 8 + (Math.random() - 0.5) * 3, y: y * 16 + 2, vx: (Math.random() - 0.5) * 8 + wind * 0.5, vy: -15 - Math.random() * 15, life: 0.6 + Math.random(), col: TORCH_PAL[1 + ((Math.random() * 2) | 0)], emit: true });
    }
    for (const [lx, ly, , kind] of view.siteLights) {
      if (kind === 'eternal') {
        if (Math.random() < 4 * dt) {
          const a = Math.random() * Math.PI * 2, d = 6 + Math.random() * 40;
          P({ x: lx * 16 + 8 + Math.cos(a) * d, y: ly * 16 + 8 + Math.sin(a) * d, vx: (Math.random() - 0.5) * 6, vy: -4 - Math.random() * 6, life: 2 + Math.random() * 2, col: ETERNAL_PALETTE[(Math.random() * 3) | 0], emit: true, wobble: Math.random() * 9, wobbleAmt: 10 });
        }
        if (Math.random() < 3 * dt) P({ x: lx * 16 + 8 + (Math.random() - 0.5) * 6, y: ly * 16 - 2, vy: -20 - Math.random() * 20, life: 0.7 + Math.random(), col: ETERNAL_PALETTE[1], emit: true });
      } else if (kind === 'shrine') {
        if (Math.random() < 2 * dt) P({ x: lx * 16 + 8 + (Math.random() - 0.5) * 10, y: ly * 16 + 2, vy: -8 - Math.random() * 8, life: 1.5 + Math.random(), col: Math.random() < 0.5 ? '#ffd27a' : '#fff6d8', emit: true, wobble: Math.random() * 9, wobbleAmt: 8 });
      } else if (Math.random() < 0.5 * dt) {
        P({ x: lx * 16 + 4 + Math.random() * 8, y: ly * 16 + 8 + Math.random() * 6, vy: -4 - Math.random() * 4, life: 2 + Math.random() * 2, col: '#8affc8', emit: true, wobble: Math.random() * 9, wobbleAmt: 6 });
      }
    }
    // rain
    if (st.weather.s === 'rain') {
      const n = (R.W * R.H) / 100000 * 300 * dt; // ~120 drops on screen
      for (let i = n; i > 0; i--) {
        if (Math.random() > i) continue;
        const life = 0.25 + Math.random() * 0.35;
        P({ x: R.camX + Math.random() * (R.W + 60), y: R.camY - 20 + Math.random() * R.H * 0.7, vx: -50, vy: 260, life, col: '#8fb0d0', a: 0.55, streak: true, splash: true });
      }
    } else if (st.weather.s === 'rain_warn' && Math.random() < dt * 8) {
      P({ x: R.camX + Math.random() * R.W, y: R.camY + Math.random() * R.H * 0.5, vx: -30, vy: 200, life: 0.4, col: '#8fb0d0', a: 0.4, streak: true, splash: true });
    }
    if (st.weather.s === 'wind' || st.weather.s === 'wind_warn') {
      const rate = st.weather.s === 'wind' ? 25 : 5;
      for (let i = 0; i < rate * dt * 2; i++) if (Math.random() < 0.5) {
        const leafy = Math.random() < 0.5;
        P({ x: R.camX - 10, y: R.camY + Math.random() * R.H, vx: 120 + Math.random() * 120, vy: (Math.random() - 0.5) * 30, life: R.W / 150 + 1, col: leafy ? ['#c47a2a', '#4f8d44', '#8a6440'][(Math.random() * 3) | 0] : '#a8b0b8', a: leafy ? 1 : 0.25, streak: !leafy, wobble: Math.random() * 9, wobbleAmt: 80 });
      }
    }
  }

  // ---------- main draw ----------
  R.draw = (st, dt, t) => {
    const w = st.world;
    const me = st.me;
    R.shake = Math.max(0, R.shake - dt);
    R.flash = Math.max(0, R.flash - dt * 1.5);
    const shaking = R.shake && R.shakeOn !== false;
    const sx = shaking ? (Math.random() - 0.5) * 6 * R.shake : 0, sy = shaking ? (Math.random() - 0.5) * 6 * R.shake : 0;
    R.camX = Math.round(me.x * TILE - R.W / 2 + sx);
    R.camY = Math.round(me.y * TILE - R.H / 2 + sy);
    const camX = R.camX, camY = R.camY;
    const x0 = Math.floor(camX / TILE) - 1, y0 = Math.floor(camY / TILE) - 2;
    const x1 = Math.ceil((camX + R.W) / TILE) + 1, y1 = Math.ceil((camY + R.H) / TILE) + 2;
    const siteLights = [];
    for (let cy = chunkOf(y0) - 1; cy <= chunkOf(y1) + 1; cy++) for (let cx = chunkOf(x0) - 1; cx <= chunkOf(x1) + 1; cx++) {
      const s = w.gen.site(cx, cy);
      if (s) for (const [lx, ly, r] of w.siteLights(s)) siteLights.push([lx, ly, r, w.getFeature(lx, ly).t]);
    }
    const view = { x0, y0, x1, y1, siteLights };

    emitAmbient(st, dt, t, view);
    updateParticles(dt);

    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.fillStyle = '#000'; sc.fillRect(0, 0, R.W, R.H);
    ec.setTransform(1, 0, 0, 1, 0, 0);
    ec.clearRect(0, 0, R.W, R.H);
    ec.fillStyle = '#000'; ec.fillRect(0, 0, R.W, R.H);
    sc.setTransform(1, 0, 0, 1, -camX, -camY);
    ec.setTransform(1, 0, 0, 1, -camX, -camY);

    // ground (looked up once per tile per frame, with a 1-tile margin for shore checks)
    const gw = x1 - x0 + 3, gh = y1 - y0 + 3;
    const G = new Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) G[y * gw + x] = w.ground(x0 - 1 + x, y0 - 1 + y);
    const gAt = (x, y) => G[(y - y0 + 1) * gw + (x - x0 + 1)];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const g = gAt(x, y);
      const arr = S.ground[g];
      const spr = g === 'water' ? arr[Math.floor(t * 2 + hash3(w.seed, x, y, 5) * 3) % 3] : arr[(hash3(w.seed, x, y, 4) * arr.length) | 0];
      sc.drawImage(spr, x * TILE, y * TILE);
    }
    // shores: a sandy lip on land, lapping foam on the water side
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const water = gAt(x, y) === 'water';
      for (const [dx, dy] of N4) {
        if ((gAt(x + dx, y + dy) === 'water') === water) continue;
        const px = x * TILE, py = y * TILE;
        for (let i = 0; i < TILE; i++) {
          // i runs along the shared edge; d goes inward from it
          const n = hash3(w.seed, x * 16 + i * dy, y * 16 + i * dx, 21);
          const depth = water ? (Math.sin(t * 2 + (x + y) * 1.3 + i * 0.4) > 0.3 ? 2 : 1) : 2 + (n < 0.4 ? 1 : 0);
          for (let d = 0; d < depth; d++) {
            const ex = dx > 0 ? px + TILE - 1 - d : dx < 0 ? px + d : px + i;
            const ey = dy > 0 ? py + TILE - 1 - d : dy < 0 ? py + d : py + i;
            sc.fillStyle = water ? (d === 0 ? '#9ac0d4' : '#4b7d9a') : d === 0 ? '#b8a272' : n < 0.2 ? '#7a6a48' : '#9a8658';
            sc.fillRect(ex, ey, 1, 1);
          }
        }
      }
    }
    // ground-level things: roots, drops
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const b = w.getB(x, y);
      if (b?.t === 'root') drawRoot(w, x, y, b, t);
    }
    // packets travelling the roots
    for (const pk of st.packets) {
      const p = Math.min(1, pk.p);
      const px = (pk.x + (pk.nx - pk.x) * p) * TILE + 8, py = (pk.y + (pk.ny - pk.y) * p) * TILE + 8;
      const c = { leaf: '#ffb070', stick: '#ffc070', log: '#ffd070', peat: '#ff9a50', charcoal: '#c8ecff' }[pk.item] || '#ffd070';
      ec.fillStyle = c; ec.fillRect(Math.round(px) - 1, Math.round(py) - 1, 2, 2);
      ec.fillStyle = '#fff6d8'; ec.fillRect(Math.round(px), Math.round(py) - 1, 1, 1);
    }
    for (const [k, arr] of w.drops) {
      const [x, y] = k.split(',').map(Number);
      if (x < x0 || x > x1 || y < y0 || y > y1 || !arr?.length) continue;
      const bob = Math.round(Math.sin(t * 3 + x + y) * 1);
      sc.globalAlpha = 0.4; sc.fillStyle = '#000'; sc.fillRect(x * TILE + 4, y * TILE + 13, 8, 2); sc.globalAlpha = 1;
      if (arr.length > 1) sc.drawImage(S.icon[arr[1][0]], x * TILE + 3, y * TILE - 1 + bob);
      sc.drawImage(S.icon[arr[0][0]], x * TILE, y * TILE - 2 + bob);
    }

    // y-sorted objects
    const living = [...st.players.values()].filter((p) => !p.dead);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x === 0 && y === 0) drawCampfire(w, t);
        const f = w.getFeature(x, y);
        if (f) drawFeature(w, f, x, y, t);
        const b = w.getB(x, y);
        if (b && b.t !== 'root' && !fusedWallAt(w, b, x, y)) drawBuilding(w, b, x, y, t);
      }
      for (const p of living) if (Math.floor(p.ry + 0.3) === y) drawPlayer(st, p, t);
    }
    // wisps of the fallen circle the fire
    let di = 0;
    for (const p of st.players.values()) {
      if (!p.dead) continue;
      const a = t * 1.3 + di++ * 2.1;
      const px = 8 + Math.cos(a) * 12, py = -4 + Math.sin(a) * 5;
      ec.fillStyle = '#9ab8ff'; ec.fillRect(Math.round(px) - 1, Math.round(py) - 1, 3, 3);
      ec.fillStyle = '#ffffff'; ec.fillRect(Math.round(px), Math.round(py), 1, 1);
    }

    // particles
    for (const p of R.parts) {
      const ctx = p.emit ? ec : sc;
      const fade = Math.min(1, p.life / p.max * 2);
      ctx.globalAlpha = (p.a ?? 1) * fade;
      ctx.fillStyle = p.col;
      if (p.streak) ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 4);
      else { const s = Math.max(1, Math.round(p.size)); ctx.fillRect(Math.round(p.x - s / 2), Math.round(p.y - s / 2), s, s); }
    }
    sc.globalAlpha = 1; ec.globalAlpha = 1;
    R.flares = R.flares.filter((f) => (f.t += dt) < FLARE_TIME);
    for (const f of R.flares) {
      const fx = f.x * TILE, fy = f.y * TILE - 10;
      const rise = Math.min(1, f.t / 0.9);
      const top = fy - 90 * (1 - (1 - rise) * (1 - rise));
      if (f.t < 0.9) {
        ec.fillStyle = '#fff6d8'; ec.fillRect(Math.round(fx) - 1, Math.round(top) - 1, 2, 3);
        P({ x: fx + (Math.random() - 0.5) * 2, y: top + 2, vx: (Math.random() - 0.5) * 10, vy: 20, life: 0.5, col: Math.random() < 0.5 ? f.color : '#ffd27a', emit: true });
      } else {
        if (!f.burst) {
          f.burst = true;
          for (let i = 0; i < 70; i++) { const a = Math.random() * Math.PI * 2, s = 30 + Math.random() * 90; P({ x: fx, y: top, vx: Math.cos(a) * s, vy: Math.sin(a) * s, g: 40, drag: 1.2, life: 1 + Math.random(), col: i % 3 ? f.color : '#fff6d8', emit: true }); }
        }
        // the star hangs, drifting down and fading
        const sink = (f.t - 0.9) * 2, fade = 1 - (f.t - 0.9) / (FLARE_TIME - 0.9);
        const sy = top + sink, pulse = Math.sin(f.t * 8) > 0;
        ec.globalAlpha = Math.max(0.2, fade);
        ec.fillStyle = pulse ? '#ffffff' : f.color; ec.fillRect(Math.round(fx) - 1, Math.round(sy) - 1, 3, 3);
        ec.fillStyle = f.color; ec.fillRect(Math.round(fx) - 3, Math.round(sy), 7, 1); ec.fillRect(Math.round(fx), Math.round(sy) - 3, 1, 7);
        ec.globalAlpha = 1;
        if (Math.random() < 0.3) P({ x: fx + (Math.random() - 0.5) * 3, y: sy + 2, vy: 12, life: 0.8, col: f.color, emit: true });
      }
    }
    R.hops = R.hops.filter((hp) => (hp.t += dt * 2.5) < 1);
    for (const hp of R.hops) {
      const x = hp.x0 + (hp.x1 - hp.x0) * hp.t, y = hp.y0 + (hp.y1 - hp.y0) * hp.t - Math.sin(hp.t * Math.PI) * 10;
      sc.drawImage(S.icon[hp.item], 0, 0, 16, 16, Math.round(x) - 4, Math.round(y) - 4, 8, 8);
      ec.fillStyle = '#ffb070'; ec.fillRect(Math.round(x), Math.round(y) - 4, 1, 1);
    }

    // ---------- lighting ----------
    const lmW = x1 - x0 + 1, lmH = y1 - y0 + 1;
    if (lightData.length !== lmW * lmH) lightData = new Uint8Array(lmW * lmH);
    const lv = new Float32Array(lmW * lmH);
    const sq = (cx, cy, r, top, fall) => {
      for (let y = Math.max(y0, cy - r); y <= Math.min(y1, cy + r); y++) for (let x = Math.max(x0, cx - r); x <= Math.min(x1, cx + r); x++) {
        const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
        const v = top - (r ? d / r : 0) * fall;
        const i = (y - y0) * lmW + (x - x0);
        if (v > lv[i]) lv[i] = v;
      }
    };
    const lights = [];
    const flick = (s) => 0.97 + 0.02 * Math.sin(t * 11 + s) + 0.01 * Math.sin(t * 23 + s * 3);
    const fuel = w.fire.fuel;
    if (fuel > 0) {
      const ratio = Math.min(1, fuel / w.maxFuel());
      sq(0, 0, w.fireRadius(), (0.9 + 0.1 * ratio) * flick(1), 0.2);
      const pal = lerpPalette(w.fire.temp);
      const sgl = w.stage();
      lights.push({ x: 8 - camX, y: 4 - sgl * 10 - camY, r: TILE * (4 + 2.5 * ratio + sgl * 1.8), i: Math.min(1.2, (0.55 + 0.4 * ratio) * (1 + sgl * 0.15)) * flick(2), c: rgb(pal[1]) });
    }
    for (const [k, b] of w.bld) {
      const [x, y] = k.split(',').map(Number);
      if (x < x0 - 3 || x > x1 + 3 || y < y0 - 3 || y > y1 + 3) continue;
      if (b.t === 'torch' && b.fuel > 0) {
        const dim = Math.min(1, 0.45 + b.fuel / 40);
        sq(x, y, TORCH.placedRadius, 0.85 * dim * flick(x * 7 + y), 0.18);
        lights.push({ x: x * TILE + 8 - camX, y: y * TILE + 4 - camY, r: TILE * 3, i: 0.6 * dim * flick(x + y * 3), c: rgb(TORCH_PAL[1]) });
      } else if (b.t === 'kiln' && b.ok && b.conn && b.in >= 2) {
        lights.push({ x: x * TILE + 8 - camX, y: y * TILE + 10 - camY, r: TILE * 2.5, i: 0.5 * flick(x), c: rgb('#ff7a2a') });
      } else if (b.t === 'root' && w.rootPowered(x, y) && (x + y) % 3 === 0) {
        lights.push({ x: x * TILE + 8 - camX, y: y * TILE + 8 - camY, r: TILE * 1.2, i: 0.25, c: rgb(w.rootNodeAt(x, y)?.net === 'fire' ? '#ff5a1a' : '#2ad8c0') });
      } else if (b.t === 'glowmoss') {
        sq(x, y, 1, 0.5 * flick(x * 3 + y), 0.15);
        lights.push({ x: x * TILE + 8 - camX, y: y * TILE + 10 - camY, r: TILE * 1.8, i: 0.28, c: rgb('#6af0b0') });
      } else if (b.t === 'watchfire' && b.lit) {
        sq(x, y, MULTIBLOCKS.watchfire.light, 0.85 * flick(x + y), 0.25);
        lights.push({ x: x * TILE + 8 - camX, y: y * TILE - 40 - camY, r: TILE * 7, i: 0.8 * flick(x), c: rgb(b.net === 'e' ? '#8af5d8' : '#ffa43a') });
      } else if (MULTIBLOCKS[b.t] && b.ok && b.on && b.t !== 'heart_seed') {
        lights.push({ x: x * TILE + 8 - camX, y: y * TILE + 10 - camY, r: TILE * (MULTIBLOCKS[b.t].size), i: 0.45 * flick(x), c: rgb(b.t === 'forge_core' ? '#ff6a8a' : '#ff7a2a') });
      }
    }
    for (const [lx, ly, r, kind] of siteLights) {
      const [col, rad, inten, top] = SITE_LIGHT[kind] || SITE_LIGHT.glowmoss;
      sq(lx, ly, r, top * flick(lx + ly), 0.15);
      lights.push({ x: lx * TILE + 8 - camX, y: ly * TILE + 4 - camY, r: TILE * rad, i: inten * flick(ly), c: rgb(col) });
    }
    for (const p of living) {
      const tx = Math.floor(p.rx), ty = Math.floor(p.ry);
      if (p.held > 0 && !w.sharedLit(tx, ty)) {
        if (p.id === st.myId) sq(tx, ty, TORCH.heldRadius, 0.72 * flick(5), 0.12);
        else sq(tx, ty, TORCH.heldRadius, 0.2, 0.05);
        lights.push({ x: p.rx * TILE + 4 - camX, y: p.ry * TILE - 4 - camY, r: TILE * 2.2, i: 0.55 * flick(p.id), c: rgb(TORCH_PAL[1]) });
      } else if (p.id === st.myId && !w.sharedLit(tx, ty)) {
        sq(tx, ty, 0, 0.12, 0); // freezing: barely see yourself
      }
    }
    // Penumbra: tiles touching real light are barely visible; everything further out is pure black.
    for (let y = 0; y < lmH; y++) for (let x = 0; x < lmW; x++) {
      const i = y * lmW + x;
      if (lv[i] > 0) continue;
      let near = false;
      for (let ey = -1; ey <= 1 && !near; ey++) for (let ex = -1; ex <= 1; ex++) {
        const xx = x + ex, yy = y + ey;
        if (xx >= 0 && yy >= 0 && xx < lmW && yy < lmH && lv[yy * lmW + xx] > 0.3) { near = true; break; }
      }
      if (near) lv[i] = -0.07; // negative = penumbra marker, resolved below
    }
    for (let i = 0; i < lv.length; i++) lightData[i] = Math.max(0, Math.min(255, Math.abs(lv[i]) * 255));
    const cxs = R.W / 2, cys = R.H / 2;
    lights.sort((a, b) => Math.hypot(a.x - cxs, a.y - cys) - Math.hypot(b.x - cxs, b.y - cys));

    if (!R.low) {
      post.render({
        scene, emit, lightData, lmW, lmH, lmOriginX: x0 * TILE - camX, lmOriginY: y0 * TILE - camY, lights,
        time: t, rain: st.weather.s === 'rain' ? 1 : 0, cold: me.dead ? 0 : Math.min(1, me.cold / 6 + (me.freezing ? 0.25 : 0)),
        pal: R.palette, flash: R.flash, dead: me.dead ? 0.8 : 0,
      });
    } else {
      drawLow(st, me, lmW, lmH, x0 * TILE - camX, y0 * TILE - camY, lights);
    }
    drawOverlay(st, t, dt);
  };

  // Low-graphics compositor: same tile lighting as the shader, done with 2D canvas ops.
  function drawLow(st, me, lmW, lmH, ox, oy, lights) {
    lc.globalCompositeOperation = 'source-over';
    lc.globalAlpha = 1;
    lc.drawImage(scene, 0, 0);
    if (lmc.width !== lmW || lmc.height !== lmH || !lmImg) { lmc.width = lmW; lmc.height = lmH; lmImg = lmx.createImageData(lmW, lmH); }
    const d = lmImg.data;
    for (let i = 0; i < lmW * lmH; i++) {
      const L = lightData[i] / 255;
      d[i * 4] = 10; d[i * 4 + 1] = 7; d[i * 4 + 2] = 16;
      d[i * 4 + 3] = L <= 0 ? 255 : Math.round((1 - Math.min(1, L * 1.1)) * 250);
    }
    lmx.putImageData(lmImg, 0, 0);
    lc.drawImage(lmc, ox, oy, lmW * TILE, lmH * TILE);
    lc.globalCompositeOperation = 'lighter';
    for (const l of lights.slice(0, 12)) {
      const g = lc.createRadialGradient(l.x, l.y, 0, l.x, l.y, l.r);
      const [r, gg, b] = l.c.map((v) => Math.round(v * 255));
      g.addColorStop(0, `rgba(${r},${gg},${b},${(0.22 * l.i).toFixed(3)})`);
      g.addColorStop(1, `rgba(${r},${gg},${b},0)`);
      lc.fillStyle = g;
      lc.fillRect(l.x - l.r, l.y - l.r, l.r * 2, l.r * 2);
    }
    lc.drawImage(emit, 0, 0);
    lc.globalCompositeOperation = 'source-over';
    const tint = (c, a) => { if (a > 0) { lc.globalAlpha = a; lc.fillStyle = c; lc.fillRect(0, 0, R.W, R.H); lc.globalAlpha = 1; } };
    if (st.weather.s === 'rain') tint('#28406a', 0.15);
    if (!me.dead) tint('#b8d8ff', Math.min(1, me.cold / 6 + (me.freezing ? 0.25 : 0)) * 0.35);
    else tint('#141a34', 0.45);
  }

  // ---------- pieces ----------
  // flame size (0-4) from how full the fire is; -1 = out
  function fireStage(w) {
    const fuel = w.fire.fuel, r = fuel / w.maxFuel();
    return fuel <= 0 ? -1 : r < 0.08 ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.8 ? 3 : 4;
  }

  // Per fire stage: coal-bed radius, flame [width, height] at full fuel, and side tongues.
  const FIRE_LOOK = [
    { bed: 5, w: 14, h: 20, tongues: 2, spread: 4 },
    { bed: 12, w: 22, h: 34, tongues: 4, spread: 9 },
    { bed: 22, w: 34, h: 56, tongues: 6, spread: 16 },
    { bed: 30, w: 46, h: 86, tongues: 8, spread: 22 },
  ];
  function drawCampfire(w, t) {
    const sg = w.stage(), look = FIRE_LOOK[sg];
    if (sg > 0) { const r = FIRE_STAGES[sg].ring; sc.drawImage(S.firePit[sg], -r * TILE, -r * TILE); }
    else sc.drawImage(S.campfire, -4, 0);
    const size = fireStage(w);
    if (size < 0) { ec.fillStyle = '#3a1a10'; ec.fillRect(5, 9, 6, 1); return; }
    const pal = lerpPalette(w.fire.temp);
    const full = [0.25, 0.45, 0.65, 0.85, 1][size];
    const cx = 8, base = sg > 0 ? 12 : 10;
    // glowing coal bed
    for (let i = 0; i < look.bed * 3; i++) {
      const a = i * 2.39996, rr = Math.sqrt(i / (look.bed * 3)) * look.bed;
      const x = Math.round(cx + Math.cos(a) * rr), y = Math.round(base - 1 + Math.sin(a) * rr * 0.55);
      ec.fillStyle = Math.sin(t * 3 + i * 1.7) > 0.1 ? pal[2] : Math.sin(t * 2 + i) > 0 ? pal[3] : '#3a140a';
      ec.fillRect(x, y, 1, 1);
    }
    // side tongues, then the main flame (an Inferno's is a towering pillar)
    for (let k = 0; k < look.tongues; k++) {
      const side = k % 2 ? 1 : -1, off = look.spread * (0.35 + 0.65 * Math.floor(k / 2 + 1) / Math.ceil(look.tongues / 2));
      const hh = look.h * full * (0.45 + 0.25 * Math.sin(t * 1.3 + k * 2.1));
      drawFlame(ec, cx + side * off, base, look.w * 0.4, hh, pal, t, k * 3.7 + 1);
    }
    drawFlame(ec, cx, base, look.w * full ** 0.5, look.h * full, pal, t, 1.3);
    if (sg >= 2) drawFlame(ec, cx, base - look.h * full * 0.25, look.w * 0.35, look.h * full * 0.9, [pal[0], pal[0], pal[1], pal[2]], t * 1.3, 9.1);
    if (sg === 3) {
      // four corner braziers
      for (const [px, py] of [[-40, -39], [40, -39], [-40, 41], [40, 41]]) drawFlame(ec, cx + px, base + py - 12, 7, 12 + Math.sin(t * 3 + px) * 2, pal, t, px * 0.1 + py);
    }
  }

  function drawFeature(w, f, x, y, t) {
    const px = x * TILE, py = y * TILE;
    switch (f.t) {
      case 'tree': {
        const sway = w.weatherWind ? Math.round(Math.sin(t * 3 + x) * 1) : 0;
        sc.drawImage(S.feat.tree[(hash3(w.seed, x, y, 6) * 3) | 0], px + sway, py - 8);
        break;
      }
      case 'bare_tree': sc.drawImage(S.feat.bare_tree, px, py - 8); break;
      case 'wall': sc.drawImage(S.feat.wall[(hash3(w.seed, x, y, 6) * 2) | 0], px, py - 4); break;
      case 'eternal':
        sc.drawImage(S.feat.eternal, px, py);
        drawFlame(ec, px + 8, py + 9, 8, 12 + Math.sin(t * 2) * 1.5, ETERNAL_PALETTE, t, x * 0.37);
        if (f.store && Object.values(f.store).some((n) => n > 0)) { ec.fillStyle = Math.sin(t * 4) > 0 ? '#c8fff0' : '#5ad8c0'; ec.fillRect(px + 12, py + 2, 2, 2); }
        break;
      case 'cave_wall': sc.drawImage(S.feat.cave_wall[(hash3(w.seed, x, y, 6) * 2) | 0], px, py - 4); break;
      case 'coal_seam': sc.drawImage(S.feat.coal_seam, px, py - 4); break;
      case 'geode':
        sc.drawImage(S.feat.geode, px, py - 4);
        for (const [cx, cy, c] of [[7, 9, '#ff8a5a'], [9, 8, '#ffd0c0'], [8, 11, '#ff6a8a'], [6, 11, '#c83a2a']]) { ec.fillStyle = Math.sin(t * 3 + cx) > -0.3 ? c : '#5a1a14'; ec.fillRect(px + cx, py + cy - 4 + 4, 1, 1); }
        break;
      case 'shrine': case 'shrine_empty':
        sc.drawImage(S.feat[f.t], px, py - 4);
        if (f.t === 'shrine') { ec.fillStyle = Math.sin(t * 3) > 0 ? '#ffe9a8' : '#ffb84a'; ec.fillRect(px + 7, py - 3 + Math.round(Math.sin(t * 2)), 2, 1); ec.fillRect(px + 6, py - 2, 4, 1); }
        break;
      case 'ancient_tree': sc.drawImage(S.feat.ancient_tree, px - 12, py - 32); for (let i = 0; i < 5; i++) { ec.fillStyle = '#4ae0a0'; if (Math.sin(t * 2 + i * 1.3) > 0.4) ec.fillRect(px - 6 + i * 6, py - 22 + (i % 3) * 7, 1, 1); } break;
      case 'ancient_stump': sc.drawImage(S.feat.ancient_stump, px - 4, py); break;
      case 'dead_fire': sc.drawImage(S.feat.dead_fire, px - 4, py); break;
      case 'glowmoss': sc.drawImage(S.feat.glowmoss, px, py); glowmossSparks(px, py, t, x + y); break;
      default: {
        const spr = S.feat[f.t];
        if (spr) sc.drawImage(spr, px, py);
      }
    }
  }

  function drawRoot(w, x, y, b, t) {
    const px = x * TILE + 8, py = y * TILE + 8;
    const powered = w.rootPowered(x, y);
    const g = b.g ?? 1;
    const node = w.rootNodeAt(x, y);
    const d = node?.d ?? 0, teal = node && node.net !== 'fire';
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      const nb = w.getB(nx, ny);
      const link = (nx === 0 && ny === 0) || nb?.t === 'root' || (nb && ROOT_LINKS(w, nb, nx, ny)) || w.getFeature(nx, ny)?.t === 'eternal' || w.rootNodeAt(nx, ny)?.d === 0;
      if (!link) continue;
      const len = Math.round(8 * g);
      for (let i = 0; i <= len; i++) {
        const lx = px + dx * i, ly = py + dy * i;
        const wig = Math.round(Math.sin((x * 3 + y * 5 + i) * 1.3) * 0.6);
        sc.fillStyle = '#2a120c'; sc.fillRect(lx - 1 + (dy ? wig : 0), ly - 1 + (dx ? wig : 0), 3, 3);
        if (powered && g >= 1) {
          const pulse = Math.sin(t * 6 - (d * 8 + i) * 0.4) > 0.6;
          ec.fillStyle = teal ? (pulse ? '#c8fff0' : '#1a8a80') : pulse ? '#ffb070' : '#a8301a';
          ec.fillRect(lx + (dy ? wig : 0), ly + (dx ? wig : 0), 1, 1);
        }
      }
    }
    sc.fillStyle = '#3a1a10'; sc.fillRect(px - 2, py - 2, 4, 4);
    ec.fillStyle = powered && g >= 1 ? (teal ? '#2ad8c0' : '#e0561f') : g < 1 ? '#5a2010' : '#2a0e08';
    ec.fillRect(px - 1, py - 1, 2, 2);
  }

  function outIcon(b, px, py, t) {
    if (!b.out) return;
    const item = Object.keys(b.out).find((k) => b.out[k] > 0);
    if (!item) return;
    const bob = Math.round(Math.sin(t * 4) * 1.5);
    sc.globalAlpha = 0.9;
    sc.drawImage(S.icon[item], 0, 0, 16, 16, px + 4, py - 10 + bob, 8, 8);
    sc.globalAlpha = 1;
  }

  function drawBuilding(w, b, x, y, t) {
    const px = x * TILE, py = y * TILE;
    switch (b.t) {
      case 'torch': {
        const lit = b.fuel > 0;
        sc.drawImage(S.bld.torch[lit ? 0 : 1], px, py);
        if (lit) drawFlame(ec, px + 8, py + 5, 4, b.fuel < 20 ? 3 : 5, b.net === 'e' ? TEAL_PAL : b.conn ? FLAME_PALETTES[2] : TORCH_PAL, t, x * 1.7 + y);
        break;
      }
      case 'kindling': sc.drawImage(S.bld.kindling[b.g < 0.4 ? 0 : b.g < 1 ? 1 : 2], px, py); outIcon(b, px, py, t); drawFeedLinks(w, b, x, y, t); break;
      case 'sapling': sc.drawImage(S.bld.sapling[b.g < 1 ? 0 : 1], px, py - 4); outIcon(b, px, py - 4, t); drawFeedLinks(w, b, x, y, t); break;
      case 'rot_pit': {
        sc.drawImage(S.bld.rot_pit, px, py);
        if (b.in > 0) {
          for (let i = 0; i < Math.min(5, b.in); i++) { sc.fillStyle = i % 2 ? '#8a5a22' : '#b8742a'; sc.fillRect(px + 5 + i, py + 8 + (i % 2), 2, 1); }
          const ph = (t * 1.5 + x) % 1;
          sc.fillStyle = '#6a5a30'; sc.fillRect(px + 6 + ((x * 3) % 4), py + 11 - Math.round(ph * 2), 1, 1);
        }
        outIcon(b, px, py, t);
        drawFeedLinks(w, b, x, y, t);
        break;
      }
      case 'resin_tap':
        sc.drawImage(S.bld.resin_tap, px, py);
        if (b.on && Math.sin(t * 3 + x) > 0.6) { sc.fillStyle = '#ffcf5a'; sc.fillRect(px + 10, py + 8 + Math.round((t * 4) % 3), 1, 1); }
        outIcon(b, px, py, t);
        break;
      case 'glowmoss': sc.drawImage(S.bld.glowmoss, px, py); glowmossSparks(px, py, t, x * 7 + y); break;
      case 'crate': {
        sc.drawImage(S.bld.crate, px, py);
        const first = Object.keys(b.store || {}).find((k) => b.store[k] > 0);
        if (first) sc.drawImage(S.icon[first], 0, 0, 16, 16, px + 4, py + 4, 8, 8);
        break;
      }
      case 'hearth': case 'fire_brick': case 'ember_stone': {
        const ringStage = FIRE_STAGES.findIndex((f) => f.block === b.t && Math.max(Math.abs(x), Math.abs(y)) === f.ring);
        if (ringStage > 0 && w.stage() >= ringStage) break; // fused into the fire pit
        sc.drawImage(S.bld[b.t], px, py);
        // ring blocks around a living fire glow at their seams
        if (w.fire.fuel > 0 && Math.max(Math.abs(x), Math.abs(y)) <= 3 && w.rootNodeAt(x, y)?.net === 'fire') {
          ec.fillStyle = Math.sin(t * 3 + x + y) > 0 ? '#a83a1a' : '#7a2a10';
          if (b.t === 'ember_stone') { ec.fillRect(px + 3, py + 4, 1, 1); ec.fillRect(px + 8, py + 9, 1, 1); ec.fillRect(px + 11, py + 5, 1, 1); }
          else { ec.fillRect(px + 7, py + 10, 3, 1); ec.fillRect(px + 8, py + 11, 1, 1); }
        }
        break;
      }
      case 'kiln': case 'press': case 'coal_bed': case 'forge_core': case 'watchfire': case 'heart_seed': {
        drawMultiblock(w, b, x, y, t);
        break;
      }
      default: { const spr = S.bld[b.t]; if (spr) sc.drawImage(Array.isArray(spr) ? spr[0] : spr, px, py); }
    }
  }

  // A wall block of a fused (formed) multiblock is drawn as part of its core's big sprite.
  function fusedWallAt(w, b, x, y) {
    if (MULTIBLOCKS[b.t] || !b) return false;
    const c = w.formedCoreAt(x, y);
    return !!(c && MULTIBLOCKS[c[2].t].fuse);
  }

  function glowmossSparks(px, py, t, seed) {
    for (const [cx, cy] of [[4, 8], [9, 7], [12, 11], [6, 12]]) {
      ec.fillStyle = Math.sin(t * 1.5 + seed + cx) > 0 ? '#6af0b0' : '#2a8a60';
      ec.fillRect(px + cx, py + cy, 1, 1);
    }
  }

  function drawMultiblock(w, b, x, y, t) {
    const m = MULTIBLOCKS[b.t], h = (m.size - 1) / 2;
    const px = x * TILE, py = y * TILE;
    const formed = S.formed[b.t];
    if (!b.ok || !formed) { sc.drawImage(S.bld[b.t], px, py); outIcon(b, px, py, t); return; }
    drawFeedLinks(w, b, x, y, t);
    const [spr, ox, oy] = formed;
    const fx = px - h * TILE + ox, fy = py - h * TILE + oy;
    if (b.t === 'heart_seed') {
      // the grove's tree grows from a sprout to full size
      const g = Math.max(0.25, b.g ?? 0);
      const wdt = Math.round(spr.width * g), hgt = Math.round(spr.height * g);
      sc.drawImage(spr, Math.round(px + 8 - wdt / 2), Math.round(py + 12 - hgt), wdt, hgt);
      for (let i = 0; i < 6; i++) if (Math.sin(t * 2 + i * 1.7) > 0.3) { ec.fillStyle = i % 2 ? '#ffb070' : '#6af0b0'; ec.fillRect(Math.round(px + 8 - wdt / 3 + (i * wdt) / 9), Math.round(py + 12 - hgt * (0.3 + (i % 3) * 0.2)), 1, 1); }
      outIcon(b, px, py - hgt + 12, t);
      return;
    }
    sc.drawImage(spr, fx, fy);
    const pal = b.net === 'e' ? TEAL_PAL : FLAME_PALETTES[1];
    const cx = px + 8;
    if (b.t === 'kiln') {
      if (b.on) {
        // glow in the firebox mouth (the arch is at x 17..31, y 38..53 of the sprite)
        ec.fillStyle = pal[3]; ec.fillRect(fx + 18, fy + 42, 12, 11);
        ec.fillStyle = pal[2]; ec.fillRect(fx + 19, fy + 46, 10, 7);
        drawFlame(ec, fx + 24, fy + 52, 10, 8, pal, t, x);
        if (Math.random() < 0.08) R.parts.push({ x: fx + 33, y: fy - 1, vx: (Math.random() - 0.5) * 4, vy: -10, g: 0, size: 2, grow: 1.5, emit: false, life: 2.5, max: 2.5, drag: 0, col: '#4a4652', a: 0.4 });
      }
    } else if (b.t === 'press') {
      if (b.on && Math.sin(t * 4) > 0) { sc.fillStyle = '#5a4228'; sc.fillRect(fx + 18 + Math.round((t * 6) % 12), fy + 41, 1, 1); }
    } else if (b.t === 'coal_bed') {
      for (const [vx, vy] of [[24, 40], [52, 36], [38, 58]]) {
        ec.fillStyle = b.on ? (Math.sin(t * 3 + vx) > 0 ? pal[1] : pal[2]) : '#2a0e08';
        ec.fillRect(fx + vx + 1, fy + vy + 1, 6, 3);
        if (b.on && Math.random() < 0.03) R.parts.push({ x: fx + vx + 4, y: fy + vy - 2, vx: 0, vy: -8, g: 0, size: 2, grow: 1.2, emit: false, life: 2, max: 2, drag: 0, col: '#4a4652', a: 0.35 });
      }
    } else if (b.t === 'forge_core') {
      const glow = b.on ? 1 : 0.35;
      for (const [sx, hh] of [[40, 34], [32, 20], [48, 24], [36, 14], [44, 16]]) {
        for (let i = 0; i < hh; i += 2) if (Math.sin(t * 3 + i * 0.5 + sx) > 1 - glow * 1.4) { ec.fillStyle = i > hh - 6 ? '#ffe0f0' : '#ff6a8a'; ec.fillRect(fx + sx, fy + 66 - i, 1, 1); }
      }
      if (b.on && Math.random() < 0.2) P({ x: fx + 40 + (Math.random() - 0.5) * 16, y: fy + 34, vy: -15 - Math.random() * 15, life: 1 + Math.random(), col: Math.random() < 0.5 ? '#ff8ad8' : '#ffd0c0', emit: true });
    } else if (b.t === 'watchfire') {
      if (b.lit) {
        drawFlame(ec, cx, fy + 12, 22, 22 + Math.sin(t * 2) * 2, pal, t, x * 0.7);
        if (Math.random() < 0.4) P({ x: cx + (Math.random() - 0.5) * 18, y: fy + 4, vx: (Math.random() - 0.5) * 10, vy: -25 - Math.random() * 30, life: 1 + Math.random(), col: pal[1 + ((Math.random() * 2) | 0)], emit: true });
      } else { ec.fillStyle = '#2a1a10'; ec.fillRect(fx + 12, fy + 14, 24, 1); }
    }
    outIcon(b, fx + (spr.width >> 1) - 8, fy + 10, t);
  }

  // Chevrons on the shared edge when a plant or building feeds the building beside it.
  function drawFeedLinks(w, b, x, y, t) {
    for (const [, , , ex, ey, fx, fy] of w.feedTargets(x, y, b.t)) {
      const dx = ex - fx, dy = ey - fy;
      const mx = fx * TILE + 8 + dx * 8, my = fy * TILE + 8 + dy * 8;
      const pulse = (Math.sin(t * 5 + x + y) + 1) / 2;
      ec.fillStyle = pulse > 0.5 ? '#ffb070' : '#a85a2a';
      for (let i = -1; i <= 1; i++) {
        // arrow pointing from producer to consumer
        const ax = dx ? mx - dx * Math.abs(i) : mx + i, ay = dy ? my - dy * Math.abs(i) : my + i;
        ec.fillRect(Math.round(ax), Math.round(ay), 1, 1);
      }
    }
  }

  function drawPlayer(st, p, t) {
    const w = st.world;
    const px = Math.round(p.rx * TILE - 8), py = Math.round(p.ry * TILE + 0.3 * TILE - 16);
    sc.globalAlpha = 0.35; sc.fillStyle = '#000'; sc.fillRect(px + 4, py + 14, 8, 2); sc.globalAlpha = 1;
    const frame = p.m ? 1 + (Math.floor(t * 8) % 2) : 0;
    const spr = S.player(p.color, frame);
    const bob = p.m && frame === 1 ? -1 : 0;
    sc.save();
    if (p.f < 0) { sc.translate(px + 16, py + bob); sc.scale(-1, 1); sc.drawImage(spr, 0, 0); }
    else sc.drawImage(spr, px, py + bob);
    sc.restore();
    const tx = Math.floor(p.rx), ty = Math.floor(p.ry);
    if (p.held > 0 && !w.sharedLit(tx, ty)) {
      const hx = p.f < 0 ? px + 3 : px + 12, hy = py + 6 + bob;
      sc.fillStyle = '#6a4a2a'; sc.fillRect(hx, hy, 1, 5);
      drawFlame(ec, hx, hy, 3, p.held < 15 ? 2 + Math.round(Math.random()) : 4, TORCH_PAL, t, p.id * 3.3);
    }
  }

  function drawOverlay(st, t, dt) {
    const s = R.scale, dpr = R.dpr;
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.clearRect(0, 0, overlay.width, overlay.height);
    oc.imageSmoothingEnabled = false; // crisp pixel previews (resizing resets this)
    const toS = (wx, wy) => [(wx - R.camX) * s, (wy - R.camY) * s];
    const w = st.world;

    // Ghosts: where the missing wall blocks of an unfinished multiblock go, and the next ring
    // around the campfire once you've started it (or are holding its block).
    const ghost = (gx, gy, item) => {
      const [sx, sy] = toS(gx * TILE, gy * TILE);
      oc.globalAlpha = 0.16 + 0.06 * Math.sin(t * 3);
      oc.drawImage(S.icon[item], sx, sy, TILE * s, TILE * s);
      oc.globalAlpha = 0.45;
      oc.fillStyle = '#e0a060';
      const c = s * 3, lw = s;
      for (const [ax, ay] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const X = sx + ax * (TILE * s - lw), Y = sy + ay * (TILE * s - lw);
        oc.fillRect(ax ? X - c + lw : X, Y, c, lw);
        oc.fillRect(X, ay ? Y - c + lw : Y, lw, c);
      }
    };
    for (const [k, b] of w.bld) {
      const m = MULTIBLOCKS[b.t];
      if (!m || b.ok) continue;
      const [x, y] = k.split(',').map(Number);
      for (const [gx, gy] of w.mbTiles(x, y, b.t)) if ((gx !== x || gy !== y) && w.getB(gx, gy)?.t !== m.wall) ghost(gx, gy, m.wall);
    }
    const next = FIRE_STAGES[w.stage() + 1];
    if (next) {
      const held = st.inv[st.sel]?.item === next.block;
      const ring = [];
      for (let y = -next.ring; y <= next.ring; y++) for (let x = -next.ring; x <= next.ring; x++) if (Math.max(Math.abs(x), Math.abs(y)) === next.ring) ring.push([x, y]);
      if (held || ring.some(([x, y]) => w.getB(x, y)?.t === next.block)) for (const [x, y] of ring) if (w.getB(x, y)?.t !== next.block) ghost(x, y, next.block);
    }
    oc.globalAlpha = 1;

    // hover target
    const h = st.hover;
    if (h && !st.me.dead && !st.uiBlocking) {
      const [sx, sy] = toS(h.x * TILE, h.y * TILE);
      const reach = Math.hypot(h.x + 0.5 - st.me.x, h.y + 0.5 - st.me.y) <= REACH + 0.75;
      const sel = st.inv[st.sel];
      const placeable = sel && ITEMS[sel.item]?.place && !w.getB(h.x, h.y) && !(w.getFeature(h.x, h.y) && !FEATURES[w.getFeature(h.x, h.y).t]?.loose) && !(h.x === 0 && h.y === 0);
      if (placeable && reach) {
        oc.globalAlpha = 0.45;
        oc.drawImage(S.icon[sel.item], sx, sy, TILE * s, TILE * s);
        oc.globalAlpha = 1;
      }
      oc.strokeStyle = reach ? 'rgba(255,240,210,0.7)' : 'rgba(255,90,70,0.5)';
      oc.lineWidth = Math.max(1, s / 2);
      const c = s * 3;
      oc.beginPath();
      for (const [ax, ay, bx, by] of [[0, 0, 1, 0], [0, 0, 0, 1], [1, 0, -1, 0], [1, 0, 0, 1], [0, 1, 1, 0], [0, 1, 0, -1], [1, 1, -1, 0], [1, 1, 0, -1]]) {
        const x = sx + ax * TILE * s, y = sy + ay * TILE * s;
        oc.moveTo(x, y); oc.lineTo(x + bx * c, y + by * c);
      }
      oc.stroke();
      if (st.harvest && st.harvest.p > 0) {
        oc.strokeStyle = '#ffd870'; oc.lineWidth = s;
        oc.beginPath();
        oc.arc(sx + TILE * s / 2, sy + TILE * s / 2, TILE * s * 0.38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * st.harvest.p);
        oc.stroke();
      }
    }

    // names
    oc.font = `${Math.round(13 * dpr * (R.ui || 1))}px "Tiny5", monospace`;
    oc.textAlign = 'center';
    for (const p of st.players.values()) {
      if (p.dead || p.id === st.myId) continue;
      const [sx, sy] = toS(p.rx * TILE, p.ry * TILE - 14);
      const fs = 13 * dpr * (R.ui || 1), tw = oc.measureText(p.name).width, pad = 4 * dpr;
      oc.fillStyle = 'rgba(10, 7, 8, 0.72)';
      oc.fillRect(Math.round(sx - tw / 2 - pad), Math.round(sy - fs * 0.85 - pad / 2), Math.round(tw + pad * 2), Math.round(fs + pad));
      oc.fillStyle = p.color; oc.fillText(p.name, sx, sy);
    }

    // flares: where did they come from?
    for (const f of R.flares) {
      if (f.t < 0.9) continue;
      const [fx, fy] = toS(f.x * TILE, f.y * TILE);
      const cx = overlay.width / 2, cy = overlay.height / 2;
      const dist = Math.round(Math.hypot(f.x - st.me.x, f.y - st.me.y));
      const fade = Math.min(1, (FLARE_TIME - f.t) / 4);
      const label = `${f.name} · ${dist}m`;
      const m = 40 * dpr;
      oc.globalAlpha = fade;
      oc.font = `${Math.round(12 * dpr * (R.ui || 1))}px "Tiny5", monospace`;
      oc.textAlign = 'center';
      if (fx > m && fx < overlay.width - m && fy > m && fy < overlay.height - m) {
        const tw = oc.measureText(label).width;
        oc.fillStyle = 'rgba(10, 7, 8, 0.72)'; oc.fillRect(fx - tw / 2 - 4 * dpr, fy + 8 * dpr, tw + 8 * dpr, 16 * dpr);
        oc.fillStyle = f.color; oc.fillText(label, fx, fy + 20 * dpr);
      } else {
        // clamp the direction to the screen edge
        const ang = Math.atan2(fy - cy, fx - cx);
        const kx = (cx - m) / Math.abs(Math.cos(ang) || 1e-6), ky = (cy - m) / Math.abs(Math.sin(ang) || 1e-6);
        const k = Math.min(kx, ky);
        const ax = cx + Math.cos(ang) * k, ay = cy + Math.sin(ang) * k;
        const sz = 12 * dpr * (R.ui || 1);
        oc.save(); oc.translate(ax, ay); oc.rotate(ang);
        oc.fillStyle = 'rgba(10, 7, 8, 0.8)';
        oc.beginPath(); oc.moveTo(sz + 3 * dpr, 0); oc.lineTo(-sz * 0.7 - 2 * dpr, -sz * 0.8 - 2 * dpr); oc.lineTo(-sz * 0.7 - 2 * dpr, sz * 0.8 + 2 * dpr); oc.fill();
        oc.fillStyle = Math.sin(f.t * 6) > 0 ? f.color : '#fff6d8';
        oc.beginPath(); oc.moveTo(sz, 0); oc.lineTo(-sz * 0.7, -sz * 0.8); oc.lineTo(-sz * 0.7, sz * 0.8); oc.fill();
        oc.restore();
        const lx = ax - Math.cos(ang) * 34 * dpr, ly = ay - Math.sin(ang) * 26 * dpr;
        const tw = oc.measureText(label).width;
        oc.fillStyle = 'rgba(10, 7, 8, 0.72)'; oc.fillRect(lx - tw / 2 - 4 * dpr, ly - 12 * dpr, tw + 8 * dpr, 16 * dpr);
        oc.fillStyle = f.color; oc.fillText(label, lx, ly);
      }
      oc.globalAlpha = 1;
    }

    // floating texts
    oc.font = `${Math.round(13 * dpr * (R.ui || 1))}px "Tiny5", monospace`;
    R.floats = R.floats.filter((f) => (f.life -= dt) > 0);
    for (const f of R.floats) {
      const [sx, sy] = toS(f.x * TILE, f.y * TILE - (1.6 - f.life) * 10);
      oc.globalAlpha = Math.min(1, f.life);
      oc.fillStyle = '#000'; oc.fillText(f.text, sx + dpr, sy + dpr);
      oc.fillStyle = f.col; oc.fillText(f.text, sx, sy);
    }
    oc.globalAlpha = 1;
  }

  return R;
}
