import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { PDFDocument } from 'pdf-lib';
import { fileExt, IMAGE_MIME, lectureSource, previewKind } from '../shared/files.ts';
import { LIMITS, type DocKind } from '../shared/protocol.ts';
import {
  createSession,
  destroySession,
  getCookie,
  hashSecret,
  RateLimiter,
  SESSION_COOKIE,
  SESSION_MAX_AGE_MS,
  userFromToken,
  verifySecret,
  type SessionUser,
} from './auth.ts';
import { askAi } from './ai.ts';
import { config } from './config.ts';
import { blankPdf, deletePage, imagesToPdf, insertPage, officeToPdf, type ImageFile } from './convert.ts';
import { stmt, transaction, type DocRow, type FileRow, type UserRow } from './db.ts';
import { ApiError } from './errors.ts';
import { notifyDocEdited, notifyDocsChanged, notifyFilesChanged, notifyFileStats } from './realtime.ts';
import * as repo from './repo.ts';
import * as S from './schemas.ts';
import { serveSite, siteDirName, siteUrl, storeSite } from './site.ts';
import { zipSize, zipStream, type ZipEntry } from './zip.ts';

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}

const insertRoom = stmt('INSERT INTO rooms (code, title, teacher_pin, created_at) VALUES (?, ?, ?, ?)');
const selectUser = stmt<UserRow>('SELECT * FROM users WHERE room_code = ? AND name = ? AND role = ?');
const insertUser = stmt('INSERT INTO users (room_code, name, role, pin, created_at) VALUES (?, ?, ?, ?, ?)');

/** Failed PIN attempts per client IP + room. */
const loginLimiter = new RateLimiter(10, 10 * 60_000);
const roomCreateLimiter = new RateLimiter(20, 60 * 60_000);
const aiLimiter = new RateLimiter(10, 60_000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 },
});
/** 교안 uploads may hold several images, which become one PDF. */
const lectureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: LIMITS.lectureImages },
});

function fail(res: Response, status: number, error: string) {
  res.status(status).json({ error });
}

function setSessionCookie(req: Request, res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

function requireUser(req: Request, res: Response, next: NextFunction) {
  const user = userFromToken(getCookie(req.headers.cookie, SESSION_COOKIE));
  if (!user) return fail(res, 401, '로그인이 필요해요.');
  req.user = user;
  next();
}

function requireTeacher(req: Request, res: Response, next: NextFunction) {
  if (req.user?.role !== 'teacher') return fail(res, 403, '강사만 할 수 있어요.');
  next();
}

function generateRoomCode(): string {
  for (;;) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!repo.getRoom(code)) return code;
  }
}

/** Multer decodes multipart filenames as latin1; recover UTF-8 names (e.g. Korean). */
function decodeFilename(name: string): string {
  if (/[^\u0000-ÿ]/.test(name)) return name;
  return Buffer.from(name, 'latin1').toString('utf8');
}

/** A safe display/download name: no directories or control characters, extension kept when shortened. */
function cleanFilename(raw: string): string {
  const name = (decodeFilename(raw).split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name) return 'file';
  if (name.length <= LIMITS.fileNameLen) return name;
  const ext = fileExt(name).slice(0, 10);
  return ext ? `${name.slice(0, LIMITS.fileNameLen - ext.length - 1)}.${ext}` : name.slice(0, LIMITS.fileNameLen);
}

/** Content-Disposition with a UTF-8 filename (RFC 6266) and an ASCII fallback for old clients. */
function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** `name`, or `name (2)`, `name (3)`… if already used (case-insensitively, as on Windows). */
function uniqueName(name: string, used: Set<string>): string {
  const ext = fileExt(name);
  const base = ext ? name.slice(0, -ext.length - 1) : name;
  let candidate = name;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = ext ? `${base} (${i}).${ext}` : `${base} (${i})`;
  used.add(candidate.toLowerCase());
  return candidate;
}

const isPdfData = (buf: Buffer) => buf.subarray(0, 5).toString('latin1') === '%PDF-';

async function pdfPageCount(buf: Buffer): Promise<number> {
  if (!isPdfData(buf)) throw new ApiError(400, '올바른 PDF 파일이 아니에요.');
  let pages: number;
  try {
    const pdf = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    pages = pdf.getPageCount();
  } catch {
    throw new ApiError(400, 'PDF를 읽을 수 없어요. 파일이 손상되었는지 확인하세요.');
  }
  if (pages < 1) throw new ApiError(400, '페이지가 없는 PDF예요.');
  return pages;
}

