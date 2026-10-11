// User actions that combine local (optimistic) state changes with server calls.
import { create } from 'zustand';
import type { DocEdit, Layer, Position, Stroke } from '../../shared/protocol.ts';
import { LIMITS } from '../../shared/protocol.ts';
import { frameCommand } from './frame.ts';
import { send, socket } from './socket.ts';
import { addStroke, clearPageStrokes, pageKey, removeStrokes, toast, useStore, type FrameState } from './store.ts';

// ---- navigation ----

function stopFollowing() {
  useStore.setState({ follow: false });
  toast('혼자 보기로 전환했어요. 다시 따라가려면 ‘혼자 보기’ 버튼을 누르세요.');
}

export function goTo(docId: string, page: number) {
  const s = useStore.getState();
  const doc = s.docs.find((d) => d.id === docId);
  if (!s.me || !doc) return;
  // An HTML 교안 numbers its own slides; the frame is moved there by HtmlViewer.
  const pages = doc.kind === 'html' ? LIMITS.htmlPages : doc.pages;
  const target = { docId, page: Math.min(Math.max(1, Math.round(page)), pages) };
  if (target.docId === s.view.docId && target.page === s.view.page) return;

  if (s.me.role === 'teacher') {
    useStore.setState({ teacher: target, view: target });
    void send('nav', target);
    return;
  }
  const leavesTeacher = target.docId !== s.teacher.docId || target.page !== s.teacher.page;
  if (s.follow && leavesTeacher) stopFollowing();
  useStore.setState({ view: target });
}

export function step(delta: number) {
  const s = useStore.getState();
  const doc = s.docs.find((d) => d.id === s.view.docId);
  if (!doc) return;
  if (doc.kind === 'pdf') return goTo(doc.id, s.view.page + delta);
  // Let the page change its own slide, as if the arrow key was pressed in it.
  if (s.me?.role === 'student' && s.follow) stopFollowing();
  frameCommand({ type: 'ss:key', key: delta > 0 ? 'ArrowRight' : 'ArrowLeft' });
}

// ---- live HTML 교안 ----

/** Scrolling a little doesn't stop a student from following the teacher. */
const SCROLL_SLACK_PX = 40;

/** Whether `pos` (which has an HTML position) is at `ref`. If only the slide of `ref` is known, `lenient` decides. */
function samePlace(pos: Position, ref: Position, slack: number, lenient: boolean) {
  if (pos.docId !== ref.docId || pos.page !== ref.page) return false;
  if (!pos.html || !ref.html) return lenient;
  const { hash, x, y } = pos.html;
  return hash === ref.html.hash && Math.abs(x - ref.html.x) <= slack && Math.abs(y - ref.html.y) <= slack;
}

let navTimer: ReturnType<typeof setTimeout> | null = null;
let pendingNav: Position | null = null;
/** Sends the teacher's position at most every 100 ms while scrolling. */
function sendNavSoon(pos: Position) {
  pendingNav = pos;
  navTimer ??= setTimeout(() => {
    navTimer = null;
    if (pendingNav) socket.emit('nav', pendingNav);
    pendingNav = null;
  }, 100);
}

/**
 * The HTML frame reported where it is. `user` is false for moves the app asked for.
 * The teacher broadcasts it; a following student who moves by themselves starts 혼자 보기.
 */
export function onFrameState(frame: FrameState, user: boolean) {
  useStore.setState({ frame });
  const s = useStore.getState();
  if (!s.me || s.view.docId !== frame.docId) return;
  const pos: Position = { docId: frame.docId, page: frame.page, html: { hash: frame.hash, x: frame.x, y: frame.y } };
  if (s.me.role === 'teacher') {
    if (samePlace(pos, s.view, 0, false)) return;
    useStore.setState({ teacher: pos, view: pos });
    sendNavSoon(pos);
    return;
  }
  if (s.follow) {
    if (!user || samePlace(pos, s.teacher, SCROLL_SLACK_PX, true)) return;
    stopFollowing();
  }
  useStore.setState({ view: pos });
}

// ---- ink editing with per-page undo ----

type HistoryEntry = { type: 'add'; stroke: Stroke } | { type: 'remove'; strokes: Stroke[] };

const histKey = (layer: Layer, docId: string, page: number) => `${layer}:${docId}:${page}`;

export const useHistory = create<{ stacks: Record<string, HistoryEntry[]> }>(() => ({ stacks: {} }));

// Page numbers shift when pages are inserted or deleted, so that 교안's undo history no longer fits.
socket.on('doc:edited', ({ docId }: DocEdit) =>
  useHistory.setState((h) => ({
    stacks: Object.fromEntries(Object.entries(h.stacks).filter(([key]) => !key.includes(`:${docId}:`))),
  })),
);

function push(layer: Layer, docId: string, page: number, entry: HistoryEntry) {
  const key = histKey(layer, docId, page);
  useHistory.setState((h) => ({ stacks: { ...h.stacks, [key]: [...(h.stacks[key] ?? []), entry].slice(-100) } }));
}

export const canUndo = (layer: Layer, docId: string | null, page: number) =>
  !!docId && (useHistory.getState().stacks[histKey(layer, docId, page)]?.length ?? 0) > 0;

async function saveStroke(layer: Layer, stroke: Stroke) {
  if ((await send('stroke:add', stroke)).ok) return;
  if (!socket.connected) toast('연결이 끊겨 필기가 저장되지 않았어요.');
  removeStrokes(layer, [stroke.id]);
}

export function commitStroke(layer: Layer, stroke: Stroke) {
  addStroke(layer, stroke);
  push(layer, stroke.docId, stroke.page, { type: 'add', stroke });
  void saveStroke(layer, stroke);
}

/** Removes strokes right away (used while dragging the eraser); call recordErase when done. */
export function eraseNow(layer: Layer, strokes: Stroke[]) {
  if (!strokes.length) return;
  const ids = strokes.map((s) => s.id);
  removeStrokes(layer, ids);
  void send('stroke:delete', { ids });
}

export function recordErase(layer: Layer, strokes: Stroke[]) {
  if (strokes.length) push(layer, strokes[0].docId, strokes[0].page, { type: 'remove', strokes });
}

export function clearPage(layer: Layer, docId: string, page: number) {
  const strokes = useStore.getState().strokes[layer][pageKey(docId, page)] ?? [];
  if (!strokes.length) return;
  clearPageStrokes(layer, docId, page);
  push(layer, docId, page, { type: 'remove', strokes });
  void send('stroke:clear', { docId, page });
}

export function undo(layer: Layer, docId: string, page: number) {
  const key = histKey(layer, docId, page);
  const stack = useHistory.getState().stacks[key];
  const entry = stack?.at(-1);
  if (!entry) return;
  useHistory.setState((h) => ({ stacks: { ...h.stacks, [key]: stack.slice(0, -1) } }));
  if (entry.type === 'add') {
    removeStrokes(layer, [entry.stroke.id]);
    void send('stroke:delete', { ids: [entry.stroke.id] });
  } else {
    for (const s of entry.strokes) {
      addStroke(layer, s);
      void saveStroke(layer, s);
    }
  }
}
