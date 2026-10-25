import { CHUNK } from './constants.js';
import { hash3, fbm, mulberry32 } from './rng.js';

export const chunkOf = (v) => Math.floor((v + CHUNK / 2) / CHUNK);

// Fisher-Yates. Never use array.sort with a random comparator for world gen: browsers sort
// differently, so the client and server would build different worlds from the same seed.
function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
const K = (x, y) => x + ',' + y;

export const NOTES = [
  'Day 3. Ran out of logs. Burned the cart. Burned the wheel. Burned the map.',
  'If you find this: the dark is a wall until it isn\'t. Keep two torches. Always two.',
  'Mara went for the shrine to the north. Her torch went out halfway. We heard her for a while.',
  'The fire wanted more every hour. We fed it everything. It still wanted more.',
  'Moss glows in the old groves. It isn\'t enough to live by. It is enough to hope by.',
  'There is coal in the collapsed mine. Bring a pickaxe. Bring three torches. Come back.',
  'We tried to bring the eternal flame home. You can\'t carry forever.',
  'Roots from the fire carry its warmth. Roots from the old flames glow blue and do not tire.',
  'The kiln needs eight bricks. We had seven.',
  'I left the blueprint in the chest. I hope someone with more fire than us finds it.',
  'It didn\'t go out. We let it go out. There is a difference, and it matters to me.',
  'Rot is not the end of wood. It is wood learning to burn hotter.',
];

// Blueprints offered by shrines, by distance from the fire.
const SHRINE_BANDS = [
  [70, ['kiln', 'resin_tap', 'peat_press']],
  [130, ['blaze', 'watchfire', 'peat_press', 'resin_tap']],
  [Infinity, ['coal_bed', 'inferno', 'crystal_forge', 'watchfire']],
];

