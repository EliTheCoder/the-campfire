// Item, building, feature, recipe and multiblock definitions.

// fuel.value = seconds of campfire burn at base rate; fuel.heat = tier. The ladder alternates
// growth (cultivated) and decay (rotted / pressed / baked) sources.
export const FUELS = [
  ['leaf', 'Leaves', 8],
  ['stick', 'Sticks', 20],
  ['log', 'Log', 55],
  ['peat', 'Peat', 90],
  ['charcoal', 'Charcoal', 160],
  ['resin', 'Resin', 240],
  ['lignite', 'Lignite', 360],
  ['heartwood', 'Heartwood', 520],
  ['coal', 'Coal', 750],
  ['ember_crystal', 'Ember Crystal', 1100],
];
export const FUEL_NAMES = FUELS.map((f) => f[1]);

export const ITEMS = {
  leaf: { desc: 'Quick to burn. Rots into peat.' },
  stick: {},
  log: { desc: 'Chop trees with an axe.' },
  peat: { desc: 'Leaves rotted down in a Rot Pit.' },
  charcoal: { desc: 'Logs baked in a Charcoal Kiln.' },
  resin: { desc: 'Tapped from living trees with a Resin Tap.' },
  lignite: { desc: 'Peat squeezed in a Peat Press.' },
  heartwood: { desc: 'Grows in a Heart Grove, or cut from ancient trees.' },
  coal: { desc: 'Mined from seams in collapsed mines, or baked from lignite in a Coal Bed.' },
  ember_crystal: { desc: 'Grown in a Crystal Forge from raw heat.' },
  charred_stick: { name: 'Charred Stick', fuel: { value: 6, heat: 0 }, desc: "What's left of a burnt-out torch. Re-craft it into a torch." },
  stone: { name: 'Stone' },
  seed: { name: 'Kindling Seed', place: 'kindling', desc: 'Plant in light. Grows leaves forever.' },
  sapling: { name: 'Sapling', place: 'sapling', desc: 'Plant in light. Grows into a grove tree that sheds sticks and logs.' },
  torch: { name: 'Torch', place: 'torch', desc: 'Carried: lights your way (3x3, only you). Placed: lights 5x5 for everyone.' },
  axe: { name: 'Stone Axe', stack: 1, desc: 'Chop trees into logs. Works from your inventory.' },
  pickaxe: { name: 'Pickaxe', stack: 1, desc: 'Mine rock, cave walls, coal seams and geodes. Works from your inventory.' },
  workbench: { name: 'Workbench', place: 'workbench', desc: 'Stand near it to craft advanced recipes.' },
  crate: { name: 'Crate', place: 'crate', desc: 'Machines beside it store their output here instead of sending it down the roots. RMB to take, RMB with items to store.' },
  ember_root: { name: 'Ember Root', place: 'root', desc: 'Carries heat from the campfire (orange) or an eternal flame (teal) to torches and machines, and carries fuel back.' },
  rot_pit: { name: 'Rot Pit', place: 'rot_pit', desc: 'Turns 4 leaves into 1 peat over time. Faster in rain.' },
  resin_tap: { name: 'Resin Tap', place: 'resin_tap', desc: 'Place beside a grown grove tree or heart tree. Drips resin.' },
  glowmoss: { name: 'Glowmoss', place: 'glowmoss', desc: 'Gives off a faint 3x3 light. Found in ancient groves.' },
  heart_seed: { name: 'Heartwood Seed', place: 'heart_seed', desc: 'Plant it surrounded by 8 Glowmoss to grow a Heart Grove.' },
  crystal_geode: { name: 'Crystal Geode', desc: 'Found deep in collapsed mines. The heart of a Crystal Forge.' },
  hearth: { name: 'Hearthstone', place: 'hearth', desc: 'Ring the campfire with 8 to grow it into a Bonfire.' },
  brick: { name: 'Stone Brick', place: 'brick', desc: 'Kiln walls.' },
  fire_brick: { name: 'Fire Brick', place: 'fire_brick', desc: 'Blaze ring (16 around the Bonfire), Watchfire and Crystal Forge walls.' },
  ember_stone: { name: 'Ember Stone', place: 'ember_stone', desc: 'Inferno ring: 24 around the Blaze.' },
  timber: { name: 'Timber Frame', place: 'timber', desc: 'Peat Press walls.' },
  packed_earth: { name: 'Packed Earth', place: 'packed_earth', desc: 'Coal Bed walls.' },
  kiln: { name: 'Kiln Core', place: 'kiln', desc: 'Surround with 8 Stone Bricks. Needs heat from a root. Bakes logs into charcoal.' },
  press: { name: 'Press Core', place: 'press', desc: 'Surround with 8 Timber Frames. Squeezes peat into lignite.' },
  coal_bed: { name: 'Coal Bed Core', place: 'coal_bed', desc: 'Surround with 24 Packed Earth (5x5). Needs heat. Bakes lignite into coal.' },
  forge_core: { name: 'Forge Heart', place: 'forge_core', desc: 'Surround with 24 Fire Bricks (5x5). Needs heat. Grows ember crystals from coal.' },
  watchfire: { name: 'Watchfire Brazier', place: 'watchfire', desc: 'Surround with 8 Fire Bricks. When heated by a root it lights 11x11 for everyone.' },
};
for (const [id, name, value] of FUELS) ITEMS[id] = { name, fuel: { value, heat: FUELS.findIndex((f) => f[0] === id) }, ...ITEMS[id] };

