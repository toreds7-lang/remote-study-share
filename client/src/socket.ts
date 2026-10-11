import { io } from 'socket.io-client';
import type {
  ChatMessage,
  DocEdit,
  DocInfo,
  DocStrokes,
  FileInfo,
  LaserPos,
  Layer,
  LiveInk,
  Position,
  PresenceUser,
  Question,
  RaisedHand,
  Snapshot,
  Stroke,
} from '../../shared/protocol.ts';
import {
  addStroke,
  applySnapshot,
  clearPageStrokes,
  isVisible,
  onDocEdited,
  onFiles,
  onLiveInk,
  onTeacherNav,
  removeStrokes,
  setDocStrokes,
  toast,
  upsertQuestion,
  useStore,
} from './store.ts';

export const socket = io({ autoConnect: false, transports: ['websocket', 'polling'] });

type AckResult<T> = { ok: true; data?: T } | { ok: false; error: string };

/** Emits an event and resolves with the server's ack data, or rejects with its error message. */
export function request<T = unknown>(event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    socket.timeout(10_000).emit(event, payload, (err: Error | null, res: AckResult<T>) => {
      if (err) reject(new Error('서버 응답이 없어요. 연결 상태를 확인하세요.'));
      else if (res.ok) resolve(res.data as T);
      else reject(new Error(res.error));
    });
  });
}

export type SendResult<T> = { ok: true; data: T } | { ok: false };

/** Like request(), but shows failures as a toast instead of throwing. */
export async function send<T = unknown>(event: string, payload: unknown): Promise<SendResult<T>> {
  try {
    return { ok: true, data: await request<T>(event, payload) };
  } catch (err) {
    toast((err as Error).message);
    return { ok: false };
  }
}

const loading = new Set<string>();
export async function ensureStrokes(docId: string | null) {
  if (!docId || useStore.getState().loadedDocs[docId] || loading.has(docId)) return;
  loading.add(docId);
  try {
    setDocStrokes(docId, await request<DocStrokes>('strokes:get', { docId }));
  } catch (err) {
    toast((err as Error).message);
  } finally {
    loading.delete(docId);
  }
}

let bound = false;
export function connect(onUnauthorized: () => void) {
  if (!bound) {
    bound = true;
    bind(onUnauthorized);
  }
  socket.connect();
}

function bind(onUnauthorized: () => void) {
  const set = useStore.setState;
  const get = useStore.getState;

  socket.on('connect', () => set({ connected: true }));
  socket.on('disconnect', () => set({ connected: false, live: {}, laser: null }));
  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') {
      socket.disconnect();
      onUnauthorized();
    }
  });

  socket.on('snapshot', (snap: Snapshot) => {
    applySnapshot(snap);
    void ensureStrokes(get().view.docId);
  });

  socket.on('docs', (docs: DocInfo[]) => {
    const s = get();
    const viewGone = s.view.docId !== null && !docs.some((d) => d.id === s.view.docId);
    // The document I was reading alone was deleted: go back to following the teacher.
    set(viewGone ? { docs, follow: true, view: s.teacher } : { docs });
  });
  socket.on('doc:edited', (edit: DocEdit) => {
    onDocEdited(edit);
    void ensureStrokes(get().view.docId);
  });
  socket.on('files', (files: FileInfo[]) => onFiles(files));
  socket.on('teacher:nav', (pos: Position) => onTeacherNav(pos));
  socket.on('presence', (online: PresenceUser[]) => set({ online }));

  socket.on('ink:live', (ink: LiveInk) => onLiveInk(ink));
  socket.on('stroke:added', ({ layer, stroke }: { layer: Layer; stroke: Stroke }) => addStroke(layer, stroke));
  socket.on('stroke:deleted', ({ layer, ids }: { layer: Layer; ids: string[] }) => removeStrokes(layer, ids));
  socket.on('stroke:cleared', ({ layer, docId, page }: { layer: Layer; docId: string; page: number }) =>
    clearPageStrokes(layer, docId, page),
  );
  socket.on('laser', (pos: LaserPos | null) => set({ laser: pos ? { ...pos, t: Date.now() } : null }));

  socket.on('hands', (hands: RaisedHand[]) => {
    const before = new Set(get().hands.map((h) => h.userId));
    for (const h of hands) if (!before.has(h.userId)) toast(`✋ ${h.name} 님이 손을 들었어요.`);
    set({ hands });
  });
  socket.on('hand:state', (raised: boolean) => set({ myHand: raised }));

  socket.on('question:new', (q: Question) => {
    const s = get();
    if (s.questions.some((x) => x.id === q.id)) return;
    set({
      questions: [...s.questions, { ...q, mine: q.authorId === s.me?.id }],
      unread: isVisible('questions') ? s.unread : { ...s.unread, questions: s.unread.questions + 1 },
    });
    if (s.me?.role === 'teacher' && !isVisible('questions')) toast('새 질문이 등록되었어요.');
  });
  socket.on('question:update', (q: Partial<Question> & { id: number }) => upsertQuestion(q));
  socket.on('question:deleted', (id: number) =>
    set((s) => ({ questions: s.questions.filter((q) => q.id !== id) })),
  );

  socket.on('chat:new', (m: ChatMessage) => {
    const s = get();
    const fromOther = m.userId !== s.me?.id;
    set({
      chat: [...s.chat, m].slice(-500),
      unread:
        fromOther && !isVisible('chat') ? { ...s.unread, chat: s.unread.chat + 1 } : s.unread,
    });
  });
}
