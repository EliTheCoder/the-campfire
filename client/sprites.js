// All art is generated procedurally at startup as small pixel canvases.
import { mulberry32 } from '../shared/rng.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

// Paint helper: p(x,y,color) sets a pixel, r(x,y,w,h,color) fills a rect.
function mk(w, h, fn) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  const p = (x, y, col) => { if (col) { ctx.fillStyle = col; ctx.fillRect(x | 0, y | 0, 1, 1); } };
  const r = (x, y, ww, hh, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, ww, hh); };
  fn({ ctx, p, r, w, h });
  return c;
}

// Blob with lighting from the top-left and a dark outline.
function blob(g, cx, cy, rx, ry, cols, rnd, jag = 0.15) {
  const [hi, mid, lo, out] = cols;
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
    const d = dx * dx + dy * dy + (rnd() - 0.5) * jag;
    if (d > 1) continue;
    const edge = d > 0.78;
    const light = -dx * 0.6 - dy * 0.8 + (rnd() - 0.5) * 0.5;
    g.p(x, y, edge ? out : light > 0.45 ? hi : light > -0.35 ? mid : lo);
  }
}

function speckle(g, rnd, n, cols) {
  for (let i = 0; i < n; i++) g.p(rnd() * g.w, rnd() * g.h, cols[(rnd() * cols.length) | 0]);
}

