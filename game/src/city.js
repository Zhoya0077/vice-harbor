// The city itself: a road grid on a 400 px pitch, city blocks subdivided into buildings, a beach
// and open water across the south, palms, props and the parked cars' berths. Everything is built
// once from the seed, then read-only: collision, traffic and the renderer all consult this object.
import { BEACH, CAR_COLORS, WORLD, PALETTE, ROAD, ROAD_COLS, ROAD_ROWS } from './config.js';
import { hash2 } from './rng.js';

/** Which district a world point belongs to. Used for the on-screen sign and job placement. */
const DISTRICTS = [
  { name: 'Palm Heights', x: 0, y: 0, w: 1400, h: 1000, accent: '#57ff9a' },
  { name: 'Neon Mile', x: 1400, y: 0, w: 1800, h: 1000, accent: '#ff3d7f' },
  { name: 'Old Market', x: 0, y: 1000, w: 1400, h: 800, accent: '#ffd166' },
  { name: 'Harbor Docks', x: 1400, y: 1000, w: 1800, h: 800, accent: '#33e1ff' },
  { name: 'Vice Beach', x: 0, y: 1800, w: WORLD.width, h: WORLD.height - 1800, accent: '#ffa64d' },
];

export function districtAt(x, y) {
  for (let i = 0; i < DISTRICTS.length; i += 1) {
    const d = DISTRICTS[i];
    if (x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) return d;
  }
  return DISTRICTS[0];
}

export const DISTRICT_LIST = DISTRICTS;

/** Zone spans: the strips between roads that may hold buildings (already set back past the walk). */
function buildSpans(lines, total, edgeClear) {
  const spans = [];
  const half = ROAD.half + ROAD.sidewalk;
  spans.push({ from: 0, to: lines[0] - half, edge: true });
  for (let i = 0; i < lines.length - 1; i += 1) spans.push({ from: lines[i] + half, to: lines[i + 1] - half, edge: false });
  spans.push({ from: lines[lines.length - 1] + half, to: total - (edgeClear ?? 0), edge: true });
  return spans.filter((s) => s.to - s.from > 40);
}

function makeBuilding(streams, x, y, w, h, options) {
  const { range, chance, pick } = streams;
  const neon = options.neon === true && chance(0.55);
  const palette = options.palette ?? PALETTE.building;
  return {
    x, y, w, h,
    color: pick(palette),
    shade: range(0.86, 1.12),
    floors: Math.max(2, Math.round(h / 26)),
    cols: Math.max(2, Math.round(w / 30)),
    roof: chance(0.34) ? 'ac' : chance(0.3) ? 'tank' : chance(0.2) ? 'helipad' : 'plain',
    neon,
    neonColor: pick(PALETTE.neon),
    trim: chance(0.4) ? '#6d7f9a' : '#4a5468',
    seed: Math.floor(range(0, 1) * 65536),
    terrace: chance(0.22),
  };
}

/** Split one block zone into building plots with narrow alleys between them. */
function fillBlock(streams, block, buildings) {
  const { int, chance, range } = streams;
  const cols = Math.max(1, Math.min(3, Math.round(block.w / 130)));
  const rows = Math.max(1, Math.min(3, Math.round(block.h / 120)));
  const gap = 9;
  const pad = 7;
  const cellW = (block.w - pad * 2 - gap * (cols - 1)) / cols;
  const cellH = (block.h - pad * 2 - gap * (rows - 1)) / rows;
  for (let cx = 0; cx < cols; cx += 1) {
    for (let cy = 0; cy < rows; cy += 1) {
      if (chance(0.08) && (cx > 0 || cy > 0) && cols * rows > 2) continue;
      const fw = Math.max(40, cellW * range(0.82, 1));
      const fh = Math.max(36, cellH * range(0.78, 1));
      const x = block.x + pad + cx * (cellW + gap) + (cellW - fw) * 0.5;
      const y = block.y + pad + cy * (cellH + gap) + (cellH - fh) * 0.5;
      buildings.push(makeBuilding(streams, x, y, fw, fh, { neon: block.district.name === 'Neon Mile' }));
    }
  }
}

