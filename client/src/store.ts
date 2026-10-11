import { create } from 'zustand';
import type {
  ChatMessage,
  DocEdit,
  DocInfo,
  DocStrokes,
  FileInfo,
  LaserPos,
  Layer,
  LiveInk,
  Me,
  PenStroke,
  Position,
  PresenceUser,
  Question,
  RaisedHand,
  RoomInfo,
  Snapshot,
  Stroke,
} from '../../shared/protocol.ts';
import { COLORS, pageAfterEdit } from '../../shared/protocol.ts';

/** Key of one page of one document. */
export const pageKey = (docId: string, page: number) => `${docId}:${page}`;

export type Tool = 'pen' | 'text' | 'eraser' | 'laser';
export type MainTab = 'home' | 'lecture' | 'practice' | 'questions' | 'chat' | 'files';
export type SideTab = 'questions' | 'chat' | 'ai';

export interface AiMessage {
  role: 'user' | 'assistant';
  text: string;
  page?: number | null;
  error?: boolean;
}

type StrokeMap = Record<string, Stroke[]>;

/** What the live HTML 교안 frame last reported: its slide (`total` 0 = unknown) and scroll offset. */
export interface FrameState {
  docId: string;
  page: number;
  total: number;
  hash: string;
  x: number;
  y: number;
}

interface State {
  connected: boolean;
  room: RoomInfo | null;
  me: Me | null;
  aiEnabled: boolean;
  docs: DocInfo[];
  files: FileInfo[];
  /** Files this user has downloaded (ids). */
  myDownloads: Record<string, true>;
  maxUploadMb: number;
  /** Office file types the server can turn into a 교안. */
  officeExts: string[];
  /** Teacher's position, as broadcast by the server. */
  teacher: Position;
  /** Student is following the teacher's screen. Always true for teachers. */
  follow: boolean;
  /** What this user is looking at. */
  view: Position;
  strokes: Record<Layer, StrokeMap>;
  loadedDocs: Record<string, boolean>;
  /** Teacher strokes still being drawn, keyed by stroke id. */
  live: Record<string, PenStroke & { t: number }>;
  laser: (LaserPos & { t: number }) | null;
  frame: FrameState | null;
  /** Teacher's upload/conversion progress for the toolbar, e.g. "PDF로 변환 중…". */
  uploadStatus: string | null;

  showTeacherInk: boolean;
  drawMode: boolean;
  tool: Tool;
  color: string;
  sizeIdx: number;

  questions: Question[];
  chat: ChatMessage[];
  online: PresenceUser[];
  hands: RaisedHand[];
  myHand: boolean;
  ai: AiMessage[];

  tab: MainTab;
  sideOpen: boolean;
  sideTab: SideTab;
  dark: boolean;
  unread: { questions: number; chat: number; files: number };
  toasts: { id: number; text: string }[];
}

export const readPref = <T>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
export const writePref = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode); preferences just won't persist.
  }
};

export const useStore = create<State>()(() => ({
  connected: false,
  room: null,
  me: null,
  aiEnabled: false,
  docs: [],
  files: [],
  myDownloads: {},
  maxUploadMb: 200,
  officeExts: [],
  teacher: { docId: null, page: 1 },
  follow: true,
  view: { docId: null, page: 1 },
  strokes: { teacher: {}, note: {} },
  loadedDocs: {},
  live: {},
  laser: null,
  frame: null,
  uploadStatus: null,

  showTeacherInk: readPref('ss.showTeacherInk', true),
  drawMode: false,
  tool: 'pen',
  color: COLORS[0],
  sizeIdx: 1,

  questions: [],
  chat: [],
  online: [],
  hands: [],
  myHand: false,
  ai: [],

  tab: 'lecture',
  sideOpen: readPref('ss.sideOpen', window.innerWidth > 900),
  sideTab: 'questions',
  dark: readPref('ss.dark', window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false),
  unread: { questions: 0, chat: 0, files: 0 },
  toasts: [],
}));

const set = useStore.setState;
const get = useStore.getState;

let toastSeq = 0;
export function toast(text: string, ms = 3000) {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts, { id, text }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

export function applySnapshot(snap: Snapshot) {
  const prev = get();
  const sameUser = prev.me?.id === snap.me.id;
  const isTeacher = snap.me.role === 'teacher';
  const follow = isTeacher || !sameUser ? true : prev.follow;
  const view = follow || !prev.view.docId ? snap.teacher : prev.view;
  set({
    room: snap.room,
    me: snap.me,
    aiEnabled: snap.aiEnabled,
    docs: snap.docs,
    files: snap.files,
    myDownloads: Object.fromEntries(snap.myDownloads.map((id) => [id, true as const])),
    maxUploadMb: snap.maxUploadMb,
    officeExts: snap.officeExts,
    teacher: snap.teacher,
    follow,
    view,
    // Strokes may have changed while we were disconnected; reload on demand.
    strokes: { teacher: {}, note: {} },
    loadedDocs: {},
    live: {},
    questions: snap.questions,
    chat: snap.chat,
    online: snap.online,
    hands: snap.hands,
    myHand: snap.myHandRaised,
    ai: sameUser ? prev.ai : [],
  });
}

/** Server says the teacher moved. */
export function onTeacherNav(pos: Position) {
  const s = get();
  set({ teacher: pos, ...(s.follow ? { view: pos } : {}) });
}

export function setFollow(follow: boolean) {
  const s = get();
  set({ follow, ...(follow ? { view: s.teacher } : {}) });
}

/** Adds or replaces a 교안 in the list (the server broadcasts the list too; this is for the uploader). */
export function upsertDoc(doc: DocInfo) {
  set((s) => ({ docs: s.docs.some((d) => d.id === doc.id) ? s.docs.map((d) => (d.id === doc.id ? doc : d)) : [...s.docs, doc] }));
}

const dropDoc = (map: StrokeMap, docId: string) =>
  Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith(`${docId}:`)));