export function makeSprites() {
  const S = { ground: {}, feat: {}, bld: {}, icon: {} };

  // ---------- ground ----------
  const groundDef = {
    grass: ['#2d4a2b', ['#365a32', '#264026', '#335330'], ['#43703b', '#4a7a3e']],
    dark: ['#21361f', ['#2a4427', '#1b2d19', '#25391f'], ['#33522e']],
    dirt: ['#46382a', ['#53432f', '#3b2f23', '#4d3d2c'], ['#6a5a48', '#5e4f3e']],
  };
  for (const [name, [base, specks, tufts]] of Object.entries(groundDef)) {
    S.ground[name] = [0, 1, 2, 3].map((v) => mk(16, 16, (g) => {
      const rnd = mulberry32(v * 77 + name.length * 13);
      g.r(0, 0, 16, 16, base);
      speckle(g, rnd, 26, specks);
      for (let i = 0; i < 3; i++) {
        const x = (rnd() * 14) | 0, y = 2 + ((rnd() * 13) | 0), c = tufts[(rnd() * tufts.length) | 0];
        g.p(x, y, c); g.p(x + 1, y - 1, c); if (name !== 'dirt') g.p(x + 2, y, c);
      }
    }));
  }
  S.ground.floor = [0, 1, 2, 3].map((v) => mk(16, 16, (g) => {
    const rnd = mulberry32(v * 31 + 5);
    g.r(0, 0, 16, 16, '#46434d');
    g.r(0, 0, 16, 1, '#34323a'); g.r(0, 0, 1, 16, '#34323a'); g.r(0, 8, 16, 1, '#34323a'); g.r(8, 0, 1, 8, '#34323a'); g.r(4, 8, 1, 8, '#34323a'); g.r(12, 8, 1, 8, '#34323a');
    g.r(1, 1, 7, 1, '#55525e'); g.r(9, 1, 7, 1, '#55525e'); g.r(1, 9, 3, 1, '#55525e'); g.r(5, 9, 7, 1, '#55525e');
    speckle(g, rnd, 8, ['#3a5236', '#3e3b45', '#504d58']);
  }));
  S.ground.water = [0, 1, 2].map((f) => mk(16, 16, (g) => {
    g.r(0, 0, 16, 16, '#1b3448');
    const rnd = mulberry32(9);
    for (let i = 0; i < 5; i++) {
      const x = (rnd() * 16) | 0, y = (rnd() * 16) | 0;
      const xx = (x + f * 2) % 16;
      g.r(xx, y, 3, 1, '#2a4f6a');
      if (i < 2) g.p((xx + 1) % 16, y, '#4b7d9a');
    }
  }));

  // ---------- trees & plants ----------
  const leafCols = ['#4f8d44', '#376d35', '#26502a', '#14301a'];
  S.feat.tree = [0, 1, 2].map((v) => mk(16, 24, (g) => {
    const rnd = mulberry32(100 + v);
    g.r(6, 15, 4, 9, '#5a3d26'); g.r(9, 15, 1, 9, '#3e2918'); g.r(5, 22, 6, 2, '#4a3220');
    blob(g, 8, 9 + v * 0.5, 7.6 - v * 0.4, 7.4, leafCols, rnd, 0.3);
    speckle({ p: (x, y, c) => { const d = Math.hypot(x - 8, y - 9); if (d < 5.5) g.p(x, y, c); }, w: 16, h: 18 }, rnd, 7, ['#5fa050', '#2e5e2e']);
  }));
  S.feat.bare_tree = mk(16, 24, (g) => {
    const c = '#5a3d26', d = '#3e2918';
    g.r(6, 12, 4, 12, c); g.r(9, 12, 1, 12, d);
    const line = (x0, y0, x1, y1) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let i = 0; i <= n; i++) g.p(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, c); };
    line(7, 12, 3, 5); line(8, 12, 12, 4); line(8, 10, 8, 2); line(4, 7, 1, 6); line(11, 6, 14, 7); line(5, 6, 6, 2);
  });
  S.feat.stump = mk(16, 16, (g) => {
    const rnd = mulberry32(3);
    blob(g, 8, 11, 5, 3.5, ['#8a6440', '#6b4a2e', '#4a3220', '#2e1f14'], rnd, 0);
    g.r(5, 10, 6, 1, '#9a7450'); g.p(8, 11, '#5a3d26'); g.p(7, 11, '#5a3d26');
  });
  const bushCols = ['#4a8840', '#336633', '#224a25', '#12301a'];
  S.feat.bush = mk(16, 16, (g) => {
    const rnd = mulberry32(44);
    blob(g, 8, 10, 7, 5.5, bushCols, rnd, 0.35);
    for (const [x, y] of [[4, 8], [10, 7], [7, 12], [12, 11]]) g.p(x, y, '#c48a3a');
  });
  S.feat.picked_bush = mk(16, 16, (g) => {
    const c = '#5a4a30';
    for (const [x0, h] of [[4, 6], [7, 8], [10, 7], [12, 5]]) for (let i = 0; i < h; i++) g.p(x0 + (i % 3 === 0 ? 1 : 0) * (x0 > 8 ? 1 : -1), 15 - i, c);
    g.p(6, 9, '#336633'); g.p(10, 10, '#336633');
  });
  S.bld.kindling = [0.25, 0.6, 1].map((s, i) => mk(16, 16, (g) => {
    const rnd = mulberry32(55 + i);
    if (i === 0) { g.r(7, 11, 1, 4, '#3f6a32'); g.p(6, 11, '#4f8d44'); g.p(8, 10, '#4f8d44'); g.p(8, 9, '#e07a2a'); return; }
    blob(g, 8, 11 - i, 6 * s + 1, 5 * s + 0.5, bushCols, rnd, 0.3);
    for (const [x, y] of [[4, 8], [11, 7], [7, 6], [12, 11], [5, 12]]) if (Math.hypot(x - 8, y - 10) < 6 * s + 1) g.p(x, y, rnd() < 0.5 ? '#ff8a3a' : '#e05a2a');
  }));
  S.bld.sapling = [0, 1].map((stage) => mk(16, 20, (g) => {
    const rnd = mulberry32(66 + stage);
    if (stage === 0) {
      g.r(7, 13, 1, 7, '#5a3d26');
      blob(g, 7.5, 12, 3, 2.6, leafCols, rnd, 0.1);
    } else {
      g.r(7, 12, 2, 8, '#5a3d26'); g.r(8, 12, 1, 8, '#3e2918');
      blob(g, 8, 8, 6, 6, leafCols, rnd, 0.3);
      g.p(5, 7, '#c49a3a'); g.p(10, 9, '#c49a3a');
    }
  }));
  S.feat.rock = mk(16, 16, (g) => {
    const rnd = mulberry32(7);
    blob(g, 8, 10, 7, 5.5, ['#9a98a3', '#77757f', '#5a5862', '#36353c'], rnd, 0.2);
    g.p(6, 8, '#b4b2bc'); g.p(5, 9, '#b4b2bc');
  });
  S.feat.leaf = mk(16, 16, (g) => {
    for (const [x, y, c] of [[4, 9, '#b8742a'], [9, 6, '#c99a3a'], [11, 11, '#8a5a22'], [6, 12, '#c47a2a']]) { g.p(x, y, c); g.p(x + 1, y, c); g.p(x, y + 1, c); g.p(x + 1, y - 1, '#6a4418'); }
  });
  S.feat.stick = mk(16, 16, (g) => {
    for (let i = 0; i < 9; i++) { g.p(4 + i, 11 - i * 0.5, '#8a6440'); g.p(4 + i, 12 - i * 0.5, '#4a3420'); }
    g.p(8, 8, '#8a6440'); g.p(8, 7, '#8a6440');
  });
  S.feat.pebble = mk(16, 16, (g) => {
    for (const [x, y] of [[5, 10], [9, 8], [10, 12]]) { g.r(x, y, 2, 2, '#77757f'); g.p(x, y, '#9a98a3'); g.p(x + 1, y + 2, '#36353c'); }
  });

  // ---------- ruins ----------
  S.feat.wall = [0, 1].map((v) => mk(16, 20, (g) => {
    const rnd = mulberry32(200 + v);
    g.r(0, 0, 16, 20, '#3c3a44');
    for (let row = 0; row < 5; row++) {
      const off = row % 2 ? 4 : 0;
      for (let bx = -1; bx < 3; bx++) {
        const x = bx * 8 + off, y = row * 4;
        g.r(x + 1, y + 1, 6, 3, rnd() < 0.15 ? '#4e4b56' : '#5a5764');
        g.r(x + 1, y + 1, 6, 1, '#6e6b78');
      }
    }
    g.r(0, 16, 16, 4, '#2c2a32');
    speckle(g, rnd, 6, ['#3e5a38', '#4a6a40']);
  }));
  S.feat.rubble = mk(16, 16, (g) => {
    for (const [x, y] of [[2, 10], [8, 12], [10, 7], [4, 5]]) { g.r(x, y, 4, 3, '#5a5764'); g.r(x, y, 4, 1, '#6e6b78'); g.r(x, y + 3, 4, 1, '#2c2a32'); }
  });
  const basin = (g) => {
    g.r(3, 10, 10, 3, '#5a5764'); g.r(3, 10, 10, 1, '#6e6b78'); g.r(5, 13, 6, 3, '#46434d'); g.r(2, 9, 12, 1, '#7a7784');
  };
  S.feat.eternal = mk(16, 16, (g) => { basin(g); g.r(4, 9, 8, 1, '#2a2a30'); });
  S.feat.brazier = mk(16, 16, (g) => { basin(g); g.r(4, 8, 8, 2, '#5a5a5a'); g.p(6, 8, '#7a7a7a'); g.p(9, 8, '#3a3a3a'); });
  const chest = (open) => mk(16, 16, (g) => {
    if (open) { g.r(2, 3, 12, 4, '#5a3720'); g.r(3, 4, 10, 2, '#3a2414'); }
    g.r(2, 7, 12, 8, '#7a4e2a'); g.r(2, 7, 12, 1, '#9a6a3a'); g.r(2, 14, 12, 1, '#4a2e18');
    g.r(2, 10, 12, 1, '#c9a040'); g.r(4, 7, 1, 8, '#c9a040'); g.r(11, 7, 1, 8, '#c9a040');
    if (open) g.r(3, 8, 10, 2, '#1e140c');
    else { g.r(7, 9, 2, 3, '#e8c860'); g.p(7, 11, '#5a3a10'); }
  });
  S.feat.chest = chest(false);
  S.feat.chest_open = chest(true);

  // ---------- buildings ----------
  S.bld.torch = [true, false].map((lit) => mk(16, 16, (g) => {
    g.r(7, 7, 2, 9, '#6a4a2a'); g.r(8, 7, 1, 9, '#4a3220');
    g.r(6, 5, 4, 3, lit ? '#4a2a14' : '#222'); g.p(7, 5, lit ? '#8a4a1a' : '#333');
  }));
  S.bld.workbench = mk(16, 16, (g) => {
    g.r(1, 6, 14, 4, '#8a6038'); g.r(1, 6, 14, 1, '#aa7a48'); g.r(1, 9, 14, 1, '#5a3d22');
    g.r(2, 10, 2, 6, '#5a3d22'); g.r(12, 10, 2, 6, '#5a3d22');
    g.r(4, 4, 4, 2, '#8a8a92'); g.r(5, 3, 1, 1, '#aaaab2'); g.r(10, 3, 1, 4, '#6a4a2a'); g.r(9, 3, 3, 1, '#77757f');
  });
  S.bld.sprouter = mk(16, 16, (g) => {
    g.r(3, 5, 10, 11, '#6a4a2c'); g.r(4, 5, 1, 11, '#7e5a36'); g.r(11, 5, 1, 11, '#4a321e');
    g.r(3, 7, 10, 1, '#55555e'); g.r(3, 13, 10, 1, '#55555e');
    g.r(4, 5, 8, 1, '#2a2018');
  });
  S.bld.rot_pit = mk(16, 16, (g) => {
    const rnd = mulberry32(12);
    blob(g, 8, 9, 7.5, 6, ['#6e6b78', '#5a5764', '#46434d', '#2c2a32'], rnd, 0.1);
    blob(g, 8, 9.5, 5.2, 4, ['#4a3a1e', '#3a2c16', '#2a2010', '#1a140a'], rnd, 0.2);
  });
  S.bld.kiln = mk(16, 16, (g) => {
    const rnd = mulberry32(13);
    blob(g, 8, 9, 7, 7, ['#8a7a70', '#6e6058', '#54483f', '#2e2622'], rnd, 0.1);
    g.r(5, 9, 6, 5, '#1a1210'); g.r(6, 8, 4, 1, '#1a1210');
  });
  S.bld.brick = mk(16, 16, (g) => {
    g.r(0, 0, 16, 16, '#3e2a24');
    for (let row = 0; row < 4; row++) {
      const off = row % 2 ? 4 : 0;
      for (let bx = -1; bx < 3; bx++) { const x = bx * 8 + off, y = row * 4; g.r(x + 1, y + 1, 6, 3, '#7a4a3a'); g.r(x + 1, y + 1, 6, 1, '#94604c'); }
    }
  });
  S.bld.hearth = mk(16, 16, (g) => {
    const rnd = mulberry32(14);
    blob(g, 8, 10, 6.5, 5, ['#8a8492', '#6a6470', '#4e4955', '#2e2a34'], rnd, 0.15);
    g.p(7, 10, '#a04a2a'); g.p(8, 11, '#a04a2a'); g.p(9, 10, '#a04a2a');
  });
  S.campfire = mk(24, 16, (g) => {
    const stones = [[2, 10], [6, 12], [11, 13], [16, 12], [20, 10], [5, 7], [18, 7]];
    g.r(5, 10, 14, 3, '#1a1210');
    for (let i = 0; i < 7; i++) { g.r(5 + i * 2, 9 - (i % 2), 6, 2, i % 2 ? '#5a3a22' : '#6b4a2e'); }
    g.r(7, 8, 10, 1, '#3a2414');
    for (const [x, y] of stones) { g.r(x, y, 4, 3, '#6a6872'); g.r(x, y, 4, 1, '#8a8892'); g.r(x, y + 3, 4, 1, '#2e2d34'); }
  });

  // ---------- item icons ----------
  S.icon.leaf = mk(16, 16, (g) => {
    for (const [x, y, c] of [[3, 8, '#c47a2a'], [8, 4, '#d9a040'], [9, 10, '#a8602a']]) {
      g.r(x, y, 4, 3, c); g.r(x + 1, y - 1, 2, 5, c); g.p(x + 1, y + 1, '#6a4418'); g.p(x + 2, y + 1, '#6a4418');
    }
  });
  S.icon.stick = mk(16, 16, (g) => {
    for (let i = 0; i < 12; i++) { g.p(2 + i, 13 - i, '#9a7450'); g.p(3 + i, 13 - i, '#5a3d26'); }
    for (let i = 0; i < 9; i++) { g.p(4 + i, 4 + i * 0.3 + 8 - i, '#8a6440'); }
    g.p(9, 6, '#4f8d44'); g.p(10, 5, '#4f8d44');
  });
  S.icon.log = mk(16, 16, (g) => {
    g.r(2, 6, 10, 6, '#6b4a2e'); g.r(2, 6, 10, 1, '#8a6440'); g.r(2, 11, 10, 1, '#4a3220');
    g.r(11, 5, 4, 8, '#b08458'); g.r(12, 6, 2, 6, '#c9a070'); g.p(12, 8, '#8a6440'); g.p(13, 9, '#8a6440');
    g.r(4, 8, 3, 1, '#5a3d26');
  });
  S.icon.peat = mk(16, 16, (g) => {
    g.r(3, 5, 10, 8, '#3a2a1a'); g.r(3, 5, 10, 1, '#5a4228'); g.r(3, 12, 10, 1, '#20160c');
    for (const [x, y] of [[5, 7], [8, 9], [10, 6], [6, 10]]) g.r(x, y, 2, 1, '#6a5030');
    g.p(4, 8, '#3f6a32'); g.p(11, 10, '#3f6a32');
  });
  S.icon.charcoal = mk(16, 16, (g) => {
    for (const [x, y, w, h] of [[2, 8, 6, 5], [7, 5, 6, 6], [8, 10, 6, 4]]) { g.r(x, y, w, h, '#1e1c22'); g.r(x, y, w, 1, '#4a4652'); g.p(x + 1, y + 1, '#6a6474'); }
    g.p(5, 11, '#a03a1a');
  });
  S.icon.charred_stick = mk(16, 16, (g) => {
    for (let i = 0; i < 11; i++) { g.p(3 + i, 13 - i, i > 7 ? '#1a1416' : '#4a3a30'); g.p(4 + i, 13 - i, i > 7 ? '#0e0a0c' : '#2a1e18'); }
    g.r(12, 2, 3, 3, '#141012'); g.p(13, 3, '#a8301a'); g.p(12, 4, '#5a1a10');
  });
  S.icon.stone = mk(16, 16, (g) => {
    const rnd = mulberry32(21);
    blob({ ...g, p: (x, y, c) => g.p(x, y, c) }, 6, 9, 4.5, 3.6, ['#9a98a3', '#77757f', '#5a5862', '#36353c'], rnd, 0.1);
    blob({ ...g }, 11, 11, 3.2, 2.6, ['#9a98a3', '#77757f', '#5a5862', '#36353c'], rnd, 0.1);
  });
  S.icon.seed = mk(16, 16, (g) => {
    g.r(5, 8, 6, 5, '#8a6440'); g.r(6, 7, 4, 7, '#8a6440'); g.r(6, 8, 2, 2, '#aa8460'); g.r(10, 9, 1, 4, '#5a3d26');
    g.r(8, 4, 1, 4, '#4f8d44'); g.p(9, 3, '#ff8a3a'); g.p(7, 4, '#4f8d44');
  });
  S.icon.sapling = mk(16, 16, (g) => { g.ctx.drawImage(S.bld.sapling[0], 0, -3); g.r(5, 14, 6, 2, '#4a3220'); });
  S.icon.torch = mk(16, 16, (g) => {
    for (let i = 0; i < 10; i++) { g.p(5 + i * 0.6, 15 - i, '#6a4a2a'); g.p(6 + i * 0.6, 15 - i, '#4a3220'); }
    g.r(9, 3, 4, 3, '#4a2a14');
    g.p(10, 2, '#ffd27a'); g.p(11, 1, '#ff8a3a'); g.p(11, 2, '#ffe9a8'); g.p(12, 2, '#ff8a3a'); g.p(10, 1, '#e0471f');
  });
  S.icon.axe = mk(16, 16, (g) => {
    for (let i = 0; i < 11; i++) { g.p(3 + i, 14 - i, '#8a6440'); g.p(4 + i, 14 - i, '#5a3d26'); }
    g.r(9, 2, 5, 5, '#8a8892'); g.r(9, 2, 5, 1, '#b4b2bc'); g.r(13, 3, 1, 4, '#5a5862'); g.r(8, 3, 1, 3, '#77757f');
    g.r(9, 6, 2, 1, '#c9a040');
  });
  S.icon.workbench = S.bld.workbench;
  S.icon.ember_root = mk(16, 16, (g) => {
    const pts = [[2, 12], [4, 11], [6, 9], [8, 8], [10, 6], [12, 5], [14, 3], [7, 11], [6, 13], [10, 9], [12, 10]];
    for (const [x, y] of pts) { g.r(x, y, 2, 2, '#5a1e10'); g.p(x, y, '#ff7a2a'); }
    g.p(14, 3, '#ffd27a');
  });
  S.icon.rot_pit = S.bld.rot_pit;
  S.icon.sprouter = mk(16, 16, (g) => { g.ctx.drawImage(S.bld.sprouter, 0, 0); g.r(5, 6, 6, 1, '#3d6d8a'); });
  S.icon.hearth = S.bld.hearth;
  S.icon.brick = S.bld.brick;
  S.icon.kiln = mk(16, 16, (g) => { g.ctx.drawImage(S.bld.kiln, 0, 0); g.r(6, 10, 4, 3, '#e0601f'); g.r(7, 11, 2, 1, '#ffd27a'); });
  S.icon.blueprint_kiln = mk(16, 16, (g) => {
    g.r(2, 3, 12, 10, '#2a5a9a'); g.r(2, 3, 12, 1, '#4a7aba'); g.r(2, 12, 12, 1, '#1a3a6a');
    g.r(1, 2, 2, 12, '#c9b48a'); g.r(13, 2, 2, 12, '#c9b48a');
    for (let x = 5; x <= 10; x++) { g.p(x, 5, '#cfe4ff'); g.p(x, 10, '#cfe4ff'); }
    for (let y = 5; y <= 10; y++) { g.p(5, y, '#cfe4ff'); g.p(10, y, '#cfe4ff'); }
    g.r(7, 7, 2, 2, '#ff9a4a');
  });

  // ---------- player ----------
  // Returns a 16x16 sprite; feet at bottom center.
  const playerCache = new Map();
  S.player = (color, frame, dead = false) => {
    const k = color + frame + dead;
    if (playerCache.has(k)) return playerCache.get(k);
    const c = mk(16, 16, (g) => {
      const shade = shadeColor(color, -0.35), light = shadeColor(color, 0.25);
      const leg = frame === 1 ? [1, 0] : frame === 2 ? [0, 1] : [0, 0];
      g.r(6, 13 - leg[0], 2, 3 - (1 - leg[0]) + 1, '#2a2230');
      g.r(9, 13 - leg[1], 2, 3, '#2a2230');
      g.r(5, 7, 7, 7, color); g.r(5, 7, 1, 7, light); g.r(11, 7, 1, 7, shade); g.r(5, 13, 7, 1, shade);
      g.r(6, 2, 5, 5, color); g.r(5, 3, 7, 4, color); g.r(6, 2, 5, 1, light);
      g.r(7, 4, 4, 3, '#e8c098'); g.p(10, 4, '#e8c098');
      g.p(8, 5, '#1a1420'); g.p(10, 5, '#1a1420');
      g.r(6, 9, 5, 1, '#3a2a1a'); g.p(8, 9, '#c9a040');
    });
    playerCache.set(k, c);
    return c;
  };

  return S;
}

