// Builds the PDF that the 교안 tab shows for uploads that aren't PDFs: images and blank
// whiteboards with pdf-lib, Office files with Microsoft Office (Windows, via COM) or
// LibreOffice, whichever is installed. Also inserts and deletes pages.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { degrees, PDFDocument, rgb, type PDFImage, type PDFPage } from 'pdf-lib';
import { fileExt, OFFICE_EXTS } from '../shared/files.ts';
import { config, ROOT } from './config.ts';
import { ApiError } from './errors.ts';

// ---- images ----

export interface ImageFile {
  data: Buffer;
  /** 'png', 'jpg' or 'jpeg'. */
  ext: string;
}

/** EXIF orientation of a JPEG as the clockwise rotation that shows it upright (0 if none). */
export function jpegRotation(buf: Buffer): number {
  try {
    let i = 2;
    while (i + 4 < buf.length && buf[i] === 0xff) {
      const marker = buf[i + 1];
      if (marker === 0xda) break; // image data starts; no EXIF before it
      if (marker === 0xe1 && buf.toString('latin1', i + 4, i + 10) === 'Exif\0\0') {
        const tiff = i + 10;
        const le = buf.toString('latin1', tiff, tiff + 2) === 'II';
        const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
        const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
        const ifd = tiff + u32(tiff + 4);
        for (let k = 0, n = u16(ifd); k < n; k++) {
          const entry = ifd + 2 + k * 12;
          if (u16(entry) !== 0x0112) continue;
          // 2/4/5/7 are mirrored variants; showing them rotated but unmirrored is close enough.
          return ({ 3: 180, 4: 180, 5: 90, 6: 90, 7: 270, 8: 270 } as Record<number, number>)[u16(entry + 8)] ?? 0;
        }
        return 0;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } catch {
    // Truncated or malformed EXIF: treat as upright.
  }
  return 0;
}

async function embedImage(pdf: PDFDocument, img: ImageFile): Promise<PDFImage> {
  try {
    return img.ext === 'png' ? await pdf.embedPng(img.data) : await pdf.embedJpg(img.data);
  } catch {
    throw new ApiError(400, '이미지를 읽을 수 없어요. PNG나 JPG 파일인지 확인하세요.');
  }
}

/** Images are laid out at 96 dpi (0.75 pt per pixel). */
const PT_PER_PX = 0.75;
const clampPt = (n: number) => Math.min(14400, Math.max(72, n));

/**
 * Adds a page showing the image at `index` (default: the end). With `size`, the page gets that size
 * and the image is centered inside it; otherwise the page is the size of the image.
 */
async function addImagePage(pdf: PDFDocument, img: ImageFile, index?: number, size?: [number, number]) {
  const image = await embedImage(pdf, img);
  const rot = img.ext === 'png' ? 0 : jpegRotation(img.data);
  const add = (s: [number, number]) => (index === undefined ? pdf.addPage(s) : pdf.insertPage(index, s));
  // Sideways photos are drawn as stored and shown upright by rotating the page.
  if (!size || rot) {
    const w = clampPt(image.width * PT_PER_PX);
    const h = clampPt(image.height * PT_PER_PX);
    const page = add([w, h]);
    page.drawImage(image, { x: 0, y: 0, width: w, height: h });
    if (rot) page.setRotation(degrees(rot));
    return;
  }
  const [pw, ph] = size;
  const margin = Math.min(pw, ph) * 0.04;
  // Fit inside the margins, but don't blow small images up more than 2x.
  const scale = Math.min((pw - 2 * margin) / image.width, (ph - 2 * margin) / image.height, PT_PER_PX * 2);
  const w = image.width * scale;
  const h = image.height * scale;
  add(size).drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

/** One page per image, in the given order. */
export async function imagesToPdf(images: ImageFile[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (const img of images) await addImagePage(pdf, img);
  return Buffer.from(await pdf.save());
}

// ---- whiteboards and page edits ----

export type Paper = 'blank' | 'grid' | 'lines';

/** Whiteboard pages are 16:9 like most slides. */
const WHITEBOARD_SIZE: [number, number] = [960, 540];

function drawPaper(page: PDFPage, paper: Paper) {
  if (paper === 'blank') return;
  const { width, height } = page.getSize();
  const line = { thickness: 0.6, color: rgb(0.82, 0.85, 0.9) };
  const step = paper === 'grid' ? 24 : 36;
  if (paper === 'grid') {
    for (let x = step; x < width; x += step) page.drawLine({ start: { x, y: 0 }, end: { x, y: height }, ...line });
  }
  for (let y = height - step; y > 0; y -= step) page.drawLine({ start: { x: 0, y }, end: { x: width, y }, ...line });
}

export async function blankPdf(pages: number, paper: Paper): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) drawPaper(pdf.addPage(WHITEBOARD_SIZE), paper);
  return Buffer.from(await pdf.save());
}

async function loadForEdit(data: Buffer): Promise<PDFDocument> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new ApiError(400, 'PDF를 읽을 수 없어요.');
  }
  // pdf-lib can't re-encrypt, so saving an encrypted PDF would corrupt it.
  if (pdf.isEncrypted) throw new ApiError(400, '암호가 걸린 PDF는 페이지를 추가하거나 지울 수 없어요.');
  return pdf;
}

