// Hybrid audio: procedural ambience (fire, rain, wind, cold) via Web Audio + CC0 Kenney one-shots.
// Music slot: drop a file at public/music/theme.ogg and it loops quietly.

const SAMPLES = {
  step_grass: 5, step_stone: 5, wood: 3, wood_light: 3, place: 3, mine: 3, rustle: 4, chop: 1,
  creak: 1, coins: 1, pluck: 2, page: 1, craft: 1, open: 1, close: 1, tick: 1, error: 1, bump: 1, drop: 1, break: 1,
};

export function createAudio() {
  let ctx = null, master, sfx, amb, music;
  const buffers = {};
  let noise = null;
  const A = { muted: false, listener: { x: 0, y: 0 }, vol: { master: 0.8, sfx: 0.7, amb: 0.9, music: 0.35 } };
  try {
    A.muted = localStorage.getItem('campfire.muted') === '1';
    Object.assign(A.vol, JSON.parse(localStorage.getItem('campfire.volume') || '{}'));
  } catch {}

  A.init = () => {
    if (ctx) { ctx.resume(); return; }
    ctx = new AudioContext();
    master = ctx.createGain(); master.gain.value = A.muted ? 0 : A.vol.master; master.connect(ctx.destination);
    sfx = ctx.createGain(); sfx.gain.value = A.vol.sfx; sfx.connect(master);
    amb = ctx.createGain(); amb.gain.value = A.vol.amb; amb.connect(master);
    music = ctx.createGain(); music.gain.value = A.vol.music; music.connect(master);
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    for (const [name, n] of Object.entries(SAMPLES)) {
      buffers[name] = [];
      for (let i = 0; i < n; i++) {
        fetch(`sfx/${name}_${i}.ogg`).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)).then((buf) => buffers[name].push(buf)).catch(() => {});
      }
    }
    buildAmbience();
    loadMusic();
  };

  A.state = () => ctx?.state ?? 'none';

  A.toggleMute = () => {
    A.muted = !A.muted;
    try { localStorage.setItem('campfire.muted', A.muted ? '1' : '0'); } catch {}
    if (master) master.gain.setTargetAtTime(A.muted ? 0 : A.vol.master, ctx.currentTime, 0.05);
    return A.muted;
  };

  // kind: master | sfx | amb | music, v: 0..1
  A.setVolume = (kind, v) => {
    A.vol[kind] = v;
    try { localStorage.setItem('campfire.volume', JSON.stringify(A.vol)); } catch {}
    const node = { master, sfx, amb, music }[kind];
    if (node && ctx) node.gain.setTargetAtTime(kind === 'master' && A.muted ? 0 : v, ctx.currentTime, 0.05);
  };

  // ---------- helpers ----------
  // Distance falloff + stereo pan relative to the listener (world tiles).
  function spatial(x, y, range = 14) {
    if (x == null) return { g: 1, pan: 0 };
    const dx = x - A.listener.x, dy = y - A.listener.y;
    const d = Math.hypot(dx, dy);
    return { g: Math.max(0, 1 - d / range) ** 1.5, pan: Math.max(-1, Math.min(1, dx / 10)) };
  }
  function out(g, pan) {
    const gain = ctx.createGain(); gain.gain.value = g;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    gain.connect(p).connect(sfx);
    return gain;
  }
  A.play = (name, { x, y, vol = 1, rate = 1, jitter = 0.08 } = {}) => {
    if (!ctx || !buffers[name]?.length) return;
    const s = spatial(x, y);
    if (s.g <= 0.01) return;
    const src = ctx.createBufferSource();
    src.buffer = buffers[name][(Math.random() * buffers[name].length) | 0];
    src.playbackRate.value = rate * (1 + (Math.random() - 0.5) * jitter * 2);
    src.connect(out(vol * s.g, s.pan));
    src.start();
  };
  function noiseSrc(loop = false) {
    const s = ctx.createBufferSource();
    s.buffer = noise; s.loop = loop;
    s.loopStart = 0; s.loopEnd = noise.duration;
    return s;
  }
  // One-shot filtered noise burst.
  function burst({ x, y, dur = 0.05, type = 'highpass', f0 = 2000, f1 = f0, q = 0.7, vol = 0.3, attack = 0.002 }) {
    const s = spatial(x, y);
    if (s.g <= 0.01) return;
    const t = ctx.currentTime;
    const src = noiseSrc();
    const filt = ctx.createBiquadFilter(); filt.type = type; filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t); filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(out(s.g, s.pan));
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }
  function tone({ x, y, freq = 440, f1 = freq, dur = 0.5, type = 'sine', vol = 0.2, delay = 0, attack = 0.01 }) {
    const s = spatial(x, y);
    if (s.g <= 0.01) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out(s.g, s.pan));
    o.start(t); o.stop(t + dur + 0.05);
  }

  // ---------- procedural one-shots ----------
  const synth = {
    whoosh: (o) => burst({ ...o, type: 'bandpass', f0: 250, f1: 2200, q: 1.2, dur: 0.45, vol: 0.35, attack: 0.08 }),
    ash: (o) => burst({ ...o, type: 'lowpass', f0: 500, f1: 120, dur: 0.6, vol: 0.3, attack: 0.02 }),
    torchLight: () => { burst({ type: 'bandpass', f0: 400, f1: 3000, q: 1, dur: 0.3, vol: 0.3, attack: 0.04 }); },
    torchOut: () => { burst({ type: 'highpass', f0: 5000, f1: 800, dur: 0.9, vol: 0.25, attack: 0.01 }); tone({ freq: 220, f1: 110, dur: 0.6, type: 'triangle', vol: 0.06 }); },
    death: (o) => { tone({ ...o, freq: 180, f1: 35, dur: 1.6, type: 'sawtooth', vol: 0.12 }); burst({ ...o, type: 'lowpass', f0: 800, f1: 60, dur: 1.4, vol: 0.35, attack: 0.05 }); },
    revive: () => { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 1.2, vol: 0.09, delay: i * 0.09, attack: 0.02 })); synth.whoosh({}); },
    learn: () => { [392, 494, 587, 784].forEach((f, i) => tone({ freq: f, dur: 0.9, type: 'triangle', vol: 0.08, delay: i * 0.12 })); },
    thunder: () => { burst({ type: 'lowpass', f0: 300, f1: 40, dur: 3, vol: 0.5, attack: 0.3 }); burst({ type: 'lowpass', f0: 1200, f1: 100, dur: 0.6, vol: 0.25, attack: 0.01 }); },
    gust: () => burst({ type: 'bandpass', f0: 200, f1: 900, q: 0.8, dur: 2.2, vol: 0.4, attack: 0.8 }),
    // heard by everyone, wherever they are: a rising hiss, then a pop
    flare: () => {
      burst({ type: 'bandpass', f0: 600, f1: 4000, q: 1.5, dur: 0.9, vol: 0.25, attack: 0.05 });
      setTimeout(() => { burst({ type: 'lowpass', f0: 2000, f1: 200, dur: 0.6, vol: 0.5, attack: 0.005 }); [880, 1320, 1760].forEach((f, i) => tone({ freq: f, dur: 0.5, vol: 0.05, delay: i * 0.04 })); }, 900);
    },
    forge: (o) => { burst({ ...o, type: 'bandpass', f0: 150, f1: 1800, q: 1, dur: 0.7, vol: 0.4, attack: 0.5 }); [196, 247, 294].forEach((f, i) => tone({ ...o, freq: f, dur: 1.4, type: 'triangle', vol: 0.07, delay: 0.65 + i * 0.04 })); },
    sparkle: (o) => [1568, 2093, 2637].forEach((f, i) => tone({ ...o, freq: f, dur: 0.35, type: 'sine', vol: 0.05, delay: i * 0.05 })),
  };

  // Server/world events.
  A.fx = (e) => {
    if (!ctx) return;
    const [kind, a, b, c] = e;
    // e[4], e[5] are used by 'hop' (target y, item)
    const at = (x, y) => ({ x: x + 0.5, y: y + 0.5 });
    switch (kind) {
      case 'feed':
        if (b) synth.ash({ x: 0.5, y: 0.5 });
        else { synth.whoosh({ x: 0.5, y: 0.5 }); A.play('wood_light', { x: 0.5, y: 0.5, vol: 0.4, rate: 0.8 }); }
        break;
      case 'harvest': {
        const p = at(a, b);
        if (c === 'tree' || c === 'bare_tree') { A.play('chop', { ...p, vol: 0.8 }); A.play('rustle', { ...p, vol: 0.5 }); }
        else if (c === 'stump') A.play('wood', { ...p, vol: 0.7 });
        else if (c === 'bush') A.play('rustle', { ...p, vol: 0.8 });
        else if (c === 'rock' || c === 'rubble' || c === 'pebble') A.play('mine', { ...p, vol: 0.7 });
        else A.play('pluck', { ...p, vol: 0.5 });
        break;
      }
      case 'place': A.play('place', { ...at(a, b), vol: 0.7 }); break;
      case 'break': A.play('break', { ...at(a, b), vol: 0.6 }); A.play('wood_light', { ...at(a, b), vol: 0.4 }); break;
      case 'pickup': A.play('pluck', { ...at(a, b), vol: 0.35, rate: 1.2 }); break;
      case 'chest': A.play('creak', { ...at(a, b), vol: 0.9 }); setTimeout(() => A.play('coins', { ...at(a, b), vol: 0.6 }), 350); synth.sparkle(at(a, b)); break;
      case 'death': synth.death({ x: a, y: b }); break;
      case 'revive': synth.revive(); break;
      case 'drop': A.play('drop', { ...at(a, b), vol: 0.5 }); break;
      case 'flare': synth.flare(); break;
      case 'hop': A.play('pluck', { ...at(c, e[4]), vol: 0.2, rate: 1.4 }); break;
      case 'forge': synth.forge(at(a, b)); setTimeout(() => A.play('place', { ...at(a, b), vol: 1, rate: 0.6 }), 650); break;
      case 'shatter': A.play('break', { ...at(a, b), vol: 1, rate: 0.7 }); A.play('mine', { ...at(a, b), vol: 0.8 }); A.play('wood', { ...at(a, b), vol: 0.6, rate: 0.7 }); break;
    }
  };
  A.synth = (name, o = {}) => { if (ctx) synth[name]?.(o); };

  // ---------- continuous ambience ----------
  let fire, rain, wind, cold, eternal;
  function loopNoise(type, freq, q = 0.7) {
    const src = noiseSrc(true);
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f).connect(g).connect(amb);
    src.start(0, Math.random());
    return { f, g };
  }
  function buildAmbience() {
    fire = loopNoise('lowpass', 500);
    fire.roar = loopNoise('bandpass', 140, 1.5);
    rain = loopNoise('highpass', 300);
    const rl = ctx.createBiquadFilter(); rl.type = 'lowpass'; rl.frequency.value = 1400; rl.Q.value = 0.5;
    rain.g.disconnect(); rain.g.connect(rl).connect(amb);
    wind = loopNoise('bandpass', 400, 1.8);
    // freezing: detuned low drone
    cold = { g: ctx.createGain() };
    cold.g.gain.value = 0;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    for (const f of [55, 58.3, 82.4]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(lp); o.start(); }
    lp.connect(cold.g).connect(amb);
    // eternal flame: soft shimmering chord
    eternal = { g: ctx.createGain() };
    eternal.g.gain.value = 0;
    for (const f of [261.6, 392, 523.3]) {
      const o = ctx.createOscillator(); o.frequency.value = f;
      const trem = ctx.createGain(); trem.gain.value = 0.5;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.3 + Math.random() * 0.4;
      const lg = ctx.createGain(); lg.gain.value = 0.5; lfo.connect(lg).connect(trem.gain); lfo.start();
      o.connect(trem).connect(eternal.g); o.start();
    }
    eternal.g.connect(amb);
  }

  let crackleAcc = 0, heartAcc = 0, windPhase = 0;
  // s: { fireFuel, fireStage(0-4|-1), temp, weather, freezing, cold, eternalDist, torchDist, dt }
  A.update = (s) => {
    if (!ctx) return;
    const t = ctx.currentTime;
    const set = (param, v, tc = 0.15) => param.setTargetAtTime(v, t, tc);
    const fd = Math.hypot(A.listener.x - 0.5, A.listener.y - 0.5);
    const near = Math.max(0, 1 - fd / 16) ** 1.4;
    const stage = s.fireStage;
    const size = stage < 0 ? 0 : (stage + 1) / 5;
    set(fire.g.gain, 0.12 * size * near);
    set(fire.f.frequency, 350 + size * 700 + s.temp * 150);
    set(fire.roar.g.gain, 0.18 * size * size * near);
    // crackles: from the campfire, plus a little from nearby torches / eternal flames
    const rate = stage < 0 ? 0 : 2 + stage * 3.5;
    crackleAcc += s.dt * rate;
    while (crackleAcc > 1) {
      crackleAcc -= Math.random() * 2;
      const big = Math.random() < 0.15;
      burst({ x: 0.5 + (Math.random() - 0.5), y: 0.5, dur: big ? 0.07 : 0.025, f0: big ? 1200 : 2500 + Math.random() * 3000, vol: (big ? 0.5 : 0.25) * (0.5 + size * 0.5) });
    }
    if (s.torchDist < 6 && Math.random() < s.dt * 2) burst({ dur: 0.02, f0: 3500, vol: 0.12 * (1 - s.torchDist / 6) });
    const rainOn = s.weather === 'rain' ? 1 : s.weather === 'rain_warn' ? 0.08 : 0;
    set(rain.g.gain, 0.11 * rainOn, 1.2);
    windPhase += s.dt;
    const windOn = s.weather === 'wind' ? 1 : s.weather === 'wind_warn' ? 0.35 : 0;
    set(wind.g.gain, 0.3 * windOn * (0.6 + 0.4 * Math.sin(windPhase * 0.7) * Math.sin(windPhase * 1.9)), 0.4);
    set(wind.f.frequency, 300 + 400 * (0.5 + 0.5 * Math.sin(windPhase * 0.5)), 0.3);
    set(cold.g.gain, s.freezing ? 0.05 + 0.1 * Math.min(1, s.cold / 6) : 0, 0.3);
    if (s.freezing) {
      heartAcc += s.dt;
      const period = 0.9 - 0.45 * Math.min(1, s.cold / 6);
      if (heartAcc > period) {
        heartAcc = 0;
        tone({ freq: 70, f1: 40, dur: 0.18, vol: 0.35, attack: 0.005 });
        tone({ freq: 60, f1: 35, dur: 0.2, vol: 0.25, attack: 0.005, delay: 0.16 });
      }
    } else heartAcc = 0;
    set(eternal.g.gain, 0.025 * Math.max(0, 1 - s.eternalDist / 9), 0.5);
  };

  function loadMusic() {
    const el = new Audio('music/theme.ogg');
    el.loop = true;
    el.addEventListener('canplaythrough', () => {
      ctx.createMediaElementSource(el).connect(music);
      el.play().catch(() => {});
    }, { once: true });
    el.addEventListener('error', () => {}, { once: true });
  }

  return A;
}
