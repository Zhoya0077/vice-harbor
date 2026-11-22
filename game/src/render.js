// Drawing only: world state in, pixels out. The view is a 1280x800 window into the city, scaled
// to fit the browser and letterboxed. Buildings get a faked extrusion (a roof lifted off the
// footprint with the south facade showing) so the city has height from straight above, and the
// night pass lights the windows, the lamps and the headlights with additive gradients.
import {
  BEACH, CAR_SPECS, FONT, FONT_DISPLAY, FONT_MONO, MAX_HEAT, PALETTE, ROAD, ROAD_COLS,
  ROAD_ROWS, SHIFT_SECONDS, WORLD,
} from './config.js';
import { windowLit } from './city.js';
import { clamp, distance, lerp } from './util.js';
import {
  JOB_CHECKPOINTS, JOB_DELIVERY, JOB_DROPS, PHASE_OVER, PHASE_PAUSED, PHASE_PLAY, PHASE_TITLE,
  REASON_BUSTED, REASON_TIME, REASON_WASTED,
} from './world.js';

export const VIEW_W = 1280;
export const VIEW_H = 800;

const TAU = Math.PI * 2;
const MINIMAP = { w: 244, h: 183, pad: 16 };

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  let city = { buildings: [], props: [], parks: [], lamps: [] };
  const scratch = [];

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, window.innerWidth);
    const h = Math.max(240, window.innerHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const scale = Math.min(w / VIEW_W, h / VIEW_H);
    view.dpr = dpr;
    view.scale = scale;
    view.ox = (w - VIEW_W * scale) / 2;
    view.oy = (h - VIEW_H * scale) / 2;
    ctx.imageSmoothingEnabled = true;
  }

  function beginFrame() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04060c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = view.scale * view.dpr;
    ctx.setTransform(s, 0, 0, s, view.ox * view.dpr, view.oy * view.dpr);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, VIEW_W, VIEW_H);
    ctx.clip();
  }

  function endFrame() {
    ctx.restore();
  }

  /* ------------------------------------------------------------- primitives */

  function font(size, weight, family) {
    return `${weight ?? 600} ${size}px ${family ?? FONT}`;
  }

  function text(value, x, y, size, color, align, weight, family) {
    ctx.font = font(size, weight, family);
    ctx.fillStyle = color;
    ctx.textAlign = align ?? 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(value, x, y);
  }

  function spacedText(value, x, y, size, color, spacing, align) {
    ctx.font = font(size, 700, FONT_DISPLAY);
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const chars = [...value];
    let width = 0;
    for (const ch of chars) width += ctx.measureText(ch).width + spacing;
    width -= spacing;
    let cx = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
    for (const ch of chars) {
      ctx.fillText(ch, cx, y);
      cx += ctx.measureText(ch).width + spacing;
    }
    return width;
  }

  function roundRect(x, y, w, h, r) {
    const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function panel(x, y, w, h, alpha, border) {
    ctx.globalAlpha = alpha ?? 0.82;
    ctx.fillStyle = '#0b0f1a';
    roundRect(x, y, w, h, 12);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1.5;
      roundRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5, 12);
      ctx.stroke();
    }
  }

  /** Blend two hex colours; t=0 gives a, t=1 gives b. */
  function mix(a, b, t) {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, t));
    const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
    const bl = Math.round(lerp(pa & 255, pb & 255, t));
    return `rgb(${r},${g},${bl})`;
  }

  /** Shift a hex colour's brightness by a factor (0.5 darker, 1.4 lighter). */
  function shade(hex, factor, alpha) {
    const p = parseInt(hex.slice(1), 16);
    const r = clamp(Math.round(((p >> 16) & 255) * factor), 0, 255);
    const g = clamp(Math.round(((p >> 8) & 255) * factor), 0, 255);
    const b = clamp(Math.round((p & 255) * factor), 0, 255);
    return alpha === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
  }

  function rgba(hex, alpha) {
    const p = parseInt(hex.slice(1), 16);
    return `rgba(${(p >> 16) & 255},${(p >> 8) & 255},${p & 255},${alpha})`;
  }

  /** Camera-space rect culling test. */
  function visible(x, y, w, h, camX, camY, pad) {
    const p = pad ?? 40;
    return x + w > camX - p && x < camX + VIEW_W + p && y + h > camY - p && y < camY + VIEW_H + p;
  }

  function vgradient(x, y, w, h, stops) {
    const g = ctx.createLinearGradient(x, y, x, y + h);
    for (const [at, color] of stops) g.addColorStop(at, color);
    return g;
  }

  function hgradient(x, y, w, h, stops) {
    const g = ctx.createLinearGradient(x, y, x + w, y);
    for (const [at, color] of stops) g.addColorStop(at, color);
    return g;
  }

  function radial(x, y, r, stops) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, r));
    for (const [at, color] of stops) g.addColorStop(at, color);
    return g;
  }

  /* ------------------------------------------------------------ the ground */

  function drawGround(state, camX, camY) {
    const night = state.night;
    // Asphalt everywhere, then the blocks are painted over it.
    ctx.fillStyle = mix('#1a1c26', '#0d1020', night * 0.55);
    ctx.fillRect(camX - 80, camY - 80, VIEW_W + 160, VIEW_H + 160);

    // Road surface bands, a touch lighter, with lane markings.
    for (const rx of ROAD_COLS) {
      if (rx < camX - 120 || rx > camX + VIEW_W + 120) continue;
      const g = hgradient(rx - ROAD.half, 0, ROAD.width, 1, [
        [0, mix('#1a1c25', '#101320', night)],
        [0.5, mix(PALETTE.asphalt, '#191c28', night)],
        [1, mix('#1a1c25', '#101320', night)],
      ]);
      ctx.fillStyle = g;
      ctx.fillRect(rx - ROAD.half, Math.max(0, camY - 60), ROAD.width, Math.min(WORLD.height, VIEW_H + 180));
    }
    for (const ry of ROAD_ROWS) {
      if (ry < camY - 120 || ry > camY + VIEW_H + 120) continue;
      const g = vgradient(0, ry - ROAD.half, 1, ROAD.width, [
        [0, mix('#1a1c25', '#101320', night)],
        [0.5, mix(PALETTE.asphalt, '#191c28', night)],
        [1, mix('#1a1c25', '#101320', night)],
      ]);
      ctx.fillStyle = g;
      ctx.fillRect(Math.max(0, camX - 60), ry - ROAD.half, Math.min(WORLD.width, VIEW_W + 180), ROAD.width);
    }

    // Intersections get a patch of asphalt so the crossings read as one surface.
    ctx.fillStyle = mix('#26282f', '#1b1e2b', night);
    for (const rx of ROAD_COLS) {
      if (rx < camX - 120 || rx > camX + VIEW_W + 120) continue;
      for (const ry of ROAD_ROWS) {
        if (ry < camY - 120 || ry > camY + VIEW_H + 120) continue;
        ctx.fillRect(rx - ROAD.half, ry - ROAD.half, ROAD.width, ROAD.width);
      }
    }

    // Lane markings: dashed centre lines, and a solid pair at every crossing approach.
    const dash = [22, 20];
    ctx.strokeStyle = mix('#c9b979', '#8f8a63', night);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(dash);
    for (const rx of ROAD_COLS) {
      if (rx < camX - 60 || rx > camX + VIEW_W + 60) continue;
      ctx.beginPath();
      ctx.moveTo(rx, camY - 40);
      ctx.lineTo(rx, camY + VIEW_H + 40);
      ctx.stroke();
    }
    for (const ry of ROAD_ROWS) {
      if (ry < camY - 60 || ry > camY + VIEW_H + 60) continue;
      ctx.beginPath();
      ctx.moveTo(camX - 40, ry);
      ctx.lineTo(camX + VIEW_W + 40, ry);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // Zebra crossings at each intersection edge.
    ctx.fillStyle = mix('#d8d4c6', '#a8a496', night);
    ctx.globalAlpha = 0.45;
    for (const rx of ROAD_COLS) {
      if (rx < camX - 120 || rx > camX + VIEW_W + 120) continue;
      for (const ry of ROAD_ROWS) {
        if (ry < camY - 120 || ry > camY + VIEW_H + 120) continue;
        for (let i = 0; i < 5; i += 1) {
          const o = -ROAD.half + 8 + i * 17;
          ctx.fillRect(rx - ROAD.half - 18, ry + o, 14, 9);
          ctx.fillRect(rx + ROAD.half + 4, ry + o, 14, 9);
          ctx.fillRect(rx + o, ry - ROAD.half - 18, 9, 14);
          ctx.fillRect(rx + o, ry + ROAD.half + 4, 9, 14);
        }
      }
    }
    ctx.globalAlpha = 1;

    // Sidewalks: the strips flanking every road, laid as slabs with a curb edge.
    const sidewalk = mix('#767b88', '#2f3546', night * 0.66);
    ctx.fillStyle = sidewalk;
    for (const rx of ROAD_COLS) {
      if (rx < camX - 120 || rx > camX + VIEW_W + 120) continue;
      ctx.fillRect(rx - ROAD.half - ROAD.sidewalk, Math.max(0, camY - 40), ROAD.sidewalk, Math.min(WORLD.height, VIEW_H + 120));
      ctx.fillRect(rx + ROAD.half, Math.max(0, camY - 40), ROAD.sidewalk, Math.min(WORLD.height, VIEW_H + 120));
    }
    for (const ry of ROAD_ROWS) {
      if (ry < camY - 120 || ry > camY + VIEW_H + 120) continue;
      ctx.fillRect(Math.max(0, camX - 40), ry - ROAD.half - ROAD.sidewalk, Math.min(WORLD.width, VIEW_W + 120), ROAD.sidewalk);
      ctx.fillRect(Math.max(0, camX - 40), ry + ROAD.half, Math.min(WORLD.width, VIEW_W + 120), ROAD.sidewalk);
    }
    // Kerb highlight line.
    ctx.strokeStyle = mix('#9ea3b0', '#454b5d', night);
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.7;
    for (const rx of ROAD_COLS) {
      if (rx < camX - 120 || rx > camX + VIEW_W + 120) continue;
      ctx.beginPath();
      ctx.moveTo(rx - ROAD.half, camY - 30);
      ctx.lineTo(rx - ROAD.half, camY + VIEW_H + 30);
      ctx.moveTo(rx + ROAD.half, camY - 30);
      ctx.lineTo(rx + ROAD.half, camY + VIEW_H + 30);
      ctx.stroke();
    }
    for (const ry of ROAD_ROWS) {
      if (ry < camY - 120 || ry > camY + VIEW_H + 120) continue;
      ctx.beginPath();
      ctx.moveTo(camX - 30, ry - ROAD.half);
      ctx.lineTo(camX + VIEW_W + 30, ry - ROAD.half);
      ctx.moveTo(camX - 30, ry + ROAD.half);
      ctx.lineTo(camX + VIEW_W + 30, ry + ROAD.half);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------- beach, water */

  function drawCoast(state, camX, camY) {
    const night = state.night;
    const t = state.time;
    if (camY + VIEW_H < BEACH.top - 60) return;
    // Sand.
    const sandTop = BEACH.top;
    ctx.fillStyle = mix(PALETTE.sand, '#5d5470', night * 0.8);
    ctx.fillRect(Math.max(0, camX - 60), sandTop, Math.min(WORLD.width, VIEW_W + 160), BEACH.water - sandTop + 6);
    // Wet sand band at the waterline.
    ctx.fillStyle = mix('#a58d5e', '#4c4a66', night * 0.85);
    ctx.fillRect(Math.max(0, camX - 60), BEACH.water - 22, Math.min(WORLD.width, VIEW_W + 160), 24);
    // Sea.
    const sea = vgradient(0, BEACH.water, 1, WORLD.height - BEACH.water, [
      [0, mix('#2c6f85', '#101c33', night * 0.9)],
      [0.25, mix(PALETTE.water, '#0a1424', night * 0.9)],
      [1, mix(PALETTE.waterDeep, '#050a14', night * 0.9)],
    ]);
    ctx.fillStyle = sea;
    ctx.fillRect(0, BEACH.water, WORLD.width, WORLD.height - BEACH.water);
    // Surf: a few slow scrolling foam lines.
    ctx.strokeStyle = `rgba(226,240,255,${0.34 - night * 0.16})`;
    ctx.lineWidth = 3;
    for (let i = 0; i < 3; i += 1) {
      const y = BEACH.water + 8 + i * 16 + Math.sin(t * 0.9 + i) * 4;
      if (y < camY - 20 || y > camY + VIEW_H + 20) continue;
      ctx.beginPath();
      for (let x = Math.max(0, camX - 40); x < Math.min(WORLD.width, camX + VIEW_W + 40); x += 26) {
        const yy = y + Math.sin(x * 0.014 + t * 1.7 + i * 2) * 3.4;
        if (x === Math.max(0, camX - 40)) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.globalAlpha = 0.7 - i * 0.18;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Glitter on the water at night.
    if (night > 0.25) {
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 26; i += 1) {
        const x = ((i * 977) % WORLD.width);
        const y = BEACH.water + 30 + ((i * 613) % (WORLD.height - BEACH.water - 60));
        if (!visible(x, y, 6, 6, camX, camY, 20)) continue;
        const wob = Math.sin(t * 2 + i) * 0.5 + 0.5;
        ctx.fillStyle = `rgba(120,200,255,${0.05 + wob * 0.09})`;
        ctx.fillRect(x, y, 22, 2);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // A pier out over the water.
    const pierX = 2180;
    if (visible(pierX, BEACH.water - 40, 96, 210, camX, camY, 60)) {
      ctx.fillStyle = mix('#6b5a45', '#2a2536', night * 0.8);
      ctx.fillRect(pierX, BEACH.water - 26, 92, 200);
      ctx.fillStyle = mix('#54462f', '#1d1a29', night * 0.8);
      for (let i = 0; i < 12; i += 1) ctx.fillRect(pierX, BEACH.water - 26 + i * 17, 92, 2);
      ctx.fillStyle = mix('#3f4a55', '#1a1e2b', night * 0.8);
      for (let i = 0; i < 5; i += 1) {
        ctx.fillRect(pierX + 4, BEACH.water + 12 + i * 40, 8, 8);
        ctx.fillRect(pierX + 80, BEACH.water + 12 + i * 40, 8, 8);
      }
      if (night > 0.2) {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 4; i += 1) {
          const lx = pierX + (i % 2 === 0 ? 10 : 82);
          const ly = BEACH.water + 20 + Math.floor(i / 2) * 90;
          ctx.fillStyle = radial(lx, ly, 74, [[0, `rgba(255,214,140,${0.2 * night})`], [1, 'rgba(255,214,140,0)']]);
          ctx.fillRect(lx - 74, ly - 74, 148, 148);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  function drawParks(state, camX, camY) {
    const night = state.night;
    for (let i = 0; i < city.parks.length; i += 1) {
      const park = city.parks[i];
      if (!visible(park.x, park.y, park.w, park.h, camX, camY, 60)) continue;
      ctx.fillStyle = mix(PALETTE.grass, '#1a2b28', night * 0.7);
      circleRectFill(park.x + 4, park.y + 4, park.w - 8, park.h - 8, 6);
      ctx.fillStyle = mix('#3d5b44', '#1d3129', night * 0.7);
      ctx.globalAlpha = 0.5;
      for (let g = 0; g < 6; g += 1) {
        const gx = park.x + 20 + ((g * 97) % Math.max(20, park.w - 40));
        const gy = park.y + 20 + ((g * 61) % Math.max(20, park.h - 40));
        ctx.beginPath();
        ctx.arc(gx, gy, 12 + (g % 3) * 6, 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // A low hedge around it.
      ctx.strokeStyle = mix('#4c6b4a', '#22362c', night * 0.7);
      ctx.lineWidth = 5;
      roundRect(park.x + 3, park.y + 3, park.w - 6, park.h - 6, 7);
      ctx.stroke();
    }
  }

  function circleRectFill(x, y, w, h, r) {
    roundRect(x, y, w, h, r);
    ctx.fill();
  }

  /* -------------------------------------------------------------- buildings */

  function drawBuilding(b, camX, camY, night) {
    if (!visible(b.x, b.y, b.w, b.h, camX, camY, 90)) return;
    // Height is faked by lifting the roof away from the footprint toward the north-west; the
    // uncovered L between roof and footprint is the south and east wall, drawn as a facade.
    const lift = clamp(b.floors * 3.8, 12, 30);
    const dx = -lift * 0.56;
    const dy = -lift;
    const base = b.color;

    // Cast shadow to the south-east, the same light the palms obey.
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    roundRect(b.x + lift * 0.5, b.y + lift * 0.72, b.w, b.h, 4);
    ctx.fill();

    // The footprint block: the wall mass, darkest where the shadowed face is.
    ctx.fillStyle = shade(base, 0.5);
    roundRect(b.x, b.y, b.w, b.h, 2);
    ctx.fill();

    const rx = b.x + dx;
    const ry = b.y + dy;
    // South wall between the lifted roof's bottom edge and the footprint's bottom edge.
    const wallTop = ry + b.h;
    const wallBottom = b.y + b.h;
    if (wallBottom - wallTop > 2) {
      const fg = vgradient(0, wallTop, 1, wallBottom - wallTop, [
        [0, shade(base, 0.82)],
        [1, shade(base, 0.46)],
      ]);
      ctx.fillStyle = fg;
      ctx.fillRect(b.x, wallTop, b.w, wallBottom - wallTop);
      // Shopfronts and windows down the south face.
      const cols = Math.max(2, Math.round(b.w / 17));
      const step = b.w / cols;
      const rows = Math.max(1, Math.round((wallBottom - wallTop) / 9));
      for (let r = 0; r < rows; r += 1) {
        const rowTop = wallTop + 4 + r * ((wallBottom - wallTop - 6) / rows);
        for (let c = 0; c < cols; c += 1) {
          const lit = windowLit(b, c, r + 3, night);
          const wx = b.x + c * step + step * 0.2;
          const ww = step * 0.6;
          const wh = Math.min(5, (wallBottom - wallTop - 6) / rows - 1.5);
          if (wh < 1) continue;
          ctx.fillStyle = lit ? rgba('#ffd98c', 0.9) : shade(base, 0.34);
          ctx.fillRect(wx, rowTop, ww, wh);
          if (r === rows - 1 && night > 0.25) {
            // Ground-floor shop glow.
            ctx.fillStyle = rgba(lit ? '#ffe0a0' : '#66d9ff', lit ? 0.10 : 0.06);
            ctx.fillRect(wx - 1, rowTop - 1, ww + 2, wh + 3);
          }
        }
      }
    }
    // East wall between the roof's right edge and the footprint's right edge.
    const eastX = rx + b.w;
    const eastW = b.x + b.w - eastX;
    if (eastW > 2) {
      const eg = hgradient(eastX, 0, eastW, 1, [
        [0, shade(base, 0.72)],
        [1, shade(base, 0.4)],
      ]);
      ctx.fillStyle = eg;
      ctx.fillRect(eastX, ry, eastW, b.h);
      const rows = Math.max(1, Math.round(b.h / 16));
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < 2; c += 1) {
          const lit = windowLit(b, c + 11, r + 9, night);
          ctx.fillStyle = lit ? rgba('#ffd98c', 0.62) : shade(base, 0.3);
          ctx.fillRect(eastX + 2 + c * (eastW - 3) * 0.55, ry + 6 + r * (b.h / rows), Math.min(3.4, eastW * 0.4), Math.min(6, b.h / rows - 4));
        }
      }
    }

    // The roof slab itself, with a lit parapet edge.
    ctx.fillStyle = shade(base, b.shade);
    roundRect(rx, ry, b.w, b.h, 2.5);
    ctx.fill();
    ctx.strokeStyle = shade(base, 1.62, 0.55);
    ctx.lineWidth = 1.6;
    ctx.strokeRect(rx + 0.8, ry + 0.8, b.w - 1.6, b.h - 1.6);

    drawRoof(b, rx, ry, night);

    if (b.neon && night > 0.1) drawNeonSign(b, rx, ry + b.h, night);
  }

  function drawRoof(b, rx, ry, night) {
    const dark = shade(b.color, 0.8);
    const inset = 5;
    ctx.strokeStyle = shade(b.color, 1.24, 0.7);
    ctx.lineWidth = 1;
    ctx.strokeRect(rx + inset + 0.5, ry + inset + 0.5, b.w - inset * 2, b.h - inset * 2);
    if (b.roof === 'ac') {
      const n = 2 + (b.seed % 3);
      for (let i = 0; i < n; i += 1) {
        const px = rx + inset + 6 + ((b.seed + i * 37) % Math.max(8, b.w - 30));
        const py = ry + inset + 6 + ((b.seed + i * 61) % Math.max(8, b.h - 30));
        ctx.fillStyle = shade(b.color, 0.62);
        ctx.fillRect(px, py, 12, 9);
        ctx.fillStyle = shade(b.color, 1.35, 0.5);
        ctx.fillRect(px + 2, py + 2, 8, 5);
      }
    } else if (b.roof === 'tank') {
      const cx = rx + b.w * 0.62;
      const cy = ry + b.h * 0.4;
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(cx + 4, cy + 5, 12, 11, 0, 0, TAU);
      ctx.fill();
      ctx.fillStyle = '#6a5844';
      ctx.fillRect(cx - 10, cy - 4, 3, 12);
      ctx.fillRect(cx + 8, cy - 4, 3, 12);
      ctx.fillStyle = '#8a7358';
      ctx.beginPath();
      ctx.arc(cx, cy - 2, 10, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy - 2, 6, 0, TAU);
      ctx.stroke();
    } else if (b.roof === 'helipad') {
      const cx = rx + b.w / 2;
      const cy = ry + b.h / 2;
      const r = Math.min(b.w, b.h) * 0.3;
      ctx.fillStyle = shade(b.color, 0.72);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(240,240,225,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 2, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = 'rgba(240,240,225,0.55)';
      ctx.font = font(Math.max(9, r), 800, FONT_DISPLAY);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('H', cx, cy + 1);
      ctx.textBaseline = 'alphabetic';
    } else {
      // Plain roof: a vent and a service hatch.
      ctx.fillStyle = shade(b.color, 0.68);
      ctx.fillRect(rx + 10, ry + 10, 9, 7);
      ctx.fillRect(rx + b.w - 22, ry + b.h - 20, 12, 10);
    }
    if (b.terrace) {
      ctx.fillStyle = 'rgba(90,140,96,0.55)';
      for (let i = 0; i < 3; i += 1) {
        ctx.beginPath();
        ctx.arc(rx + 12 + i * 9, ry + b.h - 14, 4, 0, TAU);
        ctx.fill();
      }
    }
    void dark;
  }

  function drawNeonSign(b, rx, facadeY, night) {
    const w = Math.min(b.w * 0.7, 74);
    const x = rx + (b.w - w) / 2;
    const y = facadeY - 9;
    if (y < -20) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = radial(x + w / 2, y + 3, w * 0.7, [
      [0, rgba(b.neonColor, 0.34 * night)],
      [1, rgba(b.neonColor, 0)],
    ]);
    ctx.fillRect(x - w * 0.7, y - w * 0.7, w * 2, w * 1.5);
    ctx.fillStyle = rgba(b.neonColor, 0.9);
    roundRect(x, y, w, 4, 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ------------------------------------------------------------------ props */

  function drawProp(p, camX, camY, night, t) {
    if (!visible(p.x - 30, p.y - 40, 60, 80, camX, camY, 40)) return;
    switch (p.type) {
      case 'palm': {
        const sway = Math.sin(t * 0.9 + p.sway) * 2.2;
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath();
        ctx.ellipse(p.x + 7, p.y + 8, 15, 8, 0.4, 0, TAU);
        ctx.fill();
        // Trunk, seen from above leaning away from the crown.
        ctx.strokeStyle = '#6d5233';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(p.x + 5, p.y + 6);
        ctx.quadraticCurveTo(p.x + sway, p.y - 6, p.x + sway * 2, p.y - 12);
        ctx.stroke();
        // Fronds.
        for (let i = 0; i < 7; i += 1) {
          const a = (i / 7) * TAU + p.sway * 0.3;
          const len = 15 + (i % 2) * 4;
          const tipX = p.x + sway * 2 + Math.cos(a) * len;
          const tipY = p.y - 12 + Math.sin(a) * len * 0.8;
          ctx.strokeStyle = i % 2 === 0 ? '#2f6a44' : '#3b7d4f';
          ctx.lineWidth = 3.4;
          ctx.beginPath();
          ctx.moveTo(p.x + sway * 2, p.y - 12);
          ctx.quadraticCurveTo(p.x + sway + Math.cos(a) * len * 0.5, p.y - 18 + Math.sin(a) * len * 0.4, tipX, tipY);
          ctx.stroke();
        }
        ctx.fillStyle = '#2b5c3c';
        ctx.beginPath();
        ctx.arc(p.x + sway * 2, p.y - 12, 4, 0, TAU);
        ctx.fill();
        break;
      }
      case 'lamp': {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.arc(p.x + 3, p.y + 4, 6, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#2a2f3c';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4.4, 0, TAU);
        ctx.fill();
        ctx.fillStyle = night > 0.15 ? '#ffe4a8' : '#7c8494';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 2, 0, TAU);
        ctx.fill();
        break;
      }
      case 'crate': {
        const hw = p.w / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.24)';
        ctx.fillRect(p.x - hw + 4, p.y - hw + 5, p.w, p.w);
        ctx.fillStyle = p.tone;
        ctx.fillRect(p.x - hw, p.y - hw, p.w, p.w);
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1.6;
        ctx.strokeRect(p.x - hw + 0.8, p.y - hw + 0.8, p.w - 1.6, p.w - 1.6);
        ctx.beginPath();
        ctx.moveTo(p.x - hw, p.y - hw);
        ctx.lineTo(p.x + hw, p.y + hw);
        ctx.moveTo(p.x + hw, p.y - hw);
        ctx.lineTo(p.x - hw, p.y + hw);
        ctx.stroke();
        break;
      }
      case 'barrier': {
        const hw = p.w / 2;
        const hh = p.h / 2;
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(p.x - hw + 3, p.y - hh + 4, p.w, p.h);
        ctx.fillStyle = p.tone;
        ctx.fillRect(p.x - hw, p.y - hh, p.w, p.h);
        ctx.fillStyle = '#f0e8da';
        for (let i = 0; i < 4; i += 1) ctx.fillRect(p.x - hw + 3 + i * 10, p.y - hh + 2, 5, p.h - 4);
        break;
      }
      case 'bench': {
        const rot = p.rot ?? 0;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(rot);
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(-9, -2, 20, 7);
        ctx.fillStyle = '#6b5334';
        ctx.fillRect(-10, -4, 20, 5);
        ctx.fillStyle = '#54402a';
        ctx.fillRect(-10, 1, 20, 2);
        ctx.restore();
        break;
      }
      case 'hydrant': {
        ctx.fillStyle = '#b6442f';
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#8d3323';
        ctx.fillRect(p.x - 5, p.y - 1.5, 10, 3);
        break;
      }
      default:
        break;
    }
  }

  /* -------------------------------------------------------------- vehicles */

  function drawCar(car, night, t, isPlayer) {
    const w = car.w;
    const h = car.h;
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    // Shadow.
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    roundRect(-w / 2 + 3, -h / 2 + 4, w, h, 5);
    ctx.fill();

    const body = car.wrecked ? '#3a3630' : car.color;
    // Headlight beams before the body so they read under it.
    if (night > 0.12 && car.lightsOn && !car.wrecked) {
      ctx.globalCompositeOperation = 'lighter';
      const beam = 118;
      for (const side of [-1, 1]) {
        const g = ctx.createLinearGradient(w / 2, 0, w / 2 + beam, 0);
        g.addColorStop(0, `rgba(255,240,200,${0.16 * night})`);
        g.addColorStop(1, 'rgba(255,240,200,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(w / 2 - 2, side * 3);
        ctx.lineTo(w / 2 + beam, side * 26);
        ctx.lineTo(w / 2 + beam, side * 8);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    // Wheels.
    ctx.fillStyle = '#16171c';
    const wheelW = Math.max(6, w * 0.16);
    const wheelH = 4.5;
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        ctx.fillRect(sx * (w * 0.3) - wheelW / 2, sy * (h / 2) - (sy > 0 ? 0 : wheelH), wheelW, wheelH);
      }
    }
    // Body: a rounded hull with a tapered nose.
    ctx.fillStyle = body;
    roundRect(-w / 2, -h / 2, w, h, Math.min(7, h * 0.34));
    ctx.fill();
    // Roof and glass.
    const cabInset = car.type === 'truck' ? w * 0.06 : w * 0.19;
    ctx.fillStyle = shade(body, 0.82);
    roundRect(-w / 2 + cabInset, -h / 2 + 3, w - cabInset * 2, h - 6, 4);
    ctx.fill();
    ctx.fillStyle = night > 0.3 ? '#16212f' : '#22303f';
    roundRect(-w / 2 + cabInset + 5, -h / 2 + 4, Math.max(7, w * 0.24), h - 8, 3);
    ctx.fill();
    roundRect(w / 2 - cabInset - 6 - Math.max(4, w * 0.1), -h / 2 + 4, Math.max(4, w * 0.1), h - 8, 2);
    ctx.fill();
    // Bonnet line and highlights.
    ctx.strokeStyle = shade(body, 1.35, 0.5);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(w / 2 - 2, -h / 2 + 3);
    ctx.lineTo(w / 2 - 2, h / 2 - 3);
    ctx.stroke();
    // Lights.
    ctx.fillStyle = car.wrecked ? '#54443a' : night > 0.2 ? '#fff3cf' : '#e8e6d3';
    ctx.fillRect(w / 2 - 2.5, -h / 2 + 2.5, 3, 3.5);
    ctx.fillRect(w / 2 - 2.5, h / 2 - 6, 3, 3.5);
    ctx.fillStyle = car.braking ? '#ff4d4d' : '#a63030';
    ctx.fillRect(-w / 2 - 0.5, -h / 2 + 2.5, 2.5, 3.5);
    ctx.fillRect(-w / 2 - 0.5, h / 2 - 6, 2.5, 3.5);

    if (car.driver === 'police' && !car.wrecked) drawPoliceLivery(h, t);

    if (car.type === 'truck') {
      ctx.fillStyle = shade(body, 0.9);
      ctx.fillRect(-w * 0.12, -h / 2 + 3, w * 0.3, h - 6);
    }

    // Damage: scratches and panel dents.
    if (!car.wrecked && car.health < car.maxHealth * 0.6) {
      ctx.strokeStyle = 'rgba(20,20,22,0.55)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(w * 0.1, -h / 2 + 2);
      ctx.lineTo(w * 0.02, h / 2 - 4);
      ctx.moveTo(-w * 0.24, -h / 2 + 5);
      ctx.lineTo(-w * 0.34, h / 2 - 5);
      ctx.stroke();
    }
    if (car.wrecked) {
      ctx.fillStyle = 'rgba(12,10,10,0.6)';
      roundRect(-w / 2 + 2, -h / 2 + 2, w - 4, h - 4, 4);
      ctx.fill();
    }
    ctx.restore();

    if (isPlayer) {
      // An unmistakable marker under the player's own car: a bright double ring and a nose tick.
      const pulse = 0.55 + Math.sin(t * 4) * 0.2;
      ctx.strokeStyle = `rgba(120,225,255,${pulse})`;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.ellipse(car.x, car.y, w * 0.78, h * 1.05, car.angle, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.30)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(car.x, car.y, w * 0.9, h * 1.22, car.angle, 0, TAU);
      ctx.stroke();
      // A nose chevron pointing the way the car faces.
      const nx = car.x + Math.cos(car.angle) * (w * 0.62 + 6);
      const ny = car.y + Math.sin(car.angle) * (w * 0.62 + 6);
      ctx.save();
      ctx.translate(nx, ny);
      ctx.rotate(car.angle);
      ctx.fillStyle = 'rgba(150,235,255,0.9)';
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-3, 5.5);
      ctx.lineTo(-3, -5.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /** The police livery, drawn inside the car's own rotated context: bold enough to read at 50 px. */
  function drawPoliceLivery(h, t) {
    const phase = Math.floor(t * 9) % 2 === 0;
    // Black bonnet and boot, white flanks, a wide blue band across the doors.
    ctx.fillStyle = '#14171f';
    ctx.fillRect(-26, -h / 2, 10, h);
    ctx.fillRect(18, -h / 2, 8, h);
    ctx.fillStyle = '#16337f';
    ctx.fillRect(-16, -h / 2, 32, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(-16, -h / 2, 32, 3.2);
    ctx.fillRect(-16, h / 2 - 3.2, 32, 3.2);
    // The light bar: a chunky block spanning most of the roof.
    ctx.fillStyle = '#0d1017';
    roundRect(-9, -h * 0.5, 18, h, 2.6);
    ctx.fill();
    ctx.fillStyle = phase ? '#ff2130' : '#5c1116';
    roundRect(-7.5, -h * 0.44, 8, h * 0.42, 1.6);
    ctx.fill();
    ctx.fillStyle = phase ? '#1236a8' : '#2f6bff';
    roundRect(-0.5 + 0.5, -h * 0.44, 8, h * 0.42, 1.6);
    ctx.fill();
    ctx.fillStyle = phase ? '#1236a8' : '#ff2130';
    roundRect(-7.5, h * 0.02, 8, h * 0.42, 1.6);
    ctx.fill();
    ctx.fillStyle = phase ? '#ff2130' : '#2f6bff';
    roundRect(-0.5 + 0.5, h * 0.02, 8, h * 0.42, 1.6);
    ctx.fill();
  }

  /** The strobe: a big pulsing halo plus a sweeping beacon cone, drawn in world space. */
  function drawPoliceGlow(car, t) {
    const phase = Math.floor(t * 9) % 2 === 0;
    const color = car.siren ? (phase ? '#ff2b3d' : '#2f6bff') : '#8892a6';
    const pulse = car.siren ? 0.75 + Math.sin(t * 18) * 0.25 : 0.3;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = radial(car.x, car.y, 150, [
      [0, rgba(color, 0.78 * pulse)],
      [0.3, rgba(color, 0.34 * pulse)],
      [1, rgba(color, 0)],
    ]);
    ctx.fillRect(car.x - 132, car.y - 132, 264, 264);
    // A sweeping beam, the thing the eye catches first in a chase.
    if (car.siren) {
      const sweep = t * 3.1 + car.id;
      ctx.save();
      ctx.translate(car.x, car.y);
      ctx.rotate(sweep);
      const beam = ctx.createLinearGradient(0, 0, 150, 0);
      beam.addColorStop(0, rgba(color, 0.5 * pulse));
      beam.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = beam;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(150, -34);
      ctx.lineTo(150, 34);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* --------------------------------------------------------------- people */

  function drawPerson(x, y, angle, phase, moving, colors, options) {
    const scale = options?.scale ?? 1;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(2, 3 * scale, 8 * scale, 4 * scale, 0, 0, TAU);
    ctx.fill();
    ctx.rotate(angle + Math.PI / 2);
    const swing = moving ? Math.sin(phase) : 0;
    // Legs.
    ctx.strokeStyle = colors.legs ?? '#2b3340';
    ctx.lineWidth = 3.4 * scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-2.6 * scale, 1 * scale);
    ctx.lineTo(-2.6 * scale - swing * 1.6 * scale, 7 * scale);
    ctx.moveTo(2.6 * scale, 1 * scale);
    ctx.lineTo(2.6 * scale + swing * 1.6 * scale, 7 * scale);
    ctx.stroke();
    // Torso.
    ctx.fillStyle = colors.shirt ?? '#c76b6b';
    roundRect(-4.4 * scale, -4.6 * scale, 8.8 * scale, 7.6 * scale, 3 * scale);
    ctx.fill();
    // Arms.
    ctx.strokeStyle = colors.skin ?? '#d9a066';
    ctx.lineWidth = 2.4 * scale;
    ctx.beginPath();
    ctx.moveTo(-4 * scale, -2 * scale);
    ctx.lineTo(-5.4 * scale - swing * 1.2 * scale, 2.4 * scale);
    ctx.moveTo(4 * scale, -2 * scale);
    ctx.lineTo(5.4 * scale + swing * 1.2 * scale, 2.4 * scale);
    ctx.stroke();
    // Head.
    ctx.fillStyle = colors.skin ?? '#d9a066';
    ctx.beginPath();
    ctx.arc(0, -6 * scale, 3.6 * scale, 0, TAU);
    ctx.fill();
    ctx.fillStyle = colors.hair ?? '#2a2320';
    ctx.beginPath();
    ctx.arc(0, -7 * scale, 3.4 * scale, Math.PI, TAU);
    ctx.fill();
    ctx.restore();
  }

  function drawPlayer(state, t) {
    const p = state.player;
    if (p.onFoot) {
      const hurt = p.hitFlash;
      drawPerson(p.x, p.y, p.angle, p.walkPhase, p.moving, {
        shirt: hurt > 0.2 ? '#ff5d6c' : '#e8eef6',
        legs: '#26303d',
        skin: '#e0ab7f',
        hair: '#20242c',
      }, { scale: 1.1 });
      // The player's own marker: a soft chevron in front.
      ctx.strokeStyle = 'rgba(120,220,255,0.55)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 15, p.angle - 0.5, p.angle + 0.5);
      ctx.stroke();
    } else if (p.car) {
      // Handled by the car pass; a small glow marks the player's ride.
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = radial(p.car.x, p.car.y, 30, [[0, 'rgba(120,200,255,0.10)'], [1, 'rgba(120,200,255,0)']]);
      ctx.fillRect(p.car.x - 30, p.car.y - 30, 60, 60);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function drawPed(ped, night, camX, camY) {
    if (!ped.alive) {
      if (ped.fade === undefined || ped.fade <= 0) return;
      ctx.fillStyle = 'rgba(90,50,50,0.5)';
      ctx.beginPath();
      ctx.ellipse(ped.x, ped.y, 9, 5, 0, 0, TAU);
      ctx.fill();
      return;
    }
    if (!visible(ped.x - 12, ped.y - 12, 24, 24, camX, camY, 30)) return;
    drawPerson(ped.x, ped.y, ped.angle, ped.phase, true, {
      shirt: ped.shirt,
      legs: '#2a3140',
      skin: ped.color,
      hair: '#231d1c',
    }, { scale: 0.86 });
    void night;
  }

  /* ---------------------------------------------------------- world assembly */

  function drawWorld(state) {
    const t = state.time;
    const night = state.night;
    const shake = state.camera.shake;
    const camX = Math.round(clamp(state.camera.x, 0, WORLD.width - VIEW_W));
    const camY = Math.round(clamp(state.camera.y, 0, WORLD.height - VIEW_H));
    state.camX = camX;
    state.camY = camY;
    // Shake is a function of the clock, not of Math.random: a frozen scene must not jitter
    // between reloads, and the seeded simulation should stay the only source of variation.
    const sx = shake > 0 ? Math.sin(t * 61.7) * shake * 0.6 : 0;
    const sy = shake > 0 ? Math.cos(t * 47.3) * shake * 0.6 : 0;

    ctx.save();
    ctx.translate(-camX + sx, -camY + sy);

    drawGround(state, camX, camY);
    drawCoast(state, camX, camY);
    drawParks(state, camX, camY);

    // Props under the buildings read as street furniture.
    for (let i = 0; i < city.props.length; i += 1) {
      const p = city.props[i];
      if (p.type === 'lamp' || p.type === 'hydrant' || p.type === 'bench') drawProp(p, camX, camY, night, t);
    }

    const buildings = city.buildings;
    for (let i = 0; i < buildings.length; i += 1) drawBuilding(buildings[i], camX, camY, night);

    for (let i = 0; i < city.props.length; i += 1) {
      const p = city.props[i];
      if (p.type === 'palm' || p.type === 'crate' || p.type === 'barrier') drawProp(p, camX, camY, night, t);
    }

    // Cars: the player's is drawn last so it sits on top.
    for (let i = 0; i < state.cars.length; i += 1) {
      const car = state.cars[i];
      if (car === state.player.car) continue;
      drawCar(car, night, t, false);
      if (car.smoke > 0.55 && Math.sin(t * 2.3 + car.id) > 0.86) drawSmokeWisp(car, t);
    }
    for (let i = 0; i < state.police.length; i += 1) {
      const car = state.police[i].car;
      drawCar(car, night, t, false);
    }
    if (state.player.car) drawCar(state.player.car, night, t, true);

    for (let i = 0; i < state.peds.length; i += 1) drawPed(state.peds[i], night, camX, camY);

    drawJobWorldMarkers(state, t);

    if (state.player.onFoot) drawPlayer(state, t);
    else drawPlayer(state, t);

    drawEffects(state);

    ctx.restore();

    // Vignette and the night tint sit over the world but under the HUD.
    drawNightPass(state, camX, camY);

    // Strobe lights go over the night tint: emergency lighting cuts through the dark.
    ctx.save();
    ctx.translate(-camX + sx, -camY + sy);
    for (let i = 0; i < state.police.length; i += 1) {
      const car = state.police[i].car;
      if (!car.wrecked && visible(car.x - 140, car.y - 140, 280, 280, camX, camY, 160)) drawPoliceGlow(car, t);
    }
    ctx.restore();
  }

  function drawSmokeWisp(car, t) {
    ctx.fillStyle = `rgba(120,120,128,${0.16 + Math.sin(t * 3 + car.id) * 0.05})`;
    ctx.beginPath();
    ctx.arc(car.x - Math.cos(car.angle) * car.w * 0.4, car.y - Math.sin(car.angle) * car.w * 0.4, 7 + Math.sin(t * 2 + car.id) * 2, 0, TAU);
    ctx.fill();
  }

  function drawEffects(state) {
    for (let i = 0; i < state.effects.length; i += 1) {
      const e = state.effects[i];
      const alpha = clamp(e.life / e.max, 0, 1);
      if (e.kind === 'spark') {
        ctx.fillStyle = rgba(e.color, alpha);
        ctx.fillRect(e.x - e.size / 2, e.y - e.size / 2, e.size, e.size);
      } else {
        ctx.fillStyle = rgba(e.color, alpha * 0.34);
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.size, 0, TAU);
        ctx.fill();
      }
    }
    ctx.textAlign = 'center';
    for (let i = 0; i < state.floaters.length; i += 1) {
      const f = state.floaters[i];
      const alpha = clamp(f.life / f.max, 0, 1);
      ctx.font = font(13, 800, FONT_DISPLAY);
      const w = ctx.measureText(f.text).width + 18;
      ctx.fillStyle = `rgba(6,10,18,${alpha * 0.78})`;
      roundRect(f.x - w / 2, f.y - 14, w, 20, 4);
      ctx.fill();
      ctx.fillStyle = rgba(f.color, alpha);
      ctx.fillText(f.text, f.x, f.y);
    }
  }

  /** Night: a blue tint that grows with the clock, plus every light source added on top. */
  function drawNightPass(state, camX, camY) {
    const night = state.night;
    if (night > 0.02) {
      ctx.fillStyle = `rgba(8,12,34,${night * 0.34})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalCompositeOperation = 'lighter';
      // Street lamps cast pools of sodium light.
      for (let i = 0; i < city.lamps.length; i += 1) {
        const lamp = city.lamps[i];
        if (!visible(lamp.x - 80, lamp.y - 80, 160, 160, camX, camY, 90)) continue;
        ctx.fillStyle = radial(lamp.x, lamp.y, 78, [
          [0, `rgba(255,198,110,${0.19 * night})`],
          [1, 'rgba(255,198,110,0)'],
        ]);
        ctx.fillRect(lamp.x - 78, lamp.y - 78, 156, 156);
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    // Sunset warmth when the clock is between day and night.
    const dusk = night > 0 && night < 0.55 ? Math.sin((night / 0.55) * Math.PI) : 0;
    if (dusk > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
      g.addColorStop(0, `rgba(255,120,60,${0.09 * dusk})`);
      g.addColorStop(1, `rgba(90,40,140,${0.07 * dusk})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.globalCompositeOperation = 'source-over';
    }
    // Vignette.
    const v = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.34, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.86);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, `rgba(0,0,0,${0.38 + night * 0.2})`);
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  /* --------------------------------------------------------- job markers */

  function drawJobWorldMarkers(state, t) {
    const job = state.job;
    if (!job) return;
    const pulse = 0.5 + Math.sin(t * 3) * 0.5;
    const drawBeam = (x, y, color, label, small) => {
      if (!visible(x - 60, y - 160, 120, 200, state.camX, state.camY, 120)) return;
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(x, y - 120, x, y);
      g.addColorStop(0, rgba(color, 0));
      g.addColorStop(0.65, rgba(color, 0.16 + pulse * 0.1));
      g.addColorStop(1, rgba(color, 0.4));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 130);
      ctx.lineTo(x + 4, y - 130);
      ctx.lineTo(x + 18, y);
      ctx.lineTo(x - 18, y);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = radial(x, y, 34, [[0, rgba(color, 0.45)], [1, rgba(color, 0)]]);
      ctx.fillRect(x - 34, y - 34, 68, 68);
      ctx.strokeStyle = rgba(color, 0.7 + pulse * 0.3);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y, 16 + pulse * 3, 9 + pulse * 2, 0, 0, TAU);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, y - 26 - pulse * 4);
      ctx.lineTo(x + 7, y - 15 - pulse * 4);
      ctx.lineTo(x - 7, y - 15 - pulse * 4);
      ctx.closePath();
      ctx.fill();
      if (label) {
        ctx.textAlign = 'center';
        ctx.font = font(small ? 10 : 12, 800, FONT_DISPLAY);
        ctx.fillStyle = 'rgba(6,10,18,0.82)';
        roundRect(x - (small ? 30 : 38), y - 48 - pulse * 4, small ? 60 : 76, 16, 5);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillText(label, x, y - 36 - pulse * 4);
      }
    };

    if (job.type === JOB_DROPS) {
      for (let i = 0; i < job.points.length; i += 1) {
        const p = job.points[i];
        if (p.taken) continue;
        drawBeam(p.x, p.y, '#ffd166', 'CASH', true);
      }
    } else if (job.type === JOB_CHECKPOINTS) {
      for (let i = job.stage; i < job.points.length; i += 1) {
        const p = job.points[i];
        const colour = i === job.stage ? '#33e1ff' : '#2a6f86';
        drawBeam(p.x, p.y, colour, i === job.stage ? 'CHECKPOINT' : String(i + 1), i !== job.stage);
        if (i > job.stage + 1) break;
      }
    } else if (job.type === JOB_DELIVERY) {
      const target = job.points[job.stage];
      if (target) drawBeam(target.x, target.y, job.stage === 0 ? '#57ff9a' : '#ff3d7f', job.stage === 0 ? 'PICKUP' : 'DROP');
    }
  }

  /* ------------------------------------------------------------------- HUD */

  function formatClock(minutes) {
    const total = Math.floor(minutes) % (24 * 60);
    const h = Math.floor(total / 60);
    const m = total % 60;
    return `${h}:${m < 10 ? '0' : ''}${m}`;
  }

  function formatMoney(value) {
    return '$' + Math.floor(value).toLocaleString('en-US');
  }

  function formatShift(seconds) {
    const s = Math.max(0, Math.ceil(seconds));
    return `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
  }

  function star(ctxPath, cx, cy, r, filled, pulse) {
    ctxPath.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const angle = -Math.PI / 2 + (i * Math.PI) / 5;
      const radius = i % 2 === 0 ? r : r * 0.44;
      const px = cx + Math.cos(angle) * radius;
      const py = cy + Math.sin(angle) * radius;
      if (i === 0) ctxPath.moveTo(px, py);
      else ctxPath.lineTo(px, py);
    }
    ctxPath.closePath();
    if (filled) {
      ctxPath.fillStyle = pulse ? '#ffdf8a' : PALETTE.gold;
      ctxPath.fill();
    } else {
      ctxPath.strokeStyle = 'rgba(230,235,250,0.22)';
      ctxPath.lineWidth = 1.6;
      ctxPath.stroke();
    }
  }

  function drawWanted(state, x, y) {
    const heat = state.heat;
    const pulse = heat >= 4 && Math.sin(state.time * 8) > 0.2;
    for (let i = 0; i < MAX_HEAT; i += 1) {
      star(ctx, x + i * 25, y, 10, i < heat, pulse);
    }
    if (state.heat > 0 && state.unseen > 1.2) {
      const w = 118;
      const p = clamp(state.heatProgress / (7 * (state.player.car && state.player.car !== state.player.lastCar ? 0.55 : 1)), 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      roundRect(x, y + 13, w, 3, 1.5);
      ctx.fill();
      ctx.fillStyle = 'rgba(120,200,255,0.8)';
      roundRect(x, y + 13, w * p, 3, 1.5);
      ctx.fill();
    }
  }

  function drawHealth(state, x, y, w) {
    const hp = clamp(state.player.health / 100, 0, 1);
    ctx.fillStyle = 'rgba(10,14,22,0.72)';
    roundRect(x - 2, y - 2, w + 4, 12, 4);
    ctx.fill();
    const colour = hp > 0.55 ? '#57ff9a' : hp > 0.28 ? '#ffd166' : '#ff4d5e';
    ctx.fillStyle = colour;
    roundRect(x, y, Math.max(2, w * hp), 8, 3);
    ctx.fill();
    if (hp < 0.3) {
      ctx.globalAlpha = 0.35 + Math.sin(state.time * 9) * 0.3;
      ctx.fillStyle = '#ff4d5e';
      roundRect(x, y, Math.max(2, w * hp), 8, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function drawHud(state) {
    const cash = formatMoney(state.cash);
    const player = state.player;

    // Top-left cluster: money, score, wanted stars, health.
    panel(18, 16, 268, 132, 0.72, 'rgba(255,255,255,0.08)');
    text('VICE HARBOR', 32, 38, 12, PALETTE.muted, 'left', 800, FONT_DISPLAY);
    text(cash, 32, 70, 30, PALETTE.gold, 'left', 800, FONT_DISPLAY);
    text(`SCORE ${Math.floor(state.score)}`, 32, 92, 12, '#cbd4e6', 'left', 700, FONT_MONO);
    text('HP', 32, 104, 9, PALETTE.muted, 'left', 700, FONT_MONO);
    drawHealth(state, 56, 96, 190);
    text(`${Math.ceil(player.health)}`, 272, 104, 11, PALETTE.muted, 'right', 700, FONT_MONO);
    drawWanted(state, 32, 122);

    // Top-right: the shift clock and district. Countdown on the left, city clock right.
    const clockW = 234;
    panel(VIEW_W - clockW - 18, 16, clockW, 78, 0.72, 'rgba(255,255,255,0.08)');
    const shiftLow = state.shift < 45;
    text('SHIFT LEFT', VIEW_W - clockW - 2, 38, 9, PALETTE.muted, 'left', 700, FONT_MONO);
    text(formatShift(state.shift), VIEW_W - clockW - 2, 64, 27, shiftLow && Math.sin(state.time * 6) > 0 ? '#ff8a94' : '#f2f5ff', 'left', 800, FONT_DISPLAY);
    text('CITY TIME', VIEW_W - 34, 38, 9, PALETTE.muted, 'right', 700, FONT_MONO);
    text(formatClock(state.clock), VIEW_W - 34, 62, 18, '#bcd3ff', 'right', 700, FONT_MONO);
    const d = state.district;
    ctx.fillStyle = rgba(d.accent, 0.9);
    ctx.fillRect(VIEW_W - 214, 84, 3, 12);
    text(d.name.toUpperCase(), VIEW_W - 206, 94, 11, rgba(d.accent, 0.95), 'left', 800, FONT_DISPLAY);

    // Job card, under the clock.
    if (state.job) drawJobCard(state);

    // Driving: speed and the car's health.
    if (player.car) {
      const car = player.car;
      const speed = Math.round(Math.abs(car.speed) * 0.42);
      panel(VIEW_W / 2 - 92, VIEW_H - 92, 184, 74, 0.7, 'rgba(255,255,255,0.08)');
      text(String(speed), VIEW_W / 2 - 22, VIEW_H - 44, 34, '#f2f5ff', 'right', 800, FONT_DISPLAY);
      text('KM/H', VIEW_W / 2 - 14, VIEW_H - 46, 11, PALETTE.muted, 'left', 700);
      const hp = clamp(car.health / car.maxHealth, 0, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      roundRect(VIEW_W / 2 - 72, VIEW_H - 34, 144, 6, 3);
      ctx.fill();
      ctx.fillStyle = hp > 0.5 ? '#8fd7ff' : hp > 0.25 ? '#ffd166' : '#ff4d5e';
      roundRect(VIEW_W / 2 - 72, VIEW_H - 34, Math.max(3, 144 * hp), 6, 3);
      ctx.fill();
      text(car.wrecked ? 'WRECKED' : car.spec.label.toUpperCase(), VIEW_W / 2, VIEW_H - 62, 10, car.wrecked ? '#ff8a94' : PALETTE.muted, 'center', 800, FONT_DISPLAY);
      if (car.health < car.maxHealth * 0.35 && !car.wrecked && Math.sin(state.time * 7) > 0) {
        text('ENGINE TROUBLE', VIEW_W / 2, VIEW_H - 78, 10, '#ff8a94', 'center', 800, FONT_DISPLAY);
      }
    } else {
      // On foot: a hint about the nearest car, in its own small pill.
      panel(VIEW_W / 2 - 82, VIEW_H - 48, 164, 28, 0.6, 'rgba(255,255,255,0.08)');
      text('E   ENTER CAR', VIEW_W / 2, VIEW_H - 29, 11, 'rgba(230,238,250,0.72)', 'center', 800, FONT_DISPLAY);
    }

    drawMinimap(state);
    drawBanner(state);
    drawBusted(state);
    drawTicker(state);
  }

  function drawJobCard(state) {
    const job = state.job;
    const target = job.type === JOB_DROPS ? job.points.find((p) => !p.taken) : job.points[job.stage];
    const dist = target ? Math.round(distance(state.player.x, state.player.y, target.x, target.y) * 0.085) : 0;
    const x = VIEW_W - 234;
    const y = 104;
    panel(x, y, 216, 120, 0.76, rgba('#33e1ff', 0.35));
    text(job.label, x + 12, y + 20, 10, '#33e1ff', 'left', 800, FONT_DISPLAY);
    text(job.title, x + 12, y + 40, 15, '#f2f5ff', 'left', 800, FONT_DISPLAY);
    let objective = '';
    if (job.type === JOB_DELIVERY) objective = job.stage === 0 ? 'Pick up the package' : 'Deliver it across town';
    else if (job.type === JOB_CHECKPOINTS) objective = `Checkpoint ${job.stage + 1} of ${job.points.length}`;
    else objective = `${job.points.filter((p) => p.taken).length} of ${job.points.length} drops taken`;
    text(objective, x + 12, y + 60, 11, '#cbd4e6', 'left', 500);
    text(`${dist} m`, x + 204, y + 60, 11, PALETTE.gold, 'right', 800, FONT_MONO);
    // Job progress dots, then the clock bar (clearly labelled, so the two never get confused).
    if (job.type === JOB_DROPS) {
      for (let i = 0; i < job.points.length; i += 1) {
        ctx.fillStyle = job.points[i].taken ? '#57ff9a' : 'rgba(255,255,255,0.2)';
        ctx.beginPath();
        ctx.arc(x + 16 + i * 13, y + 74, 3.6, 0, TAU);
        ctx.fill();
      }
      text('DROPS', x + 204, y + 78, 8, PALETTE.muted, 'right', 700, FONT_MONO);
    } else {
      text('PROGRESS', x + 12, y + 75, 8, PALETTE.muted, 'left', 700, FONT_MONO);
      const total = job.type === JOB_DELIVERY ? 2 : job.points.length;
      for (let i = 0; i < total; i += 1) {
        ctx.fillStyle = i <= job.stage ? '#57ff9a' : 'rgba(255,255,255,0.2)';
        ctx.beginPath();
        ctx.arc(x + 74 + i * 13, y + 72, 3.6, 0, TAU);
        ctx.fill();
      }
    }
    const p = clamp(job.timer / job.limit, 0, 1);
    text('JOB CLOCK', x + 12, y + 96, 8, PALETTE.muted, 'left', 700, FONT_MONO);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    roundRect(x + 12, y + 102, 130, 5, 2.5);
    ctx.fill();
    ctx.fillStyle = p < 0.25 ? '#ff4d5e' : '#57ff9a';
    roundRect(x + 12, y + 102, Math.max(2, 130 * p), 5, 2.5);
    ctx.fill();
    text(formatShift(job.timer), x + 204, y + 108, 15, p < 0.25 ? '#ff8a94' : '#dfe8f7', 'right', 800, FONT_DISPLAY);
  }

  /* --------------------------------------------------------------- minimap */

  function drawMinimap(state) {
    const mw = MINIMAP.w;
    const mh = MINIMAP.h;
    const mx = MINIMAP.pad;
    const my = VIEW_H - mh - MINIMAP.pad;
    const sx = mw / WORLD.width;
    const sy = mh / WORLD.height;
    panel(mx - 3, my - 3, mw + 6, mh + 6, 0.82, 'rgba(255,255,255,0.12)');
    ctx.save();
    ctx.beginPath();
    ctx.rect(mx, my, mw, mh);
    ctx.clip();
    ctx.fillStyle = '#0b1120';
    ctx.fillRect(mx, my, mw, mh);
    // Roads.
    ctx.strokeStyle = 'rgba(190,205,232,0.6)';
    ctx.lineWidth = 2.4;
    for (const rx of ROAD_COLS) {
      ctx.beginPath();
      ctx.moveTo(mx + rx * sx, my);
      ctx.lineTo(mx + rx * sx, my + BEACH.top * sy);
      ctx.stroke();
    }
    for (const ry of ROAD_ROWS) {
      ctx.beginPath();
      ctx.moveTo(mx, my + ry * sy);
      ctx.lineTo(mx + mw, my + ry * sy);
      ctx.stroke();
    }
    // Blocks as soft masses.
    ctx.fillStyle = 'rgba(70,86,112,0.5)';
    for (let i = 0; i < city.buildings.length; i += 1) {
      const b = city.buildings[i];
      ctx.fillRect(mx + b.x * sx, my + b.y * sy, Math.max(1.2, b.w * sx), Math.max(1.2, b.h * sy));
    }
    // Sea.
    ctx.fillStyle = 'rgba(24,70,96,0.85)';
    ctx.fillRect(mx, my + BEACH.water * sy, mw, mh - BEACH.water * sy);
    ctx.fillStyle = 'rgba(200,168,110,0.5)';
    ctx.fillRect(mx, my + BEACH.top * sy, mw, (BEACH.water - BEACH.top) * sy);

    // Police blips.
    for (let i = 0; i < state.police.length; i += 1) {
      const car = state.police[i].car;
      if (car.wrecked) continue;
      const blink = Math.sin(state.time * 7 + i) > 0;
      ctx.fillStyle = blink ? '#ff3d5e' : '#3f7dff';
      ctx.beginPath();
      ctx.arc(mx + car.x * sx, my + car.y * sy, 2.6, 0, TAU);
      ctx.fill();
    }
    // Job marker.
    const job = state.job;
    if (job) {
      const target = job.type === JOB_DROPS ? job.points.find((p) => !p.taken) : job.points[job.stage];
      if (target) {
        const jx = clamp(mx + target.x * sx, mx + 6, mx + mw - 6);
        const jy = clamp(my + target.y * sy, my + 8, my + mh - 8);
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.arc(jx, jy, 3.4 + Math.sin(state.time * 5), 0, TAU);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,209,102,0.6)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(jx, jy, 6 + Math.sin(state.time * 5) * 2, 0, TAU);
        ctx.stroke();
      }
    }
    // Player arrow.
    const px = mx + state.player.x * sx;
    const py = my + state.player.y * sy;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(state.player.angle + Math.PI / 2);
    ctx.fillStyle = '#8ff0ff';
    ctx.beginPath();
    ctx.moveTo(0, -5.5);
    ctx.lineTo(4.2, 4.5);
    ctx.lineTo(0, 2.4);
    ctx.lineTo(-4.2, 4.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.restore();

    // Frame and compass label.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    roundRect(mx, my, mw, mh, 6);
    ctx.stroke();
    text('VICE CITY', mx + 7, my + 12, 8, 'rgba(210,222,240,0.55)', 'left', 800, FONT_DISPLAY);
  }

  function drawBanner(state) {
    const banner = state.banner;
    if (!banner || banner.t <= 0) return;
    const life = clamp(banner.t / 0.6, 0, 1);
    ctx.globalAlpha = life;
    const y = 168;
    ctx.fillStyle = 'rgba(6,10,18,0.55)';
    roundRect(VIEW_W / 2 - 170, y - 26, 340, 34, 4);
    ctx.fill();
    ctx.fillStyle = rgba(banner.accent, 0.9);
    ctx.fillRect(VIEW_W / 2 - 170, y + 4, 340, 2);
    spacedText(banner.name.toUpperCase(), VIEW_W / 2, y - 4, 17, '#f2f5ff', 3, 'center');
    ctx.globalAlpha = 1;
  }

  function drawBusted(state) {
    if (state.busted <= 0.01) return;
    const p = state.busted;
    const y = VIEW_H / 2 + 84;
    ctx.fillStyle = 'rgba(6,10,18,0.72)';
    roundRect(VIEW_W / 2 - 150, y - 26, 300, 52, 8);
    ctx.fill();
    spacedText('BUSTED', VIEW_W / 2, y + 2, 26, '#ff5d6c', 6, 'center');
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    roundRect(VIEW_W / 2 - 120, y + 12, 240, 6, 3);
    ctx.fill();
    ctx.fillStyle = '#ff5d6c';
    roundRect(VIEW_W / 2 - 120, y + 12, 240 * p, 6, 3);
    ctx.fill();
  }

  function drawTicker(state) {
    if (state.tipTimer <= 0 || !state.tip) return;
    const alpha = clamp(state.tipTimer / 0.5, 0, 1);
    ctx.globalAlpha = alpha;
    ctx.font = font(13, 600);
    const w = ctx.measureText(state.tip).width + 30;
    ctx.fillStyle = 'rgba(6,10,18,0.72)';
    roundRect(VIEW_W / 2 - w / 2, VIEW_H - 148, w, 28, 6);
    ctx.fill();
    ctx.fillStyle = '#dfe8f7';
    ctx.textAlign = 'center';
    ctx.font = font(13, 600);
    ctx.fillText(state.tip, VIEW_W / 2, VIEW_H - 129);
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------- screens */

  function drawBackdrop(state) {
    // A slow, dark city behind the menus: the same ground, dimmed, with the neon skyline.
    const t = state.time;
    ctx.fillStyle = '#070a14';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#141a33');
    g.addColorStop(0.55, '#241834');
    g.addColorStop(1, '#0a0d18');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // A skyline of soft towers.
    for (let i = 0; i < 26; i += 1) {
      const w = 26 + ((i * 37) % 54);
      const h = 90 + ((i * 91) % 300);
      const x = i * 52 - 30;
      const y = VIEW_H - 250 - h;
      ctx.fillStyle = `rgba(${20 + (i % 4) * 8},${22 + (i % 3) * 10},${52 + (i % 5) * 12},0.85)`;
      ctx.fillRect(x, y, w, h);
      for (let wy = y + 10; wy < y + h - 8; wy += 14) {
        for (let wx = x + 5; wx < x + w - 5; wx += 11) {
          if ((i * 13 + wx + wy) % 7 < 3) {
            ctx.fillStyle = `rgba(255,214,138,${0.10 + ((i + wx) % 5) * 0.045})`;
            ctx.fillRect(wx, wy, 5, 6);
          }
        }
      }
    }
    // Sun/moon glow and a reflected strip.
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = radial(VIEW_W * 0.68, VIEW_H * 0.44, 340, [[0, 'rgba(255,90,150,0.20)'], [1, 'rgba(255,90,150,0)']]);
    ctx.fillRect(VIEW_W * 0.68 - 340, VIEW_H * 0.44 - 340, 680, 680);
    ctx.fillStyle = radial(VIEW_W * 0.3, VIEW_H * 0.6, 280, [[0, 'rgba(60,200,255,0.13)'], [1, 'rgba(60,200,255,0)']]);
    ctx.fillRect(VIEW_W * 0.3 - 280, VIEW_H * 0.6 - 280, 560, 560);
    ctx.globalCompositeOperation = 'source-over';
    // Grime and scanlines.
    ctx.fillStyle = 'rgba(6,8,16,0.35)';
    for (let y = 0; y < VIEW_H; y += 4) ctx.fillRect(0, y, VIEW_W, 1.4);
    void t;
  }

  function drawTitle(state) {
    drawBackdrop(state);
    const t = state.time;
    const cx = VIEW_W / 2;

    // Big title, with a neon echo.
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = font(96, 900, FONT_DISPLAY);
    ctx.fillStyle = 'rgba(255,61,127,0.28)';
    ctx.fillText('VICE', cx + 5, 250 + 4);
    ctx.fillStyle = 'rgba(51,225,255,0.28)';
    ctx.fillText('VICE', cx - 5, 250 - 4);
    ctx.restore();
    spacedText('VICE', cx, 250, 96, '#f7f3ff', 14, 'center');
    spacedText('HARBOR', cx, 322, 62, '#ff3d7f', 16, 'center');
    ctx.globalAlpha = 0.5 + Math.sin(t * 2) * 0.2;
    ctx.fillStyle = '#33e1ff';
    ctx.fillRect(cx - 250, 338, 500, 2);
    ctx.globalAlpha = 1;
    text('A five-minute shift in a city that never cools down', cx, 366, 14, '#a9b6ce', 'center', 500);

    // Controls panel.
    const px = cx - 330;
    const py = 400;
    panel(px, py, 660, 186, 0.7, 'rgba(255,255,255,0.1)');
    text('THE JOB', px + 24, py + 26, 11, '#33e1ff', 'left', 800, FONT_DISPLAY);
    text('Take the phone jobs, keep the cash, stay out of the cells', px + 24, py + 46, 12, '#cbd4e6', 'left', 500);
    const rows = [
      ['WASD / ARROWS', 'walk and drive'],
      ['SHIFT', 'sprint on foot'],
      ['E', 'enter or leave a car'],
      ['SPACE', 'handbrake (drift)'],
      ['P / ESC', 'pause'],
      ['M', 'mute the sound'],
      ['R', 'restart after the shift'],
      ['ENTER', 'confirm any menu'],
    ];
    const colW = 318;
    for (let i = 0; i < rows.length; i += 1) {
      const col = i < 4 ? 0 : 1;
      const row = i < 4 ? i : i - 4;
      const x = px + 24 + col * colW;
      const y = py + 74 + row * 25;
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(x, y - 14, 104, 20, 4);
      ctx.fill();
      text(rows[i][0], x + 52, y, 9, '#e8f1ff', 'center', 800, FONT_MONO);
      text(rows[i][1], x + 114, y, 11, '#a9b6ce', 'left', 500);
    }

    // Start prompt.
    const pulse = 0.55 + Math.sin(t * 3.2) * 0.45;
    ctx.globalAlpha = pulse;
    text('CLICK OR PRESS ENTER TO START', cx, 682, 15, '#ffd166', 'center', 800, FONT_DISPLAY);
    ctx.globalAlpha = 1;
    text('Shift 5:00  ·  3 job types  ·  5 wanted stars  ·  one tank of nerve', cx, 708, 10, 'rgba(160,176,200,0.6)', 'center', 600);
  }

  function drawPaused(state) {
    ctx.fillStyle = 'rgba(4,6,12,0.72)';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    const cx = VIEW_W / 2;
    spacedText('PAUSED', cx, 320, 56, '#f2f5ff', 12, 'center');
    text('The city can wait.', cx, 352, 13, '#a9b6ce', 'center', 500);
    panel(cx - 190, 386, 380, 148, 0.78, 'rgba(255,255,255,0.12)');
    const lines = [
      ['P / ESC', 'resume the shift'],
      ['M', 'toggle sound'],
      ['R', 'restart from the top'],
    ];
    for (let i = 0; i < lines.length; i += 1) {
      const y = 420 + i * 34;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      roundRect(cx - 168, y - 15, 92, 22, 4);
      ctx.fill();
      text(lines[i][0], cx - 122, y, 10, '#dfe8f7', 'center', 800, FONT_MONO);
      text(lines[i][1], cx - 58, y, 12, '#a9b6ce', 'left', 500);
    }
    text('VICE HARBOR', cx, 566, 11, 'rgba(255,61,127,0.7)', 'center', 800, FONT_DISPLAY);
  }

  function drawOver(state) {
    const cx = VIEW_W / 2;
    const reason = state.reason;
    const title = reason === REASON_BUSTED ? 'BUSTED' : reason === REASON_WASTED ? 'WASTED' : 'SHIFT OVER';
    const colour = reason === REASON_TIME ? '#57ff9a' : '#ff4d5e';
    spacedText(title, cx, 190, 64, colour, 10, 'center');
    const sub = reason === REASON_BUSTED
      ? 'The cuffs are on. The city keeps your cash.'
      : reason === REASON_WASTED
        ? 'You went down hard on Vice Harbor asphalt.'
        : 'Five minutes gone. The harbour lights stay on without you.';
    text(sub, cx, 222, 13, '#a9b6ce', 'center', 500);

    panel(cx - 300, 256, 600, 268, 0.93, 'rgba(255,255,255,0.16)');
    const stats = [
      ['CASH EARNED', formatMoney(state.cash), PALETTE.gold],
      ['SCORE', Math.floor(state.score).toLocaleString('en-US'), '#f2f5ff'],
      ['JOBS COMPLETED', String(state.stats.jobs), '#57ff9a'],
      ['HIGHEST WANTED', '★'.repeat(Math.max(0, state.best.heat)) + '☆'.repeat(Math.max(0, MAX_HEAT - state.best.heat)), '#ff8a94'],
      ['TIME SURVIVED', formatShift(Math.floor(state.stats.timePlayed)), '#bcd3ff'],
    ];
    for (let i = 0; i < stats.length; i += 1) {
      const y = 300 + i * 46;
      text(stats[i][0], cx - 268, y, 11, PALETTE.muted, 'left', 700, FONT_MONO);
      text(stats[i][1], cx + 268, y + 5, i === 0 ? 28 : 22, stats[i][2], 'right', 800, FONT_DISPLAY);
      if (i < stats.length - 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(cx - 268, y + 14, 536, 1);
      }
    }
    text(`${state.stats.stolen} cars taken · ${state.stats.crashes} crashes · ${state.roadblocks} roadblocks`, cx, 552, 11, '#9aa8c2', 'center', 600);
    const pulse = 0.6 + Math.sin(state.time * 3.4) * 0.4;
    ctx.globalAlpha = pulse;
    text('PRESS R OR CLICK TO RUN IT AGAIN', cx, 622, 15, '#ffd166', 'center', 800, FONT_DISPLAY);
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------ the frame */

  function draw(state) {
    beginFrame();
    if (state.phase === PHASE_TITLE) {
      drawTitle(state);
    } else if (state.phase === PHASE_OVER) {
      // The summary owns the frame: dim the frozen city, keep the HUD out of its way.
      drawWorld(state);
      ctx.fillStyle = 'rgba(3,5,11,0.55)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      drawOver(state);
    } else {
      drawWorld(state);
      drawHud(state);
      if (state.phase === PHASE_PAUSED) drawPaused(state);
    }
    endFrame();
  }

  function drawFrozen(state, screen) {
    beginFrame();
    if (screen === PHASE_TITLE) drawTitle(state);
    else if (screen === PHASE_OVER) {
      drawWorld(state);
      ctx.fillStyle = 'rgba(3,5,11,0.55)';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      drawOver(state);
    } else {
      drawWorld(state);
      drawHud(state);
    }
    endFrame();
  }

  function setCity(next) {
    city = next;
    city.lamps = next.props.filter((p) => p.type === 'lamp');
  }

  resize();
  return { resize, draw, drawFrozen, setCity, VIEW_W, VIEW_H };
}