/** Page size as displayed (width and height swap on pages rotated by 90°). */
function displayedSize(page: PDFPage): [number, number] {
  const { width, height } = page.getSize();
  const angle = ((page.getRotation().angle % 360) + 360) % 360;
  return angle % 180 ? [height, width] : [width, height];
}

/** Inserts a page so that it becomes page `at`: an image fitted to the neighbouring page's size, or blank paper. */
export async function insertPage(
  data: Buffer,
  at: number,
  content: { image: ImageFile } | { paper: Paper },
): Promise<{ data: Buffer; pages: number }> {
  const pdf = await loadForEdit(data);
  const size = displayedSize(pdf.getPage(Math.min(Math.max(at - 2, 0), pdf.getPageCount() - 1)));
  if ('image' in content) await addImagePage(pdf, content.image, at - 1, size);
  else drawPaper(pdf.insertPage(at - 1, size), content.paper);
  return { data: Buffer.from(await pdf.save()), pages: pdf.getPageCount() };
}

export async function deletePage(data: Buffer, at: number): Promise<{ data: Buffer; pages: number }> {
  const pdf = await loadForEdit(data);
  if (pdf.getPageCount() <= 1) throw new ApiError(400, '마지막 남은 페이지는 지울 수 없어요.');
  pdf.removePage(at - 1);
  return { data: Buffer.from(await pdf.save()), pages: pdf.getPageCount() };
}

// ---- Office files ----

type Engine = { kind: 'msoffice'; app: 'powerpoint' | 'word' | 'excel' } | { kind: 'libreoffice'; bin: string };

const MS_OFFICE = [
  { app: 'powerpoint', progId: 'PowerPoint.Application', exts: 'ppt pptx pps ppsx pot potx odp' },
  { app: 'word', progId: 'Word.Application', exts: 'doc docx rtf odt' },
  { app: 'excel', progId: 'Excel.Application', exts: 'xls xlsx ods' },
] as const;

const CONVERT_TIMEOUT_MS = 180_000;
const SCRIPT = path.join(ROOT, 'server', 'office-to-pdf.ps1');
// Full paths: System32 isn't always on PATH (e.g. when started from Git Bash).
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const POWERSHELL = path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const REG = path.join(SYSTEM32, 'reg.exe');

function run(file: string, args: string[], timeout: number) {
  return new Promise<{ ok: boolean; timedOut: boolean; output: string }>((resolve) =>
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      resolve({
        ok: !err,
        timedOut: !!err?.killed,
        output: `${stdout}${stderr}`.trim() || (err?.message ?? ''),
      }),
    ),
  );
}

