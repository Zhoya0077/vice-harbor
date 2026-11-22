// Keyboard state plus the one-shot presses the screens need. Held keys are read as a level every
// frame; Enter/R/P/E/M/F are latched as flags and drained once by the loop, so a key tapped
// between frames is neither lost nor counted twice.

export const PRESS_CONFIRM = 1;
export const PRESS_PAUSE = 2;
export const PRESS_RESTART = 4;
export const PRESS_USE = 8;
export const PRESS_MUTE = 16;

const MOVE_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight',
]);
const ONE_SHOT = new Map([
  ['Enter', PRESS_CONFIRM],
  ['NumpadEnter', PRESS_CONFIRM],
  ['Space', PRESS_CONFIRM],
  ['KeyP', PRESS_PAUSE],
  ['Escape', PRESS_PAUSE],
  ['KeyR', PRESS_RESTART],
  ['KeyE', PRESS_USE],
  ['KeyM', PRESS_MUTE],
]);

export function createInput(canvas) {
  const held = new Set();
  let presses = 0;
  let pointerDown = false;

  window.addEventListener('keydown', (event) => {
    if (event.target && event.target.tagName === 'INPUT') return;
    if (MOVE_KEYS.has(event.code)) {
      held.add(event.code);
      event.preventDefault();
      return;
    }
    const flag = ONE_SHOT.get(event.code);
    if (flag !== undefined) {
      if (!event.repeat) presses |= flag;
      event.preventDefault();
      return;
    }
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      held.add('Shift');
      event.preventDefault();
    }
  });

  window.addEventListener('keyup', (event) => {
    held.delete(event.code);
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') held.delete('Shift');
  });

  // A key let go while the tab is hidden never sends keyup: drop everything on blur.
  window.addEventListener('blur', () => {
    held.clear();
    pointerDown = false;
  });

  canvas.addEventListener('pointerdown', () => {
    pointerDown = true;
    presses |= PRESS_CONFIRM;
  });
  window.addEventListener('pointerup', () => {
    pointerDown = false;
  });

  function axis(negA, negB, posA, posB) {
    const neg = held.has(negA) || held.has(negB) ? 1 : 0;
    const pos = held.has(posA) || held.has(posB) ? 1 : 0;
    return pos - neg;
  }

  return {
    /** -1..1 each; x is right, y is down. Normalised so diagonals are not faster. */
    move() {
      let x = axis('KeyA', 'ArrowLeft', 'KeyD', 'ArrowRight');
      let y = axis('KeyW', 'ArrowUp', 'KeyS', 'ArrowDown');
      if (x !== 0 && y !== 0) {
        const inv = Math.SQRT1_2;
        x *= inv;
        y *= inv;
      }
      return { x, y };
    },
    sprinting() {
      return held.has('Shift');
    },
    handbrake() {
      return held.has('Space');
    },
    /** Drain the one-shot presses as PRESS_* bits. */
    take() {
      const value = presses;
      presses = 0;
      return value;
    },
    pointerHeld() {
      return pointerDown;
    },
  };
}
