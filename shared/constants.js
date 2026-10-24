// Tunables shared by server and client. Most balance knobs live here.
export const TILE = 16;
export const CHUNK = 24;
export const TICK_RATE = 20;
export const SNAP_EVERY = 2; // ticks per snapshot (10Hz)
export const DEFAULT_PORT = 7777;

export const FIRE = {
  radius: 4, // 9x9 lit square
  startFuel: 240,
  maxFuel: 600,
  baseBurn: 1, // fuel/sec at minute 0
  hungerPerMin: 0.05, // burn multiplier growth per minute
  demandEveryMin: 5, // heat demand tier rises every N minutes
  maxDemand: 4,
  belowHeatPenalty: 0.3, // value multiplier per tier below demand
  reviveCost: 120,
  rainMult: 1.5,
  hotBonus: 0.85, // burn multiplier when temperature exceeds demand
};

export const TORCH = {
  placedRadius: 2, // 5x5
  placedFuel: 150,
  rainMult: 3,
  networkCost: 0.3, // fire fuel paid per second of torch burn when fed by roots
  heldRadius: 1, // 3x3, personal
  heldFuel: 75,
  heldRainMult: 1.6,
};

export const ETERNAL_RADIUS = 3;
export const COLD_GRACE = 6; // seconds in the dark without light before death
export const REACH = 3.5;
export const PLAYER_SPEED = 4.5; // tiles/sec
export const PLAYER_HALF = 0.3;
export const INV_SIZE = 24;
export const HOTBAR = 8;
export const STACK = 50;
export const PACKET_SPEED = 6; // tiles/sec along roots

export const PLAYER_COLORS = ['#d8553a', '#3a8fd8', '#5fbf4a', '#d8b03a', '#a45fd8', '#3ad8c0', '#d83a8f', '#e8e8e8'];

export const FIRE_TIERS = ['Smoldering', 'Burning', 'Bright', 'White-hot', 'Blue'];