// Deterministic infinite world: same seed => same world on server and every client.
// Each chunk may hold one "site": ruin, dead campfire, shrine, collapsed mine or ancient grove.
export function makeGen(seed) {
  const siteCache = new Map();

  function site(cx, cy) {
    const k = cx + ',' + cy;
    if (siteCache.has(k)) return siteCache.get(k);
    let s = null;
    if (!(cx === 0 && cy === 0) && hash3(seed, cx, cy, 11) < 0.34) {
      const d = Math.hypot(cx, cy) * CHUNK;
      const r = hash3(seed, cx, cy, 18);
      const w = d < 40 ? [['ruin', 0.4], ['dead_fire', 0.35], ['grove', 0.25]]
        : d < 80 ? [['ruin', 0.25], ['dead_fire', 0.2], ['grove', 0.2], ['shrine', 0.2], ['mine', 0.15]]
        : [['ruin', 0.2], ['dead_fire', 0.15], ['grove', 0.15], ['shrine', 0.25], ['mine', 0.25]];
      let acc = 0, type = w[0][0];
      for (const [t, p] of w) { acc += p; if (r < acc) { type = t; break; } }
      const x = cx * CHUNK + Math.floor((hash3(seed, cx, cy, 12) - 0.5) * 4);
      const y = cy * CHUNK + Math.floor((hash3(seed, cx, cy, 13) - 0.5) * 4);
      s = { type, x, y, d, feats: new Map(), grounds: new Map(), lights: [], R: 0 };
      const rnd = mulberry32(Math.floor(hash3(seed, cx, cy, 19) * 2 ** 31));
      BUILD[type](s, rnd);
    }
    siteCache.set(k, s);
    return s;
  }

  const BUILD = {
    ruin(s, rnd) {
      s.R = 4;
      s.eternal = rnd() < 0.7;
      const door = Math.floor(rnd() * 4);
      const doors = [[0, -3], [3, 0], [0, 3], [-3, 0]];
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = s.x + dx, y = s.y + dy, m = Math.max(Math.abs(dx), Math.abs(dy));
        s.grounds.set(K(x, y), 'floor');
        if (m === 3 && !(dx === doors[door][0] && dy === doors[door][1])) s.feats.set(K(x, y), { t: rnd() < 0.2 ? 'rubble' : 'wall' });
        else if (m < 3 && rnd() < 0.08) s.feats.set(K(x, y), { t: 'rubble' });
      }
      s.feats.set(K(s.x, s.y), { t: s.eternal ? 'eternal' : 'brazier' });
      if (s.eternal) s.lights.push([s.x, s.y, 3]);
      for (const [dx, dy] of s.eternal ? [[2, 2]] : [[2, 2], [-2, -2]]) s.feats.set(K(s.x + dx, s.y + dy), { t: 'chest' });
    },
    dead_fire(s, rnd) {
      s.R = 3;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dy * dy <= 6) s.grounds.set(K(s.x + dx, s.y + dy), 'dirt');
      s.feats.set(K(s.x, s.y), { t: 'dead_fire' });
      const spots = shuffle([[1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]], rnd);
      s.feats.set(K(s.x + spots[0][0], s.y + spots[0][1]), { t: 'bedroll' });
      s.feats.set(K(s.x + spots[1][0], s.y + spots[1][1]), { t: 'note', n: Math.floor(rnd() * NOTES.length) });
      s.feats.set(K(s.x + spots[2][0], s.y + spots[2][1]), { t: 'chest' });
      if (rnd() < 0.6) s.feats.set(K(s.x + spots[3][0], s.y + spots[3][1]), { t: 'bedroll' });
      for (let i = 4; i < 7; i++) if (rnd() < 0.5) s.feats.set(K(s.x + spots[i][0], s.y + spots[i][1]), { t: 'stick' });
    },
    shrine(s, rnd) {
      s.R = 3;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s.grounds.set(K(s.x + dx, s.y + dy), 'floor');
      for (const [dx, dy] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) s.feats.set(K(s.x + dx, s.y + dy), { t: rnd() < 0.3 ? 'rubble' : 'wall' });
      const band = SHRINE_BANDS.find(([max]) => s.d < max)[1];
      s.blueprint = band[Math.floor(rnd() * band.length)];
      s.feats.set(K(s.x, s.y), { t: 'shrine' });
      s.lights.push([s.x, s.y, 2]);
    },
    mine(s, rnd) {
      s.R = 7;
      const carved = new Set();
      const carve = (x, y) => carved.add(K(x, y));
      const inside = (x, y) => Math.abs(x - s.x) <= 4 && Math.abs(y - s.y) <= 4;
      const dirs = [[0, 1], [-1, 0], [0, -1], [1, 0]];
      const side = Math.floor(rnd() * 4);
      const [ix, iy] = dirs[side];
      // entrance tunnel from the edge to the middle
      let x = s.x - ix * 6, y = s.y - iy * 6;
      for (let i = 0; i < 6; i++) {
        carve(x, y);
        if (rnd() < 0.5) carve(x + iy, y + ix);
        x += ix; y += iy;
        if (rnd() < 0.25) { const w = rnd() < 0.5 ? 1 : -1; if (inside(x + iy * w, y + ix * w)) { x += iy * w; y += ix * w; } }
      }
      // branches wander out from the middle
      const ends = [];
      for (let b = 0; b < 3; b++) {
        let [dx, dy] = dirs[(side + b) % 4];
        let bx = x, by = y;
        const len = 4 + Math.floor(rnd() * 4);
        for (let i = 0; i < len; i++) {
          carve(bx, by);
          if (rnd() < 0.45) carve(bx + dy, by + dx);
          if (rnd() < 0.3) [dx, dy] = rnd() < 0.5 ? [dy, -dx] : [-dy, dx];
          if (!inside(bx + dx, by + dy)) [dx, dy] = [-dx, -dy];
          bx += dx; by += dy;
        }
        ends.push([bx, by]);
      }
      // rock walls hug the tunnels; walls touching a tunnel may hold coal
      const walls = new Set();
      for (const k of carved) {
        const [cx, cy] = k.split(',').map(Number);
        s.grounds.set(k, 'cave');
        for (let ey = -2; ey <= 2; ey++) for (let ex = -2; ex <= 2; ex++) {
          const wk = K(cx + ex, cy + ey);
          const out = -((cx + ex - s.x) * ix + (cy + ey - s.y) * iy); // distance out past the entrance side
          if (!carved.has(wk) && out < 6 && Math.abs(cx + ex - s.x) <= 7 && Math.abs(cy + ey - s.y) <= 7) walls.add(wk);
        }
      }
      for (const wk of walls) {
        const [wx, wy] = wk.split(',').map(Number);
        const touch = dirs.some(([ex, ey]) => carved.has(K(wx + ex, wy + ey)));
        s.grounds.set(wk, 'cave');
        s.feats.set(wk, { t: touch && rnd() < 0.18 ? 'coal_seam' : 'cave_wall' });
      }
      // geodes at the deepest ends, plus a forgotten chest
      ends.forEach(([ex, ey], i) => {
        for (const [dx, dy] of dirs) {
          const k = K(ex + dx, ey + dy);
          if (s.feats.get(k)?.t === 'cave_wall') { s.feats.set(k, { t: i < 2 ? 'geode' : 'coal_seam' }); break; }
        }
      });
      const [chx, chy] = ends[2];
      s.feats.set(K(chx, chy), { t: 'chest' });
    },
    grove(s, rnd) {
      s.R = 6;
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (dx * dx + dy * dy <= 26) s.grounds.set(K(s.x + dx, s.y + dy), 'moss');
      s.feats.set(K(s.x, s.y), { t: 'ancient_tree' });
      s.lights.push([s.x, s.y, 2]); // the old tree glows faintly
      for (let i = 0; i < 12; i++) {
        const a = rnd() * Math.PI * 2, r = 2 + rnd() * 3;
        const x = Math.round(s.x + Math.cos(a) * r), y = Math.round(s.y + Math.sin(a) * r);
        if (s.feats.has(K(x, y)) || (x === s.x && y === s.y)) continue;
        s.feats.set(K(x, y), { t: 'glowmoss' });
        s.lights.push([x, y, 1]);
      }
      for (let i = 0; i < 6; i++) {
        const a = rnd() * Math.PI * 2, r = 3 + rnd() * 2.5;
        const x = Math.round(s.x + Math.cos(a) * r), y = Math.round(s.y + Math.sin(a) * r);
        if (!s.feats.has(K(x, y))) s.feats.set(K(x, y), { t: rnd() < 0.5 ? 'tree' : 'bush' });
      }
    },
  };

  function siteAt(x, y) {
    const s = site(chunkOf(x), chunkOf(y));
    if (s && Math.abs(x - s.x) <= s.R && Math.abs(y - s.y) <= s.R) return s;
    return null;
  }

  function ground(x, y) {
    const s = siteAt(x, y);
    const g = s?.grounds.get(K(x, y));
    if (g) return g;
    const cheb = Math.max(Math.abs(x), Math.abs(y));
    if (cheb > 6 && !s && fbm(seed + 1, x, y, 20) > 0.74) return 'water';
    const n = fbm(seed + 2, x, y, 10);
    return n > 0.6 ? 'dirt' : n < 0.35 ? 'dark' : 'grass';
  }

  function feature(x, y) {
    const s = siteAt(x, y);
    if (s) { const f = s.feats.get(K(x, y)); return f ? { ...f } : null; }
    if (ground(x, y) === 'water') return null;
    const cheb = Math.max(Math.abs(x), Math.abs(y));
    if (cheb <= 6) return null; // the campsite starts empty (13x13 around the fire)
    const forest = fbm(seed + 3, x, y, 14);
    if (hash3(seed, x, y, 1) < (forest > 0.62 ? 0.03 : 0.004)) return { t: 'tree' };
    const h = hash3(seed, x, y, 2);
    if (h < 0.006) return { t: 'bush' };
    if (h < 0.009) return { t: 'rock' };
    if (h < 0.024) return { t: 'leaf' };
    if (h < 0.0315) return { t: 'stick' };
    if (h < 0.0345) return { t: 'pebble' };
    return null;
  }

  function loot(x, y) {
    const rnd = mulberry32(Math.floor(hash3(seed, x, y, 99) * 2 ** 31));
    const s = siteAt(x, y);
    const dist = Math.hypot(x, y);
    const out = [];
    const add = (item, lo, hi) => out.push([item, lo + Math.floor(rnd() * (hi - lo + 1))]);
    const rolls = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < rolls; i++) {
      const p = rnd();
      if (s?.type === 'mine') {
        if (p < 0.35) add('coal', 1, 3); else if (p < 0.6) add('torch', 2, 4); else if (p < 0.8) add('charcoal', 2, 4); else add('stone', 4, 8);
        continue;
      }
      if (p < 0.18) add('stick', 3, 8);
      else if (p < 0.34) add('log', 2, 4);
      else if (p < 0.5) add('torch', 2, 4);
      else if (p < 0.6) add('stone', 3, 6);
      else if (p < 0.7) add('seed', 1, 3);
      else if (p < 0.78) add('sapling', 1, 2);
      else if (p < 0.88) add(dist > 90 ? 'lignite' : dist > 40 ? 'charcoal' : 'peat', 1, 3);
      else if (p < 0.94) add(dist > 60 ? 'resin' : 'peat', 1, 2);
      else if (!out.some((e) => e[0] === 'axe')) add('axe', 1, 1);
    }
    // at most one blueprint per chest
    const bp = (id, chance) => { if (rnd() < chance && !out.some((e) => e[0].startsWith('bp_'))) out.push(['bp_' + id, 1]); };
    if (s?.type === 'dead_fire') { bp('watchfire', dist > 40 ? 0.25 : 0); bp('kiln', 0.2); bp('resin_tap', 0.15); }
    else if (s?.type === 'mine') { bp('coal_bed', 0.2); bp('blaze', 0.15); }
    else { bp('kiln', 0.35); bp('resin_tap', dist > 30 ? 0.2 : 0); bp('peat_press', dist > 40 ? 0.15 : 0); }
    return out;
  }

  return { site, siteAt, ground, feature, loot };
}
