import { CHUNK } from './constants.js';
import { hash3, fbm, mulberry32 } from './rng.js';

export const chunkOf = (v) => Math.floor((v + CHUNK / 2) / CHUNK);

// Deterministic infinite world: same seed => same world on server and every client.
export function makeGen(seed) {
  const ruinCache = new Map();

  function ruin(cx, cy) {
    const k = cx + ',' + cy;
    if (ruinCache.has(k)) return ruinCache.get(k);
    let r = null;
    if (!(cx === 0 && cy === 0) && hash3(seed, cx, cy, 11) < 0.3) {
      const ox = Math.floor((hash3(seed, cx, cy, 12) - 0.5) * 10);
      const oy = Math.floor((hash3(seed, cx, cy, 13) - 0.5) * 10);
      const eternal = hash3(seed, cx, cy, 14) < 0.7;
      r = {
        x: cx * CHUNK + ox,
        y: cy * CHUNK + oy,
        eternal,
        door: Math.floor(hash3(seed, cx, cy, 15) * 4),
        chests: eternal ? [[2, 2]] : [[2, 2], [-2, -2]],
      };
    }
    ruinCache.set(k, r);
    return r;
  }

  function ruinAt(x, y) {
    const r = ruin(chunkOf(x), chunkOf(y));
    if (r && Math.abs(x - r.x) <= 4 && Math.abs(y - r.y) <= 4) return r;
    return null;
  }

  function ground(x, y) {
    const r = ruinAt(x, y);
    if (r && Math.max(Math.abs(x - r.x), Math.abs(y - r.y)) <= 3) return 'floor';
    const cheb = Math.max(Math.abs(x), Math.abs(y));
    if (cheb > 6 && !r && fbm(seed + 1, x, y, 20) > 0.68) return 'water';
    const g = fbm(seed + 2, x, y, 10);
    return g > 0.6 ? 'dirt' : g < 0.35 ? 'dark' : 'grass';
  }

  function feature(x, y) {
    const r = ruinAt(x, y);
    if (r) {
      const dx = x - r.x, dy = y - r.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      if (dx === 0 && dy === 0) return { t: r.eternal ? 'eternal' : 'brazier' };
      for (const [cx, cy] of r.chests) if (dx === cx && dy === cy) return { t: 'chest' };
      if (m === 3) {
        const doors = [[0, -3], [3, 0], [0, 3], [-3, 0]];
        const [ddx, ddy] = doors[r.door];
        if (dx === ddx && dy === ddy) return null;
        return hash3(seed, x, y, 16) < 0.2 ? { t: 'rubble' } : { t: 'wall' };
      }
      if (m < 3 && hash3(seed, x, y, 17) < 0.08) return { t: 'rubble' };
      return null;
    }
    if (ground(x, y) === 'water') return null;
    const cheb = Math.max(Math.abs(x), Math.abs(y));
    if (cheb <= 1) return null;
    const forest = fbm(seed + 3, x, y, 14);
    if (cheb > 4 && hash3(seed, x, y, 1) < (forest > 0.62 ? 0.12 : 0.015)) return { t: 'tree' };
    const h = hash3(seed, x, y, 2);
    if (h < 0.035) return { t: 'bush' };
    if (h < 0.05 && cheb > 3) return { t: 'rock' };
    if (h < 0.1) return { t: 'leaf' };
    if (h < 0.125) return { t: 'stick' };
    if (h < 0.135) return { t: 'pebble' };
    return null;
  }

  function loot(x, y) {
    const rnd = mulberry32(Math.floor(hash3(seed, x, y, 99) * 2 ** 31));
    const dist = Math.hypot(x, y);
    const out = [];
    const add = (item, lo, hi) => out.push([item, lo + Math.floor(rnd() * (hi - lo + 1))]);
    const rolls = 3 + Math.floor(rnd() * 3);
    for (let i = 0; i < rolls; i++) {
      const p = rnd();
      if (p < 0.2) add('stick', 3, 8);
      else if (p < 0.38) add('log', 2, 4);
      else if (p < 0.55) add('torch', 2, 4);
      else if (p < 0.66) add('stone', 3, 6);
      else if (p < 0.76) add('seed', 1, 3);
      else if (p < 0.84) add('sapling', 1, 2);
      else if (p < 0.92) add(dist > 40 ? 'charcoal' : 'peat', 1, 3);
      else if (!out.some((e) => e[0] === 'axe')) add('axe', 1, 1);
    }
    if (rnd() < 0.45) out.push(['blueprint_kiln', 1]);
    return out;
  }

  return { ruin, ruinAt, ground, feature, loot };
}