// Blueprints: found in ruins, dead campfires and shrines. Reading one teaches everyone.
export const BLUEPRINTS = {
  kiln: 'Charcoal Kiln',
  resin_tap: 'Resin Tap',
  peat_press: 'Peat Press',
  blaze: 'Blaze (Fire Bricks)',
  watchfire: 'Watchfire',
  coal_bed: 'Coal Bed',
  inferno: 'Inferno (Ember Stones)',
  crystal_forge: 'Crystal Forge',
};
for (const [id, name] of Object.entries(BLUEPRINTS)) ITEMS['bp_' + id] = { name: 'Blueprint: ' + name, learn: id, desc: 'Right-click to read. Teaches everyone at the fire.', blueprint: true };

export const BUILDINGS = {
  torch: { name: 'Torch', item: 'torch' },
  root: { name: 'Ember Root', item: 'ember_root' },
  workbench: { name: 'Workbench', item: 'workbench', solid: true },
  crate: { name: 'Crate', item: 'crate', solid: true },
  kindling: { name: 'Kindling Bush', item: 'seed' },
  sapling: { name: 'Sapling', item: 'sapling' },
  rot_pit: { name: 'Rot Pit', item: 'rot_pit', solid: true },
  resin_tap: { name: 'Resin Tap', item: 'resin_tap', solid: true },
  glowmoss: { name: 'Glowmoss', item: 'glowmoss' },
  heart_seed: { name: 'Heart Grove', item: 'heart_seed', solid: true },
  hearth: { name: 'Hearthstone', item: 'hearth', solid: true },
  brick: { name: 'Stone Brick', item: 'brick', solid: true },
  fire_brick: { name: 'Fire Brick', item: 'fire_brick', solid: true },
  ember_stone: { name: 'Ember Stone', item: 'ember_stone', solid: true },
  timber: { name: 'Timber Frame', item: 'timber', solid: true },
  packed_earth: { name: 'Packed Earth', item: 'packed_earth', solid: true },
  kiln: { name: 'Charcoal Kiln', item: 'kiln', solid: true },
  press: { name: 'Peat Press', item: 'press', solid: true },
  coal_bed: { name: 'Coal Bed', item: 'coal_bed', solid: true },
  forge_core: { name: 'Crystal Forge', item: 'forge_core', solid: true },
  watchfire: { name: 'Watchfire', item: 'watchfire', solid: true },
};

// Multiblocks: a core surrounded by wall blocks (every other tile of a size x size square).
// in: input item + capacity; make: [inputs per batch, output item, seconds]; heat: needs a
// powered root touching its walls (draw = campfire fuel/sec while working, on orange roots).
// grows: produces output without input (heart grove). light: shared light radius when running.
export const MULTIBLOCKS = {
  kiln: { size: 3, wall: 'brick', in: ['log', 10], make: [2, 'charcoal', 15], heat: true, draw: 0.25, fuse: true },
  press: { size: 3, wall: 'timber', in: ['peat', 12], make: [3, 'lignite', 25], heat: false, fuse: true },
  coal_bed: { size: 5, wall: 'packed_earth', in: ['lignite', 12], make: [2, 'coal', 40], heat: true, draw: 0.6, fuse: true },
  forge_core: { size: 5, wall: 'fire_brick', in: ['coal', 10], make: [1, 'ember_crystal', 60], heat: true, draw: 1.5, fuse: true },
  heart_seed: { size: 3, wall: 'glowmoss', grows: ['heartwood', 45], growTime: 120 },
  watchfire: { size: 3, wall: 'fire_brick', heat: true, draw: 1.0, light: 5, fuse: true },
};
export const WALL_OF = {}; // wall block type -> multiblock core types using it
for (const [core, m] of Object.entries(MULTIBLOCKS)) (WALL_OF[m.wall] ||= []).push(core);

// The campfire grows in stages by ringing it with blocks.
export const FIRE_STAGES = [
  { name: 'Campfire', radius: 4, maxFuel: 600 },
  { name: 'Bonfire', radius: 5, maxFuel: 1500, ring: 1, block: 'hearth' },
  { name: 'Blaze', radius: 6, maxFuel: 4000, ring: 2, block: 'fire_brick' },
  { name: 'Inferno', radius: 7, maxFuel: 10000, ring: 3, block: 'ember_stone' },
];
export const RING_BLOCKS = new Set(FIRE_STAGES.filter((s) => s.block).map((s) => s.block));