export function createCity(streams) {
  const { range, int, chance, pick, sign } = streams;
  const buildings = [];
  const props = [];
  const parks = [];
  const parked = [];

  const xSpans = buildSpans(ROAD_COLS, WORLD.width, 0);
  const ySpans = buildSpans(ROAD_ROWS, BEACH.top - 24, 0);

  for (let xi = 0; xi < xSpans.length; xi += 1) {
    for (let yi = 0; yi < ySpans.length; yi += 1) {
      const sx = xSpans[xi];
      const sy = ySpans[yi];
      const block = {
        x: sx.from,
        y: sy.from,
        w: sx.to - sx.from,
        h: sy.to - sy.from,
        district: districtAt(sx.from + 4, sy.from + 4),
      };
      if (block.w < 44 || block.h < 44) continue;
      // A few blocks are parks or parking lots: open ground with palms and lamps, no buildings.
      const open = chance(0.13);
      if (open) {
        parks.push(block);
        for (let p = 0; p < 3; p += 1) {
          props.push({ type: 'palm', x: range(block.x + 18, block.x + block.w - 18), y: range(block.y + 18, block.y + block.h - 18), r: 9, blocking: false, sway: range(0, 6.28) });
        }
        for (let p = 0; p < 2; p += 1) {
          props.push({ type: 'bench', x: range(block.x + 24, block.x + block.w - 24), y: range(block.y + 24, block.y + block.h - 24), r: 5, blocking: false });
        }
        continue;
      }
      fillBlock(streams, block, buildings);
    }
  }

  // The beachfront: a low strip of bars and shops facing the sand, then palms down the sand.
  for (let xi = 0; xi < xSpans.length; xi += 1) {
    const sx = xSpans[xi];
    if (sx.to - sx.from < 90) continue;
    const w = Math.min(sx.to - sx.from - 20, range(80, 150));
    const h = range(52, 74);
    buildings.push(makeBuilding(streams, sx.from + 10, BEACH.top - h - 34, w, h, { neon: true, palette: ['#4a3a3a', '#3f4652', '#53403f', '#3a4a4a'] }));
  }
  for (let i = 0; i < 46; i += 1) {
    props.push({
      type: 'palm',
      x: range(30, WORLD.width - 30),
      y: range(BEACH.top + 22, BEACH.water - 26),
      r: 9,
      blocking: false,
      sway: range(0, 6.28),
    });
  }

  // Street furniture: lamps at intersections, crates and barriers on the docks, hydrants on corners.
  const corners = [];
  for (let i = 0; i < ROAD_COLS.length; i += 1) {
    for (let j = 0; j < ROAD_ROWS.length; j += 1) corners.push([ROAD_COLS[i], ROAD_ROWS[j]]);
  }
  for (let i = 0; i < corners.length; i += 1) {
    const [cx, cy] = corners[i];
    const off = ROAD.half + 8;
    props.push({ type: 'lamp', x: cx - off, y: cy - off, r: 5, blocking: false, glow: true });
    props.push({ type: 'lamp', x: cx + off, y: cy + off, r: 5, blocking: false, glow: true });
    if (i % 3 === 0) props.push({ type: 'hydrant', x: cx + off + 6, y: cy - off - 4, r: 4, blocking: false });
  }
  for (let i = 0; i < 26; i += 1) {
    const x = range(1700, WORLD.width - 80);
    const y = range(1000, 1780);
    props.push({ type: 'crate', x, y, w: 22, h: 22, r: 12, blocking: true, tone: chance(0.5) ? '#8a6a3f' : '#6d7a84' });
  }
  for (let i = 0; i < 12; i += 1) {
    const x = range(120, WORLD.width - 120);
    const y = pick(ROAD_ROWS) + sign() * (ROAD.half - 10);
    props.push({ type: 'barrier', x, y, w: 40, h: 12, r: 16, blocking: true, tone: '#d8863a' });
  }
  for (let i = 0; i < 18; i += 1) {
    const x = range(80, WORLD.width - 80);
    const y = chance(0.6) ? range(BEACH.top - 20, BEACH.top + 20) : pick(ROAD_ROWS) + sign() * (ROAD.half + 12);
    props.push({ type: 'bench', x, y, r: 5, blocking: false, rot: chance(0.5) ? 0 : Math.PI / 2 });
  }

  // Parked cars: tucked against the curb, nose along the road they sit on.
  const lanes = [];
  for (let i = 0; i < ROAD_COLS.length; i += 1) {
    for (let a = 40; a < BEACH.top - 40; a += range(120, 210)) {
      if (chance(0.45)) continue;
      lanes.push({ x: ROAD_COLS[i] + (chance(0.5) ? -1 : 1) * (ROAD.half - 14), y: a, angle: chance(0.5) ? -Math.PI / 2 : Math.PI / 2 });
    }
  }
  for (let i = 0; i < ROAD_ROWS.length; i += 1) {
    for (let a = 40; a < WORLD.width - 40; a += range(120, 210)) {
      if (chance(0.45)) continue;
      lanes.push({ x: a, y: ROAD_ROWS[i] + (chance(0.5) ? -1 : 1) * (ROAD.half - 14), angle: chance(0.5) ? 0 : Math.PI });
    }
  }
  for (let i = 0; i < lanes.length; i += 1) {
    const spot = lanes[i];
    if (spot.y > BEACH.top - 10) continue;
    parked.push({
      x: spot.x,
      y: spot.y,
      angle: spot.angle,
      type: pick(['compact', 'compact', 'sports', 'truck']),
      color: pick(CAR_COLORS),
    });
  }

  // A coarse bucket grid over the solid rects, so a circle only tests what is near it.
  const CELL = 160;
  const buckets = new Map();
  const solids = [];
  for (let i = 0; i < buildings.length; i += 1) solids.push(buildings[i]);
  for (let i = 0; i < props.length; i += 1) if (props[i].blocking) solids.push({ x: props[i].x - (props[i].w ?? 14) / 2, y: props[i].y - (props[i].h ?? 14) / 2, w: props[i].w ?? 14, h: props[i].h ?? 14, prop: props[i] });
  for (let i = 0; i < solids.length; i += 1) {
    const r = solids[i];
    const x0 = Math.floor(r.x / CELL);
    const x1 = Math.floor((r.x + r.w) / CELL);
    const y0 = Math.floor(r.y / CELL);
    const y1 = Math.floor((r.y + r.h) / CELL);
    for (let gx = x0; gx <= x1; gx += 1) {
      for (let gy = y0; gy <= y1; gy += 1) {
        const key = gx * 1000 + gy;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
      }
    }
  }

  const city = {
    width: WORLD.width,
    height: WORLD.height,
    roads: { cols: ROAD_COLS.slice(), rows: ROAD_ROWS.slice() },
    buildings,
    props,
    parks,
    parked,
    solids,
    water: { x: 0, y: BEACH.water, w: WORLD.width, h: WORLD.height - BEACH.water },
    sand: { x: 0, y: BEACH.top, w: WORLD.width, h: BEACH.water - BEACH.top },
    districtAt,
    /** Every solid rect whose bucket touches the circle's neighbourhood. */
    nearbySolids(x, y, radius, out) {
      out.length = 0;
      const x0 = Math.floor((x - radius) / CELL);
      const x1 = Math.floor((x + radius) / CELL);
      const y0 = Math.floor((y - radius) / CELL);
      const y1 = Math.floor((y + radius) / CELL);
      for (let gx = x0; gx <= x1; gx += 1) {
        for (let gy = y0; gy <= y1; gy += 1) {
          const list = buckets.get(gx * 1000 + gy);
          if (!list) continue;
          for (let i = 0; i < list.length; i += 1) if (out.indexOf(list[i]) === -1) out.push(list[i]);
        }
      }
      return out;
    },
    /** Is the point inside a building or out over the water? */
    blocked(x, y) {
      if (y > BEACH.water) return true;
      const list = city.nearbySolids(x, y, 2, []);
      for (let i = 0; i < list.length; i += 1) {
        const r = list[i];
        if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
      }
      return false;
    },
    /** Does the straight line from a to b hit a building? The police's line of sight. */
    lineBlocked(x1, y1, x2, y2) {
      const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 24);
      for (let i = 1; i < steps; i += 1) {
        const t = i / steps;
        if (city.blocked(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)) return true;
      }
      return false;
    },
    /** A random point on a road, for spawning traffic and police. */
    randomRoadPoint(random, nearX, nearY, minDistance) {
      for (let attempt = 0; attempt < 48; attempt += 1) {
        const vertical = random() < 0.5;
        const x = vertical ? pick(ROAD_COLS) : random() * WORLD.width;
        const y = vertical ? random() * (BEACH.top - 40) : pick(ROAD_ROWS);
        if (nearX === undefined || Math.hypot(x - nearX, y - nearY) > (minDistance ?? 600)) return { x, y, vertical };
      }
      return { x: pick(ROAD_COLS), y: pick(ROAD_ROWS), vertical: true };
    },
  };
  return city;
}

/** Window light pattern for one building, drawn from its stable seed: no state, no allocation. */
export function windowLit(building, col, row, night) {
  const h = hash2(building.seed + col * 37, row * 91, 0x51ed);
  return h < night * 0.62;
}