export function shadeColor(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  return '#' + ((f(r) << 16) | (f(g) << 8) | f(b)).toString(16).padStart(6, '0');
}

// Flame palettes: [core, inner, outer, tip]. Index = fire temperature tier.
export const FLAME_PALETTES = [
  ['#ffb070', '#ff6a2a', '#c2301c', '#6a1a12'],
  ['#ffe9a8', '#ffa43a', '#e2551f', '#8a2a14'],
  ['#fff8d0', '#ffd94a', '#ff9a2a', '#c4521c'],
  ['#ffffff', '#fff3c8', '#ffd27a', '#e09040'],
  ['#ffffff', '#c8ecff', '#5aa8ff', '#2a4ad0'],
];
export const ETERNAL_PALETTE = ['#f0fff8', '#8af5d8', '#2ab8a8', '#16606a'];

export function lerpPalette(temp) {
  const i = Math.max(0, Math.min(FLAME_PALETTES.length - 1, Math.round(temp)));
  return FLAME_PALETTES[i];
}

// Procedural pixel flame, drawn directly into ctx (emissive layer).
export function drawFlame(ctx, cx, baseY, width, height, pal, t, seed = 0) {
  const half = width / 2;
  for (let i = -Math.floor(half); i <= Math.floor(half); i++) {
    const nx = i / (half + 0.5);
    const wob = 0.72 + 0.28 * Math.sin(t * 9 + i * 1.9 + seed) * Math.sin(t * 5.3 + i * 0.7 + seed * 2);
    const h = Math.max(1, height * (1 - nx * nx) * wob);
    for (let y = 0; y < h; y++) {
      const f = y / h;
      const edge = Math.abs(nx) + f * 0.6;
      const col = edge < 0.35 && f < 0.55 ? pal[0] : edge < 0.65 ? pal[1] : f < 0.85 ? pal[2] : pal[3];
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(cx + i), Math.round(baseY - y), 1, 1);
    }
  }
  // flickering tongues
  for (let k = 0; k < 2; k++) {
    const ph = (t * 1.7 + k * 0.5 + seed) % 1;
    const tx = cx + Math.sin(seed * 3 + k * 2 + Math.floor(t * 1.7 + k * 0.5) * 7.3) * half * 0.5;
    const ty = baseY - height * (0.7 + ph * 0.6);
    ctx.fillStyle = ph < 0.5 ? pal[2] : pal[3];
    ctx.fillRect(Math.round(tx), Math.round(ty), 1, 1 + (ph < 0.3 ? 1 : 0));
  }
}
