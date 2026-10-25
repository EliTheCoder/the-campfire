// The in-game wiki. Item and building pages are generated from the game's definitions so the
// numbers always match; guides and world pages are written by hand.
import { ITEMS, BUILDINGS, FEATURES, RECIPES, MULTIBLOCKS, FIRE_STAGES, FEEDS, FUELS, FUEL_NAMES, BLUEPRINTS, BLUEPRINT_FINDS, SHRINE_BANDS } from '../shared/defs.js';
import { FIRE, TORCH, COLD_GRACE, ETERNAL_ROOT_REACH, PACKET_SPEED } from '../shared/constants.js';

export function buildWiki(iconURL, keyOf) {
  const A = new Map(); // id -> { id, title, cat, icon, html, words }
  const add = (id, cat, title, icon, html) => A.set(id, { id, cat, title, icon, html });
  const img = (item, cls = 'wi') => (iconURL[item] ? `<img class="${cls}" src="${iconURL[item]}">` : '');
  const link = (id, text) => `<a data-wiki="${id}">${text ?? A.get(id)?.title ?? id}</a>`;
  const item = (id, n) => `<span class="wl">${img(id)}${n ? n + ' ' : ''}<a data-wiki="item:${id}">${ITEMS[id].name}</a></span>`;
  const bld = (t) => `<a data-wiki="bld:${t}">${BUILDINGS[t].name}</a>`;
  const K = (a) => `<kbd>${keyOf(a)}</kbd>`;
  const tierName = (h) => `tier ${h + 1} (${FUEL_NAMES[h]})`;
  const minutesFor = (h) => h * FIRE.demandEveryMin;
  const recipeRow = (r) => `<div class="wrecipe">${Object.entries(r.in).map(([i, n]) => item(i, n)).join(' + ')} <span class="arrow">→</span> ${item(r.out[0], r.out[1])}${r.station ? ` <span class="dim">at a ${bld('workbench')}</span>` : ' <span class="dim">by hand</span>'}${r.requires ? ` <span class="bp">needs ${link('item:bp_' + r.requires, 'Blueprint: ' + BLUEPRINTS[r.requires])}</span>` : ''}</div>`;
  const grid = (cells) => `<div class="wgrid" style="grid-template-columns:repeat(${cells[0].length}, 28px)">${cells.flat().map((c) => (c ? `<span title="${ITEMS[c]?.name ?? ''}">${img(c, '')}</span>` : '<span></span>')).join('')}</div>`;
  const mbGrid = (core) => {
    const m = MULTIBLOCKS[core], n = m.size, h = (n - 1) / 2;
    return grid(Array.from({ length: n }, (_, y) => Array.from({ length: n }, (_, x) => (x === h && y === h ? BUILDINGS[core].item : m.wall))));
  };

  // ---------------- how each item is obtained (beyond recipes) ----------------
  const SOURCES = {
    leaf: ['Loose on the ground - walk over it.', `Gather a Bush (hold LMB): 3 leaves, and a 1-in-4 chance of a ${item('seed')}. It regrows in 2 minutes.`, `A ${bld('kindling')} grows them forever.`, 'Scavenge an abandoned bedroll.'],
    stick: ['Loose on the ground.', 'Shake a tree by hand: 1-2 sticks, three times before it\'s bare.', 'Pry up stumps, clear picked bushes.', `${bld('sapling')}s shed them.`, 'Windfalls drop them everywhere.'],
    log: [`Chop a tree with a ${item('axe')}: 3 logs, a stick, and often a ${item('sapling')}. Bare trees give 2.`, `${bld('sapling')}s drop one every ~50s.`, 'Windfalls.', 'Old chests.'],
    peat: [`A ${bld('rot_pit')}: 4 leaves rot into 1 peat (20s, 10s in rain).`, 'Old chests near the fire.'],
    charcoal: [`A ${link('mb:kiln', 'Charcoal Kiln')}: 2 logs bake into 1 (15s).`, 'Sift the ashes of a dead campfire.', 'Chests farther out.'],
    resin: [`A ${bld('resin_tap')} beside a grown Grove Tree (1 per 30s) or a Heart Grove (1 per 20s). Taps on the same tree share that.`, 'Chests more than ~60 tiles out.'],
    lignite: [`A ${link('mb:press', 'Peat Press')}: 3 peat squeeze into 1 (25s).`, 'Chests far from the fire.'],
    heartwood: [`A ${link('mb:heart_seed', 'Heart Grove')}: 5 logs make 1 (90s, needs heat).`, `Fell an ${link('world:ancient_tree', 'Ancient Tree')} with an axe: 3 at once.`],
    coal: [`Mine ${link('world:mines', 'coal seams')} with a ${item('pickaxe')}: 1-2 per swing, three swings each.`, `A ${link('mb:coal_bed', 'Coal Bed')}: 2 lignite bake into 1 (40s).`, 'Chests in collapsed mines.'],
    ember_crystal: [`A ${link('mb:forge_core', 'Crystal Forge')}: grows 1 from each coal (60s).`],
    charred_stick: ['Every torch that burns out leaves one - carried or placed.', 'Sift a dead campfire\'s ashes.'],
    stone: [`A ${bld('rain_basin')}: rain fills it and the silt settles into stone (1 per 15s while it holds water).`, 'Pebbles on the ground.', `Rocks (hold LMB): 2 stone, 3 with a ${item('pickaxe')}. Three times each.`, 'Rubble in ruins.', 'Cave walls in mines (pickaxe).'],
    seed: ['Gathering bushes sometimes drops one.', 'Old chests.'],
    sapling: ['Chopping trees with an axe often drops one.', 'Old chests.'],
    torch: ['You start with 2.', 'Old chests.'],
    axe: ['Old chests (rarely).'],
    glowmoss: [`Gather it in ${link('world:groves', 'ancient groves')}.`],
    heart_seed: [`Fell an ${link('world:ancient_tree', 'Ancient Tree')}.`],
    crystal_geode: [`Pry one out of a geode deep in a ${link('world:mines', 'collapsed mine')} (pickaxe).`],
  };
  const SITE_LINKS = { ruin: ['world:ruins', 'ruins'], dead_fire: ['world:dead_fires', 'dead campfires'], mine: ['world:mines', 'collapsed mines'] };
  const SHRINE_WHERE = ['near', 'middle-distance', 'far'];
  for (const id of Object.keys(BLUEPRINTS)) {
    const where = [];
    for (const [site, list] of Object.entries(BLUEPRINT_FINDS)) {
      const e = list.find(([b]) => b === id);
      if (e) where.push(`chests in ${link(...SITE_LINKS[site])}${e[1] ? ` (${e[1]}+ tiles out)` : ''}`);
    }
    const bands = SHRINE_BANDS.map(([, l], i) => (l.includes(id) ? SHRINE_WHERE[i] : null)).filter(Boolean);
    if (bands.length) where.push(`${bands.join(' and ')} ${link('world:shrines', 'shrines')}`);
    SOURCES['bp_' + id] = [`Only found in ${where.join(', ')}. Designs nobody has found yet turn up more often.`];
  }

  // ---------------- guides ----------------
  const G = 'Guides';
  add('guide:start', G, 'Getting started', 'torch', `
    <p>Your <b>campfire</b> is everything. If it goes out, the game is over for everyone. It starts with ${FIRE.startFuel} fuel and burns about 1 fuel a second - faster every minute.</p>
    <h4>Your first minutes</h4>
    <ol>
      <li>Look at the fuel bar at the top. That's how long you have.</li>
      <li>The campsite starts empty, so head out into the dark. Your ${item('torch')}es light themselves at the fire and burn while you're out.</li>
      <li>Grab ${item('leaf')}, ${item('stick')} and ${item('stone')}. Shake trees for sticks, gather bushes for leaves.</li>
      <li>Come back and feed the fire: select fuel in your hotbar and <b>right-click</b> the fire (Ctrl+right-click feeds the whole stack).</li>
      <li>Craft more torches (C), then a ${item('axe')} and a ${item('workbench')}. Logs, ember roots and automation come next.</li>
    </ol>
    <p>Read ${link('guide:fire')} to understand why your old fuel will stop working, and ${link('guide:light')} before you wander too far.</p>`);
  add('guide:light', G, 'Light & darkness', 'torch', `
    <p>Darkness is pitch black. Only light shows you the world: the fire's square, placed torches, eternal flames, shrines, glowmoss, watchfires, and your own torch.</p>
    <h4>Your torches</h4>
    <ul>
      <li>Torches in your inventory <b>are</b> your light. While you're in light they're put away and don't burn.</li>
      <li>In the dark, one burns at a time (${TORCH.heldFuel}s each, faster in rain), lighting a 3x3 around you - <b>only for you</b>. When it's spent it leaves a ${item('charred_stick')} and the next one lights from its embers.</li>
      <li>Unlit torches (ones you pick up in the dark) light at any flame, or from a friend standing next to you with a lit torch.</li>
    </ul>
    <h4>The cold</h4>
    <p>You can walk into the dark without light, but the cold starts killing you. You have <b>${COLD_GRACE} seconds</b> to get back into light (or light a torch). Otherwise you die and drop everything - see ${link('guide:death')}.</p>
    <h4>Placed light</h4>
    <p>A placed ${bld('torch')} lights 5x5 for everyone for ${TORCH.placedFuel}s. Hook it to an ${link('bld:root', 'Ember Root')} and it burns forever.</p>`);
  add('guide:fire', G, 'The fire\'s hunger', 'charcoal', `
    <p>The fire never stops getting hungrier. Its burn rate grows every minute (and keeps accelerating), it burns ${Math.round((FIRE.rainMult - 1) * 100)}% faster in rain, and <b>faster with more players</b> online (2 players: 1.6x, 4: 2.4x, 10: 4.1x - each extra player adds a little less).</p>
    <h4>Heat demand</h4>
    <p>Every ${FIRE.demandEveryMin} minutes it demands the next <b>heat tier</b>. Fuel below the demand mostly turns to ash: each tier short keeps only ${Math.round(FIRE.belowHeatPenalty * 100)}% of its value. The HUD shows what it's hungry for.</p>
    <table class="wtable"><tr><th>Tier</th><th>Fuel</th><th>Value</th><th>Demanded from</th></tr>
      ${FUELS.map(([id, , v], h) => `<tr><td>${h + 1}</td><td>${item(id)}</td><td>${v}</td><td>${h ? minutesFor(h) + ' min' : 'start'}</td></tr>`).join('')}
    </table>
    <p>The ladder alternates <b>growth</b> (things you cultivate) and <b>decay</b> (things you rot, press and bake).</p>
    <p>Feeding fuel <b>hotter</b> than the demand makes it burn ${Math.round((1 - FIRE.hotBonus) * 100)}% slower, and shifts the flame's colour toward blue and beyond. The fire can only hold so much - see ${link('guide:stages')}.</p>`);
  add('guide:stages', G, 'Growing the fire', 'hearth', `
    <p>Ring the campfire with blocks to grow it. Each stage holds more fuel and lights more ground - and looks a lot more impressive.</p>
    <table class="wtable"><tr><th>Stage</th><th>Ring</th><th>Holds</th><th>Lights</th></tr>
      ${FIRE_STAGES.map((s) => `<tr><td>${s.name}</td><td>${s.block ? `${s.ring * 8} ${item(s.block)} at distance ${s.ring}` : '-'}</td><td>${s.maxFuel}</td><td>${s.radius * 2 + 1}x${s.radius * 2 + 1}</td></tr>`).join('')}
    </table>
    ${grid(Array.from({ length: 7 }, (_, y) => Array.from({ length: 7 }, (_, x) => { const r = Math.max(Math.abs(x - 3), Math.abs(y - 3)); return r === 0 ? 'torch' : FIRE_STAGES[r].block; })))}
    <p class="dim">Each ring goes outside the previous one. Start a ring (or hold its block) and the missing spots show as faint outlines. Ember roots pass straight through the rings to the fire.</p>
    <p>Fire Bricks and Ember Stones need blueprints: ${link('item:bp_blaze')} and ${link('item:bp_inferno')}.</p>`);
  add('guide:roots', G, 'Ember roots', 'ember_root', `
    <p>${link('bld:root', 'Ember Roots')} carry the fire's heat outward, and carry fuel back in. Hold RMB with roots selected and drag to lay a line (LMB still mines).</p>
    <h4>Orange roots (the campfire)</h4>
    <ul>
      <li>Grow out of the fire (or its rings) and connect up/down/left/right - never diagonally.</li>
      <li>Their reach depends on how full the fire is: about 6 + 54 x fill tiles. A weak fire's roots go dark from the tips.</li>
      <li>Torches on them burn forever (costing the fire ${TORCH.networkCost} fuel/s each). Buildings that need heat cost fuel too.</li>
      <li>Fuel made by a building touching them travels home at ${PACKET_SPEED} tiles/s and goes straight into the fire.</li>
    </ul>
    <h4>Teal roots (eternal flames)</h4>
    <ul>
      <li>Roots touching an ${link('world:eternal', 'eternal flame')} glow teal. They reach ${ETERNAL_ROOT_REACH} tiles and never weaken.</li>
      <li>Heat on teal roots is <b>free</b>. Output goes into the flame's cache - right-click the flame to open it and carry things home.</li>
      <li>Orange and teal networks can never meet: a root that would join them is refused.</li>
    </ul>`);
  add('guide:automation', G, 'Automation', 'rot_pit', `
    <p>Buildings hand their output onward on their own. In order, each one tries:</p>
    <ol>
      <li>A neighbouring building that takes it (arrows on the shared edge show this).</li>
      <li>A ${bld('crate')} beside it - storage, for when you want to keep the output.</li>
      <li>The fire or an eternal flame it touches directly.</li>
      <li>A powered ember root beside it, which carries it home.</li>
    </ol>
    <h4>Feeding chains</h4>
    <p>${Object.entries(FEEDS).map(([a, b]) => `${link(MULTIBLOCKS[a] ? 'mb:' + a : 'bld:' + a, BUILDINGS[a].name)} → ${link(MULTIBLOCKS[b] ? 'mb:' + b : 'bld:' + b, BUILDINGS[b].name)}`).join('<br>')}</p>
    <p>A full chain: Kindling Bushes → Rot Pit → Peat Press → Coal Bed → Crystal Forge, each placed touching the next.</p>
    <p class="dim">Plants only grow in light. Buildings that need heat need a powered root touching them (or their walls).</p>`);
  add('guide:weather', G, 'Weather', 'leaf', `
    <p><b>Rain</b> (warned ~15s ahead): the fire burns ${Math.round((FIRE.rainMult - 1) * 100)}% faster, placed torches ${TORCH.rainMult}x faster and carried ones ${TORCH.heldRainMult}x. But plants grow twice as fast, rot pits work twice as fast, and resin taps drip faster.</p>
    <p><b>Windfall</b> (warned ~8s ahead): for 25 seconds, sticks and logs crash down all over the place - around the fire and around players. Go gather!</p>`);
  add('guide:death', G, 'Death & reviving', 'charred_stick', `
    <p>You die if the cold takes you (${COLD_GRACE}s in the dark without light), or if you give in to the dark from the Esc menu.</p>
    <ul>
      <li>Everything you carry drops where you fell - bring a torch to get it back.</li>
      <li>You wait as a wisp circling the fire. A friend standing near the fire presses ${K('revive')} to bring you back, costing the fire ${FIRE.reviveCost} fuel. You return with one torch.</li>
      <li>If everyone is dead, everyone rises after a few seconds - at the same cost each.</li>
    </ul>`);
  add('guide:together', G, 'Playing together', 'flare', `
    <p>Everyone shares one fire. More players means more hands - and a hungrier fire (2 players: 1.6x burn, 4: 2.4x, 10: 4.1x). A new fire with 3 or more people around starts full.</p>
    <ul>
      <li>Lost? Fire a ${item('flare')}. Everyone sees it go up and gets an arrow pointing to where it came from, with your name and distance.</li>
      <li>Throw items to a friend with ${K('drop')} (Shift: the whole stack) - they land where you're pointing.</li>
      <li>A friend with a lit torch lights your unlit ones just by standing next to you.</li>
      <li>Leaving and rejoining keeps your character and inventory. The world pauses while nobody is online, and is saved on the server.</li>
    </ul>`);
  add('guide:controls', G, 'Controls', 'workbench', `
    <table class="wtable">
      <tr><td>Move</td><td>${K('up')} ${K('left')} ${K('down')} ${K('right')} or arrows</td></tr>
      <tr><td>Gather / pick up / break</td><td>Hold left mouse</td></tr>
      <tr><td>Use / place / feed</td><td>Right mouse (Ctrl: whole stack)</td></tr>
      <tr><td>Pick block</td><td>Middle mouse</td></tr>
      <tr><td>Hotbar</td><td>1-8, mouse wheel</td></tr>
      <tr><td>Inventory</td><td>Tab / ${K('inventory')}</td></tr>
      <tr><td>Crafting</td><td>${K('craft')}</td></tr>
      <tr><td>Wiki</td><td>${K('help')} (opens the page for whatever you're pointing at)</td></tr>
      <tr><td>Drop</td><td>${K('drop')} (Shift: stack)</td></tr>
      <tr><td>Revive a friend</td><td>${K('revive')} near the fire</td></tr>
      <tr><td>Chat</td><td>${K('chat')}</td></tr>
      <tr><td>Menu</td><td>Esc</td></tr>
    </table>
    <p class="dim">Rebind any of these in Controls (main menu or Esc menu).</p>`);

  // ---------------- items & fuel ----------------
  const usesOf = (id) => {
    const out = [];
    for (const r of RECIPES) if (r.in[id]) out.push(recipeRow(r));
    for (const [core, m] of Object.entries(MULTIBLOCKS)) {
      if (m.wall === id || BUILDINGS[core].item === id) continue;
      if (m.in?.[0] === id) out.push(`<div>Fed into the ${link('mb:' + core, BUILDINGS[core].name)}.</div>`);
    }
    for (const [core, m] of Object.entries(MULTIBLOCKS)) if (m.wall === id) out.push(`<div>Walls of the ${link('mb:' + core, BUILDINGS[core].name)}.</div>`);
    for (const s of FIRE_STAGES) if (s.block === id) out.push(`<div>The ${link('guide:stages', s.name)} ring around the campfire.</div>`);
    if (id === 'leaf') out.push(`<div>Fed into a ${bld('rot_pit')}.</div>`);
    if (ITEMS[id].fuel) out.push(`<div>Fuel for the fire - and for topping up placed torches.</div>`);
    return out;
  };
  for (const [id, it] of Object.entries(ITEMS)) {
    const cat = it.fuel && FUELS.some((f) => f[0] === id) ? 'Fuel' : it.blueprint ? 'Blueprints' : it.place && BUILDINGS[it.place] ? null : 'Items';
    if (!cat) continue; // placeable things get a building page instead
    const made = RECIPES.filter((r) => r.out[0] === id);
    const uses = usesOf(id);
    let html = `<p>${it.desc ?? ''}</p>`;
    if (it.fuel) html += `<p class="wfuel">Fuel value <b>${it.fuel.value}</b> · heat ${tierName(it.fuel.heat)}${it.fuel.heat ? ` · demanded from minute ${minutesFor(it.fuel.heat)}` : ''}</p>`;
    if (it.learn) html += `<p>Teaches everyone: ${RECIPES.filter((r) => r.requires === it.learn).map((r) => item(r.out[0])).join(', ')}.</p>`;
    if (made.length || SOURCES[id]) html += `<h4>How to get it</h4>${made.map(recipeRow).join('')}${(SOURCES[id] ?? []).map((s) => `<div>${s}</div>`).join('')}`;
    if (uses.length) html += `<h4>Used for</h4>${uses.join('')}`;
    if (id === 'flare') html += `<h4>Using it</h4><p>Select it and right-click anywhere. It shoots up from where you stand; every player hears it and sees a hanging star plus an arrow at their screen edge pointing to you, with your name and distance, for 25 seconds.</p>`;
    if (id === 'axe' || id === 'pickaxe') html += `<p class="dim">Works from anywhere in your inventory - no need to hold it.</p>`;
    add('item:' + id, cat, it.name, id, html);
  }

  // ---------------- buildings ----------------
  const BLD_INFO = {
    torch: `<p>Lights a 5x5 for everyone for ${TORCH.placedFuel}s (${TORCH.rainMult}x faster in rain). Right-click it with fuel to top it up (2s per point of fuel value).</p><p>Touching a powered ${link('bld:root', 'ember root')} it burns forever - orange roots charge the fire ${TORCH.networkCost} fuel/s for it, teal roots nothing.</p><p>Picking up a lit one keeps its fuel; a burnt-out one gives a ${item('charred_stick')}.</p>`,
    root: `<p>Carries heat and fuel. Full details in ${link('guide:roots')}.</p><p>Place it anywhere; it only works when connected (up/down/left/right) back to the fire or an eternal flame. Takes 2 seconds to grow in.</p>`,
    workbench: `<p>Stand within 4 tiles of it to craft advanced recipes.</p>`,
    kindling: `<p>Plant in light. Grows for ~45s (twice as fast in rain), then sheds a ${item('leaf')} every ~7s - forever.</p><p>Beside a ${bld('rot_pit')} it feeds its leaves straight in.</p>`,
    sapling: `<p>Plant in light. Grows for ~90s into a Grove Tree (solid), which sheds a ${item('stick')} every ~14s and a ${item('log')} every ~50s.</p><p>Beside a ${link('mb:kiln', 'Charcoal Kiln')} its logs go straight in. A ${bld('resin_tap')} beside it drips resin.</p>`,
    rain_basin: `<p>Rain fills it (a full basin takes ~30s of rain). While it holds water, the silt settles into 1 ${item('stone')} every 15s, so it keeps working for about a minute after the rain stops. Needs no heat. Doesn't work under a cave roof.</p><p>Like other buildings, it sends its stone down an ember root or into a crate beside it.</p>`,
    rot_pit: `<p>Holds 20 ${item('leaf')}. Every 4 rot into 1 ${item('peat')} in 20s (10s in rain). Needs no heat.</p><p>Kindling Bushes beside it fill it; a ${link('mb:press', 'Peat Press')} beside it takes its peat.</p>`,
    resin_tap: `<p>Place beside a grown Grove Tree (1 ${item('resin')} per 30s) or a Heart Grove (1 per 20s). Faster in rain. Every tap on the same tree shares its flow, so one tap per tree is enough.</p>`,
    crate: `<p>16 slots of storage. Right-click to open it, then move items between it and your inventory like your bag (drag, click, Shift-click to send a stack across). Buildings beside it store their output in it instead of sending it down the roots - perfect for stockpiling charcoal.</p><p>Breaking it gives you the crate and everything in it.</p>`,
    glowmoss: `<p>Gives off a faint 3x3 light, forever. Ring a ${item('heart_seed')} with 8 of these to grow a ${link('mb:heart_seed', 'Heart Grove')}.</p>`,
    hearth: `<p>A ring of 8 around the campfire grows it into a <b>Bonfire</b>. See ${link('guide:stages')}.</p>`,
    fire_brick: `<p>16 in a ring around the Bonfire grow it into a <b>Blaze</b>. Also the walls of the ${link('mb:watchfire', 'Watchfire')} and ${link('mb:forge_core', 'Crystal Forge')}.</p>`,
    ember_stone: `<p>24 in a ring around the Blaze grow it into an <b>Inferno</b>.</p>`,
    brick: `<p>Walls of the ${link('mb:kiln', 'Charcoal Kiln')}.</p>`,
    timber: `<p>Walls of the ${link('mb:press', 'Peat Press')}.</p>`,
    packed_earth: `<p>Walls of the ${link('mb:coal_bed', 'Coal Bed')}.</p>`,
  };
  const B = 'Buildings';
  for (const [t, b] of Object.entries(BUILDINGS)) {
    if (MULTIBLOCKS[t]) continue;
    const recipe = RECIPES.filter((r) => r.out[0] === b.item);
    let html = BLD_INFO[t] ?? `<p>${ITEMS[b.item]?.desc ?? ''}</p>`;
    if (recipe.length) html += `<h4>Crafting</h4>${recipe.map(recipeRow).join('')}`;
    if (SOURCES[b.item]) html += `<h4>Also found</h4>${SOURCES[b.item].map((s) => `<div>${s}</div>`).join('')}`;
    html += `<p class="dim">Hold LMB to pick it back up.</p>`;
    add('bld:' + t, B, b.name, b.item, html);
    A.set('item:' + b.item, A.get('bld:' + t)); // an item that places it links here
  }

  // ---------------- multiblocks ----------------
  const MB_INFO = {
    kiln: `Bakes ${item('log', 2)} into ${item('charcoal', 1)} every 15s. Needs heat: a powered root touching its walls. Grove Trees beside it feed it logs.`,
    press: `Squeezes ${item('peat', 3)} into ${item('lignite', 1)} every 25s. Needs no heat. A Rot Pit beside it feeds it peat; a Coal Bed beside it takes the lignite.`,
    coal_bed: `Bakes ${item('lignite', 2)} into ${item('coal', 1)} every 40s. Needs heat. A Peat Press beside it feeds it; a Crystal Forge beside it takes the coal.`,
    forge_core: `Grows ${item('ember_crystal', 1)} from each ${item('coal')} in 60s. Needs heat. A Coal Bed beside it feeds it.`,
    watchfire: `When a powered root touches its walls it lights an 11x11 area for everyone - an outpost in the dark. On teal roots it's free.`,
    heart_seed: `A ${item('heart_seed')} ringed by 8 ${item('glowmoss')} grows over ~2 minutes into a great tree. Then it works like a kiln: put in ${item('log')}s and, with an ember root touching its moss (for heat), it turns every 5 logs into 1 ${item('heartwood')} (90s). A Resin Tap beside the grown tree drips a little faster than on a Grove Tree.`,
  };
  for (const [core, m] of Object.entries(MULTIBLOCKS)) {
    const name = BUILDINGS[core].name;
    const coreItem = BUILDINGS[core].item;
    const bp = RECIPES.find((r) => r.out[0] === coreItem)?.requires;
    let html = `<p>${MB_INFO[core]}</p><h4>Layout (${m.size}x${m.size})</h4>${mbGrid(core)}<p class="dim">${item(coreItem)} in the middle, ${(m.size * m.size - 1)} ${item(m.wall)} around it. Place the core first and the missing spots show as outlines.</p>`;
    if (m.in) html += `<p>Holds up to ${m.in[1]} ${item(m.in[0])}. Right-click it while holding them to put one in (Shift: the whole stack), and right-click it otherwise to grab everything it has made - or let a neighbour feed it and a root carry its output away.</p>`;
    if (m.heat) html += `<p>Heat cost on orange roots: ${m.draw} fuel/s while working. Free on teal roots.</p>`;
    if (m.fuse) html += `<p>When the last block goes in, it fuses into one structure. Breaking any part breaks the whole thing and drops every block.</p>`;
    const recipes = RECIPES.filter((r) => r.out[0] === coreItem || r.out[0] === m.wall);
    if (recipes.length) html += `<h4>Crafting</h4>${recipes.map(recipeRow).join('')}`;
    if (bp) html += `<p>Needs ${link('item:bp_' + bp, 'Blueprint: ' + BLUEPRINTS[bp])}.</p>`;
    add('mb:' + core, 'Multiblocks', name, coreItem, html);
    A.set('bld:' + core, A.get('mb:' + core));
    A.set('item:' + coreItem, A.get('mb:' + core));
  }

  // ---------------- the world ----------------
  const W = 'The World';
  add('world:eternal', W, 'Eternal flames', 'torch', `<p>Found in about two thirds of ruins - and there's always one in a ruin 20-40 tiles from your campfire, close enough to root to. It never goes out: a 7x7 of safe light anywhere in the dark, and your torches relight there.</p><p>Roots touching it grow <b>teal</b> - see ${link('guide:roots')}. Right-click it to open its cache.</p>`);
  add('world:ruins', W, 'Ruins', 'stone', `<p>Walled stone squares with a door gap and one or two old chests. Most have an ${link('world:eternal', 'eternal flame')}; the rest have a cold brazier and an extra chest.</p><p>Chests hold sticks, logs, torches, seeds, saplings and better fuel the farther out you go - and often a blueprint: the Kiln, or farther out the Resin Tap or Peat Press. Designs nobody has found yet are likelier, but duplicates still happen.</p>`);
  add('world:dead_fires', W, 'Dead campfires', 'charred_stick', `<p>Someone else's fire, gone out. A ring of cold stones, bedrolls, scattered sticks, a chest, and a scrawled note (right-click to read it).</p><p>Sift the ashes (hold LMB) for charcoal and charred sticks. Their chests sometimes hold a blueprint: the Kiln, Resin Tap, or (40+ tiles out) the Watchfire.</p>`);
  add('world:shrines', W, 'Shrines', 'bp_kiln', `<p>A lit stone pedestal holding one blueprint - guaranteed. Right-click to take it; the shrine stays lit, a safe place to rest.</p><p>Shrines farther out hold better designs: near ones offer the Kiln, Resin Tap or Peat Press; middle ones the Blaze, Watchfire, Press or Tap; the farthest the Inferno, Crystal Forge, Watchfire or Blaze. The Inferno and Crystal Forge are found nowhere else. A shrine favours a design nobody has found yet.</p>`);
  add('world:mines', W, 'Collapsed mines', 'coal', `<p>Tunnels through solid rock, pitch dark inside - bring plenty of torches and a ${item('pickaxe')}.</p><p>Coal seams (dark specks in the walls) give ${item('coal')}. Geodes at the far ends give a ${item('crystal_geode')}. There's usually a chest at a dead end - the only place to find the Coal Bed blueprint (it can also hold the Blaze). You can tunnel through cave walls with the pickaxe.</p>`);
  add('world:groves', W, 'Ancient groves', 'glowmoss', `<p>Mossy clearings lit by patches of ${item('glowmoss')}, around an ${link('world:ancient_tree', 'Ancient Tree')}. Small oases of light in the dark.</p>`);
  add('world:ancient_tree', W, 'Ancient Tree', 'heartwood', `<p>A huge glowing tree at the heart of a grove. Fell it with an axe for 3 ${item('heartwood')}, 4 logs and a ${item('heart_seed')}.</p>`);
  add('world:nature', W, 'Trees, bushes & rocks', 'sapling', `<p><b>Trees</b>: shake by hand for sticks (three times, then bare); chop with an axe for logs. <b>Bushes</b>: leaves, sometimes a seed; they regrow, or clear a picked one away. <b>Rocks</b>: stone, three times each.</p><p>The 13x13 around the fire starts empty - everything is out in the dark.</p>`);

  for (const a of A.values()) a.words = (a.title + ' ' + a.html.replace(/<[^>]+>/g, ' ')).toLowerCase();
  return A;
}

