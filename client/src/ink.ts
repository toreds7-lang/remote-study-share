import type { Stroke, TextStroke } from '../../shared/protocol.ts';

export const TEXT_LINE_HEIGHT = 1.25;
const FONT_FAMILY = `'Pretendard Variable', 'Pretendard', 'Apple SD Gothic Neo', 'Malgun Gothic', system-ui, sans-serif`;
export const textFont = (px: number) => `600 ${px}px ${FONT_FAMILY}`;

/** Draws one stroke onto a context whose coordinate space is `w` x `h` page pixels. */
export function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, w: number, h: number) {
  if (s.kind === 'text') return drawText(ctx, s, w, h);

  const pts = s.points;
  const width = (s.size * w) / 1000;
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (pts.length <= 4) {
    // A tap or a tiny stroke: draw a dot.
    ctx.beginPath();
    ctx.arc(pts[0] * w, pts[1] * h, width / 2, 0, Math.PI * 2);
    ctx.fill();
    if (pts.length < 4) return;
  }

  // Quadratic smoothing through the midpoints of consecutive points.
  ctx.beginPath();
  ctx.moveTo(pts[0] * w, pts[1] * h);
  for (let i = 2; i < pts.length - 2; i += 2) {
    const x = pts[i] * w;
    const y = pts[i + 1] * h;
    const mx = ((pts[i] + pts[i + 2]) / 2) * w;
    const my = ((pts[i + 1] + pts[i + 3]) / 2) * h;
    ctx.quadraticCurveTo(x, y, mx, my);
  }
  ctx.lineTo(pts[pts.length - 2] * w, pts[pts.length - 1] * h);
  ctx.stroke();
}

function drawText(ctx: CanvasRenderingContext2D, s: TextStroke, w: number, h: number) {
  const px = (s.size * w) / 1000;
  ctx.font = textFont(px);
  ctx.fillStyle = s.color;
  ctx.textBaseline = 'top';
  // Offset by the half-leading so text lands where the <textarea> editor showed it.
  const lead = ((TEXT_LINE_HEIGHT - 1) / 2) * px;
  s.text
    .split('\n')
    .forEach((line, i) => ctx.fillText(line, s.x * w, s.y * h + lead + i * px * TEXT_LINE_HEIGHT));
}

export function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Iterable<Stroke>, w: number, h: number) {
  for (const s of strokes) drawStroke(ctx, s, w, h);
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textBox(s: TextStroke, w: number, h: number) {
  measureCtx ??= document.createElement('canvas').getContext('2d')!;
  const px = (s.size * w) / 1000;
  measureCtx.font = textFont(px);
  const lines = s.text.split('\n');
  const width = Math.max(...lines.map((l) => measureCtx!.measureText(l).width));
  return { x: s.x * w, y: s.y * h, w: width, h: lines.length * px * TEXT_LINE_HEIGHT };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a point (in page pixels) is within `radius` px of the stroke. */
export function hitTest(s: Stroke, px: number, py: number, radius: number, w: number, h: number): boolean {
  if (s.kind === 'text') {
    const b = textBox(s, w, h);
    return px >= b.x - radius && px <= b.x + b.w + radius && py >= b.y - radius && py <= b.y + b.h + radius;
  }
  const reach = radius + (s.size * w) / 2000;
  const p = s.points;
  if (p.length === 2) return Math.hypot(px - p[0] * w, py - p[1] * h) <= reach;
  for (let i = 0; i < p.length - 2; i += 2) {
    if (distToSegment(px, py, p[i] * w, p[i + 1] * h, p[i + 2] * w, p[i + 3] * h) <= reach) return true;
  }
  return false;
}

/** Random id that works without a secure context (crypto.randomUUID needs https). */
export function uid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Rounds a normalized coordinate to keep payloads small (0.0001 of the page). */
export const round4 = (n: number) => Math.round(n * 10000) / 10000;
