// Boot and the loop. Input is read each frame, the world advances in fixed 1/60 s steps (several
// in a slow frame, none in a fast one) and the renderer paints what is there. Four screens:
// title, play, paused and the shift summary.
//
// ?seed=N fixes the city, the traffic and the jobs. ?shot=start|play|chase|end stages that scene,
// paints it twice and sets window.__shotReady so the screenshot script knows it can shoot.
import { STEP } from './config.js';
import { createWorld, PHASE_OVER, PHASE_PAUSED, PHASE_PLAY, PHASE_TITLE } from './world.js';
import { createRenderer } from './render.js';
import { createInput, PRESS_CONFIRM, PRESS_MUTE, PRESS_PAUSE, PRESS_RESTART, PRESS_USE } from './input.js';
import { createAudio } from './audio.js';
import { stageShot } from './shots.js';

const MAX_FRAME = 0.2;
const MAX_STEPS = 12;
const BEST_KEY = 'vice-harbor-best';

const params = new URLSearchParams(window.location.search);
const shotName = params.get('shot');
const seedParam = Number.parseInt(params.get('seed') ?? '', 10);
const seed = Number.isInteger(seedParam) ? seedParam : Math.floor(Math.random() * 4294967296);

const canvas = document.getElementById('game');
const statusLine = document.getElementById('status');
const world = createWorld(seed);
const renderer = createRenderer(canvas);
renderer.setCity(world.city);
const audio = createAudio();

let screen = PHASE_TITLE;
let accumulator = 0;
let last = performance.now();
let bestCash = readBest();
let quietStep = 0;
const controls = { moveX: 0, moveY: 0, sprint: false, handbrake: false };

function readBest() {
  try {
    return Number.parseInt(window.localStorage.getItem(BEST_KEY) ?? '0', 10) || 0;
  } catch {
    return 0;
  }
}

function saveBest(value) {
  try {
    window.localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // Storage can be off in a private window: the record then lasts this visit.
  }
}

function announce(text) {
  if (statusLine) statusLine.textContent = text;
}

/** Route a batch of one-shot presses to whatever screen is up. */
function handlePresses(presses) {
  if (presses === 0) return;
  if (presses & PRESS_MUTE) {
    audio.unlock();
    audio.setMuted(!audio.muted());
    announce(audio.muted() ? 'Sound off' : 'Sound on');
  }
  if (screen === PHASE_TITLE) {
    if (presses & PRESS_CONFIRM) {
      audio.unlock();
      world.startShift();
      screen = PHASE_PLAY;
      announce('Shift started. Find the job marker and get moving.');
    }
    return;
  }
  if (screen === PHASE_PLAY) {
    if (presses & PRESS_PAUSE) {
      screen = PHASE_PAUSED;
      world.setPhase(PHASE_PAUSED);
      announce('Paused');
    } else if (presses & PRESS_USE) {
      world.tryUseCar();
    } else if (presses & PRESS_RESTART) {
      restart();
    }
    return;
  }
  if (screen === PHASE_PAUSED) {
    if (presses & PRESS_PAUSE) {
      screen = PHASE_PLAY;
      world.setPhase(PHASE_PLAY);
      announce('Shift resumed');
    } else if (presses & PRESS_RESTART) {
      restart();
    } else if (presses & PRESS_CONFIRM) {
      screen = PHASE_PLAY;
      world.setPhase(PHASE_PLAY);
    }
    return;
  }
  if (screen === PHASE_OVER) {
    if (presses & (PRESS_RESTART | PRESS_CONFIRM)) {
      restart();
    }
  }
}

function restart() {
  world.startShift();
  screen = PHASE_PLAY;
  accumulator = 0;
  announce('Shift restarted. Five minutes on the clock.');
}

function spawnSound() {
  // Drain the world's sound requests into the synth; the world knows nothing about WebAudio.
  const sounds = world.state.sounds;
  for (let i = 0; i < sounds.length; i += 1) {
    const cue = sounds[i];
    if (cue.type === 'sting') audio.sting();
    else if (cue.type === 'jingle') audio.jingle();
    else if (cue.type === 'blip') audio.blip();
    else if (cue.type === 'crash') audio.crash(cue.value ?? 0.4);
    else if (cue.type === 'skid') audio.skid();
    else if (cue.type === 'click') audio.click();
  }
  sounds.length = 0;
}

