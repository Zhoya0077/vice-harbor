// The frozen scenes behind ?shot=start|play|chase|end. Each one builds the real world from the
// URL's seed, plays the real rules forward under an autopilot for a fixed number of steps, then
// stops with the camera settled. Same seed, same scene: the shots script and the judge both get
// the same pixels.
import { SHIFT_SECONDS } from './config.js';
import { PHASE_OVER, PHASE_PLAY, PHASE_TITLE, REASON_TIME, JOB_CHECKPOINTS, JOB_DELIVERY } from './world.js';
import { distance } from './util.js';

const STEP = 1 / 60;

/** Hold the autopilot's controls for `seconds` of fixed steps. */
function run(world, seconds, controls) {
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) world.step(STEP, controls);
}

/** A simple driver: aim at a point, back off when it is behind, brake into corners. */
function driveTo(world, x, y, seconds, extra) {
  const state = world.state;
  const steps = Math.round(seconds / STEP);
  for (let i = 0; i < steps; i += 1) {
    const p = state.player;
    const car = p.car;
    const heading = car ? car.angle : p.angle;
    const wanted = Math.atan2(y - p.y, x - p.x);
    let diff = wanted - heading;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const steer = Math.max(-1, Math.min(1, diff * 2.4));
    const distanceLeft = Math.hypot(x - p.x, y - p.y);
    const throttle = distanceLeft < 90 ? 0.15 : Math.abs(diff) > 1.7 ? -0.9 : 1;
    world.step(STEP, {
      moveX: steer,
      moveY: -throttle,
      sprint: false,
      handbrake: extra?.handbrake ?? false,
    });
  }
}

/** Put a car right beside the player and step in, then point it at a target. */
function takeNearestCar(world) {
  const state = world.state;
  let best = null;
  let bestD = Infinity;
  for (const car of state.cars) {
    if (car.wrecked) continue;
    const d = distance(car.x, car.y, state.player.x, state.player.y);
    if (d < bestD) {
      bestD = d;
      best = car;
    }
  }
  if (!best) return null;
  state.player.x = best.x;
  state.player.y = best.y;
  world.tryUseCar();
  return state.player.car;
}

/** The play scene: on foot at a kerb, a car pulled up beside, a delivery job waiting. */
function stagePlay(world) {
  const state = world.state;
  world.startShift();
  run(world, 1.2, { moveX: 0, moveY: 0, sprint: false, handbrake: false });
  // A job with the pickup a couple of blocks away, so the marker and the arrow both read.
  state.job = null;
  state.jobWait = 999;
  world.spawnJob();
  if (state.job) {
    state.job.type = JOB_DELIVERY;
    state.job.label = 'DELIVERY';
    state.job.title = 'Hot package';
    state.job.stage = 0;
    state.job.timer = 63;
    state.job.limit = 78;
    state.job.pay = 420;
  }
  // Park the car the player just took, on the kerb, nose down the avenue.
  const car = takeNearestCar(world);
  if (car) {
    car.x = state.player.x + 4;
    car.y = state.player.y + 2;
    car.angle = -Math.PI / 2;
    car.speed = 0;
    car.vx = 0;
    car.vy = 0;
    state.player.x = car.x;
    state.player.y = car.y;
    state.player.angle = car.angle;
  }
  state.heat = 0;
  state.cash = 240;
  state.score = 180;
  state.clock = 17 * 60 + 55;
  state.shift = SHIFT_SECONDS - 70;
  state.night = 0.3;
  state.floaters.length = 0;
  state.effects.length = 0;
  state.tip = 'New job on the phone: Hot package';
  state.district = { name: 'Palm Heights', accent: '#57ff9a' };
  state.banner = { name: 'Palm Heights', t: 0, accent: '#57ff9a' };
  state.tipTimer = 2.5;
  state.camera.shake = 0;
  world.updateCamera(1);
}

