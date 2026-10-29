import type { Server, Socket } from 'socket.io';
import type { z } from 'zod';
import type { DocEdit, HtmlState, Layer, Position, PresenceUser, RaisedHand, Snapshot } from '../shared/protocol.ts';
import { LIMITS, pageAfterEdit } from '../shared/protocol.ts';
import { getCookie, RateLimiter, SESSION_COOKIE, userFromToken, type SessionUser } from './auth.ts';
import { config } from './config.ts';
import { officeExts } from './convert.ts';
import { UserError } from './errors.ts';
import * as repo from './repo.ts';
import * as S from './schemas.ts';
import { screenEvents, screenState, serverUrls } from './screen.ts';

const roomChannel = (code: string) => `room:${code}`;
const teachersChannel = (code: string) => `teachers:${code}`;
const userChannel = (id: number) => `user:${id}`;

// In-memory, per-process state. Persisted state (docs, strokes, Q&A) lives in SQLite.
const presence = new Map<string, Map<number, { user: SessionUser; sockets: number }>>();
const hands = new Map<string, Map<number, RaisedHand>>();
/** The teacher's slide and scroll position in a live HTML 교안, for students who join later. */
const htmlPositions = new Map<string, { docId: string; html: HtmlState }>();

function teacherPosition(code: string): Position {
  const room = repo.getRoom(code)!;
  const html = htmlPositions.get(code);
  const pos: Position = { docId: room.current_doc, page: room.current_page };
  return html && html.docId === pos.docId ? { ...pos, html: html.html } : pos;
}

const chatLimiter = new RateLimiter(10, 10_000);
const questionLimiter = new RateLimiter(5, 60_000);

let io: Server;

function onlineList(code: string): PresenceUser[] {
  return [...(presence.get(code)?.values() ?? [])].map(({ user }) => ({
    id: user.id,
    name: user.name,
    role: user.role,
  }));
}

function handList(code: string): RaisedHand[] {
  return [...(hands.get(code)?.values() ?? [])].sort((a, b) => a.at - b.at);
}

function broadcastHands(code: string) {
  io.to(teachersChannel(code)).emit('hands', handList(code));
}

function snapshot(user: SessionUser): Snapshot {
  const room = repo.getRoom(user.roomCode)!;
  return {
    room: { code: room.code, title: room.title },
    me: { id: user.id, name: user.name, role: user.role },
    docs: repo.listDocs(room.code),
    files: repo.listFiles(room.code, user.role === 'teacher'),
    myDownloads: repo.listMyDownloads(room.code, user.id),
    maxUploadMb: config.maxUploadMb,
    officeExts,
    teacher: teacherPosition(room.code),
    questions: repo.listQuestions(room.code, user.id),
    chat: repo.listChat(room.code),
    online: onlineList(room.code),
    hands: user.role === 'teacher' ? handList(room.code) : [],
    myHandRaised: hands.get(room.code)?.has(user.id) ?? false,
    aiEnabled: !!config.openaiKey,
    screen: screenState(room.code, user.role === 'teacher'),
    serverUrls: user.role === 'teacher' ? serverUrls() : [],
  };
}

/** Called by the REST API after a document is uploaded or deleted. */
export function notifyDocsChanged(code: string) {
  const docs = repo.listDocs(code);
  io.to(roomChannel(code)).emit('docs', docs);
  const room = repo.getRoom(code)!;
  const stillExists = docs.some((d) => d.id === room.current_doc);
  if (!stillExists) {
    const next: Position = { docId: docs[0]?.id ?? null, page: 1 };
    repo.setRoomPosition(code, next.docId, next.page);
    htmlPositions.delete(code);
    io.to(roomChannel(code)).emit('teacher:nav', next);
  }
}

/**
 * Called after pages were inserted into or deleted from a 교안: sends the new list, the edit
 * (clients move ink and their own position), questions whose page changed, and the teacher's
 * position if it moved.
 */
export function notifyDocEdited(code: string, edit: DocEdit, questions: { id: number; page: number | null }[]) {
  const channel = io.to(roomChannel(code));
  channel.emit('docs', repo.listDocs(code));
  channel.emit('doc:edited', edit);
  for (const q of questions) channel.emit('question:update', q);
  const room = repo.getRoom(code)!;
  const doc = repo.getDoc(edit.docId)!;
  if (room.current_doc !== edit.docId) return;
  const page = Math.min(pageAfterEdit(room.current_page, edit), doc.pages);
  if (page === room.current_page) return;
  repo.setRoomPosition(code, edit.docId, page);
  channel.emit('teacher:nav', { docId: edit.docId, page } satisfies Position);
}


