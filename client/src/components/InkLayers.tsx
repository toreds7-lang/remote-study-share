// Ink drawn over a 교안 page: the teacher's 판서, my own 필기, the laser pointer, and the
// transparent surface that turns pointer input into strokes. Shared by the PDF and HTML viewers.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Layer, PenStroke, Stroke } from '../../../shared/protocol.ts';
import { LIMITS, PEN_SIZES, TEXT_SIZES } from '../../../shared/protocol.ts';
import { commitStroke, eraseNow, recordErase } from '../actions.ts';
import { drawStroke, drawStrokes, hitTest, round4, TEXT_LINE_HEIGHT, textFont, uid } from '../ink.ts';
import { socket } from '../socket.ts';
import { pageKey, useStore } from '../store.ts';

const EMPTY: Stroke[] = [];

/**
 * A page as laid out on screen: `w` x `h` CSS pixels. `ox`/`oy` is how far the content is
 * scrolled, in page widths/heights (only a live HTML 교안 scrolls), so ink stays on its content.
 */
export interface Rendered {
  docId: string;
  page: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
}

/** Size of an element's content box, updated as it resizes. */
export function useBoxSize(ref: React.RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setBox((b) => (Math.abs(b.w - width) < 1 && Math.abs(b.h - height) < 1 ? b : { w: width, h: height }));
    });
    ro.observe(ref.current!);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/** All ink layers for one page. `onWheel` receives wheel input while drawing (to scroll HTML). */
export function InkLayers({ rendered, onWheel }: { rendered: Rendered; onWheel?: (dx: number, dy: number) => void }) {
  const isTeacher = useStore((s) => s.me?.role === 'teacher');
  const showTeacherInk = useStore((s) => s.showTeacherInk);
  const { docId, page } = rendered;
  const key = pageKey(docId, page);
  const teacherStrokes = useStore((s) => s.strokes.teacher[key]) ?? EMPTY;
  const noteStrokes = useStore((s) => s.strokes.note[key]) ?? EMPTY;
  const liveAll = useStore((s) => s.live);
  const live = useMemo(
    () => Object.values(liveAll).filter((l) => l.docId === docId && l.page === page),
    [liveAll, docId, page],
  );
  return (
    <>
      {(isTeacher || showTeacherInk) && <InkCanvas strokes={teacherStrokes} extra={live} rendered={rendered} />}
      {!isTeacher && <InkCanvas strokes={noteStrokes} rendered={rendered} />}
      <LaserDot rendered={rendered} />
      <DrawSurface rendered={rendered} layer={isTeacher ? 'teacher' : 'note'} onWheel={onWheel} />
    </>
  );
}

function InkCanvas({ strokes, extra, rendered }: { strokes: Stroke[]; extra?: Stroke[]; rendered: Rendered }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { w, h, ox, oy } = rendered;
  useLayoutEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (c.width !== pw || c.height !== ph) {
      c.width = pw;
      c.height = ph;
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pw, ph);
    ctx.setTransform(dpr, 0, 0, dpr, -ox * w * dpr, -oy * h * dpr);
    drawStrokes(ctx, strokes, w, h);
    if (extra) drawStrokes(ctx, extra, w, h);
  }, [strokes, extra, w, h, ox, oy]);
  return <canvas ref={ref} className="ink-layer" style={{ width: w, height: h }} />;
}

function LaserDot({ rendered }: { rendered: Rendered }) {
  const laser = useStore((s) => s.laser);
  const [, force] = useState(0);
  // Hide the dot if the teacher stops moving it for a while.
  useEffect(() => {
    if (!laser) return;
    const t = setTimeout(() => force((n) => n + 1), 3100);
    return () => clearTimeout(t);
  }, [laser]);
  if (!laser || laser.docId !== rendered.docId || laser.page !== rendered.page) return null;
  if (Date.now() - laser.t > 3000) return null;
  const x = (laser.x - rendered.ox) * rendered.w;
  const y = (laser.y - rendered.oy) * rendered.h;
  return <div className="laser" style={{ transform: `translate(${x}px, ${y}px)` }} />;
}