const newId = () => crypto.randomBytes(12).toString('base64url');
const uploadPath = (file: string) => path.join(config.uploadsDir, file);

/** Saves an upload as `<id>.<ext>` in the uploads folder and returns that name. */
async function writeUpload(id: string, name: string, data: Buffer): Promise<string> {
  const ext = fileExt(name).replace(/[^a-z0-9]/g, '').slice(0, 10);
  const file = ext ? `${id}.${ext}` : id;
  await fs.writeFile(uploadPath(file), data);
  return file;
}

function fileRow(user: SessionUser, id: string, file: string, name: string, data: Buffer, tag: string | null, hidden: boolean): FileRow {
  return {
    id,
    room_code: user.roomCode,
    name,
    file,
    size: data.length,
    crc32: zlib.crc32(data),
    tag,
    hidden: hidden ? 1 : 0,
    uploader_id: user.id,
    uploaded_at: Date.now(),
  };
}

/** Writes an upload to disk and adds its files row. */
async function storeFile(
  user: SessionUser,
  data: Buffer,
  name: string,
  tag: string | null,
  hidden: boolean,
): Promise<FileRow> {
  const id = newId();
  const row = fileRow(user, id, await writeUpload(id, name, data), name, data, tag, hidden);
  repo.insertFile(row);
  return row;
}

/** The PDF a 교안 shows when it isn't the upload itself, at a revision (bumped by page edits). */
const lecturePdf = (id: string, rev: number) => `${id}.r${rev}.pdf`;

/** Deletes stored files of an upload id (never anything outside the uploads folder) and its HTML site. */
async function removeStored(id: string, files: (string | undefined)[]) {
  for (const file of new Set(files)) {
    if (file && !file.startsWith(`${siteDirName(id)}/`)) await fs.rm(uploadPath(file), { force: true });
  }
  await fs.rm(uploadPath(siteDirName(id)), { recursive: true, force: true });
}

/** Deletes a file (and its 교안, strokes and download records) from the DB and disk. */
async function removeFile(id: string) {
  const f = repo.getFile(id);
  const doc = repo.getDoc(id);
  const roomCode = f?.room_code ?? doc?.room_code;
  if (!roomCode) return;
  repo.deleteFileAndDoc(id);
  await removeStored(id, [f?.file, doc?.file]);
  if (doc) notifyDocsChanged(roomCode);
  notifyFilesChanged(roomCode);
}

interface Lecture {
  kind: DocKind;
  file: string;
  pages: number;
}

/**
 * Builds what the 교안 tab shows for an upload already saved as `stored`: a PDF as it is,
 * images and Office files converted to PDF, an HTML page or ZIP unpacked as a live site.
 */
async function prepareLecture(id: string, name: string, data: Buffer, stored: string): Promise<Lecture> {
  const save = async (pdf: Buffer): Promise<Lecture> => {
    const pages = await pdfPageCount(pdf);
    await fs.writeFile(uploadPath(lecturePdf(id, 0)), pdf);
    return { kind: 'pdf', file: lecturePdf(id, 0), pages };
  };
  switch (lectureSource(name)) {
    case 'pdf':
      return { kind: 'pdf', file: stored, pages: await pdfPageCount(data) };
    case 'image':
      return save(await imagesToPdf([{ data, ext: fileExt(name) }]));
    case 'office':
      return save(await officeToPdf(uploadPath(stored)));
    case 'html':
    case 'zip':
      return { kind: 'html', file: await storeSite(id, name, data), pages: 1 };
    default:
      throw new ApiError(415, '교안으로 쓸 수 없는 형식이에요. PDF, PPT, 워드, 엑셀, 이미지, HTML(또는 ZIP)을 올려 주세요.');
  }
}

interface Upload {
  name: string;
  data: Buffer;
}

/**
 * Adds a 교안 and its 파일 entry. Several uploads must all be images; they become one PDF with
 * a page each, which is also what the 파일 tab offers.
 */
