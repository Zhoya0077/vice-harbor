// Cars: one physics model for the player's ride, the traffic and the police. A car is a heading,
// a velocity and a health pool; the model is a light arcade bicycle model (forward thrust, lateral
// grip, speed-scaled steering) which gives understeer at speed and a real handbrake slide.
import { CAR_SPECS, ROAD, ROAD_COLS, ROAD_ROWS } from './config.js';
import { clamp, damp, wrapAngle, approach } from './util.js';

let nextCarId = 1;

export function carSpec(type) {
  return CAR_SPECS[type] ?? CAR_SPECS.compact;
}

export function createCar({ x, y, angle, type, color, driver }) {
  const spec = carSpec(type);
  return {
    id: nextCarId++,
    x,
    y,
    angle: angle ?? 0,
    vx: 0,
    vy: 0,
    steer: 0,
    spec,
    type,
    w: spec.width,
    h: spec.height,
    color,
    health: spec.health,
    maxHealth: spec.health,
    driver: driver ?? 'none',
    wrecked: false,
    smoke: 0,
    braking: false,
    reverse: false,
    handbrake: false,
    ai: null,
    stuck: 0,
    hitCooldown: 0,
    siren: false,
    lightsOn: true,
    occupiedByPlayer: false,
    spawnFlash: 0,
  };
}

/** Two circles down the car's length: a decent, cheap stand-in for a rectangle. */
const circleOffsets = (car) => {
  const half = car.w * 0.27;
  const c = Math.cos(car.angle);
  const s = Math.sin(car.angle);
  return [
    { x: car.x + c * half, y: car.y + s * half, r: car.h / 2 + 1 },
    { x: car.x - c * half, y: car.y - s * half, r: car.h / 2 + 1 },
  ];
};
export { circleOffsets };

/** Push a car out of the buildings and the water; returns the impact speed it felt. */
export function resolveCarStatic(car, city) {
  let impact = 0;
  const pts = circleOffsets(car);
  for (let i = 0; i < 2; i += 1) {
    const p = pts[i];
    const list = city.nearbySolids(p.x, p.y, p.r + 2, []);
    for (let j = 0; j < list.length; j += 1) {
      const r = list[j];
      const nx = clamp(p.x, r.x, r.x + r.w);
      const ny = clamp(p.y, r.y, r.y + r.h);
      let dx = p.x - nx;
      let dy = p.y - ny;
      let d = Math.hypot(dx, dy);
      if (d >= p.r) continue;
      if (d < 0.001) {
        dx = 0;
        dy = -1;
        d = 1;
      }
      const push = p.r - d;
      const ux = dx / d;
      const uy = dy / d;
      car.x += ux * push;
      car.y += uy * push;
      const vn = car.vx * ux + car.vy * uy;
      if (vn < 0) {
        impact = Math.max(impact, -vn);
        car.vx -= vn * ux * 1.35;
        car.vy -= vn * uy * 1.35;
        car.vx *= 0.72;
        car.vy *= 0.72;
      }
    }
  }
  // The sea and the sand cliff: water is wall.
  if (car.y > city.water.y - car.h * 0.4) {
    const over = car.y - (city.water.y - car.h * 0.4);
    car.y -= over;
    impact = Math.max(impact, Math.abs(car.vy));
    car.vy = -Math.abs(car.vy) * 0.3;
    car.vx *= 0.8;
  }
  if (car.x < 8) { car.x = 8; car.vx = Math.abs(car.vx) * 0.25; }
  if (car.x > city.width - 8) { car.x = city.width - 8; car.vx = -Math.abs(car.vx) * 0.25; }
  if (car.y < 8) { car.y = 8; car.vy = Math.abs(car.vy) * 0.25; }
  return impact;
}