/** Update the continuous audio beds: the engine under the player's car, the siren in a chase. */
function updateAudio(dt) {
  const state = world.state;
  const car = state.player.car;
  if (screen === PHASE_PLAY && car && !car.wrecked) {
    const ratio = Math.min(1, Math.abs(car.speed) / car.spec.maxSpeed);
    audio.engine(true, ratio);
  } else {
    audio.engine(false, 0);
  }
  let siren = 0;
  if (screen === PHASE_PLAY && state.heat > 0) {
    let nearest = Infinity;
    for (const unit of state.police) {
      if (unit.car.wrecked) continue;
      const d = Math.hypot(unit.car.x - state.player.x, unit.car.y - state.player.y);
      if (d < nearest) nearest = d;
    }
    siren = Number.isFinite(nearest) ? Math.max(0, 1 - nearest / 1100) : 0;
  }
  audio.siren(siren, dt);
}

function readControls(input) {
  const move = input.move();
  controls.moveX = move.x;
  controls.moveY = move.y;
  controls.sprint = input.sprinting();
  controls.handbrake = input.handbrake();
  return controls;
}

function tick(now) {
  const delta = Math.min(MAX_FRAME, (now - last) / 1000);
  last = now;
  const input = inputSource;
  const presses = input.take();
  handlePresses(presses);

  if (screen === PHASE_PLAY) {
    readControls(input);
    accumulator += delta;
    let steps = 0;
    while (accumulator >= STEP && steps < MAX_STEPS) {
      world.step(STEP, controls);
      accumulator -= STEP;
      steps += 1;
    }
    if (steps === MAX_STEPS) accumulator = 0;
    if (world.state.phase === PHASE_OVER) {
      screen = PHASE_OVER;
      if (world.state.cash > bestCash) {
        bestCash = world.state.cash;
        saveBest(bestCash);
      }
      announce(`Shift over. Cash ${Math.floor(world.state.cash)}. Press R to run it again.`);
    }
  } else {
    // Title, pause and summary: the world only creeps, for the ambient motion.
    accumulator = 0;
    world.step(STEP, { moveX: 0, moveY: 0, sprint: false, handbrake: false });
    if (screen === PHASE_OVER && world.state.phase !== PHASE_OVER) world.setPhase(PHASE_OVER);
  }

  spawnSound();
  updateAudio(delta);
  renderer.draw(world.state);
  requestAnimationFrame(tick);
}

let inputSource = null;

/** Frozen scenes: stage, paint a couple of frames, flag ready. No loop runs. */
function runShot(name) {
  const scene = stageShot(name, world);
  const state = world.state;
  state.time = 0;
  let painted = 0;
  cameraSnap(state);
  function paint() {
    renderer.drawFrozen(state, scene.screen);
    painted += 1;
    if (painted < 2) requestAnimationFrame(paint);
    else window.__shotReady = true;
  }
  requestAnimationFrame(paint);
}

/** Put the camera exactly where it belongs without any easing, for a stable frame. */
function cameraSnap(state) {
  const cx = Math.max(0, Math.min(world.city.width - renderer.VIEW_W, state.player.x - renderer.VIEW_W / 2));
  const cy = Math.max(0, Math.min(world.city.height - renderer.VIEW_H, state.player.y - renderer.VIEW_H / 2));
  state.camera.x = cx;
  state.camera.y = cy;
}

function boot() {
  renderer.resize();
  window.addEventListener('resize', renderer.resize);
  inputSource = createInput(canvas);

  // Audio can only start from a gesture, so every first gesture unlocks it.
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });

  if (shotName && ['start', 'play', 'chase', 'end'].includes(shotName)) {
    runShot(shotName);
    return;
  }
  world.toTitle();
  if (world.state.phase !== PHASE_TITLE) world.setPhase(PHASE_TITLE);
  renderer.draw(world.state);
  announce('Vice Harbor. Press Enter to start a five-minute shift.');
  requestAnimationFrame(tick);
}

boot();