/** Sends the file list after a change: the full list to teachers, visible files to everyone else. */
export function notifyFilesChanged(code: string) {
  notifyFileStats(code);
  io.to(roomChannel(code)).except(teachersChannel(code)).emit('files', repo.listFiles(code, false));
}

/** Download counts changed; only teachers see them. */
export function notifyFileStats(code: string) {
  io.to(teachersChannel(code)).emit('files', repo.listFiles(code, true));
}

type Reply = (res: { ok: true; data?: unknown } | { ok: false; error: string }) => void;

export function setupRealtime(server: Server) {
  io = server;

  io.use((socket, next) => {
    // Reject cross-site WebSocket connections.
    const { origin, host } = socket.handshake.headers;
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) return next(new Error('forbidden origin'));
      } catch {
        return next(new Error('forbidden origin'));
      }
    }
    const user = userFromToken(getCookie(socket.handshake.headers.cookie, SESSION_COOKIE));
    if (!user || !repo.getRoom(user.roomCode)) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => onConnection(socket, socket.data.user as SessionUser));
}

function onConnection(socket: Socket, user: SessionUser) {
  const code = user.roomCode;
  const room = roomChannel(code);
  const isTeacher = user.role === 'teacher';

  socket.join([room, userChannel(user.id)]);
  if (isTeacher) socket.join(teachersChannel(code));

  let members = presence.get(code);
  if (!members) presence.set(code, (members = new Map()));
  const entry = members.get(user.id);
  if (entry) entry.sockets++;
  else members.set(user.id, { user, sockets: 1 });

  socket.emit('snapshot', snapshot(user));
  io.to(room).emit('presence', onlineList(code));

  /**
   * Registers a validated event handler. The handler's return value (or what its promise
   * resolves to) is sent back via ack.
   */
  function handle<T extends z.ZodType>(
    event: string,
    schema: T,
    fn: (data: z.infer<T>) => unknown,
    opts: { teacherOnly?: boolean; limiter?: RateLimiter } = {},
  ) {
    socket.on(event, async (raw: unknown, ack?: unknown) => {
      const reply: Reply = typeof ack === 'function' ? (ack as Reply) : () => {};
      try {
        if (opts.teacherOnly && !isTeacher) return reply({ ok: false, error: '강사만 할 수 있어요.' });
        if (opts.limiter && !opts.limiter.hit(String(user.id)))
          return reply({ ok: false, error: '너무 자주 보내고 있어요. 잠시 후 다시 시도하세요.' });
        const parsed = schema.safeParse(raw);
        if (!parsed.success) return reply({ ok: false, error: '잘못된 요청입니다.' });
        reply({ ok: true, data: await fn(parsed.data) });
      } catch (err) {
        if (err instanceof UserError) reply({ ok: false, error: err.message });
        else {
          console.error(`[socket ${event}]`, err);
          reply({ ok: false, error: '서버 오류가 발생했어요.' });
        }
      }
    });
  }

  function roomDoc(docId: string, page?: number) {
    const doc = repo.getDoc(docId);
    if (!doc || doc.room_code !== code) throw new UserError('교안을 찾을 수 없어요.');
    // An HTML 교안 numbers its own slides, so only PDFs have a known page count.
    const pages = doc.kind === 'html' ? LIMITS.htmlPages : doc.pages;
    if (page !== undefined && page > pages) throw new UserError('페이지 범위를 벗어났어요.');
    return doc;
  }

  const myLayer: Layer = isTeacher ? 'teacher' : 'note';
  /** Teacher ink goes to the whole room; personal notes only to the owner's other devices. */
  const layerChannel = isTeacher ? room : userChannel(user.id);

  // ---- 교안 / ink ----

  handle('strokes:get', S.docRefSchema, ({ docId }) => {
    roomDoc(docId);
    return {
      teacher: repo.listStrokes(docId, 'teacher', user.id),
      note: repo.listStrokes(docId, 'note', user.id),
    };
  });

  handle(
    'nav',
    S.navSchema,
    ({ docId, page, html }) => {
      const doc = roomDoc(docId, page);
      const current = repo.getRoom(code)!;
      // Scrolling an HTML 교안 sends many navs; only slide changes need to reach the database.
      if (current.current_doc !== docId || current.current_page !== page) repo.setRoomPosition(code, docId, page);
      const pos: Position = { docId, page };
      if (doc.kind === 'html' && html) {
        pos.html = html;
        htmlPositions.set(code, { docId, html });
      } else htmlPositions.delete(code);
      socket.to(room).emit('teacher:nav', pos);
    },
    { teacherOnly: true },
  );

  socket.on('ink:live', (raw: unknown) => {
    if (!isTeacher) return;
    const parsed = S.liveInkSchema.safeParse(raw);
    if (!parsed.success) return;
    const doc = repo.getDoc(parsed.data.docId);
    if (doc?.room_code !== code) return;
    socket.to(room).emit('ink:live', parsed.data);
  });

  handle('stroke:add', S.strokeSchema, (stroke) => {
    roomDoc(stroke.docId, stroke.page);
    if (!repo.addStroke(stroke, myLayer, user.id)) throw new UserError('이미 저장된 필기입니다.');
    socket.to(layerChannel).emit('stroke:added', { layer: myLayer, stroke });
  });

  handle('stroke:delete', S.strokeIdsSchema, ({ ids }) => {
    const docIds = new Set(repo.listDocs(code).map((d) => d.id));
    const removed = repo.deleteStrokes(ids, myLayer, user.id, docIds);
    if (removed.length) socket.to(layerChannel).emit('stroke:deleted', { layer: myLayer, ids: removed });
    return removed;
  });

  handle('stroke:clear', S.pageRefSchema, ({ docId, page }) => {
    roomDoc(docId, page);
    repo.clearPage(docId, page, myLayer, user.id);
    socket.to(layerChannel).emit('stroke:cleared', { layer: myLayer, docId, page });
  });

  socket.on('laser', (raw: unknown) => {
    if (!isTeacher) return;
    const parsed = S.laserSchema.safeParse(raw);
    if (parsed.success) socket.to(room).volatile.emit('laser', parsed.data);
  });

  // ---- raise hand ----

  handle('hand', S.handSchema, ({ raised }) => {
    let roomHands = hands.get(code);
    if (!roomHands) hands.set(code, (roomHands = new Map()));
    if (raised) roomHands.set(user.id, { userId: user.id, name: user.name, at: Date.now() });
    else roomHands.delete(user.id);
    socket.to(userChannel(user.id)).emit('hand:state', raised);
    broadcastHands(code);
  });

  handle(
    'hand:lower',
    S.lowerHandSchema,
    ({ userId }) => {
      const roomHands = hands.get(code);
      if (!roomHands) return;
      const ids = userId === null ? [...roomHands.keys()] : [userId];
      for (const id of ids) {
        if (roomHands.delete(id)) io.to(userChannel(id)).emit('hand:state', false);
      }
      broadcastHands(code);
    },
    { teacherOnly: true },
  );

  // ---- questions ----

  function ownQuestion(id: number) {
    const found = repo.getQuestion(id, user.id);
    if (!found || found.roomCode !== code) throw new UserError('질문을 찾을 수 없어요.');
    return found;
  }

  handle(
    'question:create',
    S.questionSchema,
    ({ body, anonymous, docId, page }) => {
      const validDoc = docId && repo.getDoc(docId)?.room_code === code ? docId : null;
      const id = repo.createQuestion(code, user.id, body, anonymous, validDoc, validDoc ? page : null);
      // viewerId 0 = an outsider's view: not mine, not liked.
      socket.to(room).emit('question:new', repo.getQuestion(id, 0)!.question);
      return repo.getQuestion(id, user.id)!.question;
    },
    { limiter: questionLimiter },
  );

  handle('question:like', S.questionIdSchema, ({ id }) => {
    ownQuestion(id);
    const liked = repo.toggleLike(id, user.id);
    const likes = repo.getQuestion(id, user.id)!.question.likes;
    socket.to(room).emit('question:update', { id, likes });
    return { liked, likes };
  });

  handle(
    'question:answer',
    S.answerSchema,
    ({ id, answer }) => {
      ownQuestion(id);
      repo.updateAnswer(answer || null, id);
      io.to(room).emit('question:update', { id, answer: answer || null });
    },
    { teacherOnly: true },
  );

  handle(
    'question:resolve',
    S.resolveSchema,
    ({ id, resolved }) => {
      ownQuestion(id);
      repo.updateResolved(resolved ? 1 : 0, id);
      io.to(room).emit('question:update', { id, resolved });
    },
    { teacherOnly: true },
  );

  handle('question:delete', S.questionIdSchema, ({ id }) => {
    const { ownerId } = ownQuestion(id);
    if (!isTeacher && ownerId !== user.id) throw new UserError('내 질문만 삭제할 수 있어요.');
    repo.deleteQuestion(id);
    io.to(room).emit('question:deleted', id);
  });

  screenEvents(socket, user, room, handle);

  // ---- chat ----

  handle(
    'chat:send',
    S.chatSchema,
    ({ body }) => {
      io.to(room).emit('chat:new', repo.createChat(code, user, body));
    },
    { limiter: chatLimiter },
  );

  socket.on('disconnect', () => {
    const e = members!.get(user.id);
    if (e && --e.sockets <= 0) {
      members!.delete(user.id);
      if (hands.get(code)?.delete(user.id)) broadcastHands(code);
    }
    io.to(room).emit('presence', onlineList(code));
  });
}
