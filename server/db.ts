import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import zlib from 'node:zlib';
import type { DocKind } from '../shared/protocol.ts';
import { config } from './config.ts';

export const db = new DatabaseSync(path.join(config.dataDir, 'study.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
  code         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  teacher_pin  TEXT NOT NULL,
  current_doc  TEXT,
  current_page INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code  TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('teacher', 'student')),
  pin        TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (room_code, name, role)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- 교안. file is what the 교안 tab shows: the uploaded PDF, a PDF made from the upload
-- (<id>.r<rev>.pdf), or the entry page of an HTML site (<id>.site/...).
CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'pdf' CHECK (kind IN ('pdf', 'html')),
  file        TEXT NOT NULL,
  pages       INTEGER NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL
);

-- Everything in the 파일 tab. A 교안 PDF has a documents row with the same id.
CREATE TABLE IF NOT EXISTS files (
  id          TEXT PRIMARY KEY,
  room_code   TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  file        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  crc32       INTEGER NOT NULL,
  tag         TEXT,
  hidden      INTEGER NOT NULL DEFAULT 0,
  uploader_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS files_by_room ON files (room_code, uploaded_at);

-- Students who downloaded a file (teacher downloads aren't recorded).
CREATE TABLE IF NOT EXISTS file_downloads (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  count   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (file_id, user_id)
);

CREATE TABLE IF NOT EXISTS strokes (
  id         TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page       INTEGER NOT NULL,
  layer      TEXT NOT NULL CHECK (layer IN ('teacher', 'note')),
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS strokes_by_doc ON strokes (doc_id, layer, owner_id);

CREATE TABLE IF NOT EXISTS questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code  TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anonymous  INTEGER NOT NULL,
  body       TEXT NOT NULL,
  doc_id     TEXT,
  page       INTEGER,
  answer     TEXT,
  resolved   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS question_likes (
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (question_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code  TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_by_room ON chat (room_code, id);
`);

// Columns added after the first release.
for (const [table, column, def] of [
  ['documents', 'kind', "TEXT NOT NULL DEFAULT 'pdf'"],
  ['documents', 'rev', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

/** A prepared statement whose rows are typed as T. */
export function stmt<T = unknown>(sql: string) {
  const s = db.prepare(sql);
  return {
    get: (...args: SQLInputValue[]) => s.get(...args) as T | undefined,
    all: (...args: SQLInputValue[]) => s.all(...args) as T[],
    run: (...args: SQLInputValue[]) => s.run(...args),
  };
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export interface RoomRow {
  code: string;
  title: string;
  teacher_pin: string;
  current_doc: string | null;
  current_page: number;
  created_at: number;
}
export interface UserRow {
  id: number;
  room_code: string;
  name: string;
  role: 'teacher' | 'student';
  pin: string | null;
  created_at: number;
}
export interface DocRow {
  id: string;
  room_code: string;
  name: string;
  kind: DocKind;
  file: string;
  pages: number;
  rev: number;
  uploaded_at: number;
}
export interface FileRow {
  id: string;
  room_code: string;
  name: string;
  file: string;
  size: number;
  crc32: number;
  tag: string | null;
  hidden: number;
  uploader_id: number | null;
  uploaded_at: number;
}

// 교안 PDFs uploaded before the 파일 tab existed get their files row.
{
  const orphans = stmt<DocRow & { teacher_id: number | null }>(
    `SELECT d.*, (SELECT u.id FROM users u WHERE u.room_code = d.room_code AND u.role = 'teacher'
                  ORDER BY u.id LIMIT 1) AS teacher_id
     FROM documents d WHERE d.id NOT IN (SELECT id FROM files)`,
  ).all();
  const insert = db.prepare(
    `INSERT INTO files (id, room_code, name, file, size, crc32, tag, hidden, uploader_id, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  );
  for (const d of orphans) {
    let data: Buffer;
    try {
      data = fs.readFileSync(path.join(config.uploadsDir, d.file));
    } catch {
      console.warn(`[db] 교안 파일이 없어 파일 목록에 추가하지 않았어요: ${d.file}`);
      continue;
    }
    insert.run(d.id, d.room_code, `${d.name}.pdf`, d.file, data.length, zlib.crc32(data), d.teacher_id, d.uploaded_at);
  }
}
