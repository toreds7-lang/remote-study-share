// File-type rules shared by the server (MIME types, what may be previewed) and
// the client (badges, filter chips). The kind is derived from the extension only.

export type FileKind = 'image' | 'pdf' | 'notebook' | 'code' | 'doc' | 'archive' | 'other';

const KIND_BY_EXT: Record<string, FileKind> = {};
function register(kind: FileKind, exts: string) {
  for (const ext of exts.split(' ')) KIND_BY_EXT[ext] = kind;
}
register('image', 'png jpg jpeg gif webp bmp avif svg heic');
register('pdf', 'pdf');
register('notebook', 'ipynb');
register(
  'code',
  'py js mjs ts jsx tsx java c h cpp hpp cs go rs rb php kt swift r sql sh bat ps1 html htm css ' +
    'json jsonl csv tsv yaml yml toml xml ini cfg parquet pkl npy npz h5 db sqlite',
);
register('doc', 'txt md log doc docx ppt pptx xls xlsx hwp hwpx rtf odt ods odp key pages numbers');
register('archive', 'zip 7z rar tar gz tgz bz2 xz');

/** Lower-case extension without the dot ('' for none or for dotfiles like `.env`). */
export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export const fileKind = (name: string): FileKind => KIND_BY_EXT[fileExt(name)] ?? 'other';

export type PreviewKind = 'image' | 'pdf' | 'text' | 'notebook';

/** Raster images browsers can show directly. SVG is excluded: it can carry scripts. */
export const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const TEXT_EXTS = new Set(
  ('txt md log csv tsv json jsonl yaml yml toml xml ini cfg sql html htm css ' +
    'py js mjs ts jsx tsx java c h cpp hpp cs go rs rb php kt swift r sh bat ps1').split(' '),
);

/** How a file can be shown in the browser, or null if it can only be downloaded. */
export function previewKind(name: string): PreviewKind | null {
  const ext = fileExt(name);
  if (ext in IMAGE_MIME) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'ipynb') return 'notebook';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

// ---- 교안 (lecture material) ----

/** How an upload becomes a 교안: shown as-is (pdf), converted to PDF (image, office), or run live (html, zip). */
export type LectureSource = 'pdf' | 'image' | 'office' | 'html' | 'zip';

/** Images the server turns into PDF pages directly. */
export const LECTURE_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg']);
/** Other images the browser re-encodes as PNG before uploading them as a 교안. */
export const BROWSER_IMAGE_EXTS = new Set(['gif', 'webp', 'bmp', 'avif']);
/** Office files the server may convert to PDF. Which ones it can depends on the converter installed. */
export const OFFICE_EXTS = 'ppt pptx pps ppsx pot potx odp doc docx rtf odt xls xlsx ods hwp hwpx'.split(' ');

/** What kind of 교안 a file can become, or null if it can't be one. */
export function lectureSource(name: string): LectureSource | null {
  const ext = fileExt(name);
  if (ext === 'pdf') return 'pdf';
  if (LECTURE_IMAGE_EXTS.has(ext)) return 'image';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'zip') return 'zip';
  if (OFFICE_EXTS.includes(ext)) return 'office';
  return null;
}

/** Whether the server can make a 교안 from this file. `officeExts` are the Office types it can convert. */
export function canLecture(name: string, officeExts: readonly string[]): boolean {
  const source = lectureSource(name);
  return source === 'office' ? officeExts.includes(fileExt(name)) : source !== null;
}