async function createLecture(user: SessionUser, uploads: Upload[], tag: string | null = null): Promise<DocRow> {
  let { name, data } = uploads[0];
  if (uploads.length > 1) {
    if (uploads.some((u) => lectureSource(u.name) !== 'image'))
      throw new ApiError(400, '여러 파일을 한 교안으로 묶을 수 있는 건 이미지(PNG·JPG)뿐이에요.');
    data = await imagesToPdf(uploads.map((u): ImageFile => ({ data: u.data, ext: fileExt(u.name) })));
    name = cleanFilename(`${repo.docName(name)} 외 ${uploads.length - 1}장.pdf`);
  }
  const id = newId();
  const stored = await writeUpload(id, name, data);
  try {
    const lecture = await prepareLecture(id, name, data, stored);
    const row = fileRow(user, id, stored, name, data, tag, false);
    transaction(() => {
      repo.insertFile(row);
      repo.createDoc(row, lecture.kind, lecture.file, lecture.pages);
    });
  } catch (err) {
    await removeStored(id, [stored, lecturePdf(id, 0)]);
    throw err;
  }
  notifyDocsChanged(user.roomCode);
  notifyFilesChanged(user.roomCode);
  return repo.getDoc(id)!;
}

// Each page edit reads and rewrites the whole PDF, so edits of one 교안 run one at a time.
const editQueues = new Map<string, Promise<unknown>>();

/** Inserts (delta 1, the new page becomes `at`) or deletes (delta -1) a page of a PDF 교안. */
function editPages(
  docId: string,
  at: number,
  delta: 1 | -1,
  edit: (pdf: Buffer, at: number) => Promise<{ data: Buffer; pages: number }>,
): Promise<DocRow> {
  const run = async () => {
    const doc = repo.getDoc(docId);
    if (!doc) throw new ApiError(404, '교안을 찾을 수 없어요.');
    if (doc.kind !== 'pdf') throw new ApiError(400, 'HTML 교안은 페이지를 추가하거나 지울 수 없어요.');
    if (at > doc.pages + (delta > 0 ? 1 : 0)) throw new ApiError(400, '페이지 범위를 벗어났어요.');
    const result = await edit(await fs.readFile(uploadPath(doc.file)), at);
    const file = lecturePdf(doc.id, doc.rev + 1);
    await fs.writeFile(uploadPath(file), result.data);
    const questions = repo.editPages(doc.id, at, delta, file, result.pages);
    // The previous PDF can go unless it's the original upload, which the 파일 tab still offers.
    if (doc.file !== repo.getFile(doc.id)?.file) await fs.rm(uploadPath(doc.file), { force: true });
    notifyDocEdited(doc.room_code, { docId: doc.id, at, delta }, questions);
    return repo.getDoc(doc.id)!;
  };
  const next = (editQueues.get(docId) ?? Promise.resolve()).then(run, run);
  const settled = next.catch(() => {});
  editQueues.set(docId, settled);
  void settled.then(() => editQueues.get(docId) === settled && editQueues.delete(docId));
  return next;
}