/** Rectangles laid over the car's body, used for car-car contact. */
function carCircles(car) {
  const c = Math.cos(car.angle);
  const s = Math.sin(car.angle);
  const off = car.w * 0.26;
  const r = car.h * 0.52;
  return [
    { x: car.x + c * off, y: car.y + s * off, r },
    { x: car.x - c * off, y: car.y - s * off, r },
  ];
}

/**
 * Resolve contact between two cars, damaging both in proportion to the closing speed. Returns the
 * closing speed so the world can decide about crime, sound and sparks.
 */
export function collideCars(a, b) {
  const ca = carCircles(a);
  const cb = carCircles(b);
  let best = 0;
  let hit = null;
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      const dx = cb[j].x - ca[i].x;
      const dy = cb[j].y - ca[i].y;
      const d = Math.hypot(dx, dy);
      const overlap = ca[i].r + cb[j].r - d;
      if (overlap > best) {
        best = overlap;
        hit = { dx, dy, d: Math.max(d, 0.001), overlap };
      }
    }
  }
  if (!hit) return 0;
  const ux = hit.dx / hit.d;
  const uy = hit.dy / hit.d;
  const rvx = b.vx - a.vx;
  const rvy = b.vy - a.vy;
  const closing = -(rvx * ux + rvy * uy);
  const totalMass = a.spec.mass + b.spec.mass;
  const pushA = (hit.overlap * b.spec.mass) / totalMass;
  const pushB = (hit.overlap * a.spec.mass) / totalMass;
  a.x -= ux * pushA;
  a.y -= uy * pushA;
  b.x += ux * pushB;
  b.y += uy * pushB;
  const impulse = Math.max(0, closing) * 0.6;
  a.vx -= ux * impulse * (b.spec.mass / totalMass);
  a.vy -= uy * impulse * (b.spec.mass / totalMass);
  b.vx += ux * impulse * (a.spec.mass / totalMass);
  b.vy += uy * impulse * (a.spec.mass / totalMass);
  const energy = Math.max(0, closing);
  return energy;
}

const FORWARD = { x: 1, y: 0 };

/**
 * Integrate one car. `controls` is {throttle -1..1, steer -1..1, handbrake}. Returns the forward
 * speed (signed) after the step, for HUD, engine pitch and the sound of the tyres.
 */
export function driveCar(car, controls, dt) {
  const spec = car.spec;
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  let forward = car.vx * cos + car.vy * sin;
  let lateral = -car.vx * sin + car.vy * cos;

  if (car.wrecked) controls = { throttle: 0, steer: 0, handbrake: false };

  const powerFactor = 1 - Math.min(0.55, Math.abs(forward) / spec.maxSpeed * 0.55);
  if (controls.throttle > 0) {
    forward += spec.accel * powerFactor * controls.throttle * dt;
  } else if (controls.throttle < 0) {
    if (forward > 6) forward += spec.brake * controls.throttle * dt;
    else forward += spec.accel * 0.75 * controls.throttle * dt;
  }
  car.braking = controls.throttle < 0 && forward > 20;
  car.reverse = forward < -6;

  // Drag and rolling resistance; a wrecked car coasts to a stop and cannot be driven.
  const drag = car.wrecked ? 2.2 : controls.throttle === 0 ? 0.85 : 0.12;
  forward *= 1 - Math.min(0.9, drag * dt);
  if (forward > spec.maxSpeed) forward = approach(forward, spec.maxSpeed, 420 * dt);
  if (forward < -spec.maxSpeed * 0.42) forward = -spec.maxSpeed * 0.42;

  // Steering authority grows from nothing at rest and tapers slightly at the top end.
  const speedRatio = Math.min(1, Math.abs(forward) / spec.maxSpeed);
  const authority = (0.25 + 0.75 * speedRatio) * (1 - 0.18 * speedRatio);
  const gripLoss = controls.handbrake ? 0.34 : 1;
  const turn = controls.steer * spec.handling * authority * gripLoss;
  const direction = forward < 0 ? -1 : 1;
  car.angle = wrapAngle(car.angle + turn * dt * direction);

  // Lateral grip: the handbrake lets the tail slide, everything else grips quickly.
  const gripRate = spec.grip * (controls.handbrake ? 0.24 : 1);
  lateral *= 1 - Math.min(1, damp(gripRate, dt));

  car.vx = Math.cos(car.angle) * forward - Math.sin(car.angle) * lateral;
  car.vy = Math.sin(car.angle) * forward + Math.cos(car.angle) * lateral;
  if (controls.handbrake) {
    car.vx *= 1 - Math.min(0.6, 0.9 * dt);
    car.vy *= 1 - Math.min(0.6, 0.9 * dt);
  }

  car.x += car.vx * dt;
  car.y += car.vy * dt;
  car.speed = forward;
  car.handbrake = controls.handbrake;
  car.steer = controls.steer;
  return forward;
}

