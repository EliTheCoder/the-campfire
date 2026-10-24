import { TILE, FIRE, TORCH, ETERNAL_RADIUS, REACH } from '../shared/constants.js';
import { FEATURES, BUILDINGS, ITEMS } from '../shared/defs.js';
import { hash3 } from '../shared/rng.js';
import { key, N4, N8 } from '../shared/world.js';
import { chunkOf } from '../shared/worldgen.js';
import { makePost } from './post.js';
import { drawFlame, lerpPalette, ETERNAL_PALETTE, FLAME_PALETTES } from './sprites.js';

const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
const TORCH_PAL = FLAME_PALETTES[1];

export function createRenderer(glCanvas, overlay, S) {
  const scene = document.createElement('canvas');
  const emit = document.createElement('canvas');
  const sc = scene.getContext('2d');
  const ec = emit.getContext('2d');
  const oc = overlay.getContext('2d');
  let post = null;
  try { post = makePost(glCanvas); } catch (e) { console.error('WebGL post failed', e); }
  const fallback = post ? null : glCanvas.getContext('2d');

  const R = { scale: 3, W: 0, H: 0, camX: 0, camY: 0, parts: [], flash: 0, shake: 0, palette: false, floats: [] };
  let lightData = new Uint8Array(1);

  R.resize = () => {
    const dpr = window.devicePixelRatio || 1;
    R.scale = Math.max(2, Math.round((innerHeight * dpr) / 280));
    R.W = Math.ceil((innerWidth * dpr) / R.scale);
    R.H = Math.ceil((innerHeight * dpr) / R.scale);
    for (const c of [scene, emit, glCanvas]) { c.width = R.W; c.height = R.H; }
    overlay.width = innerWidth * dpr; overlay.height = innerHeight * dpr;
    R.dpr = dpr;
    sc.imageSmoothingEnabled = false; ec.imageSmoothingEnabled = false;
    if (fallback) fallback.imageSmoothingEnabled = false;
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
    const ratio = Math.min(1, fuel / FIRE.maxFuel);
    const stage = fireStage(fuel);
    const pal = lerpPalette(w.fire.temp);
    const wind = st.weather.s === 'wind' ? 50 : 0;
    // fire embers + smoke
    if (fuel > 0) {
      const rate = [3, 7, 12, 18, 28][stage];
      for (let n = rate * dt; n > 0; n--) if (Math.random() < n) P({ x: 8 + (Math.random() - 0.5) * (6 + stage * 2), y: 6 - stage, vx: (Math.random() - 0.5) * 12 + wind * 0.5, vy: -20 - Math.random() * (20 + stage * 10), life: 0.8 + Math.random() * 1.8, col: pal[1 + ((Math.random() * 3) | 0) % 3], emit: true, wobble: Math.random() * 9, wobbleAmt: 40 });
      if (Math.random() < (2 + stage * 1.5) * dt) P({ x: 8 + (Math.random() - 0.5) * 6, y: -6 - stage * 3, vx: (Math.random() - 0.5) * 6 + wind, vy: -12 - Math.random() * 8, life: 2.5 + Math.random() * 2, col: '#4a4652', a: 0.35, size: 2, grow: 1.5 });
    }
    // torches & eternal flames on screen
    for (const [k, b] of w.bld) {
      if (b.t !== 'torch' || b.fuel <= 0) continue;
      const [x, y] = k.split(',').map(Number);
      if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
      if (Math.random() < 1.5 * dt) P({ x: x * 16 + 8 + (Math.random() - 0.5) * 3, y: y * 16 + 2, vx: (Math.random() - 0.5) * 8 + wind * 0.5, vy: -15 - Math.random() * 15, life: 0.6 + Math.random(), col: TORCH_PAL[1 + ((Math.random() * 2) | 0)], emit: true });
    }
    for (const r of view.ruins) {
      if (!r.eternal) continue;
      if (Math.random() < 4 * dt) {
        const a = Math.random() * Math.PI * 2, d = 6 + Math.random() * 40;
        P({ x: r.x * 16 + 8 + Math.cos(a) * d, y: r.y * 16 + 8 + Math.sin(a) * d, vx: (Math.random() - 0.5) * 6, vy: -4 - Math.random() * 6, life: 2 + Math.random() * 2, col: ETERNAL_PALETTE[(Math.random() * 3) | 0], emit: true, wobble: Math.random() * 9, wobbleAmt: 10 });
      }
      if (Math.random() < 3 * dt) P({ x: r.x * 16 + 8 + (Math.random() - 0.5) * 6, y: r.y * 16 - 2, vy: -20 - Math.random() * 20, life: 0.7 + Math.random(), col: ETERNAL_PALETTE[1], emit: true });
    }
    // rain
    if (st.weather.s === 'rain') {
      const n = (R.W * R.H) / 900 * dt * 60;
      for (let i = 0; i < n; i++) {
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
    const sx = R.shake ? (Math.random() - 0.5) * 6 * R.shake : 0, sy = R.shake ? (Math.random() - 0.5) * 6 * R.shake : 0;
    R.camX = Math.round(me.x * TILE - R.W / 2 + sx);
    R.camY = Math.round(me.y * TILE - R.H / 2 + sy);
    const camX = R.camX, camY = R.camY;
    const x0 = Math.floor(camX / TILE) - 1, y0 = Math.floor(camY / TILE) - 2;
    const x1 = Math.ceil((camX + R.W) / TILE) + 1, y1 = Math.ceil((camY + R.H) / TILE) + 2;
    const ruins = [];
    for (let cy = chunkOf(y0) - 1; cy <= chunkOf(y1) + 1; cy++) for (let cx = chunkOf(x0) - 1; cx <= chunkOf(x1) + 1; cx++) { const r = w.gen.ruin(cx, cy); if (r) ruins.push(r); }
    const view = { x0, y0, x1, y1, ruins };

    emitAmbient(st, dt, t, view);
    updateParticles(dt);

    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.fillStyle = '#000'; sc.fillRect(0, 0, R.W, R.H);
    ec.setTransform(1, 0, 0, 1, 0, 0);
    ec.clearRect(0, 0, R.W, R.H);
    ec.fillStyle = '#000'; ec.fillRect(0, 0, R.W, R.H);
    sc.setTransform(1, 0, 0, 1, -camX, -camY);
    ec.setTransform(1, 0, 0, 1, -camX, -camY);

    // ground
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const g = w.ground(x, y);
      const arr = S.ground[g];
      const spr = g === 'water' ? arr[Math.floor(t * 2 + hash3(w.seed, x, y, 5) * 3) % 3] : arr[(hash3(w.seed, x, y, 4) * arr.length) | 0];
      sc.drawImage(spr, x * TILE, y * TILE);
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
        if (b && b.t !== 'root') drawBuilding(w, b, x, y, t);
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
      const ratio = Math.min(1, fuel / FIRE.maxFuel);
      sq(0, 0, FIRE.radius, (0.9 + 0.1 * ratio) * flick(1), 0.2);
      const pal = lerpPalette(w.fire.temp);
      lights.push({ x: 8 - camX, y: 4 - camY, r: TILE * (4 + 2.5 * ratio), i: (0.55 + 0.4 * ratio) * flick(2), c: rgb(pal[1]) });
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
        lights.push({ x: x * TILE + 8 - camX, y: y * TILE + 8 - camY, r: TILE * 1.2, i: 0.25, c: rgb('#ff5a1a') });
      }
    }
    for (const r of ruins) {
      if (!r.eternal) continue;
      sq(r.x, r.y, ETERNAL_RADIUS, 0.82 * flick(r.x), 0.15);
      lights.push({ x: r.x * TILE + 8 - camX, y: r.y * TILE + 2 - camY, r: TILE * 4.5, i: 0.7 * flick(r.y), c: rgb(ETERNAL_PALETTE[1]) });
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
    for (let i = 0; i < lv.length; i++) lightData[i] = Math.max(0, Math.min(255, lv[i] * 255));
    const cxs = R.W / 2, cys = R.H / 2;
    lights.sort((a, b) => Math.hypot(a.x - cxs, a.y - cys) - Math.hypot(b.x - cxs, b.y - cys));

    if (post) {
      post.render({
        scene, emit, lightData, lmW, lmH, lmOriginX: x0 * TILE - camX, lmOriginY: y0 * TILE - camY, lights,
        time: t, rain: st.weather.s === 'rain' ? 1 : 0, cold: me.dead ? 0 : Math.min(1, me.cold / 6 + (me.freezing ? 0.25 : 0)),
        pal: R.palette, flash: R.flash, dead: me.dead ? 0.8 : 0,
      });
    } else {
      fallback.drawImage(scene, 0, 0);
      fallback.globalCompositeOperation = 'lighter';
      fallback.drawImage(emit, 0, 0);
      fallback.globalCompositeOperation = 'source-over';
    }
    drawOverlay(st, t, dt);
  };

  // ---------- pieces ----------
  function fireStage(fuel) {
    const r = fuel / FIRE.maxFuel;
    return fuel <= 0 ? -1 : r < 0.08 ? 0 : r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.8 ? 3 : 4;
  }

  function drawCampfire(w, t) {
    sc.drawImage(S.campfire, -4, 0);
    const stage = fireStage(w.fire.fuel);
    if (stage < 0) { ec.fillStyle = '#3a1a10'; ec.fillRect(5, 9, 6, 1); return; }
    const pal = lerpPalette(w.fire.temp);
    const H = [3, 7, 11, 15, 20][stage], Wd = [5, 8, 10, 12, 14][stage];
    // embers bed
    for (let i = 0; i < 10; i++) { ec.fillStyle = (Math.sin(t * 4 + i * 1.7) > 0.2) ? pal[2] : pal[3]; ec.fillRect(4 + i, 9 + (i % 2), 1, 1); }
    if (stage >= 2) { drawFlame(ec, 4, 10, Wd * 0.5, H * 0.55, pal, t, 4.1); drawFlame(ec, 12, 10, Wd * 0.5, H * 0.6, pal, t, 7.3); }
    drawFlame(ec, 8, 10, Wd, H, pal, t, 1.3);
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
        break;
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
    const d = w.rootDistAt(x, y) ?? 0;
    for (const [dx, dy] of N4) {
      const nx = x + dx, ny = y + dy;
      const nb = w.getB(nx, ny);
      const link = (nx === 0 && ny === 0) || nb?.t === 'root' || (nb && nb.t !== 'root' && w.connected(nx, ny));
      if (!link) continue;
      const len = Math.round(8 * g);
      for (let i = 0; i <= len; i++) {
        const lx = px + dx * i, ly = py + dy * i;
        const wig = Math.round(Math.sin((x * 3 + y * 5 + i) * 1.3) * 0.6);
        sc.fillStyle = '#2a120c'; sc.fillRect(lx - 1 + (dy ? wig : 0), ly - 1 + (dx ? wig : 0), 3, 3);
        if (powered && g >= 1) {
          const pulse = Math.sin(t * 6 - (d * 8 + i) * 0.4) > 0.6;
          ec.fillStyle = pulse ? '#ffb070' : '#a8301a';
          ec.fillRect(lx + (dy ? wig : 0), ly + (dx ? wig : 0), 1, 1);
        }
      }
    }
    sc.fillStyle = '#3a1a10'; sc.fillRect(px - 2, py - 2, 4, 4);
    ec.fillStyle = powered && g >= 1 ? '#e0561f' : g < 1 ? '#5a2010' : '#2a0e08';
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
        if (lit) drawFlame(ec, px + 8, py + 5, 4, b.fuel < 20 ? 3 : 5, b.conn ? FLAME_PALETTES[2] : TORCH_PAL, t, x * 1.7 + y);
        break;
      }
      case 'kindling': sc.drawImage(S.bld.kindling[b.g < 0.4 ? 0 : b.g < 1 ? 1 : 2], px, py); outIcon(b, px, py, t); break;
      case 'sapling': sc.drawImage(S.bld.sapling[b.g < 1 ? 0 : 1], px, py - 4); outIcon(b, px, py - 4, t); break;
      case 'sprouter': {
        sc.drawImage(S.bld.sprouter, px, py);
        const lvl = Math.round((b.water / 100) * 9);
        if (lvl > 0) { sc.fillStyle = '#3d6d8a'; sc.fillRect(px + 4, py + 6, 8, 1); sc.fillStyle = '#2a4f6a'; sc.fillRect(px + 12 - 0, py + 15 - lvl, 1, lvl); }
        if (b.p > 0.2) { sc.fillStyle = '#8a6440'; sc.fillRect(px + 7, py + 5 - Math.round(b.p * 4), 1, Math.round(b.p * 4)); sc.fillStyle = '#4f8d44'; sc.fillRect(px + 8, py + 4 - Math.round(b.p * 4), 1, 1); }
        outIcon(b, px, py, t);
        break;
      }
      case 'rot_pit': {
        sc.drawImage(S.bld.rot_pit, px, py);
        if (b.in > 0) {
          for (let i = 0; i < Math.min(5, b.in); i++) { sc.fillStyle = i % 2 ? '#8a5a22' : '#b8742a'; sc.fillRect(px + 5 + i, py + 8 + (i % 2), 2, 1); }
          const ph = (t * 1.5 + x) % 1;
          sc.fillStyle = '#6a5a30'; sc.fillRect(px + 6 + ((x * 3) % 4), py + 11 - Math.round(ph * 2), 1, 1);
        }
        outIcon(b, px, py, t);
        break;
      }
      case 'kiln': {
        sc.drawImage(S.bld.kiln, px, py);
        if (b.ok && b.conn && b.in >= 2) {
          const pal = FLAME_PALETTES[1];
          ec.fillStyle = pal[2]; ec.fillRect(px + 5, py + 10, 6, 4);
          drawFlame(ec, px + 8, py + 13, 5, 4, pal, t, x);
        }
        outIcon(b, px, py, t);
        break;
      }
      case 'hearth': {
        sc.drawImage(S.bld.hearth, px, py);
        if (w.fire.fuel > 0 && Math.max(Math.abs(x), Math.abs(y)) <= 1) {
          ec.fillStyle = Math.sin(t * 3 + x) > 0 ? '#a83a1a' : '#7a2a10';
          ec.fillRect(px + 7, py + 10, 3, 1); ec.fillRect(px + 8, py + 11, 1, 1);
        }
        break;
      }
      default: { const spr = S.bld[b.t]; if (spr) sc.drawImage(Array.isArray(spr) ? spr[0] : spr, px, py); }
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

    // kiln ghosts: show where the missing bricks go
    for (const [k, b] of w.bld) {
      if (b.t !== 'kiln' || b.ok) continue;
      const [x, y] = k.split(',').map(Number);
      for (const [dx, dy] of N8) {
        if (w.getB(x + dx, y + dy)?.t === 'brick') continue;
        const [sx, sy] = toS((x + dx) * TILE, (y + dy) * TILE);
        oc.globalAlpha = 0.35 + 0.15 * Math.sin(t * 4);
        oc.drawImage(S.icon.brick, sx, sy, TILE * s, TILE * s);
        oc.globalAlpha = 0.8;
        oc.strokeStyle = '#9fd8ff'; oc.lineWidth = Math.max(1, s / 2);
        oc.setLineDash([s * 2, s * 2]);
        oc.strokeRect(sx + 1, sy + 1, TILE * s - 2, TILE * s - 2);
        oc.setLineDash([]);
      }
      oc.globalAlpha = 1;
    }

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
    oc.font = `${Math.round(7 * dpr)}px "Pixelify Sans", monospace`;
    oc.textAlign = 'center';
    for (const p of st.players.values()) {
      if (p.dead || p.id === st.myId) continue;
      const [sx, sy] = toS(p.rx * TILE, p.ry * TILE - 14);
      oc.fillStyle = 'rgba(0,0,0,0.6)'; oc.fillText(p.name, sx + dpr, sy + dpr);
      oc.fillStyle = p.color; oc.fillText(p.name, sx, sy);
    }

    // floating texts
    oc.font = `${Math.round(8 * dpr)}px "Pixelify Sans", monospace`;
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