export function createApi() {
  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));

  api.get('/config', (_req, res) => {
    res.json({ adminRequired: !!config.adminPassword });
  });

  api.get('/rooms/:code', (req, res) => {
    const room = repo.getRoom(req.params.code);
    if (!room) return fail(res, 404, '수업을 찾을 수 없어요.');
    res.json({ code: room.code, title: room.title });
  });

  api.post('/rooms', (req, res) => {
    const parsed = S.createRoomSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '입력값을 확인해 주세요. (PIN은 4자 이상)');
    const { title, teacherName, teacherPin, adminPassword } = parsed.data;
    if (!roomCreateLimiter.hit(req.ip ?? '')) return fail(res, 429, '잠시 후 다시 시도하세요.');
    if (config.adminPassword && adminPassword !== config.adminPassword)
      return fail(res, 403, '관리자 비밀번호가 올바르지 않아요.');
    const code = parsed.data.code || generateRoomCode();
    if (repo.getRoom(code)) return fail(res, 409, '이미 사용 중인 수업 코드예요.');

    const userId = transaction(() => {
      insertRoom.run(code, title, hashSecret(teacherPin), Date.now());
      return Number(insertUser.run(code, teacherName, 'teacher', null, Date.now()).lastInsertRowid);
    });
    setSessionCookie(req, res, createSession(userId));
    res.json({ code });
  });

  api.post('/join', (req, res) => {
    const parsed = S.joinSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '입력값을 확인해 주세요.');
    const { code, name, role, pin } = parsed.data;
    const room = repo.getRoom(code);
    if (!room) return fail(res, 404, '수업을 찾을 수 없어요.');

    const limitKey = `${req.ip}:${code}`;
    if (loginLimiter.isBlocked(limitKey)) return fail(res, 429, '시도가 너무 많아요. 10분 후 다시 시도하세요.');
    const rejectPin = (msg: string) => {
      loginLimiter.hit(limitKey);
      fail(res, 403, msg);
    };

    let user = selectUser.get(code, name, role);
    if (role === 'teacher') {
      if (!pin || !verifySecret(pin, room.teacher_pin)) return rejectPin('강사 PIN이 올바르지 않아요.');
    } else if (user?.pin) {
      if (!pin || !verifySecret(pin, user.pin))
        return rejectPin('이미 사용 중인 이름이에요. 처음 입장할 때 정한 비밀번호를 입력하세요.');
    }

    if (!user) {
      const studentPin = role === 'student' && pin ? hashSecret(pin) : null;
      if (role === 'student' && pin && pin.length < 4) return fail(res, 400, '비밀번호는 4자 이상이어야 해요.');
      const id = Number(insertUser.run(code, name, role, studentPin, Date.now()).lastInsertRowid);
      user = { id } as UserRow;
    }
    setSessionCookie(req, res, createSession(user.id));
    res.json({ code });
  });

  api.get('/session', (req, res) => {
    const user = userFromToken(getCookie(req.headers.cookie, SESSION_COOKIE));
    const room = user && repo.getRoom(user.roomCode);
    if (!user || !room) return res.json({ user: null, room: null });
    res.json({ user, room: { code: room.code, title: room.title } });
  });

  api.post('/logout', (req, res) => {
    destroySession(getCookie(req.headers.cookie, SESSION_COOKIE));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // ---- documents (교안) ----

  /** The 교안 named in the URL, if it belongs to the caller's class. */
  function roomDoc(req: Request, res: Response) {
    const doc = repo.getDoc(String(req.params.id));
    if (!doc || doc.room_code !== req.user!.roomCode) {
      fail(res, 404, '교안을 찾을 수 없어요.');
      return null;
    }
    return doc;
  }

  /** New 교안 from a PDF, an Office file, an HTML page or ZIP, or several images (one page each). */
  api.post('/docs', requireUser, requireTeacher, lectureUpload.array('file'), async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (!files.length) return fail(res, 400, '교안으로 올릴 파일을 선택하세요.');
    const uploads = files.map((f) => ({ name: cleanFilename(f.originalname), data: f.buffer }));
    // A PDF that lost its extension still works.
    const [first] = uploads;
    if (uploads.length === 1 && !lectureSource(first.name) && isPdfData(first.data)) first.name += '.pdf';
    res.json(repo.toDocInfo(await createLecture(req.user!, uploads)));
  });

  /** New whiteboard 교안: blank, squared or lined pages to write on. */
  api.post('/docs/blank', requireUser, requireTeacher, async (req, res) => {
    const parsed = S.blankDocSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '입력값을 확인해 주세요.');
    const { name, pages, paper } = parsed.data;
    const data = await blankPdf(pages, paper);
    res.json(repo.toDocInfo(await createLecture(req.user!, [{ name: cleanFilename(`${name}.pdf`), data }])));
  });

  api.get('/docs/:id/file', requireUser, (req, res) => {
    const doc = roomDoc(req, res);
    if (!doc) return;
    if (doc.kind !== 'pdf') return fail(res, 404, 'PDF 교안이 아니에요.');
    const headers: Record<string, string> = {
      'Content-Type': 'application/pdf',
      // The client adds ?v=<rev>, so a page edit gets a fresh URL.
      'Cache-Control': 'private, max-age=86400',
    };
    if (req.query.download) headers['Content-Disposition'] = contentDisposition('attachment', `${doc.name}.pdf`);
    res.sendFile(uploadPath(doc.file), { headers });
  });

  /** Where the sandboxed frame loads an HTML 교안 from (a signed URL, since the frame sends no cookies). */
  api.get('/docs/:id/site', requireUser, (req, res) => {
    const doc = roomDoc(req, res);
    if (!doc) return;
    if (doc.kind !== 'html') return fail(res, 400, 'HTML 교안이 아니에요.');
    res.json({ url: siteUrl(doc) });
  });

  /** Inserts a page so it becomes page `at`: blank paper, or the uploaded image (e.g. a pasted screenshot). */
  api.post('/docs/:id/pages', requireUser, requireTeacher, upload.single('image'), async (req, res) => {
    const doc = roomDoc(req, res);
    if (!doc) return;
    const parsed = S.insertPageSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '입력값을 확인해 주세요.');
    let image: ImageFile | null = null;
    if (req.file) {
      const ext = fileExt(cleanFilename(req.file.originalname));
      if (lectureSource(`x.${ext}`) !== 'image') return fail(res, 400, 'PNG나 JPG 이미지만 페이지로 넣을 수 있어요.');
      image = { data: req.file.buffer, ext };
    }
    const { at, paper } = parsed.data;
    const updated = await editPages(doc.id, at, 1, (pdf) => insertPage(pdf, at, image ? { image } : { paper }));
    res.json(repo.toDocInfo(updated));
  });

  api.delete('/docs/:id/pages/:page', requireUser, requireTeacher, async (req, res) => {
    const doc = roomDoc(req, res);
    if (!doc) return;
    const page = Number(req.params.page);
    if (!Number.isInteger(page) || page < 1) return fail(res, 400, '페이지 번호가 올바르지 않아요.');
    res.json(repo.toDocInfo(await editPages(doc.id, page, -1, deletePage)));
  });

  api.delete('/docs/:id', requireUser, requireTeacher, async (req, res) => {
    const doc = roomDoc(req, res);
    if (!doc) return;
    await removeFile(doc.id);
    res.json({ ok: true });
  });

  // No requireUser: the sandboxed frame sends no cookies. The path carries a signed token instead.
  api.get('/site/:id/:token/{*path}', serveSite);

  // ---- shared files (파일 tab) ----

  /** The file named in the URL, if the caller may see it (students can't see hidden files). */
  function visibleFile(req: Request, res: Response) {
    const f = repo.getFile(String(req.params.id));
    const user = req.user!;
    if (!f || f.room_code !== user.roomCode || (f.hidden && user.role !== 'teacher')) {
      fail(res, 404, '파일을 찾을 수 없어요.');
      return null;
    }
    return f;
  }

  /** Counts a student's download. Resumed requests (a Range not starting at 0) don't count again. */
  function countDownload(req: Request, fileIds: string[]) {
    const user = req.user!;
    if (user.role !== 'student' || /^bytes=(?!0-)/.test(req.headers.range ?? '')) return;
    repo.recordDownloads(fileIds, user.id);
    notifyFileStats(user.roomCode);
  }

  api.post('/files', requireUser, requireTeacher, upload.single('file'), async (req, res) => {
    const file = req.file;
    if (!file) return fail(res, 400, '파일을 선택하세요.');
    const parsed = S.fileUploadSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '입력값을 확인해 주세요.');
    const name = cleanFilename(file.originalname);
    const tag = parsed.data.tag ?? null;
    if (parsed.data.asDoc === '1' && lectureSource(name)) {
      // 교안 are always visible: students need them in the 교안 tab anyway.
      const doc = await createLecture(req.user!, [{ name, data: file.buffer }], tag);
      return res.json({ id: doc.id });
    }
    const row = await storeFile(req.user!, file.buffer, name, tag, parsed.data.hidden === '1');
    notifyFilesChanged(row.room_code);
    res.json({ id: row.id });
  });

  api.get('/files/zip', requireUser, async (req, res) => {
    const parsed = S.zipQuerySchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, '잘못된 요청입니다.');
    const user = req.user!;
    const rows = [...new Set(parsed.data.ids)]
      .map((id) => repo.getFile(id))
      .filter((f): f is FileRow => !!f && f.room_code === user.roomCode && (!f.hidden || user.role === 'teacher'));

    const used = new Set<string>();
    const entries: ZipEntry[] = [];
    for (const f of rows) {
      const filePath = path.join(config.uploadsDir, f.file);
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.size !== f.size) continue;
      entries.push({ name: uniqueName(f.name, used), path: filePath, size: f.size, crc32: f.crc32, mtime: f.uploaded_at });
    }
    if (!entries.length) return fail(res, 404, '받을 파일이 없어요.');
    const size = zipSize(entries);
    if (size === null) return fail(res, 413, '한 번에 받기에는 너무 커요. 나눠서 받으세요.');

    countDownload(req, rows.map((f) => f.id));
    const title = repo
      .getRoom(user.roomCode)!
      .title.replace(/[\\/:*?"<>|\s]+/g, ' ')
      .trim();
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': size,
      'Content-Disposition': contentDisposition('attachment', `${title || '수업'}_파일.zip`),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    try {
      await pipeline(zipStream(entries), res);
    } catch {
      // The browser cancelled the download.
    }
  });

  api.get('/files/:id/download', requireUser, (req, res) => {
    const f = visibleFile(req, res);
    if (!f) return;
    countDownload(req, [f.id]);
    res.sendFile(path.join(config.uploadsDir, f.file), {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition('attachment', f.name),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-cache',
      },
    });
  });

  /** Inline view for previews. Text is always sent as sandboxed text/plain, so uploaded HTML can't run. */
  api.get('/files/:id/view', requireUser, (req, res) => {
    const f = visibleFile(req, res);
    if (!f) return;
    const kind = previewKind(f.name);
    if (!kind) return fail(res, 415, '미리보기를 지원하지 않는 파일이에요.');
    const headers: Record<string, string> = {
      'Content-Type':
        kind === 'image' ? IMAGE_MIME[fileExt(f.name)] : kind === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8',
      'Content-Disposition': contentDisposition('inline', f.name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    };
    // Chrome won't render a PDF in a sandboxed document; its PDF viewer is isolated anyway.
    if (kind !== 'pdf') headers['Content-Security-Policy'] = 'sandbox';
    res.sendFile(path.join(config.uploadsDir, f.file), { headers });
  });

  api.get('/files/:id/downloads', requireUser, requireTeacher, (req, res) => {
    const f = visibleFile(req, res);
    if (f) res.json(repo.fileDownloads(f));
  });

  api.patch('/files/:id', requireUser, requireTeacher, (req, res) => {
    const f = visibleFile(req, res);
    if (!f) return;
    const parsed = S.fileUpdateSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '입력값을 확인해 주세요.');
    const isDoc = !!repo.getDoc(f.id);
    const { tag = f.tag, hidden = f.hidden === 1 } = parsed.data;
    if (hidden && isDoc) return fail(res, 400, '교안은 숨길 수 없어요.');
    let name = parsed.data.name ? cleanFilename(parsed.data.name) : f.name;
    // The extension decides the file type, so renaming keeps it.
    const ext = fileExt(f.name);
    if (ext && fileExt(name) !== ext) name = `${name}.${ext}`;
    repo.updateFile(name, tag, hidden ? 1 : 0, f.id);
    if (isDoc && name !== f.name) {
      repo.renameDoc(repo.docName(name), f.id);
      notifyDocsChanged(f.room_code);
    }
    notifyFilesChanged(f.room_code);
    res.json({ ok: true });
  });

  /** Turns an uploaded file into a 교안, so it can be presented and written on in the 교안 tab. */
  api.post('/files/:id/lecture', requireUser, requireTeacher, async (req, res) => {
    const f = visibleFile(req, res);
    if (!f) return;
    if (repo.getDoc(f.id)) return fail(res, 409, '이미 교안으로 등록된 파일이에요.');
    let lecture: Lecture;
    try {
      lecture = await prepareLecture(f.id, f.name, await fs.readFile(uploadPath(f.file)), f.file);
    } catch (err) {
      await removeStored(f.id, [lecturePdf(f.id, 0)]);
      throw err;
    }
    transaction(() => {
      repo.createDoc(f, lecture.kind, lecture.file, lecture.pages);
      if (f.hidden) repo.updateFile(f.name, f.tag, 0, f.id);
    });
    notifyDocsChanged(f.room_code);
    notifyFilesChanged(f.room_code);
    res.json({ ok: true });
  });

  api.delete('/files/:id', requireUser, requireTeacher, async (req, res) => {
    const f = visibleFile(req, res);
    if (!f) return;
    await removeFile(f.id);
    res.json({ ok: true });
  });

  // ---- AI helper ----

  api.post('/ai/ask', requireUser, async (req, res) => {
    if (!config.openaiKey) return fail(res, 503, 'AI 기능이 설정되지 않았어요.');
    const parsed = S.aiAskSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, '잘못된 요청입니다.');
    if (!aiLimiter.hit(String(req.user!.id))) return fail(res, 429, 'AI 질문이 너무 많아요. 1분 후 다시 시도하세요.');
    const { docId, page } = parsed.data;
    const doc = docId ? repo.getDoc(docId) : undefined;
    const docName = doc && doc.room_code === req.user!.roomCode ? doc.name : null;
    const room = repo.getRoom(req.user!.roomCode)!;
    await askAi(res, { ...parsed.data, docName, page, courseTitle: room.title });
  });

  api.use((_req, res) => fail(res, 404, 'Not found'));

  api.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof ApiError) return fail(res, err.status, err.message);
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
      return fail(res, 413, `파일이 너무 커요. (최대 ${config.maxUploadMb}MB)`);
    if (err instanceof multer.MulterError && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'))
      return fail(res, 400, `한 번에 올릴 수 있는 파일은 ${LIMITS.lectureImages}개까지예요.`);
    console.error('[api]', err);
    fail(res, 500, '서버 오류가 발생했어요.');
  });

  return api;
}