/** Add damage to a car; returns true when that step wrecked it. */
export function damageCar(car, amount) {
  if (car.wrecked) return false;
  car.health -= amount;
  if (car.health <= 0) {
    car.health = 0;
    car.wrecked = true;
    car.smoke = 1;
    car.siren = false;
    car.braking = false;
    return true;
  }
  car.smoke = Math.max(car.smoke, 1 - car.health / car.maxHealth);
  return false;
}

/* ------------------------------------------------------------------ traffic */

const NODE = (ci, ri) => ({ x: ROAD_COLS[ci], y: ROAD_ROWS[ri] });

/** Pick the next grid node for a traffic car. It prefers straight on, and never U-turns. */
export function chooseNextNode(car, random) {
  const ai = car.ai;
  const node = ai.node;
  const prev = ai.prev;
  const options = [];
  const ci = ROAD_COLS.indexOf(node.x);
  const ri = ROAD_ROWS.indexOf(node.y);
  if (ci > 0) options.push({ x: ci - 1, y: ri });
  if (ci < ROAD_COLS.length - 1) options.push({ x: ci + 1, y: ri });
  if (ri > 0) options.push({ x: ci, y: ri - 1 });
  if (ri < ROAD_ROWS.length - 1) options.push({ x: ci, y: ri + 1 });
  const viable = options.filter((o) => !(prev && o.x === prev.x && o.y === prev.y));
  const pool = viable.length > 0 ? viable : options;
  let pickIndex = 0;
  if (pool.length > 1) {
    // 62% straight-ish (same axis as the arrival road), else a turn.
    const cameVertically = prev ? prev.x === node.x : true;
    const sameAxis = pool.map((o, i) => ({ o, i })).filter(({ o }) => (o.x === node.x) === cameVertically);
    if (sameAxis.length > 0 && random() < 0.68) pickIndex = sameAxis[Math.floor(random() * sameAxis.length)].i;
    else pickIndex = Math.floor(random() * pool.length);
  }
  const chosen = pool[pickIndex] ?? pool[0] ?? { x: 1, y: 1 };
  ai.prev = { x: node.x, y: node.y };
  ai.node = { x: ROAD_COLS[chosen.x], y: ROAD_ROWS[chosen.y] };
  ai.turn = 0;
}

/** Where the car wants to be: the lane on the right of the road it is heading down. */
export function trafficTarget(car) {
  const ai = car.ai;
  const node = ai.node;
  const dx = node.x - car.x;
  const dy = node.y - car.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Right-hand traffic: offset perpendicular (to the right of travel) by half a lane.
  const rx = -uy;
  const ry = ux;
  const ahead = Math.min(len, 130);
  return {
    x: car.x + ux * ahead + rx * ROAD.lane * 0.85,
    y: car.y + uy * ahead + ry * ROAD.lane * 0.85,
    nodeDistance: len,
  };
}