interface Drawing {
  id: string;
  pointerId: number;
  points: number[];
  /** Points not yet streamed to students (teacher only). */
  pending: number[];
  lastEmit: number;
}

/** Transparent layer on top of the page that turns pointer input into strokes. */
function DrawSurface({
  rendered,
  layer,
  onWheel,
}: {
  rendered: Rendered;
  layer: Layer;
  onWheel?: (dx: number, dy: number) => void;
}) {
  const drawMode = useStore((s) => s.drawMode);
  const tool = useStore((s) => s.tool);
  const color = useStore((s) => s.color);
  const sizeIdx = useStore((s) => s.sizeIdx);
  const isTeacher = layer === 'teacher';
  const { docId, page, w, h, ox, oy } = rendered;

  const surfaceRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef<Drawing | null>(null);
  const erasing = useRef<Stroke[] | null>(null);
  const penSeen = useRef(false);
  const lastLaser = useRef(0);
  const [text, setText] = useState<{ id: string; x: number; y: number; value: string } | null>(null);
  const committedText = useRef<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  const penSize = PEN_SIZES[sizeIdx];
  const textSize = TEXT_SIZES[sizeIdx];
  const active = drawMode;

  // Cancel any in-progress input when the page or mode changes.
  useEffect(() => {
    drawing.current = null;
    erasing.current = null;
    setText(null);
    clearDraft();
  }, [docId, page, drawMode, tool]);

  useEffect(() => {
    if (text) textRef.current?.focus();
  }, [text?.id]);

  // Turn the laser off when the teacher switches tools or leaves the page.
  useEffect(() => {
    if (!isTeacher || !drawMode || tool !== 'laser') return;
    return () => {
      socket.emit('laser', null);
      useStore.setState({ laser: null });
    };
  }, [isTeacher, drawMode, tool, docId, page]);

  function clearDraft() {
    const c = draftRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
  }

  /** Pointer position: `px`/`py` in page pixels (from the top of scrolled content), `x`/`y` normalized. */
  function pos(e: { clientX: number; clientY: number }) {
    const r = surfaceRef.current!.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width + ox;
    const y = (e.clientY - r.top) / r.height + oy;
    return { px: x * w, py: y * h, x, y };
  }

  function redrawDraft(d: Drawing) {
    const c = draftRef.current!;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.setTransform(dpr, 0, 0, dpr, -ox * w * dpr, -oy * h * dpr);
    drawStroke(ctx, penStroke(d), w, h);
  }

  function penStroke(d: Drawing): PenStroke {
    return { id: d.id, docId, page, kind: 'pen', color, size: penSize, points: d.points };
  }

  function streamLive(d: Drawing, force = false) {
    if (!isTeacher || !d.pending.length) return;
    const now = performance.now();
    if (!force && now - d.lastEmit < 40) return;
    socket.emit('ink:live', { id: d.id, docId, page, color, size: penSize, points: d.pending });
    d.pending = [];
    d.lastEmit = now;
  }

  function finishStroke(d: Drawing) {
    streamLive(d, true);
    commitStroke(layer, penStroke(d));
  }

  function eraseAt(px: number, py: number) {
    const current = useStore.getState().strokes[layer][pageKey(docId, page)] ?? [];
    const hits = current.filter((s) => hitTest(s, px, py, 8, w, h));
    if (!hits.length) return;
    eraseNow(layer, hits);
    erasing.current?.push(...hits);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.pointerType === 'pen') penSeen.current = true;
    // Palm rejection: once a stylus is used, ignore touches for drawing.
    if (e.pointerType === 'touch' && penSeen.current) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = pos(e);

    if (tool === 'pen') {
      e.currentTarget.setPointerCapture(e.pointerId);
      const start = [round4(p.x), round4(p.y)];
      const d: Drawing = { id: uid(), pointerId: e.pointerId, points: start, pending: [...start], lastEmit: 0 };
      drawing.current = d;
      redrawDraft(d);
      streamLive(d, true);
    } else if (tool === 'eraser') {
      e.currentTarget.setPointerCapture(e.pointerId);
      erasing.current = [];
      eraseAt(p.px, p.py);
    } else if (tool === 'text') {
      e.preventDefault();
      if (text) commitText();
      else setText({ id: uid(), x: p.x, y: p.y, value: '' });
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (tool === 'laser' && isTeacher) {
      const now = performance.now();
      if (now - lastLaser.current < 33) return;
      lastLaser.current = now;
      const p = pos(e);
      const laser = { docId, page, x: round4(p.x), y: round4(p.y) };
      socket.emit('laser', laser);
      useStore.setState({ laser: { ...laser, t: Date.now() } });
      return;
    }
    const d = drawing.current;
    if (d && e.pointerId === d.pointerId) {
      const events = e.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const ev of events.length ? events : [e.nativeEvent]) {
        const p = pos(ev);
        const n = d.points.length;
        if (Math.hypot((p.x - d.points[n - 2]) * w, (p.y - d.points[n - 1]) * h) < 1.5) continue;
        const pt = [round4(p.x), round4(p.y)];
        d.points.push(...pt);
        d.pending.push(...pt);
      }
      redrawDraft(d);
      streamLive(d);
      // Very long strokes are split so each one stays under the server's size limit.
      if (d.points.length >= LIMITS.strokePoints - 200) {
        finishStroke(d);
        const last = d.points.slice(-2);
        drawing.current = { id: uid(), pointerId: d.pointerId, points: last, pending: [...last], lastEmit: 0 };
      }
      return;
    }
    if (erasing.current) {
      const p = pos(e);
      eraseAt(p.px, p.py);
    }
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = drawing.current;
    if (d && e.pointerId === d.pointerId) {
      drawing.current = null;
      finishStroke(d);
      // Clear the draft after the committed stroke has been painted on the ink layer.
      requestAnimationFrame(clearDraft);
    }
    if (erasing.current) {
      recordErase(layer, erasing.current);
      erasing.current = null;
    }
  }

  function onPointerLeave() {
    if (tool === 'laser' && isTeacher) {
      socket.emit('laser', null);
      useStore.setState({ laser: null });
    }
  }

  function commitText() {
    if (!text || committedText.current === text.id) return;
    committedText.current = text.id;
    const value = text.value.replace(/\s+$/, '');
    setText(null);
    if (!value.trim()) return;
    commitStroke(layer, {
      id: uid(),
      docId,
      page,
      kind: 'text',
      color,
      size: textSize,
      x: round4(text.x),
      y: round4(text.y),
      text: value.slice(0, LIMITS.textStrokeLen),
    });
  }

  const fontPx = (textSize * w) / 1000;
  return (
    <>
      <canvas ref={draftRef} className="ink-layer" style={{ width: w, height: h }} />
      <div
        ref={surfaceRef}
        className={`draw-surface tool-${tool}`}
        style={{ pointerEvents: active ? 'auto' : 'none', touchAction: active ? 'none' : 'auto' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        onWheel={onWheel && ((e) => onWheel(e.deltaX, e.deltaY))}
      />
      {text && (
        <textarea
          ref={textRef}
          className="text-editor"
          value={text.value}
          maxLength={LIMITS.textStrokeLen}
          placeholder="텍스트 입력"
          rows={Math.max(1, text.value.split('\n').length)}
          style={{
            left: (text.x - ox) * w,
            top: (text.y - oy) * h,
            font: textFont(fontPx),
            lineHeight: TEXT_LINE_HEIGHT,
            color,
            maxWidth: w - (text.x - ox) * w,
          }}
          onChange={(e) => setText({ ...text, value: e.target.value })}
          onBlur={commitText}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setText(null);
            else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              commitText();
            }
          }}
        />
      )}
    </>
  );
}
