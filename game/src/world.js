// The simulation: the player, traffic, police, jobs and the shift clock. No drawing and no browser
// in here, only state and rules, so the same code runs the live game and the frozen screenshot
// scenes. Everything random comes from the seeded streams, so a scene set up the same way is the
// same pixels every reload.
import {
  BEACH, CAR_COLORS, DECAY, JOB_PAY, JOB_TIME, MAX_HEAT, PED_COLORS, PLAYER,
  POLICE_UNITS, SHIFT_SECONDS, STEP, WORLD, ROAD, ROAD_COLS, ROAD_ROWS,
} from './config.js';
import { createCity, districtAt, DISTRICT_LIST } from './city.js';
import { createStreams } from './rng.js';
import { angleTo, clamp, damp, distance, wrapAngle } from './util.js';
import {
  circleOffsets, collideCars, createCar, damageCar, driveCar, makeTrafficCar, nearestIndex,
  obstacleAhead, resolveCarStatic, updateTrafficCar,
} from './car.js';

export const PHASE_TITLE = 'title';
export const PHASE_PLAY = 'play';
export const PHASE_PAUSED = 'paused';
export const PHASE_OVER = 'over';

export const REASON_TIME = 'time';
export const REASON_BUSTED = 'busted';
export const REASON_WASTED = 'wasted';

export const JOB_DELIVERY = 'delivery';
export const JOB_CHECKPOINTS = 'checkpoints';
export const JOB_DROPS = 'drops';

const TRAFFIC_TARGET = 20;
const MAX_EFFECTS = 220;
const MAX_FLOATERS = 26;
/** A shift's clock starts at 17:40, so the player drives through the sunset into neon night. */
const CLOCK_START = 17 * 60 + 40;