// Plants and machines hand their output straight to a neighbouring machine that takes it.
export const FEEDS = { kindling: 'rot_pit', sapling: 'kiln', rot_pit: 'press', press: 'coal_bed', coal_bed: 'forge_core' };

export const FEATURES = {
  tree: { name: 'Tree', solid: true, time: 0.9 },
  bare_tree: { name: 'Bare Tree', solid: true, time: 1.0 },
  stump: { name: 'Stump', time: 0.6 },
  bush: { name: 'Bush', time: 0.5 },
  picked_bush: { name: 'Picked Bush', time: 0.6 },
  rock: { name: 'Rock', solid: true, time: 1.2 },
  leaf: { name: 'Leaves', loose: 'leaf' },
  stick: { name: 'Sticks', loose: 'stick' },
  pebble: { name: 'Stone', loose: 'stone' },
  wall: { name: 'Ancient Wall', solid: true },
  rubble: { name: 'Rubble', time: 0.6 },
  eternal: { name: 'Eternal Flame', solid: true, light: 3 },
  brazier: { name: 'Cold Brazier', solid: true },
  chest: { name: 'Old Chest', solid: true },
  chest_open: { name: 'Empty Chest', solid: true },
  // dead campfires
  dead_fire: { name: 'Dead Campfire' },
  bedroll: { name: 'Abandoned Bedroll', time: 0.6 },
  note: { name: 'Scrawled Note' },
  // shrines
  shrine: { name: 'Shrine', solid: true, light: 2 },
  shrine_empty: { name: 'Empty Shrine', solid: true, light: 2 },
  // mines
  cave_wall: { name: 'Cave Wall', solid: true, time: 1.4, tool: 'pickaxe' },
  coal_seam: { name: 'Coal Seam', solid: true, time: 1.6, tool: 'pickaxe' },
  geode: { name: 'Crystal Geode', solid: true, time: 2.2, tool: 'pickaxe' },
  // groves
  ancient_tree: { name: 'Ancient Tree', solid: true, time: 2.5, tool: 'axe', light: 2 },
  ancient_stump: { name: 'Ancient Stump', solid: true },
  glowmoss: { name: 'Glowmoss', time: 0.6, light: 1 },
};

export const RECIPES = [
  { id: 'torch', out: ['torch', 2], in: { stick: 1, leaf: 2 } },
  { id: 'retorch', out: ['torch', 1], in: { charred_stick: 1, leaf: 1 } },
  { id: 'axe', out: ['axe', 1], in: { stick: 3, stone: 2 } },
  { id: 'workbench', out: ['workbench', 1], in: { stick: 6, stone: 4 } },
  { id: 'ember_root', out: ['ember_root', 4], in: { log: 1, leaf: 2 }, station: 'workbench' },
  { id: 'crate', out: ['crate', 1], in: { log: 3, stick: 2 }, station: 'workbench' },
  { id: 'pickaxe', out: ['pickaxe', 1], in: { stick: 2, stone: 3, log: 1 }, station: 'workbench' },
  { id: 'rot_pit', out: ['rot_pit', 1], in: { stone: 6, log: 2 }, station: 'workbench' },
  { id: 'hearth', out: ['hearth', 1], in: { stone: 4 }, station: 'workbench' },
  { id: 'brick', out: ['brick', 1], in: { stone: 2 }, station: 'workbench', requires: 'kiln' },
  { id: 'kiln', out: ['kiln', 1], in: { stone: 4, log: 2, peat: 1 }, station: 'workbench', requires: 'kiln' },
  { id: 'resin_tap', out: ['resin_tap', 1], in: { log: 2, stone: 2, charcoal: 1 }, station: 'workbench', requires: 'resin_tap' },
  { id: 'timber', out: ['timber', 1], in: { log: 2 }, station: 'workbench', requires: 'peat_press' },
  { id: 'press', out: ['press', 1], in: { log: 4, stone: 4, peat: 2 }, station: 'workbench', requires: 'peat_press' },
  { id: 'fire_brick', out: ['fire_brick', 2], in: { stone: 2, charcoal: 1 }, station: 'workbench', requires: 'blaze' },
  { id: 'watchfire', out: ['watchfire', 1], in: { fire_brick: 4, charcoal: 4, resin: 2 }, station: 'workbench', requires: 'watchfire' },
  { id: 'packed_earth', out: ['packed_earth', 2], in: { stone: 1, peat: 1 }, station: 'workbench', requires: 'coal_bed' },
  { id: 'coal_bed', out: ['coal_bed', 1], in: { stone: 6, lignite: 4, charcoal: 4 }, station: 'workbench', requires: 'coal_bed' },
  { id: 'ember_stone', out: ['ember_stone', 2], in: { stone: 2, coal: 1, lignite: 1 }, station: 'workbench', requires: 'inferno' },
  { id: 'forge_core', out: ['forge_core', 1], in: { crystal_geode: 1, coal: 6, fire_brick: 4 }, station: 'workbench', requires: 'crystal_forge' },
];

export function stackMax(item) { return ITEMS[item]?.stack ?? 50; }