export const WIKI_CATS = ['Guides', 'Fuel', 'Items', 'Buildings', 'Multiblocks', 'Blueprints', 'The World'];

// Which wiki page describes a thing in the world.
export function wikiIdFor(w, x, y) {
  if (x === 0 && y === 0) return 'guide:stages';
  const b = w.getB(x, y);
  if (b) {
    const core = w.formedCoreAt(x, y);
    if (core) return 'mb:' + core[2].t;
    return MULTIBLOCKS[b.t] ? 'mb:' + b.t : 'bld:' + b.t;
  }
  const f = w.getFeature(x, y);
  if (!f) return null;
  const map = { eternal: 'world:eternal', wall: 'world:ruins', brazier: 'world:ruins', chest: 'world:ruins', chest_open: 'world:ruins', dead_fire: 'world:dead_fires', bedroll: 'world:dead_fires', note: 'world:dead_fires', shrine: 'world:shrines', shrine_empty: 'world:shrines', cave_wall: 'world:mines', coal_seam: 'world:mines', geode: 'world:mines', ancient_tree: 'world:ancient_tree', ancient_stump: 'world:ancient_tree', glowmoss: 'world:groves' };
  if (map[f.t]) return map[f.t];
  if (FEATURES[f.t]?.loose) return 'item:' + FEATURES[f.t].loose;
  return 'world:nature';
}
