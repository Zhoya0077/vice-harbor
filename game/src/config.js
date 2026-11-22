// Vice Harbor: every tuning number, colour and label in one place. The world is measured in
// pixels at 1:1, the camera shows a 1280x800 window into it and the renderer scales that view to
// whatever the browser gives us, so nothing below depends on the screen.

export const WORLD = { width: 3200, height: 2400 };

/** The simulation ticks at a fixed 60 Hz no matter what the display does. */
export const STEP = 1 / 60;

/** One shift is five minutes of in-game time. */
export const SHIFT_SECONDS = 300;

/** Roads run on a 400 px grid; a car lane sits 23 px either side of a road's centre line. */
export const ROAD = { width: 96, half: 48, sidewalk: 20, lane: 23 };
export const ROAD_COLS = [200, 600, 1000, 1400, 1800, 2200, 2600, 3000];
export const ROAD_ROWS = [160, 560, 960, 1360, 1760];

/** South edge: sand from `top` and open water from `water` to the bottom of the world. */
export const BEACH = { top: 2036, water: 2160 };

export const MAX_HEAT = 5;

export const PLAYER = {
  radius: 11,
  walk: 176,
  sprint: 292,
  health: 100,
  regen: 3.4,
  enterRange: 74,
  hurtCooldown: 0.55,
};

/** Car archetypes. Speeds are px/s, accelerations px/s². */
export const CAR_SPECS = {
  compact: { label: 'Compact', width: 44, height: 23, maxSpeed: 330, accel: 235, brake: 430, handling: 2.55, grip: 9.0, health: 100, mass: 1.0 },
  sports: { label: 'Sports', width: 50, height: 22, maxSpeed: 492, accel: 400, brake: 540, handling: 3.15, grip: 8.2, health: 88, mass: 0.95 },
  truck: { label: 'Truck', width: 64, height: 28, maxSpeed: 252, accel: 168, brake: 350, handling: 1.75, grip: 8.0, health: 158, mass: 1.5 },
  police: { label: 'Police', width: 50, height: 25, maxSpeed: 415, accel: 305, brake: 470, handling: 2.85, grip: 9.2, health: 132, mass: 1.15 },
};

export const CAR_COLORS = [
  '#c0392b', '#2d6fb8', '#d8d8d2', '#2b2f3a', '#c9a227', '#5b8f6a',
  '#8e5ba6', '#b7532f', '#3f8f9e', '#a8455f', '#dcd6c4', '#44506b',
];

export const PED_COLORS = ['#d9a066', '#c76b6b', '#7fa7c4', '#b7c27a', '#c39bc0', '#9fb0b8', '#e0b26a'];

export const PALETTE = {
  night: '#070a12',
  asphalt: '#23252e',
  asphaltAlt: '#1d1f27',
  sidewalk: '#5a5d68',
  sidewalkAlt: '#4c4f59',
  curb: '#6b6f7c',
  building: ['#2b3040', '#343a4c', '#3d3345', '#2f3d47', '#443b39', '#39404f'],
  buildingLit: '#ffd98a',
  neon: ['#ff3d7f', '#33e1ff', '#ffd166', '#9b6bff', '#57ff9a'],
  sand: '#c8a76f',
  sandDark: '#b3935f',
  water: '#14384d',
  waterDeep: '#0c2437',
  grass: '#37543f',
  text: '#f2f5ff',
  muted: '#93a0b8',
  gold: '#ffd166',
  danger: '#ff4d5e',
  police: '#3f7dff',
};

export const FONT_DISPLAY = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
export const FONT = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const FONT_MONO = '"SF Mono", "Cascadia Mono", Consolas, "Roboto Mono", monospace';

/** Cash paid per job type, and how long each job's clock runs. */
export const JOB_PAY = { delivery: 420, checkpoints: 560, drops: 380 };
export const JOB_TIME = { delivery: 78, checkpoints: 96, drops: 72 };

/** Police pressure per wanted star: how many units may be on the street at once. */
export const POLICE_UNITS = [0, 1, 2, 3, 4, 6];

export const DECAY = { unseenAfter: 4.5, starSeconds: 7.0, swapBonus: 2.6 };
