// Types and constants shared by the server and the browser client.
// Coordinates are normalized to the displayed page: x in [0,1] of page width,
// y in [0,1] of page height. Sizes are in 1/1000 of the page width, so ink
// looks identical at any zoom level or screen size. On a live HTML 교안 the
// "page" is the HTML_FRAME, and y is measured from the top of the scrolled
// document, so it can exceed 1.

export type Role = 'teacher' | 'student';
/** 'teacher' = 강사 판서 (shared with everyone), 'note' = 내 필기 (private). */
export type Layer = 'teacher' | 'note';

interface StrokeBase {
  id: string;
  docId: string;
  page: number;
  color: string;
  size: number;
}
export interface PenStroke extends StrokeBase {
  kind: 'pen';
  /** Flat list [x0, y0, x1, y1, ...]. */
  points: number[];
}
export interface TextStroke extends StrokeBase {
  kind: 'text';
  x: number;
  y: number;
  text: string;
}
export type Stroke = PenStroke | TextStroke;

/** An in-progress teacher pen stroke, streamed in small batches of points. */
export interface LiveInk {
  id: string;
  docId: string;
  page: number;
  color: string;
  size: number;
  /** New points since the previous batch. */
  points: number[];
}

export interface LaserPos {
  docId: string;
  page: number;
  x: number;
  y: number;
}

/**
 * pdf: rendered with pdf.js. Uploaded PDFs, plus images, Office files and whiteboards converted to PDF.
 * html: a live web page in a sandboxed frame; it reports its own slide number.
 */
export type DocKind = 'pdf' | 'html';

export interface DocInfo {
  id: string;
  name: string;
  kind: DocKind;
  /** Number of pages (always 1 for HTML). */
  pages: number;
  /** Bumped when pages are added or deleted, so clients reload the PDF. */
  rev: number;
  uploadedAt: number;
}

/** Pages were added (delta 1, new page `at`) or deleted (delta -1, page `at`); later pages moved by delta. */
export interface DocEdit {
  docId: string;
  at: number;
  delta: 1 | -1;
}

/** Where page `page` is after an edit. A deleted page's number goes to the page after it. */
export function pageAfterEdit(page: number, { at, delta }: DocEdit): number {
  if (delta > 0) return page >= at ? page + 1 : page;
  return page > at ? page - 1 : page;
}

/** Logical size of the frame a live HTML 교안 is laid out in, so its layout is the same on every screen. */
export const HTML_FRAME = { w: 1280, h: 720 } as const;

/** Where a live HTML 교안 is: its URL hash (the slide, e.g. `#/3`) and its scroll offset in frame pixels. */
export interface HtmlState {
  hash: string;
  x: number;
  y: number;
}

/** A file in the 파일 tab. 교안 PDFs are listed too (isDoc) and share their id with the DocInfo. */
export interface FileInfo {
  id: string;
  /** Original filename, including the extension. */
  name: string;
  size: number;
  tag: string | null;
  uploader: string | null;
  uploadedAt: number;
  isDoc: boolean;
  /** Hidden from students. Students never receive hidden files, so this is always false for them. */
  hidden: boolean;
  /** Number of students who downloaded it. Sent to teachers only (null for students). */
  downloads: number | null;
}

export interface FileDownloads {
  downloaded: { name: string; at: number }[];
  /** Students of this class who haven't downloaded it yet. */
  pending: string[];
}

export interface Me {
  id: number;
  name: string;
  role: Role;
}

export interface RoomInfo {
  code: string;
  title: string;
}

/** Where the teacher currently is. docId is null until a 교안 is uploaded. */
export interface Position {
  docId: string | null;
  page: number;
  /** HTML 교안 only. */
  html?: HtmlState;
}

export interface Question {
  id: number;
  body: string;
  /** null when asked anonymously. */
  authorId: number | null;
  authorName: string | null;
  createdAt: number;
  likes: number;
  likedByMe: boolean;
  mine: boolean;
  docId: string | null;
  page: number | null;
  answer: string | null;
  resolved: boolean;
}

export interface ChatMessage {
  id: number;
  userId: number;
  name: string;
  role: Role;
  body: string;
  createdAt: number;
}

export interface PresenceUser {
  id: number;
  name: string;
  role: Role;
}

export interface RaisedHand {
  userId: number;
  name: string;
  at: number;
}

export interface Snapshot {
  room: RoomInfo;
  me: Me;
  docs: DocInfo[];
  files: FileInfo[];
  /** Ids of files this user has downloaded. */
  myDownloads: string[];
  maxUploadMb: number;
  /** Office file types (extensions) this server can convert into a 교안. */
  officeExts: string[];
  teacher: Position;
  questions: Question[];
  chat: ChatMessage[];
  online: PresenceUser[];
  /** Full list for teachers; empty for students. */
  hands: RaisedHand[];
  myHandRaised: boolean;
  aiEnabled: boolean;
}

export interface DocStrokes {
  teacher: Stroke[];
  note: Stroke[];
}

export type Ack<T = undefined> = (res: { ok: true; data?: T } | { ok: false; error: string }) => void;

export const COLORS = ['#e5484d', '#1e3a8a', '#15803d', '#111827'] as const;
/** Pen width per size preset, in 1/1000 of page width. */
export const PEN_SIZES = [2, 4, 8] as const;
/** Text height per size preset, in 1/1000 of page width. */
export const TEXT_SIZES = [18, 26, 38] as const;

export const LIMITS = {
  nameLen: 20,
  titleLen: 100,
  questionLen: 1000,
  chatLen: 500,
  textStrokeLen: 500,
  strokePoints: 20000,
  aiQuestionLen: 1000,
  aiContextLen: 8000,
  fileNameLen: 200,
  tagLen: 20,
  zipFiles: 500,
  lectureImages: 100,
  whiteboardPages: 100,
  htmlPages: 10000,
} as const;
