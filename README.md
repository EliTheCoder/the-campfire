# The Campfire

Co-op survival for the "growth or decay" jam. Keep one shared campfire alive in an infinite, procedurally generated dark world. You can only walk where there is light.

## Running (dev)

Node lives in `~/.local/node/bin` (add it to your PATH).

```sh
npm install
npm run dev        # game server (with --cheats) + Vite client
```

Open http://localhost:5173. Friends connect to `ws://<your-ip>:7777` (forward TCP 7777). Vite also listens on the LAN at port 5173.

Server only: `npm run server -- --port 7777 --seed 123` (add `--cheats` for chat commands).

### Server console commands
`status`, `players`, `say <msg>`, `restart [seed]`, `fuel <n>`, `weather rain|wind|clear`, `give <player> <item> [n]`, `kill <player>`, `revive <player>`, `time <minutes>`, `items`, `quit`

### Cheat chat commands (`--cheats` only)
`/give item n`, `/weather rain|wind|clear`, `/fuel n`, `/time min`, `/tp x y`, `/ruin [eternal]`

## Layout

- `shared/`: world gen, item/recipe definitions, and world rules. The server and the client use the same code, so the world is deterministic from the seed.
- `server/`: the authoritative simulation (`game.js`) and the WebSocket + CLI wrapper (`index.js`).
- `client/`: Canvas2D scene and emissive layers, WebGL post-processing (`post.js`), procedural pixel sprites (`sprites.js`), HUD and input (`main.js`).

Balance knobs live in `shared/constants.js` and `shared/defs.js`.
