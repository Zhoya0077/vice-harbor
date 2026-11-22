// Small geometry and maths helpers. Nothing here knows about the game; the collision routines are
// the ones the player, the cars, the police line-of-sight and the renderer all share.

export const TAU = Math.PI * 2;

export const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Move `value` toward `target` by at most `step`. */
export function approach(value, target, step) {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  let angle = a % TAU;
  if (angle > Math.PI) angle -= TAU;
  if (angle <= -Math.PI) angle += TAU;
  return angle;
}

export function angleTo(x1, y1, x2, y2) {
  return Math.atan2(y2 - y1, x2 - x1);
}

export function distance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

/** Proportional-ish damping that behaves the same at any frame length. */
export function damp(rate, dt) {
  return 1 - Math.exp(-rate * dt);
}

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function pointInRect(x, y, r) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** Push a circle out of an axis-aligned rect. Returns the corrected {x, y} or null when clear. */
export function circleRect(x, y, radius, rect) {
  const nx = clamp(x, rect.x, rect.x + rect.w);
  const ny = clamp(y, rect.y, rect.y + rect.h);
  const dx = x - nx;
  const dy = y - ny;
  const d2 = dx * dx + dy * dy;
  if (d2 > radius * radius) return null;
  if (d2 > 0.0001) {
    const d = Math.sqrt(d2);
    const push = radius - d;
    return { x: x + (dx / d) * push, y: y + (dy / d) * push, nx: dx / d, ny: dy / d };
  }
  // Dead centre: leave by the shortest side.
  const left = x - rect.x;
  const right = rect.x + rect.w - x;
  const top = y - rect.y;
  const bottom = rect.y + rect.h - y;
  const m = Math.min(left, right, top, bottom);
  if (m === left) return { x: rect.x - radius, y, nx: -1, ny: 0 };
  if (m === right) return { x: rect.x + rect.w + radius, y, nx: 1, ny: 0 };
  if (m === top) return { x, y: rect.y - radius, nx: 0, ny: -1 };
  return { x, y: rect.y + rect.h + radius, nx: 0, ny: 1 };
}

/** Does the segment (x1,y1)-(x2,y2) touch the rect? Slab test, used for line of sight. */
export function segmentRect(x1, y1, x2, y2, rect) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - rect.x, rect.x + rect.w - x1, y1 - rect.y, rect.y + rect.h - y1];
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

/** Distance along the segment to its first hit on any of the rects, or Infinity. */
export function rayDistance(x, y, dirX, dirY, maxLength, rects, skip) {
  let best = maxLength;
  for (let i = 0; i < rects.length; i += 1) {
    const r = rects[i];
    if (r === skip) continue;
    const x2 = x + dirX * best;
    const y2 = y + dirY * best;
    if (!segmentRect(x, y, x2, y2, r)) continue;
    // March a short distance to find the first contact to within a couple of pixels.
    let lo = 0;
    let hi = best;
    for (let s = 0; s < 12; s += 1) {
      const mid = (lo + hi) / 2;
      if (segmentRect(x, y, x + dirX * mid, y + dirY * mid, r)) hi = mid;
      else lo = mid;
    }
    if (hi < best) best = hi;
  }
  return best;
}

/** Point on a rectangle's border closest to (x, y), for edge arrows. */
export function borderPoint(x, y, w, h, margin) {
  const cx = w / 2;
  const cy = h / 2;
  const dx = x - cx;
  const dy = y - cy;
  const scale = Math.min((cx - margin) / Math.max(1e-4, Math.abs(dx)), (cy - margin) / Math.max(1e-4, Math.abs(dy)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}