function findSoffice(): string | null {
  if (config.sofficePath) return fs.existsSync(config.sofficePath) ? config.sofficePath : null;
  const names = process.platform === 'win32' ? ['soffice.exe'] : ['soffice', 'libreoffice'];
  const known =
    process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].map((d) => d && path.join(d, 'LibreOffice', 'program'))
      : process.platform === 'darwin'
        ? ['/Applications/LibreOffice.app/Contents/MacOS']
        : ['/usr/lib/libreoffice/program', '/opt/libreoffice/program', '/snap/bin'];
  for (const dir of [...(process.env.PATH ?? '').split(path.delimiter), ...known]) {
    if (!dir) continue;
    for (const name of names) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** Which program converts each Office extension. Microsoft Office wins where both are installed. */
async function detectEngines() {
  const engines = new Map<string, Engine>();
  const found: string[] = [];
  const mode = config.officeConverter;
  if (process.platform === 'win32' && (mode === 'auto' || mode === 'msoffice')) {
    for (const { app, progId, exts } of MS_OFFICE) {
      if (!(await run(REG, ['query', `HKCR\\${progId}\\CurVer`], 10_000)).ok) continue;
      for (const ext of exts.split(' ')) engines.set(ext, { kind: 'msoffice', app });
      found.push(progId.split('.')[0]);
    }
  }
  if (mode === 'auto' || mode === 'libreoffice') {
    const bin = findSoffice();
    if (bin) {
      for (const ext of OFFICE_EXTS) if (!engines.has(ext)) engines.set(ext, { kind: 'libreoffice', bin });
      found.push('LibreOffice');
    }
  }
  return { engines, label: found.join(', ') };
}

const detected = await detectEngines();

/** Office file extensions this server can convert. */
export const officeExts = [...detected.engines.keys()];
/** e.g. "PowerPoint, Word, Excel" or "LibreOffice"; empty if none. */
export const officeConverters = detected.label;

/** Ends the Office processes listed (comma-separated ids) by office-to-pdf.ps1. It lists only ones it started. */
async function endOfficeProcesses(pidFile: string) {
  const ids = (await fsp.readFile(pidFile, 'ascii').catch(() => '')).split(/[,\s]+/).map(Number);
  for (const id of ids) {
    if (!id) continue;
    try {
      process.kill(id);
    } catch {
      // Already gone.
    }
  }
}

// Office automation doesn't like parallel use, so conversions run one at a time.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}

/** Converts the Office file at `input` (its extension decides the program) to PDF. */
export async function officeToPdf(input: string): Promise<Buffer> {
  const ext = fileExt(input);
  const engine = detected.engines.get(ext);
  if (!engine) {
    throw new ApiError(415, `이 서버에는 .${ext} 파일을 변환할 프로그램이 없어요. PDF로 저장해서 올려 주세요.`);
  }
  const tmp = path.join(config.uploadsDir, `.convert-${crypto.randomBytes(6).toString('hex')}`);
  await fsp.mkdir(tmp, { recursive: true });
  try {
    return await oneAtATime(async () => {
      let out: string;
      let res: Awaited<ReturnType<typeof run>>;
      if (engine.kind === 'msoffice') {
        out = path.join(tmp, 'out.pdf');
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT];
        res = await run(POWERSHELL, [...args, '-App', engine.app, '-In', input, '-Out', out], CONVERT_TIMEOUT_MS);
        // A hidden dialog or an error can leave the Office process the script started running.
        if (!res.ok) await endOfficeProcesses(`${out}.pid`);
      } else {
        const profile = pathToFileURL(path.join(config.dataDir, 'libreoffice-profile')).href;
        const args = ['--headless', '--norestore', '--nolockcheck', '--nologo', `-env:UserInstallation=${profile}`];
        res = await run(engine.bin, [...args, '--convert-to', 'pdf', '--outdir', tmp, input], CONVERT_TIMEOUT_MS);
        out = path.join(tmp, `${path.parse(input).name}.pdf`);
      }
      const pdf = await fsp.readFile(out).catch(() => null);
      if (pdf?.length) return pdf;
      console.warn(`[convert] ${engine.kind} failed for .${ext}:`, res.output.slice(0, 2000));
      throw new ApiError(
        422,
        res.timedOut
          ? '변환이 너무 오래 걸려 중단했어요. PDF로 저장해서 올려 주세요.'
          : 'PDF로 변환하지 못했어요. 암호가 걸려 있거나 손상된 파일인지 확인하세요.',
      );
    });
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}