export function createWorld(seed) {
  const streams = createStreams(seed);
  const city = createCity(streams);
  const random = streams.random;

  const player = {
    x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2,
    radius: PLAYER.radius,
    health: PLAYER.health,
    onFoot: true,
    car: null,
    walkPhase: 0,
    moving: false,
    hurtCooldown: 0,
    hitFlash: 0,
    lastCar: null,
    sinceHit: 99,
  };

  const state = {
    seed,
    phase: PHASE_TITLE,
    time: 0,
    shift: SHIFT_SECONDS,
    clock: CLOCK_START,
    player,
    cars: [],
    police: [],
    peds: [],
    effects: [],
    floaters: [],
    sounds: [],
    cash: 0,
    score: 0,
    heat: 0,
    heatProgress: 0,
    unseen: 0,
    seen: false,
    busted: 0,
    bustTime: 0,
    reason: null,
    job: null,
    jobOrder: [],
    jobsDone: 0,
    jobWait: 4,
    best: { heat: 0, cash: 0 },
    district: districtAt(0, 0),
    banner: { name: '', t: 0, accent: '#fff' },
    camera: { x: 0, y: 0, shake: 0 },
    stats: { stolen: 0, crashes: 0, distance: 0, busted: 0, wasted: 0, jobs: 0, timePlayed: 0 },
    night: 0,
    roadblocks: 0,
    lastRoadblock: -99,
    tip: '',
    tipTimer: 0,
  };

  let unitSpawnTimer = 0.8;
  const scratchCars = [];
  const scratchSolids = [];

  function sound(type, value) {
    if (state.sounds.length < 24) state.sounds.push({ type, value });
  }

  function float(x, y, text, color) {
    if (state.floaters.length >= MAX_FLOATERS) state.floaters.shift();
    state.floaters.push({ x, y, text, color, life: 1.5, max: 1.5, vy: -22 });
  }

  function spark(x, y, count, color, speed) {
    for (let i = 0; i < count; i += 1) {
      if (state.effects.length >= MAX_EFFECTS) return;
      const a = random() * Math.PI * 2;
      const v = (speed ?? 120) * (0.4 + random());
      state.effects.push({
        kind: 'spark', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 0.45, max: 0.45, color: color ?? '#ffd166', size: 1.6 + random() * 1.8,
      });
    }
  }

  function smokePuff(x, y, dark) {
    if (state.effects.length >= MAX_EFFECTS) return;
    state.effects.push({
      kind: 'smoke', x: x + (random() - 0.5) * 8, y: y + (random() - 0.5) * 8,
      vx: (random() - 0.5) * 18, vy: -14 - random() * 20,
      life: 1.6, max: 1.6, color: dark ? '#3a3a42' : '#9aa0aa', size: 5 + random() * 7,
    });
  }

  /* --------------------------------------------------------------- spawning */

  function freeRoadSpot(minDistance, fromX, fromY) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const vertical = random() < 0.5;
      const x = vertical ? ROAD_COLS[Math.floor(random() * ROAD_COLS.length)] : random() * (WORLD.width - 80) + 40;
      const y = vertical ? random() * (BEACH.top - 120) + 60 : ROAD_ROWS[Math.floor(random() * ROAD_ROWS.length)];
      if (distance(x, y, fromX, fromY) < minDistance) continue;
      if (city.blocked(x, y)) continue;
      return { x, y, vertical };
    }
    return { x: ROAD_COLS[3], y: ROAD_ROWS[1], vertical: true };
  }

  function addTrafficCar(point, type) {
    const spot = point ?? freeRoadSpot(300, player.x, player.y);
    const spec = type ?? streams.pick(['compact', 'compact', 'sports', 'truck']);
    const car = makeTrafficCar(streams, spot, spec, streams.pick(CAR_COLORS));
    state.cars.push(car);
    return car;
  }

  function addParkedCar(spot) {
    const car = createCar({ x: spot.x, y: spot.y, angle: spot.angle, type: spot.type, color: spot.color, driver: 'none' });
    state.cars.push(car);
    return car;
  }

  function spawnPed(x, y) {
    const ped = {
      x, y, vx: 0, vy: 0, angle: random() * 6.28,
      speed: 30 + random() * 26,
      color: streams.pick(PED_COLORS),
      shirt: streams.pick(PED_COLORS),
      phase: random() * 6.28,
      target: null,
      panic: 0,
      alive: true,
      fade: undefined,
      radius: 7,
    };
    state.peds.push(ped);
    return ped;
  }

  /* ------------------------------------------------------------------ heat */

  function addHeat(amount, reason) {
    if (amount <= 0) return;
    const before = state.heat;
    state.heat = clamp(state.heat + amount, 0, MAX_HEAT);
    if (state.heat > before) {
      state.heatProgress = 0;
      state.unseen = 0;
      state.best.heat = Math.max(state.best.heat, state.heat);
      if (reason) float(player.x, player.y - 26, reason, '#ff8a94');
      sound('sting', state.heat);
    }
  }

  function tip(text, seconds) {
    state.tip = text;
    state.tipTimer = seconds ?? 3;
  }

  /* ---------------------------------------------------------------- player */

  function nearbyCars(x, y, radius, out) {
    out.length = 0;
    for (let i = 0; i < state.cars.length; i += 1) {
      const car = state.cars[i];
      if (Math.abs(car.x - x) > radius + 40 || Math.abs(car.y - y) > radius + 40) continue;
      out.push(car);
    }
    for (let i = 0; i < state.police.length; i += 1) {
      const car = state.police[i].car;
      if (Math.abs(car.x - x) > radius + 40 || Math.abs(car.y - y) > radius + 40) continue;
      out.push(car);
    }
    return out;
  }

  function collidePlayerStatic(dt) {
    player.x += player.vx * dt;
    player.y += player.vy * dt;
    const solids = city.nearbySolids(player.x, player.y, player.radius + 3, scratchSolids);
    for (let i = 0; i < solids.length; i += 1) {
      const r = solids[i];
      const nx = clamp(player.x, r.x, r.x + r.w);
      const ny = clamp(player.y, r.y, r.y + r.h);
      let dx = player.x - nx;
      let dy = player.y - ny;
      let d = Math.hypot(dx, dy);
      if (d >= player.radius) continue;
      if (d < 0.001) { dx = 0; dy = -1; d = 1; }
      const push = player.radius - d;
      player.x += (dx / d) * push;
      player.y += (dy / d) * push;
    }
    if (player.y > city.water.y - player.radius) {
      player.y = city.water.y - player.radius;
      player.vy = Math.min(0, player.vy);
    }
    if (player.x < 6) player.x = 6;
    if (player.x > WORLD.width - 6) player.x = WORLD.width - 6;
    if (player.y < 6) player.y = 6;

    // Cars are solid too: push out of any body the player walks into.
    nearbyCars(player.x, player.y, 60, scratchCars);
    for (let i = 0; i < scratchCars.length; i += 1) {
      const car = scratchCars[i];
      const pts = circleOffsets(car);
      for (let k = 0; k < pts.length; k += 1) {
        const p = pts[k];
        const dx = player.x - p.x;
        const dy = player.y - p.y;
        const d = Math.hypot(dx, dy);
        const min = player.radius + p.r;
        if (d < min && d > 0.001) {
          const push = min - d;
          player.x += (dx / d) * push;
          player.y += (dy / d) * push;
          const closing = Math.abs(car.speed ?? 0);
          if (closing > 120 && car.driver !== 'none') {
            hurtPlayer(6 + closing * 0.05, car.angle);
            spark(player.x, player.y, 4, '#ff6b7a', 90);
          }
        }
      }
    }
  }

  function hurtPlayer(amount, fromAngle) {
    if (player.hurtCooldown > 0) return;
    player.health = Math.max(0, player.health - amount);
    player.hurtCooldown = PLAYER.hurtCooldown;
    player.hitFlash = 1;
    player.sinceHit = 0;
    state.camera.shake = Math.max(state.camera.shake, Math.min(9, amount * 0.35));
    sound('crash', Math.min(1, amount / 22));
    if (fromAngle !== undefined) {
      const a = fromAngle + Math.PI + (random() - 0.5) * 0.8;
      player.vx = Math.cos(a) * 180;
      player.vy = Math.sin(a) * 180;
    }
    if (player.health <= 0 && state.phase === PHASE_PLAY) endShift(REASON_WASTED);
  }

  function exitCar(side) {
    const car = player.car;
    if (!car) return;
    const cos = Math.cos(car.angle);
    const sin = Math.sin(car.angle);
    const offsets = side === 'left' ? [1, -1] : [-1, 1];
    let placed = false;
    for (let i = 0; i < offsets.length && !placed; i += 1) {
      const ox = car.x - sin * (car.h / 2 + 16) * offsets[i];
      const oy = car.y + cos * (car.h / 2 + 16) * offsets[i];
      if (!city.blocked(ox, oy) && oy < city.water.y - 14) {
        player.x = ox;
        player.y = oy;
        placed = true;
      }
    }
    if (!placed) {
      player.x = car.x;
      player.y = car.y - car.h - 20;
    }
    car.occupiedByPlayer = false;
    car.driver = 'none';
    car.braking = false;
    car.ai = null;
    player.lastCar = car;
    player.car = null;
    player.onFoot = true;
    player.vx = 0;
    player.vy = 0;
    player.angle = car.angle;
    sound('click');
  }

  function enterCar(car) {
    if (!car || car.wrecked) return false;
    const stolen = car.driver === 'ai' || car.driver === 'police' || car.driver === 'none';
    const isNew = car !== player.lastCar;
    const wasUnseenFor = state.unseen;
    player.car = car;
    player.onFoot = false;
    player.vx = 0;
    player.vy = 0;
    car.occupiedByPlayer = true;
    car.driver = 'player';
    car.ai = null;
    if (stolen && isNew) {
      state.stats.stolen += 1;
      if (state.heat < 1) {
        addHeat(1, 'GRAND THEFT AUTO');
        tip('The car is hot. Lose the cops to cool down.', 3.4);
      } else {
        state.unseen = 0;
        state.heatProgress = 0;
        tip('Another car, another set of plates.', 2.4);
      }
    }
    if (wasUnseenFor > 1.2 && state.heat > 0) {
      // Swapping plates while unseen speeds the cooldown along.
      state.heatProgress += DECAY.swapBonus;
      tip('Fresh plates — the heat is fading faster.', 2.6);
    }
    sound('click');
    player.lastCar = car;
    return true;
  }

  function tryUseCar() {
    if (!player.onFoot) {
      exitCar();
      return;
    }
    nearbyCars(player.x, player.y, PLAYER.enterRange + 40, scratchCars);
    let best = null;
    let bestDistance = PLAYER.enterRange;
    for (let i = 0; i < scratchCars.length; i += 1) {
      const car = scratchCars[i];
      if (car.wrecked) continue;
      const d = distance(player.x, player.y, car.x, car.y);
      if (d < bestDistance) {
        bestDistance = d;
        best = car;
      }
    }
    if (best) enterCar(best);
    else tip('Nothing to drive here.', 1.6);
  }

  function updateOnFoot(dt, controls) {
    const targetSpeed = controls.sprint ? PLAYER.sprint : PLAYER.walk;
    const wishX = controls.moveX * targetSpeed;
    const wishY = controls.moveY * targetSpeed;
    const rate = damp(14, dt);
    player.vx += (wishX - player.vx) * rate;
    player.vy += (wishY - player.vy) * rate;
    const speed = Math.hypot(player.vx, player.vy);
    player.moving = speed > 12;
    if (player.moving) {
      player.angle = Math.atan2(player.vy, player.vx);
      player.walkPhase += dt * (5 + speed * 0.045);
    }
    collidePlayerStatic(dt);
    player.sinceHit += dt;
    player.hurtCooldown = Math.max(0, player.hurtCooldown - dt);
    player.hitFlash = Math.max(0, player.hitFlash - dt * 2.4);
    const calm = state.heat === 0 || state.unseen > 2.5;
    if (calm && player.sinceHit > 3 && player.health < PLAYER.health) {
      player.health = Math.min(PLAYER.health, player.health + PLAYER.regen * dt);
    }
    if (player.hurtCooldown <= 0 && player.health <= 0 && state.phase === PHASE_PLAY) {
      endShift(REASON_WASTED);
    }
  }

  function updateDriving(dt, controls) {
    const car = player.car;
    if (!car) return;
    const throttle = controls.moveY < -0.2 ? 1 : controls.moveY > 0.2 ? -1 : 0;
    const steer = controls.moveX;
    driveCar(car, { throttle, steer, handbrake: controls.handbrake }, dt);
    const impact = resolveCarStatic(car, city);
    if (impact > 70) onCarCrash(car, impact, null);
    player.x = car.x;
    player.y = car.y;
    player.angle = car.angle;
    if (car.health < car.maxHealth * 0.6 && random() < 0.5) {
      smokePuff(car.x, car.y - 4, car.wrecked);
    }
    state.stats.distance += Math.abs(car.speed) * dt;
    if (Math.abs(car.speed) > 150 && controls.handbrake) sound('skid');
    if (car.wrecked && Math.abs(car.speed) < 8) {
      state.bustTime += dt * 0.55;
      if (state.bustTime > 4) {
        // Sitting in a wreck is not a way out.
        exitCar();
        state.bustTime = 0;
        tip('Wrecked. Find another ride — fast.', 3);
      }
    }
  }
  /* ---------------------------------------------------------------- crashes */

  function onCarCrash(car, impact, other) {
    if (impact < 60) return;
    const damage = impact * 0.055;
    const wrecked = damageCar(car, damage);
    state.camera.shake = Math.max(state.camera.shake, Math.min(11, impact * 0.035));
    spark(car.x, car.y, Math.min(10, 2 + Math.floor(impact / 60)), '#ffca7a', 120);
    sound('crash', Math.min(1, impact / 320));
    state.stats.crashes += 1;
    if (wrecked) {
      addHeat(1, 'CAR WRECKED');
      if (player.car === car) {
        hurtPlayer(26, car.angle);
        tip('Your ride is done for.', 3);
      }
    }
    void other;
  }

  function carCrimeFor(car, impact) {
    if (impact < 95) return;
    if (car.driver === 'police') {
      addHeat(1, 'COP RAMMED');
      state.score += 15;
    } else if (state.heat > 0 && impact > 140) {
      if (state.heatProgress > 8) addHeat(1, 'RECKLESS');
    }
  }

  /* ---------------------------------------------------------------- traffic */

  function updateTraffic(dt) {
    const ctx = { city, cars: state.cars, player, random };
    for (let i = 0; i < state.cars.length; i += 1) {
      const car = state.cars[i];
      if (car.occupiedByPlayer) continue;
      if (car.driver === 'ai') updateTrafficCar(car, dt, ctx);
      else if (car.wrecked) {
        driveCar(car, { throttle: 0, steer: 0, handbrake: true }, dt);
        resolveCarStatic(car, city);
      }
    }
    // Car against car, player's body against car.
    for (let i = 0; i < state.cars.length; i += 1) {
      for (let j = i + 1; j < state.cars.length; j += 1) {
        const a = state.cars[i];
        const b = state.cars[j];
        if (Math.abs(a.x - b.x) > 90 || Math.abs(a.y - b.y) > 90) continue;
        const closing = collideCars(a, b);
        if (closing > 60) {
          const isPlayer = a === player.car || b === player.car;
          if (isPlayer) {
            const mine = a === player.car ? a : b;
            const theirs = a === player.car ? b : a;
            onCarCrash(mine, closing, theirs);
            carCrimeFor(theirs, closing);
            state.unseen = 0;
          } else {
            damageCar(a, closing * 0.02);
            damageCar(b, closing * 0.02);
          }
        }
      }
    }
  }

  function updatePeds(dt) {
    for (let i = 0; i < state.peds.length; i += 1) {
      const ped = state.peds[i];
      if (!ped.alive) continue;
      ped.phase += dt * 4;
      const px = player.x;
      const py = player.y;
      const d = distance(ped.x, ped.y, px, py);
      const danger = d < 130 && (state.heat > 0 || (player.car && Math.abs(player.car.speed) > 90));
      if (danger) {
        ped.panic = 1.4;
        ped.angle = Math.atan2(ped.y - py, ped.x - px);
      } else if (ped.panic > 0) {
        ped.panic -= dt;
      } else if (!ped.target || distance(ped.x, ped.y, ped.target.x, ped.target.y) < 12) {
        ped.target = { x: clamp(ped.x + (random() - 0.5) * 200, 20, WORLD.width - 20), y: clamp(ped.y + (random() - 0.5) * 200, 20, BEACH.top - 10) };
        ped.angle = Math.atan2(ped.target.y - ped.y, ped.target.x - ped.x);
      }
      const speed = ped.speed * (danger ? 2.1 : 1);
      ped.vx = Math.cos(ped.angle) * speed;
      ped.vy = Math.sin(ped.angle) * speed;
      const nx = ped.x + ped.vx * dt;
      const ny = ped.y + ped.vy * dt;
      if (city.blocked(nx, ny) || ny > BEACH.top - 6) {
        ped.angle += Math.PI * (0.4 + random() * 0.6);
      } else {
        ped.x = nx;
        ped.y = ny;
      }
      // Player's car hitting a pedestrian.
      if (player.car && !player.car.wrecked) {
        const car = player.car;
        if (distance(ped.x, ped.y, car.x, car.y) < car.h + 8 && Math.abs(car.speed) > 70) {
          ped.alive = false;
          ped.fade = 1;
          addHeat(1, 'HIT AND RUN');
          state.score = Math.max(0, state.score - 25);
          float(ped.x, ped.y - 10, 'DOWN!', '#ff8a94');
          sound('crash', 0.8);
        }
      }
      if (ped.fade !== undefined) {
        ped.fade -= dt;
        if (ped.fade <= 0) ped.alive = false;
      }
    }
  }

  /* ---------------------------------------------------------------- the law */

  const sightRects = [];

  function policeCanSee(unit) {
    const car = unit.car;
    if (car.wrecked) return false;
    const d = distance(car.x, car.y, player.x, player.y);
    if (d > 900) return false;
    if (d < 120) return true;
    return !city.lineBlocked(car.x, car.y, player.x, player.y);
  }

  function edgeSpawn() {
    const side = Math.floor(random() * 4);
    if (side === 0) return { x: random() * WORLD.width, y: 24 };
    if (side === 1) return { x: WORLD.width - 24, y: random() * (BEACH.top - 40) };
    if (side === 2) return { x: 24, y: random() * (BEACH.top - 40) };
    return { x: random() * WORLD.width, y: BEACH.top - 60 };
  }

  function spawnPoliceUnit() {
    const car = createCar({ x: 0, y: 0, angle: 0, type: 'police', color: '#eef2f7', driver: 'police' });
    let spot = null;
    for (let attempt = 0; attempt < 40 && !spot; attempt += 1) {
      const edge = edgeSpawn();
      const ci = nearestIndex(ROAD_COLS, edge.x);
      const ri = nearestIndex(ROAD_ROWS, edge.y);
      const candidate = { x: ROAD_COLS[ci], y: ROAD_ROWS[ri] };
      if (distance(candidate.x, candidate.y, player.x, player.y) > 700) spot = candidate;
    }
    const at = spot ?? { x: ROAD_COLS[0], y: ROAD_ROWS[0] };
    car.x = at.x;
    car.y = at.y;
    car.angle = angleTo(at.x, at.y, player.x, player.y);
    car.spawnFlash = 1.6;
    car.siren = true;
    const unit = { car, aggression: 0.72 + state.heat * 0.05, stuck: 0, ramCooldown: 0, pathTimer: 0, alive: true };
    state.police.push(unit);
    return unit;
  }

  /** Police steering: chase the player's body, nudge around corners, ram when close. */
  function updatePoliceUnit(unit, dt) {
    const car = unit.car;
    const targetX = player.x;
    const targetY = player.y;
    const d = distance(car.x, car.y, targetX, targetY);
    if (car.wrecked) {
      unit.alive = false;
      return;
    }
    unit.ramCooldown = Math.max(0, unit.ramCooldown - dt);
    unit.pathTimer -= dt;
    const wanted = Math.atan2(targetY - car.y, targetX - car.x);
    const diff = wrapAngle(wanted - car.angle);
    // If a building is in the way, slide along it toward the nearest road line.
    let bias = 0;
    if (unit.pathTimer <= 0) {
      unit.pathTimer = 0.35;
      const probe = 90;
      const hit = city.blocked(car.x + Math.cos(car.angle) * probe, car.y + Math.sin(car.angle) * probe);
      unit.blockedAhead = hit;
    }
    if (unit.blockedAhead && d > 140) {
      const onVertical = Math.abs(Math.sin(car.angle)) > Math.abs(Math.cos(car.angle));
      const roadLine = onVertical ? ROAD_ROWS[nearestIndex(ROAD_ROWS, car.y)] : ROAD_COLS[nearestIndex(ROAD_COLS, car.x)];
      const off = onVertical ? car.x - ROAD_COLS[nearestIndex(ROAD_COLS, car.x)] : car.y - roadLine;
      bias = off > 0 ? -0.7 : 0.7;
    }
    const steer = clamp(diff * 2.2 + bias, -1, 1);
    const stopAhead = obstacleAhead(car, state.cars, null, 80 + Math.abs(car.speed) * 0.4, car.w * 0.6);
    let throttle = 1;
    if (d < 60 && Math.abs(car.speed) > 200) throttle = -0.9;
    if (stopAhead && d > 90) throttle = stopAhead.along < 55 ? -0.6 : 0.3;
    if (Math.abs(diff) > 1.5 && Math.abs(car.speed) > 180) throttle = 0.45;
    const stuckNow = Math.abs(car.speed) < 12 && d > 90;
    unit.stuck = stuckNow ? unit.stuck + dt : 0;
    if (unit.stuck > 1.2) {
      // Shuffle out: reverse a moment, then try again.
      throttle = -1;
      unit.stuck = 0.2;
      car.angle = wrapAngle(car.angle + 0.5);
    }
    driveCar(car, { throttle, steer, handbrake: false }, dt);
    resolveCarStatic(car, city);
    if (d < 500) car.siren = true;
  }

  function updatePolice(dt) {
    const wanted = POLICE_UNITS[state.heat] ?? 0;
    let active = 0;
    for (let i = 0; i < state.police.length; i += 1) {
      const unit = state.police[i];
      if (!unit.car.wrecked) active += 1;
    }
    if (state.heat > 0 && active < wanted) {
      unitSpawnTimer -= dt;
      if (unitSpawnTimer <= 0) {
        spawnPoliceUnit();
        unitSpawnTimer = Math.max(1.6, 4.2 - state.heat * 0.45);
      }
    } else {
      unitSpawnTimer = 0.8;
    }
    for (let i = 0; i < state.police.length; i += 1) {
      const unit = state.police[i];
      if (!unit.car.wrecked) updatePoliceUnit(unit, dt);
      unit.car.spawnFlash = Math.max(0, unit.car.spawnFlash - dt);
    }
    // Police against traffic and the player.
    for (let i = 0; i < state.police.length; i += 1) {
      const unit = state.police[i];
      const car = unit.car;
      if (car.wrecked) continue;
      for (let j = 0; j < state.cars.length; j += 1) {
        const other = state.cars[j];
        if (Math.abs(other.x - car.x) > 90 || Math.abs(other.y - car.y) > 90) continue;
        const closing = collideCars(car, other);
        if (closing > 70) {
          onCarCrash(car, closing, other);
          if (other === player.car) {
            carCrimeFor(car, closing);
            state.unseen = 0;
            if (unit.ramCooldown <= 0) {
              unit.ramCooldown = 1.4;
              if (state.heat < 5) addHeat(1, 'RAMMED THE LAW');
              else hurtPlayer(8, car.angle);
            }
          } else {
            damageCar(other, closing * 0.03);
          }
        }
      }
    }
    if (state.heat >= 4 && state.time - state.lastRoadblock > 16) {
      state.lastRoadblock = state.time;
      makeRoadblock();
    }
    // Sight and the cooldown clock.
    let seen = false;
    for (let i = 0; i < state.police.length; i += 1) {
      if (policeCanSee(state.police[i])) {
        seen = true;
        break;
      }
    }
    state.seen = seen && state.heat > 0;
    if (state.heat > 0) {
      if (state.seen) {
        state.unseen = 0;
      } else {
        state.unseen += dt;
        if (state.unseen > DECAY.unseenAfter) {
          const swap = player.lastCar !== null && player.car !== null && player.car !== player.lastCar;
          const rate = DECAY.starSeconds * (swap ? 0.55 : 1);
          state.heatProgress += dt;
          if (state.heatProgress > rate) {
            state.heatProgress = 0;
            state.heat = Math.max(0, state.heat - 1);
            if (state.heat === 0) {
              state.unseen = 0;
              for (let k = 0; k < state.police.length; k += 1) state.police[k].car.siren = false;
              tip('You lost them. Heat cleared.', 3);
            } else {
              tip('Heat dropping.', 2);
            }
          }
        }
      }
      if (state.heat > state.best.heat) state.best.heat = state.heat;
    } else {
      state.heatProgress = 0;
      state.unseen = 0;
    }
    // The BUSTED meter: a unit in contact, the player on foot or stopped in a wreck.
    let touching = false;
    for (let i = 0; i < state.police.length; i += 1) {
      const car = state.police[i].car;
      if (car.wrecked) continue;
      const d = distance(car.x, car.y, player.x, player.y);
      if (d < 74) {
        touching = true;
        break;
      }
    }
    const stuck = !player.onFoot && player.car && (player.car.wrecked || Math.abs(player.car.speed) < 26);
    if (touching && (player.onFoot || stuck) && state.heat > 0) {
      state.bustTime += dt;
      state.busted = clamp(state.bustTime / 3.2, 0, 1);
      if (state.bustTime >= 3.2) endShift(REASON_BUSTED);
    } else {
      state.bustTime = Math.max(0, state.bustTime - dt * 0.9);
      state.busted = clamp(state.bustTime / 3.2, 0, 1);
    }
    sightRects.length = 0;
  }

  function makeRoadblock() {
    const point = { x: player.x, y: player.y };
    // Place the wall of cars a little way down the road the player is on.
    const vertical = Math.abs(Math.sin(player.angle)) > 0.5;
    const line = vertical ? ROAD_ROWS[nearestIndex(ROAD_ROWS, point.y + (Math.sin(player.angle) > 0 ? 300 : -300))] : ROAD_COLS[nearestIndex(ROAD_COLS, point.x + (Math.cos(player.angle) > 0 ? 300 : -300))];
    const along = vertical ? player.x : player.y;
    for (let i = -1; i <= 1; i += 1) {
      const car = createCar({ x: 0, y: 0, angle: vertical ? 0 : Math.PI / 2, type: 'police', color: '#eef2f7', driver: 'police' });
      car.x = vertical ? along + i * 42 : line;
      car.y = vertical ? line : along + i * 42;
      car.siren = true;
      car.wrecked = false;
      car.blocker = true;
      state.police.push({ car, aggression: 0.5, stuck: 0, ramCooldown: 0, pathTimer: 0, alive: true });
    }
    state.roadblocks += 1;
    tip('ROADBLOCK AHEAD', 2.4);
  }

  /* ------------------------------------------------------------------ peds */

  /* ------------------------------------------------------------------ jobs */

  function jobSpawnPoint(district, minFromPlayer) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const vertical = random() < 0.5;
      const x = vertical ? ROAD_COLS[Math.floor(random() * ROAD_COLS.length)] : random() * (WORLD.width - 120) + 60;
      const y = vertical ? random() * (BEACH.top - 140) + 70 : ROAD_ROWS[Math.floor(random() * ROAD_ROWS.length)];
      const around = districtAt(x, y);
      if (district && around.name !== district) continue;
      if (distance(x, y, player.x, player.y) < minFromPlayer) continue;
      if (city.blocked(x, y)) continue;
      return { x, y };
    }
    return { x: ROAD_COLS[4], y: ROAD_ROWS[2] };
  }

  function nextJobType() {
    const order = state.jobOrder ?? [];
    if (order.length === 0) {
      state.jobOrder = streams.shuffle([JOB_DELIVERY, JOB_CHECKPOINTS, JOB_DROPS]);
      order.push(...state.jobOrder);
    }
    return order.splice(0, 1)[0];
  }

  function spawnJob() {
    const type = nextJobType();
    const district = streams.pick(DISTRICT_LIST.slice(0, 4)).name;
    if (type === JOB_DELIVERY) {
      const pickup = jobSpawnPoint(district, 260);
      const drop = jobSpawnPoint(null, 900);
      state.job = {
        type,
        label: 'DELIVERY',
        title: 'Hot package',
        stage: 0,
        pickup,
        drop,
        points: [pickup, drop],
        timer: JOB_TIME.delivery,
        limit: JOB_TIME.delivery,
        pay: JOB_PAY.delivery,
        district,
      };
    } else if (type === JOB_CHECKPOINTS) {
      const points = [];
      const startDistrict = districtAt(player.x, player.y).name;
      for (let i = 0; i < 4; i += 1) points.push(jobSpawnPoint(i === 0 ? startDistrict : null, 300 + i * 120));
      state.job = {
        type, label: 'CHECKPOINTS', title: 'Street circuit', stage: 0, points,
        timer: JOB_TIME.checkpoints, limit: JOB_TIME.checkpoints, pay: JOB_PAY.checkpoints, district: startDistrict,
      };
    } else {
      const drops = [];
      for (let i = 0; i < 5; i += 1) drops.push(jobSpawnPoint(district, 200));
      state.job = {
        type, label: 'CASH DROPS', title: 'Loose change', stage: 0, points: drops,
        timer: JOB_TIME.drops, limit: JOB_TIME.drops, pay: JOB_PAY.drops, district,
      };
    }
    sound('blip');
    tip('New job on the phone: ' + state.job.title, 3);
  }

  function jobTarget() {
    const job = state.job;
    if (!job) return null;
    if (job.type === JOB_DROPS) {
      const list = job.points.filter((p) => !p.taken);
      return list[0] ?? null;
    }
    return job.points[job.stage] ?? null;
  }

  function completeJob() {
    const job = state.job;
    if (!job) return;
    const bonus = Math.round(job.timer * 3);
    const pay = job.pay + bonus;
    state.cash += pay;
    state.score += 100 + job.pay / 10;
    state.jobsDone += 1;
    state.stats.jobs += 1;
    addHeat(1, 'JOB PULLED');
    float(player.x, player.y - 40, '+$' + pay, '#ffd166');
    sound('jingle');
    tip('Job done: $' + pay, 3);
    state.job = null;
    state.jobWait = 6;
  }

  function failJob() {
    tip('Job blown. The phone will ring again.', 3);
    state.job = null;
    state.jobWait = 5;
  }

  function updateJob(dt) {
    if (!state.job) {
      state.jobWait -= dt;
      if (state.jobWait <= 0) spawnJob();
      return;
    }
    const job = state.job;
    job.timer -= dt;
    if (job.timer <= 0) {
      failJob();
      return;
    }
    if (job.type === JOB_DROPS) {
      for (let i = 0; i < job.points.length; i += 1) {
        const p = job.points[i];
        if (!p.taken && distance(player.x, player.y, p.x, p.y) < 34) {
          p.taken = true;
          state.cash += 60;
          state.score += 20;
          sound('blip');
          float(p.x, p.y - 12, '+$60', '#ffd166');
        }
      }
      if (job.points.every((p) => p.taken)) completeJob();
      return;
    }
    const target = jobTarget();
    if (!target) return;
    if (distance(player.x, player.y, target.x, target.y) < 40) {
      if (job.type === JOB_DELIVERY && job.stage === 0) {
        job.stage = 1;
        addHeat(state.heat < 1 ? 1 : 0, 'PICKUP MADE');
        sound('blip');
        tip('Package in hand. Get to the drop.', 2.6);
      } else if (job.type === JOB_CHECKPOINTS && job.stage < job.points.length - 1) {
        job.stage += 1;
        state.cash += 40;
        sound('blip');
        float(target.x, target.y - 14, 'CHECKPOINT', '#33e1ff');
      } else {
        completeJob();
      }
    }
  }

  /* ----------------------------------------------------------------- shift */

  function endShift(reason) {
    if (state.phase !== PHASE_PLAY) return;
    state.phase = PHASE_OVER;
    state.reason = reason;
    state.stats.timePlayed = SHIFT_SECONDS - state.shift;
    if (reason === REASON_BUSTED) {
      state.stats.busted += 1;
      state.score = Math.max(0, state.score - 50);
      sound('sting');
    } else if (reason === REASON_WASTED) {
      state.stats.wasted += 1;
      sound('sting');
    } else {
      sound('jingle');
    }
    if (player.car) {
      player.car.occupiedByPlayer = false;
      player.car.driver = 'none';
    }
    state.best.cash = Math.max(state.best.cash, state.cash);
  }

  function placePlayer(x, y, angle) {
    player.x = x;
    player.y = y;
    player.angle = angle ?? 0;
    player.vx = 0;
    player.vy = 0;
    player.health = PLAYER.health;
    player.onFoot = true;
    player.car = null;
    player.walkPhase = 0;
    state.camera.x = clamp(x - 640, 0, WORLD.width);
    state.camera.y = clamp(y - 400, 0, WORLD.height);
  }

  function startShift() {
    state.phase = PHASE_PLAY;
    state.shift = SHIFT_SECONDS;
    state.time = 0;
    state.cash = 0;
    state.score = 0;
    state.heat = 0;
    state.heatProgress = 0;
    state.busted = 0;
    state.bustTime = 0;
    state.reason = null;
    state.jobsDone = 0;
    state.jobOrder = [];
    state.stats = { stolen: 0, crashes: 0, distance: 0, busted: 0, wasted: 0, jobs: 0, timePlayed: 0 };
    state.job = null;
    state.jobWait = 2.5;
    state.police.length = 0;
    state.effects.length = 0;
    state.floaters.length = 0;
    state.tip = '';
    state.tipTimer = 0;
    state.best.heat = 0;
    state.lastRoadblock = -99;
    state.roadblocks = 0;
    // A Palm Heights sidewalk, with a car at the curb so the first job can start moving.
    const startX = ROAD_COLS[0] + ROAD.half + 34;
    const startY = ROAD_ROWS[1] + 66;
    placePlayer(startX, startY, -Math.PI / 2);
    const spot = { x: ROAD_COLS[0] + ROAD.half - 16, y: ROAD_ROWS[1] + 46, angle: -Math.PI / 2, type: 'sports', color: '#f4f7ff' };
    if (!state.cars.some((c) => distance(c.x, c.y, spot.x, spot.y) < 60)) addParkedCar(spot);
    state.district = districtAt(player.x, player.y);
    state.banner = { name: state.district.name, t: 3.2, accent: state.district.accent };
  }

  function toTitle() {
    state.phase = PHASE_TITLE;
    state.shift = SHIFT_SECONDS;
    state.time = 0;
    state.heat = 0;
    state.police.length = 0;
    state.job = null;
    state.cash = 0;
    state.score = 0;
    placePlayer(ROAD_COLS[1] + ROAD.half + 40, ROAD_ROWS[1] + 30, 0);
    state.district = districtAt(player.x, player.y);
    state.banner = { name: state.district.name, t: 0, accent: state.district.accent };
  }

  /* ------------------------------------------------------------ the step */

  function applyControls(controls) {
    if (state.phase !== PHASE_PLAY) return;
    if (player.onFoot) updateOnFoot(STEP, controls);
    else updateDriving(STEP, controls);
  }

  function updateEffects(dt) {
    for (let i = state.effects.length - 1; i >= 0; i -= 1) {
      const e = state.effects[i];
      e.life -= dt;
      if (e.life <= 0) {
        state.effects.splice(i, 1);
        continue;
      }
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      if (e.kind === 'spark') {
        e.vx *= 1 - 2.6 * dt;
        e.vy *= 1 - 2.6 * dt;
      } else {
        e.size += dt * 9;
        e.vy -= dt * 6;
      }
    }
    for (let i = state.floaters.length - 1; i >= 0; i -= 1) {
      const f = state.floaters[i];
      f.life -= dt;
      f.y += (f.vy ?? -22) * dt;
      if (f.life <= 0) state.floaters.splice(i, 1);
    }
  }

  function updateCamera(dt) {
    const viewW = 1280;
    const viewH = 800;
    const lead = player.car ? Math.cos(player.car.angle) * Math.min(140, Math.abs(player.car.speed) * 0.5) : 0;
    const leadY = player.car ? Math.sin(player.car.angle) * Math.min(140, Math.abs(player.car.speed) * 0.5) : 0;
    const targetX = clamp(player.x + lead - viewW / 2, 0, Math.max(0, WORLD.width - viewW));
    const targetY = clamp(player.y + leadY - viewH / 2, 0, Math.max(0, WORLD.height - viewH));
    const rate = damp(4.2, dt);
    state.camera.x += (targetX - state.camera.x) * rate;
    state.camera.y += (targetY - state.camera.y) * rate;
    state.camera.shake = Math.max(0, state.camera.shake - dt * 26);
  }

  function updateClock(dt) {
    state.shift = Math.max(0, state.shift - dt);
    state.clock = CLOCK_START + (SHIFT_SECONDS - state.shift) * 0.55;
    // 17:40 -> 18:50 is dusk; full neon night by the end of the shift.
    const progress = 1 - state.shift / SHIFT_SECONDS;
    state.night = clamp(progress * 1.45 - 0.12, 0, 1);
    if (state.shift <= 0 && state.phase === PHASE_PLAY) endShift(REASON_TIME);
  }

  function updateDistrict(dt) {
    const here = districtAt(player.x, player.y);
    if (here !== state.district && here.name !== state.district.name) {
      state.district = here;
      state.banner = { name: here.name, t: 3.4, accent: here.accent };
    }
    if (state.banner.t > 0) state.banner.t -= dt;
    if (state.tipTimer > 0) state.tipTimer -= dt;
  }

  function updateStreams(dt) {
    // Keep the streets busy, but only top up away from the player's view.
    if (state.cars.length < TRAFFIC_TARGET && random() < dt * 1.5) addTrafficCar();
    if (state.peds.length < 54 && random() < dt * 2.2) {
      const spot = freeRoadSpot(240, player.x, player.y);
      const side = random() < 0.5 ? 1 : -1;
      spawnPed(spot.x + side * (ROAD.half + 12), spot.y + side * (ROAD.half + 12));
    }
  }

  /** One fixed step of the live game, with the keyboard's controls. */
  function step(dt, controls) {
    if (state.phase !== PHASE_PLAY) {
      updateCamera(dt);
      updateEffects(dt);
      updateDistrict(dt);
      return;
    }
    state.time += dt;
    applyControls(controls);
    if (state.phase !== PHASE_PLAY) return;
    updateDrivingOrOnFootExtras(dt, controls);
    updateTraffic(dt);
    updatePeds(dt);
    updatePolice(dt);
    updateJob(dt);
    updateClock(dt);
    updateEffects(dt);
    updateDistrict(dt);
    updateCamera(dt);
    updateStreams(dt);
  }

  /** Smoke, siren distance and the other per-frame extras that hang off driving. */
  function updateDrivingOrOnFootExtras(dt) {
    if (player.onFoot) return;
    const car = player.car;
    if (!car) return;
    let nearest = 9999;
    for (let i = 0; i < state.police.length; i += 1) {
      const unit = state.police[i];
      if (unit.car.wrecked) continue;
      nearest = Math.min(nearest, distance(unit.car.x, unit.car.y, car.x, car.y));
    }
    state.sirenDistance = nearest;
    if (state.police.length > 0 && state.heat > 0) {
      const ratio = clamp(1 - nearest / 1400, 0, 1);
      if (random() < 0.12) state.sirenLevel = ratio;
    } else state.sirenLevel = 0;
  }

  /** A world ready to play: traffic on the roads, people on the walks, a job waiting. */
  function populate() {
    for (let i = 0; i < TRAFFIC_TARGET; i += 1) addTrafficCar();
    for (let i = 0; i < 54; i += 1) {
      const spot = freeRoadSpot(120, player.x, player.y);
      const side = random() < 0.5 ? 1 : -1;
      spawnPed(spot.x + side * (ROAD.half + 12), spot.y + side * (ROAD.half + 12));
    }
    for (let i = 0; i < city.parked.length; i += 1) {
      if (i % 1 === 0) addParkedCar(city.parked[i]);
    }
    state.parkedAt = city.parked.length;
  }

  toTitle();
  populate();

  return {
    state,
    city,
    streams,
    step,
    startShift,
    toTitle,
    enterCar,
    exitCar,
    tryUseCar,
    endShift,
    spawnJob,
    addTrafficCar,
    addParkedCar,
    spawnPed,
    spawnPoliceUnit,
    makeRoadblock,
    freeRoadSpot,
    jobSpawnPoint,
    updateJob,
    updatePolice,
    updatePoliceUnit,
    updateTraffic,
    updatePeds,
    updateOnFoot,
    updateDriving,
    addHeat,
    hurtPlayer,
    onCarCrash,
    placePlayer,
    updateCamera,
    updateDistrict,
    updateClock,
    updateEffects,
    populate,
    tip,
    float,
    spark,
    smokePuff,
    sound,
    setHeating(value) {
      state.heat = clamp(value, 0, MAX_HEAT);
      state.best.heat = Math.max(state.best.heat, state.heat);
    },
    setPhase(phase) {
      state.phase = phase;
    },
  };
}
