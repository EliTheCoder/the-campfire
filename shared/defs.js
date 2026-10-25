// Item, building, feature and recipe definitions.

// fuel.value = seconds of campfire burn at base rate; fuel.heat = tier (0..4)
export const ITEMS = {
  leaf: { name: 'Leaves', fuel: { value: 8, heat: 0 }, desc: 'Quick to burn. Rots into peat.' },
  stick: { name: 'Sticks', fuel: { value: 20, heat: 1 } },
  log: { name: 'Log', fuel: { value: 55, heat: 2 }, desc: 'Chop trees with an axe.' },
  peat: { name: 'Peat', fuel: { value: 90, heat: 3 }, desc: 'Leaves, rotted down in a Rot Pit.' },
  charcoal: { name: 'Charcoal', fuel: { value: 160, heat: 4 }, desc: 'Logs baked in a Charcoal Kiln.' },
  charred_stick: { name: 'Charred Stick', fuel: { value: 6, heat: 0 }, desc: "What's left of a burnt-out torch. Re-craft it into a torch." },
  stone: { name: 'Stone' },
  seed: { name: 'Kindling Seed', place: 'kindling', desc: 'Plant in light. Grows leaves forever.' },
  sapling: { name: 'Sapling', place: 'sapling', desc: 'Plant in light. Grows into a grove tree that sheds sticks and logs.' },
  torch: { name: 'Torch', place: 'torch', desc: 'Carried: lights your way (3x3, only you). Placed: lights 5x5 for everyone.' },
  axe: { name: 'Stone Axe', stack: 1, desc: 'Chop trees into logs. Works from your inventory.' },
  workbench: { name: 'Workbench', place: 'workbench', desc: 'Stand near it to craft advanced recipes.' },
  ember_root: { name: 'Ember Root', place: 'root', desc: 'Place next to the fire or another root. Carries fire out to torches, and carries fuel back in.' },
  rot_pit: { name: 'Rot Pit', place: 'rot_pit', desc: 'Turns 4 leaves into 1 peat over time. Faster in rain.' },
  hearth: { name: 'Hearthstone', place: 'hearth', desc: 'Place touching the campfire: -8% burn rate each (max 4).' },
  brick: { name: 'Stone Brick', place: 'brick' },
  kiln: { name: 'Kiln Core', place: 'kiln', desc: 'Surround with 8 Stone Bricks. Needs an ember root. Bakes logs into charcoal.' },
  blueprint_kiln: { name: 'Blueprint: Kiln', learn: 'kiln', desc: 'Right-click to read. Teaches the Charcoal Kiln to everyone.' },
};

export const BUILDINGS = {
  torch: { name: 'Torch', item: 'torch' },
  root: { name: 'Ember Root', item: 'ember_root' },
  workbench: { name: 'Workbench', item: 'workbench', solid: true },
  kindling: { name: 'Kindling Bush', item: 'seed' },
  sapling: { name: 'Sapling', item: 'sapling' },
  rot_pit: { name: 'Rot Pit', item: 'rot_pit', solid: true },
  kiln: { name: 'Charcoal Kiln', item: 'kiln', solid: true },
  brick: { name: 'Stone Brick', item: 'brick', solid: true },
  hearth: { name: 'Hearthstone', item: 'hearth', solid: true },
};

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
  eternal: { name: 'Eternal Flame', solid: true },
  brazier: { name: 'Cold Brazier', solid: true },
  chest: { name: 'Old Chest', solid: true },
  chest_open: { name: 'Empty Chest', solid: true },
};

export const RECIPES = [
  { id: 'torch', out: ['torch', 2], in: { stick: 1, leaf: 2 } },
  { id: 'retorch', out: ['torch', 1], in: { charred_stick: 1, leaf: 1 } },
  { id: 'axe', out: ['axe', 1], in: { stick: 3, stone: 2 } },
  { id: 'workbench', out: ['workbench', 1], in: { stick: 6, stone: 4 } },
  { id: 'ember_root', out: ['ember_root', 4], in: { log: 1, leaf: 2 }, station: 'workbench' },
  { id: 'hearth', out: ['hearth', 1], in: { stone: 5 }, station: 'workbench' },
  { id: 'rot_pit', out: ['rot_pit', 1], in: { stone: 6, log: 2 }, station: 'workbench' },
  { id: 'brick', out: ['brick', 1], in: { stone: 2 }, station: 'workbench' },
  { id: 'kiln', out: ['kiln', 1], in: { stone: 4, log: 2, peat: 1 }, station: 'workbench', requires: 'kiln' },
];

export function stackMax(item) { return ITEMS[item]?.stack ?? 50; }
