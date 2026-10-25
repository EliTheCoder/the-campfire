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

### Saves
The world autosaves every 30s (while anyone is online) and on shutdown to `saves/world.json`, and loads it on startup, so updates/restarts keep the world. Starting a new world (`restart`, the in-game "Light a new fire", or `--new`) backs the old save up as `saves/world-<timestamp>.json`. Use `--save <path>` for a different file. The world is paused while nobody is connected.

### Server console commands
`status`, `players`, `save`, `say <msg>`, `restart [seed]`, `fuel <n>`, `weather rain|wind|clear`, `give <player> <item> [n]`, `kill <player>`, `revive <player>`, `time <minutes>`, `items`, `quit`

### Cheat chat commands (`--cheats` only)
`/give item n`, `/weather rain|wind|clear`, `/fuel n`, `/time min`, `/tp x y`, `/ruin [eternal]`

## Layout

- `shared/`: world gen, item/recipe definitions, and world rules. The server and the client use the same code, so the world is deterministic from the seed.
- `server/`: the authoritative simulation (`game.js`) and the WebSocket + CLI wrapper (`index.js`).
- `client/`: Canvas2D scene and emissive layers, WebGL post-processing (`post.js`), procedural pixel sprites (`sprites.js`), HUD and input (`main.js`).

Balance knobs live in `shared/constants.js` and `shared/defs.js`.

## Audio

Ambience (fire, rain, wind, freezing drone, eternal-flame hum) is synthesized live in `client/audio.js`. One-shot sounds are CC0 from Kenney (`public/sfx/`, license included). `M` mutes.

### Music
An adaptive piano score in four stems that loop in sync (`public/music/{bed,flow,melody,lonely}.ogg`); `client/audio.js` fades them with the fire's state (full when strong, thinning to `lonely` in the dark or when it's low). The score is code: edit `music-src/compose.py` (harmony, melody, voicings, tempo) and run `music-src/render.sh` (needs `fluidsynth`, `sox`, and the CC0 Upright Piano KW soundfont in `music-src/soundfonts/` from freepats.zenvoid.org). `public/music/preview-full.ogg` is the full mix for listening.

## Progression

The fire never stops getting hungrier (linear x 1.02^minutes burn growth) and every 6 minutes demands a hotter fuel tier, so a base that doesn't expand dies. Fuel ladder (alternating growth/decay): leaves, sticks, logs, peat, charcoal, resin, lignite, heartwood, coal, ember crystal.

- **Fire stages**: ring the campfire with 8 Hearthstones (Bonfire), then 16 Fire Bricks (Blaze), then 24 Ember Stones (Inferno) for more fuel capacity and light.
- **Multiblocks** (`MULTIBLOCKS` in `shared/defs.js`): Kiln, Peat Press (3x3), Coal Bed, Crystal Forge (5x5), Watchfire (3x3 light tower), Heart Grove (heartwood seed ringed by glowmoss). Machines feed the next machine beside them (`FEEDS`).
- **Eternal flames** grow teal root networks: free heat, output goes to the flame's cache. Orange and teal networks can't be joined.
- **Sites** (`shared/worldgen.js`): ruins, dead campfires, shrines (guaranteed blueprint, better farther out), collapsed mines (coal seams, geodes; pickaxe), ancient groves (glowmoss, heartwood).
- Cheats: `/site [ruin|eternal|dead_fire|shrine|mine|grove]`, `/learn` (all blueprints).
