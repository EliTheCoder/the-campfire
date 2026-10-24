#!/usr/bin/env node
import { WebSocketServer } from 'ws';
import readline from 'node:readline';
import { Game } from './game.js';
import { DEFAULT_PORT, TICK_RATE } from '../shared/constants.js';
import { ITEMS } from '../shared/defs.js';
import { countItem } from '../shared/inventory.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const port = Number(opt('port', process.env.PORT || DEFAULT_PORT));
const seedArg = opt('seed');

const log = (...a) => console.log('\x1b[33m[campfire]\x1b[0m', ...a);
const wss = new WebSocketServer({ port });

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => {
  const data = JSON.stringify(obj);
  for (const p of game.players.values()) if (p.ws.readyState === 1) p.ws.send(data);
};
const game = new Game({ cheats: args.includes('--cheats'), seed: seedArg != null ? Number(seedArg) : undefined, send, broadcast, log });

wss.on('connection', (ws, req) => {
  let player = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!player) {
      if (m.t === 'join') { player = game.join(ws, m.name); log(`${player.name} joined from ${req.socket.remoteAddress}`); }
      return;
    }
    game.handle(player, m);
  });
  ws.on('close', () => { if (player) { game.leave(player); log(`${player.name} left`); } });
});

let last = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  game.tick(dt);
}, 1000 / TICK_RATE);

log(`Listening on ws://0.0.0.0:${port}  (seed ${game.seed}). Type "help" for commands.`);

const findPlayer = (name) => [...game.players.values()].find((p) => p.name.toLowerCase() === String(name).toLowerCase());
const commands = {
  help: () => log('commands: status | players | say <msg> | restart [seed] | fuel <n> | weather rain|wind|clear | give <player> <item> [n] | kill <player> | revive <player> | time <minutes> | items | quit'),
  status: () => {
    const f = game.world.fire;
    log(`time ${Math.floor(game.world.time / 60)}m${Math.floor(game.world.time % 60)}s | fuel ${f.fuel.toFixed(1)} | burn ${f.burn.toFixed(2)}/s | temp ${f.temp.toFixed(2)} | demand ${f.demand} | weather ${game.weather.s} (${game.weather.t.toFixed(0)}s) | buildings ${game.world.bld.size} | packets ${game.packets.length} | ${game.over ? 'GAME OVER' : 'running'}`);
  },
  players: () => {
    if (!game.players.size) return log('no players');
    for (const p of game.players.values()) log(`#${p.id} ${p.name} (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) ${p.dead ? 'DEAD' : `torch ${p.held.toFixed(0)}s, ${countItem(p.inv, 'torch')} spare`}`);
  },
  say: (...w) => game.say(`[server] ${w.join(' ')}`, '#ffcc66'),
  restart: (seed) => game.reset(seed != null ? Number(seed) : undefined),
  fuel: (n) => { game.world.setFuel(Number(n)); log(`fuel set to ${n}`); },
  weather: (s) => {
    const W = game.weather;
    if (s === 'rain') { W.s = 'rain_warn'; W.t = 0; }
    else if (s === 'wind') { W.s = 'wind_warn'; W.t = 0; }
    else { W.s = 'rain'; W.t = 0; }
  },
  give: (name, item, n = 1) => {
    const p = findPlayer(name);
    if (!p) return log('no such player');
    if (!ITEMS[item]) return log('unknown item. try "items"');
    game.give(p, item, Number(n));
    log(`gave ${n} ${item} to ${p.name}`);
  },
  kill: (name) => { const p = findPlayer(name); if (p) game.kill(p, 'the server'); },
  revive: (name) => { const p = findPlayer(name); if (p?.dead) game.revive(p); },
  time: (m) => { game.world.time = Number(m) * 60; log(`time set to ${m} minutes`); },
  items: () => log(Object.keys(ITEMS).join(', ')),
  quit: () => process.exit(0),
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (!cmd) return;
  const fn = commands[cmd];
  if (fn) { try { fn(...rest); } catch (e) { log('error:', e.message); } }
  else log(`unknown command "${cmd}" - type help`);
});