/** Pages were inserted or deleted: ink is reloaded (its page numbers changed) and my own position moves along. */
export function onDocEdited(edit: DocEdit) {
  set((s) => {
    // Following viewers get the teacher's new position from the server instead.
    const moveView = s.view.docId === edit.docId && !s.follow;
    // The server sends the new list (with the new page count) before the edit.
    const pages = s.docs.find((d) => d.id === edit.docId)?.pages ?? Infinity;
    const page = Math.max(1, Math.min(pageAfterEdit(s.view.page, edit), pages));
    return {
      strokes: { teacher: dropDoc(s.strokes.teacher, edit.docId), note: dropDoc(s.strokes.note, edit.docId) },
      loadedDocs: { ...s.loadedDocs, [edit.docId]: false },
      view: moveView ? { ...s.view, page } : s.view,
    };
  });
}

export function setDocStrokes(docId: string, data: DocStrokes) {
  set((s) => {
    const strokes = { teacher: { ...s.strokes.teacher }, note: { ...s.strokes.note } };
    for (const layer of ['teacher', 'note'] as const) {
      for (const key of Object.keys(strokes[layer])) if (key.startsWith(`${docId}:`)) delete strokes[layer][key];
      for (const st of data[layer]) {
        const key = pageKey(st.docId, st.page);
        (strokes[layer][key] ??= []).push(st);
      }
    }
    return { strokes, loadedDocs: { ...s.loadedDocs, [docId]: true } };
  });
}

export function addStroke(layer: Layer, stroke: Stroke) {
  set((s) => {
    const key = pageKey(stroke.docId, stroke.page);
    const list = (s.strokes[layer][key] ?? []).filter((x) => x.id !== stroke.id);
    const live = { ...s.live };
    delete live[stroke.id];
    return {
      strokes: { ...s.strokes, [layer]: { ...s.strokes[layer], [key]: [...list, stroke] } },
      live,
    };
  });
}

export function removeStrokes(layer: Layer, ids: string[]) {
  const drop = new Set(ids);
  set((s) => {
    const map: StrokeMap = {};
    for (const [key, list] of Object.entries(s.strokes[layer])) {
      map[key] = list.some((x) => drop.has(x.id)) ? list.filter((x) => !drop.has(x.id)) : list;
    }
    return { strokes: { ...s.strokes, [layer]: map } };
  });
}

export function clearPageStrokes(layer: Layer, docId: string, page: number) {
  set((s) => ({
    strokes: { ...s.strokes, [layer]: { ...s.strokes[layer], [pageKey(docId, page)]: [] } },
  }));
}

export function onLiveInk(ink: LiveInk) {
  set((s) => {
    const prev = s.live[ink.id];
    const stroke: PenStroke & { t: number } = {
      id: ink.id,
      docId: ink.docId,
      page: ink.page,
      kind: 'pen',
      color: ink.color,
      size: ink.size,
      points: prev ? [...prev.points, ...ink.points] : ink.points,
      t: Date.now(),
    };
    return { live: { ...s.live, [ink.id]: stroke } };
  });
}

/** Drops live strokes whose author stopped sending (e.g. disconnected mid-stroke). */
export function pruneLive() {
  const s = get();
  const now = Date.now();
  const stale = Object.values(s.live).filter((l) => now - l.t > 10_000);
  if (!stale.length) return;
  const live = { ...s.live };
  for (const l of stale) delete live[l.id];
  set({ live });
}

export function upsertQuestion(q: Partial<Question> & { id: number }) {
  set((s) => {
    const idx = s.questions.findIndex((x) => x.id === q.id);
    if (idx < 0) return {};
    const questions = [...s.questions];
    questions[idx] = { ...questions[idx], ...q };
    return { questions };
  });
}

/** New file list from the server. Students are told about files they haven't seen before. */
export function onFiles(files: FileInfo[]) {
  const s = get();
  const known = new Set(s.files.map((f) => f.id));
  const added = s.me?.role === 'student' ? files.filter((f) => !known.has(f.id)) : [];
  set({
    files,
    unread: added.length && s.tab !== 'files' ? { ...s.unread, files: s.unread.files + added.length } : s.unread,
  });
  if (added.length === 1) toast(`📎 새 파일: ${added[0].name}`);
  else if (added.length > 1) toast(`📎 새 파일 ${added.length}개가 올라왔어요.`);
}

export function markDownloaded(ids: string[]) {
  set((s) => ({ myDownloads: { ...s.myDownloads, ...Object.fromEntries(ids.map((id) => [id, true as const])) } }));
}

export function setTab(tab: MainTab) {
  set((s) => ({
    tab,
    unread: {
      questions: tab === 'questions' ? 0 : s.unread.questions,
      chat: tab === 'chat' ? 0 : s.unread.chat,
      files: tab === 'files' ? 0 : s.unread.files,
    },
  }));
}

export function setSideTab(sideTab: SideTab) {
  set((s) => ({
    sideTab,
    sideOpen: true,
    unread: {
      questions: sideTab === 'questions' ? 0 : s.unread.questions,
      chat: sideTab === 'chat' ? 0 : s.unread.chat,
      files: s.unread.files,
    },
  }));
}

/** True if the user can currently see this side-panel list. */
export function isVisible(list: 'questions' | 'chat') {
  const s = get();
  if (s.tab === list) return true;
  return s.tab === 'lecture' && s.sideOpen && s.sideTab === list;
}