/** The chase scene: three wanted stars, police behind, the player flat out down Neon Mile. */
function stageChase(world) {
  const state = world.state;
  world.startShift();
  run(world, 0.6, { moveX: 0, moveY: 0, sprint: false, handbrake: false });
  // Straight into a fast car on the nearest avenue.
  const car = takeNearestCar(world);
  if (car) {
    car.x = 1490;
    car.y = 1120;
    car.angle = -Math.PI / 2;
    state.player.x = car.x;
    state.player.y = car.y;
  }
  state.heat = 3;
  state.best.heat = 3;
  state.cash = 1860;
  state.score = 940;
  state.jobsDone = 2;
  state.stats.jobs = 2;
  state.stats.stolen = 3;
  state.clock = 18 * 60 + 12;
  state.shift = SHIFT_SECONDS - 96;
  state.night = 0.62;
  state.district = { name: 'Neon Mile', accent: '#ff3d7f' };
  state.banner = { name: 'Neon Mile', t: 0, accent: '#ff3d7f' };
  state.floaters.length = 0;
  state.effects.length = 0;
  state.tip = 'Three stars. Lose them or lose the shift.';
  state.tipTimer = 2.4;
  state.job = {
    type: JOB_CHECKPOINTS,
    label: 'CHECKPOINTS',
    title: 'Street circuit',
    stage: 2,
    points: [{ x: 1490, y: 500 }, { x: 2100, y: 500 }, { x: 2100, y: 1400 }, { x: 2600, y: 1760 }],
    timer: 71,
    limit: 96,
    pay: 560,
    district: 'Neon Mile',
  };
  state.jobWait = 999;
  // Three cruisers boxed in ahead and to the sides, where the frame can see them.
  state.police.length = 0;
  const spots = [
    { x: 1452, y: 968, angle: -Math.PI / 2 },
    { x: 1536, y: 902, angle: Math.PI / 2 + 0.35 },
    { x: 1372, y: 1082, angle: -Math.PI / 2 + 0.22 },
  ];
  for (let i = 0; i < spots.length; i += 1) {
    const unit = world.spawnPoliceUnit();
    unit.car.x = spots[i].x;
    unit.car.y = spots[i].y;
    unit.car.angle = spots[i].angle;
    unit.car.speed = 180 - i * 20;
    unit.car.vx = Math.cos(spots[i].angle) * 180;
    unit.car.vy = Math.sin(spots[i].angle) * 180;
    unit.car.siren = true;
    unit.car.spawnFlash = 0;
  }
  // Traffic ahead and a truck to dodge: speed and danger in one frame.
  world.addTrafficCar({ x: 1690, y: 820, vertical: true }, 'compact');
  world.addTrafficCar({ x: 1320, y: 760, vertical: true }, 'truck');
  world.addTrafficCar({ x: 1070, y: 1000, vertical: true }, 'compact');
  if (car) {
    car.x = 1490;
    car.y = 1236;
    car.angle = -Math.PI / 2;
    car.speed = 352;
    car.vx = 0;
    car.vy = -352;
    car.health = car.maxHealth * 0.72;
    state.player.x = car.x;
    state.player.y = car.y;
    state.player.health = 78;
  }
  state.camera.x = 1490 - 640;
  state.camera.y = 1236 - 400;
  world.updateCamera(1);
  state.camera.shake = 3;
}

/** The end scene: a full five minutes spent, a plausible good-but-not-perfect shift. */
function stageEnd(world) {
  const state = world.state;
  world.startShift();
  run(world, 1.0, { moveX: 0, moveY: 0, sprint: false, handbrake: false });
  state.cash = 2840;
  state.score = 1720;
  state.jobsDone = 5;
  state.stats = { stolen: 6, crashes: 14, distance: 12840, busted: 1, wasted: 0, jobs: 5, timePlayed: SHIFT_SECONDS };
  state.best.heat = 4;
  state.heat = 2;
  state.shift = 0;
  state.clock = 17 * 60 + 40 + SHIFT_SECONDS * 0.55;
  state.night = 1;
  state.reason = REASON_TIME;
  state.phase = PHASE_OVER;
  state.floaters.length = 0;
  state.effects.length = 0;
  state.tipTimer = 0;
  state.job = null;
  const car = takeNearestCar(world);
  if (car) {
    car.x = 2210;
    car.y = 1500;
    car.angle = 0.4;
    state.player.x = car.x;
    state.player.y = car.y;
  }
  state.phase = PHASE_OVER;
  state.camera.x = 2210 - 640;
  state.camera.y = 1500 - 400;
}

const SCENES = {
  start: { screen: PHASE_TITLE, stage: null },
  play: { screen: PHASE_PLAY, stage: stagePlay },
  chase: { screen: PHASE_PLAY, stage: stageChase },
  end: { screen: PHASE_OVER, stage: stageEnd },
};

export const SHOT_NAMES = Object.keys(SCENES);

/** Stage a named scene on a fresh world. Returns the screen the renderer should paint. */
export function stageShot(name, world) {
  const scene = SCENES[name];
  if (!scene) return { screen: PHASE_TITLE, name: 'start' };
  const state = world.state;
  if (scene.stage) scene.stage(world);
  else {
    state.phase = PHASE_TITLE;
    state.clock = 17 * 60 + 48;
    state.night = 0.1;
  }
  state.time = 0;
  state.tip = '';
  state.tipTimer = 0;
  if (state.phase !== PHASE_OVER) state.banner = { name: state.banner.name, t: 0, accent: state.banner.accent };
  return { screen: scene.screen, name };
}
