// Read/write helpers that map database rows to protocol objects.
import type {
  ChatMessage,
  DocInfo,
  DocKind,
  FileDownloads,
  FileInfo,
  Layer,
  Question,
  Role,
  Stroke,
} from '../shared/protocol.ts';
import { stmt, transaction, type DocRow, type FileRow, type RoomRow } from './db.ts';

export const getRoom = stmt<RoomRow>('SELECT * FROM rooms WHERE code = ?').get;

export const getDoc = stmt<DocRow>('SELECT * FROM documents WHERE id = ?').get;

const selectDocs = stmt<DocRow>('SELECT * FROM documents WHERE room_code = ? ORDER BY uploaded_at');
export const toDocInfo = (d: DocRow): DocInfo => ({
  id: d.id,
  name: d.name,
  kind: d.kind,
  pages: d.pages,
  rev: d.rev,
  uploadedAt: d.uploaded_at,
});
export const listDocs = (roomCode: string) => selectDocs.all(roomCode).map(toDocInfo);

const insertDoc = stmt(
  'INSERT INTO documents (id, room_code, name, kind, file, pages, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
/** Registers an upload (already in `files`) as a 교안 with the same id. `file` is what the 교안 tab shows. */
export const createDoc = (f: FileRow, kind: DocKind, file: string, pages: number) =>
  insertDoc.run(f.id, f.room_code, docName(f.name), kind, file, pages, f.uploaded_at);
/** 교안 title shown in the lecture tab: the filename without its extension. */
export const docName = (fileName: string) => fileName.replace(/\.[a-z0-9]{1,5}$/i, '') || '교안';
export const renameDoc = stmt('UPDATE documents SET name = ? WHERE id = ?').run;

const updateDocFile = stmt('UPDATE documents SET file = ?, pages = ?, rev = rev + 1 WHERE id = ?');
const shiftStrokes = stmt(
  `UPDATE strokes SET page = page + ?1, data = json_set(data, '$.page', page + ?1) WHERE doc_id = ?2 AND page >= ?3`,
);
const deletePageStrokes = stmt('DELETE FROM strokes WHERE doc_id = ? AND page = ?');
const shiftQuestions = stmt('UPDATE questions SET page = page + ?1 WHERE doc_id = ?2 AND page >= ?3');
const unlinkQuestions = stmt('UPDATE questions SET page = NULL WHERE doc_id = ? AND page = ?');
const selectQuestionPages = stmt<{ id: number; page: number | null }>(
  'SELECT id, page FROM questions WHERE doc_id = ? AND (page IS NULL OR page >= ?)',
);

/**
 * Records that a page was inserted (delta 1, the new page is `at`) or deleted (delta -1) in a PDF 교안
 * now stored in `file`. Ink and question links on later pages move with their page; those on a deleted
 * page are removed. Returns the questions whose page changed.
 */
export function editPages(docId: string, at: number, delta: 1 | -1, file: string, pages: number) {
  return transaction(() => {
    if (delta < 0) {
      deletePageStrokes.run(docId, at);
      unlinkQuestions.run(docId, at);
    }
    const from = delta > 0 ? at : at + 1;
    shiftStrokes.run(delta, docId, from);
    shiftQuestions.run(delta, docId, from);
    updateDocFile.run(file, pages, docId);
    return selectQuestionPages.all(docId, Math.min(at, from));
  });
}

const updatePosition = stmt('UPDATE rooms SET current_doc = ?, current_page = ? WHERE code = ?');
export const setRoomPosition = (roomCode: string, docId: string | null, page: number) =>
  updatePosition.run(docId, page, roomCode);

// ---- shared files ----

export const getFile = stmt<FileRow>('SELECT * FROM files WHERE id = ?').get;

const insertFileRow = stmt(
  `INSERT INTO files (id, room_code, name, file, size, crc32, tag, hidden, uploader_id, uploaded_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
export function insertFile(f: FileRow) {
  insertFileRow.run(f.id, f.room_code, f.name, f.file, f.size, f.crc32, f.tag, f.hidden, f.uploader_id, f.uploaded_at);
}

export const updateFile = stmt('UPDATE files SET name = ?, tag = ?, hidden = ? WHERE id = ?').run;

const deleteDocRow = stmt('DELETE FROM documents WHERE id = ?');
const deleteFileRow = stmt('DELETE FROM files WHERE id = ?');
/** Removes a file and, if it is a 교안, the document with its strokes. */
export const deleteFileAndDoc = (id: string) =>
  transaction(() => {
    deleteDocRow.run(id);
    deleteFileRow.run(id);
  });

const selectFiles = stmt<FileRow & { uploader: string | null; is_doc: number; downloads: number }>(
  `SELECT f.*, u.name AS uploader,
     EXISTS (SELECT 1 FROM documents d WHERE d.id = f.id) AS is_doc,
     (SELECT COUNT(*) FROM file_downloads dl WHERE dl.file_id = f.id) AS downloads
   FROM files f LEFT JOIN users u ON u.id = f.uploader_id
   WHERE f.room_code = ? ORDER BY f.uploaded_at DESC, f.rowid DESC`,
);
/** Files as a teacher sees them, or (forTeacher = false) as students see them. */
export function listFiles(roomCode: string, forTeacher: boolean): FileInfo[] {
  return selectFiles
    .all(roomCode)
    .filter((r) => forTeacher || !r.hidden)
    .map((r) => ({
      id: r.id,
      name: r.name,
      size: r.size,
      tag: r.tag,
      uploader: r.uploader,
      uploadedAt: r.uploaded_at,
      isDoc: r.is_doc === 1,
      hidden: forTeacher && r.hidden === 1,
      downloads: forTeacher ? r.downloads : null,
    }));
}

const upsertDownload = stmt(
  `INSERT INTO file_downloads (file_id, user_id, at) VALUES (?, ?, ?)
   ON CONFLICT (file_id, user_id) DO UPDATE SET count = count + 1`,
);
export function recordDownloads(fileIds: string[], userId: number) {
  const now = Date.now();
  transaction(() => {
    for (const id of fileIds) upsertDownload.run(id, userId, now);
  });
}

const selectMyDownloads = stmt<{ file_id: string }>(
  `SELECT dl.file_id FROM file_downloads dl JOIN files f ON f.id = dl.file_id
   WHERE f.room_code = ? AND dl.user_id = ?`,
);
export const listMyDownloads = (roomCode: string, userId: number) =>
  selectMyDownloads.all(roomCode, userId).map((r) => r.file_id);

const selectDownloaders = stmt<{ name: string; at: number }>(
  `SELECT u.name, dl.at FROM file_downloads dl JOIN users u ON u.id = dl.user_id
   WHERE dl.file_id = ? ORDER BY dl.at`,
);
const selectPending = stmt<{ name: string }>(
  `SELECT name FROM users WHERE room_code = ? AND role = 'student'
     AND id NOT IN (SELECT user_id FROM file_downloads WHERE file_id = ?)
   ORDER BY name`,
);
export const fileDownloads = (f: FileRow): FileDownloads => ({
  downloaded: selectDownloaders.all(f.id),
  pending: selectPending.all(f.room_code, f.id).map((r) => r.name),
});

// ---- strokes ----

const selectStrokes = stmt<{ data: string }>(
  `SELECT data FROM strokes WHERE doc_id = ? AND layer = ? AND (layer = 'teacher' OR owner_id = ?)
   ORDER BY created_at, rowid`,
);
export const listStrokes = (docId: string, layer: Layer, ownerId: number): Stroke[] =>
  selectStrokes.all(docId, layer, ownerId).map((r) => JSON.parse(r.data) as Stroke);

const selectStrokeOwner = stmt<{ layer: Layer; owner_id: number; doc_id: string }>(
  'SELECT layer, owner_id, doc_id FROM strokes WHERE id = ?',
);
const insertStroke = stmt(
  'INSERT INTO strokes (id, doc_id, page, layer, owner_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
/** Inserts a stroke. Returns false if the id is already taken. */
export function addStroke(stroke: Stroke, layer: Layer, ownerId: number): boolean {
  if (selectStrokeOwner.get(stroke.id)) return false;
  insertStroke.run(stroke.id, stroke.docId, stroke.page, layer, ownerId, JSON.stringify(stroke), Date.now());
  return true;
}

const deleteTeacherStroke = stmt(`DELETE FROM strokes WHERE id = ? AND layer = 'teacher' AND doc_id = ?`);
const deleteNoteStroke = stmt(`DELETE FROM strokes WHERE id = ? AND layer = 'note' AND owner_id = ?`);
/** Deletes strokes the caller is allowed to delete; returns the ids actually removed. */
export function deleteStrokes(ids: string[], layer: Layer, ownerId: number, roomDocIds: Set<string>): string[] {
  const removed: string[] = [];
  for (const id of ids) {
    const row = selectStrokeOwner.get(id);
    if (!row || row.layer !== layer || !roomDocIds.has(row.doc_id)) continue;
    const res =
      layer === 'teacher' ? deleteTeacherStroke.run(id, row.doc_id) : deleteNoteStroke.run(id, ownerId);
    if (res.changes > 0) removed.push(id);
  }
  return removed;
}

const clearTeacherPage = stmt(`DELETE FROM strokes WHERE doc_id = ? AND page = ? AND layer = 'teacher'`);
const clearNotePage = stmt(`DELETE FROM strokes WHERE doc_id = ? AND page = ? AND layer = 'note' AND owner_id = ?`);
export function clearPage(docId: string, page: number, layer: Layer, ownerId: number) {
  if (layer === 'teacher') clearTeacherPage.run(docId, page);
  else clearNotePage.run(docId, page, ownerId);
}

// ---- questions ----

interface QuestionRow {
  id: number;
  room_code: string;
  user_id: number;
  anonymous: number;
  body: string;
  doc_id: string | null;
  page: number | null;
  answer: string | null;
  resolved: number;
  created_at: number;
  author_name: string;
  likes: number;
  liked_by_me: number;
}

const QUESTION_SELECT = `
  SELECT q.*, u.name AS author_name,
    (SELECT COUNT(*) FROM question_likes l WHERE l.question_id = q.id) AS likes,
    EXISTS (SELECT 1 FROM question_likes l WHERE l.question_id = q.id AND l.user_id = ?) AS liked_by_me
  FROM questions q JOIN users u ON u.id = q.user_id`;
const selectQuestions = stmt<QuestionRow>(`${QUESTION_SELECT} WHERE q.room_code = ? ORDER BY q.id`);
const selectQuestion = stmt<QuestionRow>(`${QUESTION_SELECT} WHERE q.id = ?`);

function toQuestion(r: QuestionRow, viewerId: number): Question {
  const anonymous = r.anonymous === 1;
  return {
    id: r.id,
    body: r.body,
    authorId: anonymous ? null : r.user_id,
    authorName: anonymous ? null : r.author_name,
    createdAt: r.created_at,
    likes: r.likes,
    likedByMe: r.liked_by_me === 1,
    mine: r.user_id === viewerId,
    docId: r.doc_id,
    page: r.page,
    answer: r.answer,
    resolved: r.resolved === 1,
  };
}

export const listQuestions = (roomCode: string, viewerId: number) =>
  selectQuestions.all(viewerId, roomCode).map((r) => toQuestion(r, viewerId));

/** Returns the question as seen by `viewerId` plus its raw owner and room. */
export function getQuestion(id: number, viewerId: number) {
  const r = selectQuestion.get(viewerId, id);
  if (!r) return null;
  return { question: toQuestion(r, viewerId), ownerId: r.user_id, roomCode: r.room_code };
}

const insertQuestion = stmt(
  'INSERT INTO questions (room_code, user_id, anonymous, body, doc_id, page, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
export function createQuestion(
  roomCode: string,
  userId: number,
  body: string,
  anonymous: boolean,
  docId: string | null,
  page: number | null,
): number {
  return Number(
    insertQuestion.run(roomCode, userId, anonymous ? 1 : 0, body, docId, page, Date.now()).lastInsertRowid,
  );
}

const insertLike = stmt('INSERT OR IGNORE INTO question_likes (question_id, user_id) VALUES (?, ?)');
const deleteLike = stmt('DELETE FROM question_likes WHERE question_id = ? AND user_id = ?');
export function toggleLike(questionId: number, userId: number): boolean {
  if (deleteLike.run(questionId, userId).changes > 0) return false;
  insertLike.run(questionId, userId);
  return true;
}

export const updateAnswer = stmt('UPDATE questions SET answer = ? WHERE id = ?').run;
export const updateResolved = stmt('UPDATE questions SET resolved = ? WHERE id = ?').run;
export const deleteQuestion = stmt('DELETE FROM questions WHERE id = ?').run;

// ---- chat ----

interface ChatRow {
  id: number;
  user_id: number;
  name: string;
  role: Role;
  body: string;
  created_at: number;
}
const selectChat = stmt<ChatRow>(
  `SELECT * FROM (
     SELECT c.id, c.user_id, u.name, u.role, c.body, c.created_at
     FROM chat c JOIN users u ON u.id = c.user_id WHERE c.room_code = ? ORDER BY c.id DESC LIMIT 200
   ) ORDER BY id`,
);
const toChat = (r: ChatRow): ChatMessage => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  role: r.role,
  body: r.body,
  createdAt: r.created_at,
});
export const listChat = (roomCode: string) => selectChat.all(roomCode).map(toChat);

const insertChat = stmt('INSERT INTO chat (room_code, user_id, body, created_at) VALUES (?, ?, ?, ?)');
export function createChat(roomCode: string, user: { id: number; name: string; role: Role }, body: string): ChatMessage {
  const createdAt = Date.now();
  const id = Number(insertChat.run(roomCode, user.id, body, createdAt).lastInsertRowid);
  return { id, userId: user.id, name: user.name, role: user.role, body, createdAt };
}