/** Is something right in front of this car within `range` along its heading? */
export function obstacleAhead(car, cars, player, range, lateralLimit) {
  const cos = Math.cos(car.angle);
  const sin = Math.sin(car.angle);
  const limit = lateralLimit ?? car.w * 0.55;
  for (let i = 0; i < cars.length; i += 1) {
    const other = cars[i];
    if (other === car || other.wrecked === true && other === car) continue;
    const dx = other.x - car.x;
    const dy = other.y - car.y;
    const along = dx * cos + dy * sin;
    if (along <= 0 || along > range) continue;
    const side = Math.abs(-dx * sin + dy * cos);
    if (side < limit + other.h * 0.4) return { along, other };
  }
  if (player && player.onFoot) {
    const dx = player.x - car.x;
    const dy = player.y - car.y;
    const along = dx * cos + dy * sin;
    if (along > 0 && along < range) {
      const side = Math.abs(-dx * sin + dy * cos);
      if (side < limit + 10) return { along, other: null };
    }
  }
  return null;
}

/** One traffic step: follow the grid, brake for what is ahead, keep a sane speed. */
export function updateTrafficCar(car, dt, ctx) {
  const ai = car.ai;
  if (!ai) return;
  if (car.wrecked) {
    driveCar(car, { throttle: 0, steer: 0, handbrake: true }, dt);
    resolveCarStatic(car, ctx.city);
    return;
  }
  const target = trafficTarget(car);
  if (target.nodeDistance < 46) chooseNextNode(car, ctx.random);
  const desired = Math.atan2(target.y - car.y, target.x - car.x);
  const diff = wrapAngle(desired - car.angle);
  const steer = clamp(diff * 2.4, -1, 1);
  const speed = car.speed;
  let wanted = ai.cruise;
  const blocked = obstacleAhead(car, ctx.cars, ctx.player, 46 + Math.abs(speed) * 0.45, car.w * 0.5);
  if (blocked) {
    wanted = blocked.along < 70 ? 0 : Math.min(wanted, 90);
    if (Math.abs(speed) < 6 && blocked.along < 60) {
      // Creep around the obstruction rather than sit still forever.
      car.stuck += dt;
      if (car.stuck > 1.1) {
        car.steerOffset = Math.sin(car.stuck * 3) * 0.5;
        wanted = 42;
      }
    } else car.stuck = 0;
  } else car.stuck = Math.max(0, car.stuck - dt);
  // Corner slowly.
  if (Math.abs(diff) > 0.5) wanted = Math.min(wanted, 110);
  let throttle = 0;
  if (speed < wanted - 12) throttle = 1;
  else if (speed > wanted + 12) throttle = -0.85;
  driveCar(car, { throttle, steer: clamp(steer + (car.steerOffset ?? 0), -1, 1), handbrake: false }, dt);
  resolveCarStatic(car, ctx.city);
}

/** A traffic car placed on a lane of the grid, driving toward the next node. */
export function makeTrafficCar(streams, point, type, color) {
  const vertical = point.vertical;
  const car = createCar({ x: point.x, y: point.y, angle: vertical ? Math.PI / 2 : 0, type, color, driver: 'ai' });
  const ci = nearestIndex(ROAD_COLS, point.x);
  const ri = nearestIndex(ROAD_ROWS, point.y);
  const node = vertical ? { x: ROAD_COLS[ci], y: ROAD_ROWS[Math.min(ROAD_ROWS.length - 1, ri + 1)] } : { x: ROAD_COLS[Math.min(ROAD_COLS.length - 1, ci + 1)], y: ROAD_ROWS[ri] };
  car.ai = {
    node,
    prev: { x: ROAD_COLS[ci], y: ROAD_ROWS[ri] },
    cruise: streams.range(105, 175),
    turn: 0,
  };
  car.angle = Math.atan2(node.y - point.y, node.x - point.x);
  return car;
}

export function nearestIndex(list, value) {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < list.length; i += 1) {
    const d = Math.abs(list[i] - value);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}
