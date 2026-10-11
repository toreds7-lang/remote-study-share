import type { Stroke } from '../../shared/protocol.ts';
import { drawStrokes } from './ink.ts';
import { loadPdf, renderPageToCanvas } from './pdf.ts';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);

const canvasToBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지를 만들 수 없어요.'))), 'image/png'),
  );

/** Saves the page (with the given ink layers) as a PNG image. */
export async function capturePage(docId: string, docName: string, pageNum: number, layers: Stroke[][]) {
  const pdf = await loadPdf(docId);
  const page = await pdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(2, 2000 / base.width);
  const { canvas, task } = await renderPageToCanvas(page, scale);
  await task.promise;
  const ctx = canvas.getContext('2d')!;
  for (const strokes of layers) drawStrokes(ctx, strokes, canvas.width, canvas.height);
  downloadBlob(await canvasToBlob(canvas), `${safeName(docName)}_p${pageNum}.png`);
}

/**
 * Downloads the PDF with ink merged in. Each annotated page gets a transparent
 * PNG overlay (so Korean text needs no embedded font); other pages are untouched.
 */
export async function exportPdfWithInk(
  docId: string,
  docName: string,
  byPage: Map<number, Stroke[]>,
  onProgress?: (done: number, total: number) => void,
) {
  // pdf-lib is only needed here, so load it on demand to keep the initial bundle small.
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await loadPdf(docId);
  const bytes = await pdf.getData();
  const out = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = [...byPage.entries()].filter(([, s]) => s.length > 0);

  let done = 0;
  for (const [pageNum, strokes] of pages) {
    const src = await pdf.getPage(pageNum);
    const vp = src.getViewport({ scale: 1 }); // displayed (rotated) size in PDF points
    const rot = (((src.rotate % 360) + 360) % 360) as 0 | 90 | 180 | 270;
    const W = vp.width;
    const H = vp.height;
    const unW = rot % 180 ? H : W; // unrotated page size
    const unH = rot % 180 ? W : H;

    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(unW * scale);
    canvas.height = Math.ceil(unH * scale);
    const ctx = canvas.getContext('2d')!;
    // Map displayed coordinates back onto the unrotated page, since the
    // overlay image is placed in the page's own (unrotated) coordinate space.
    const m: Record<number, [number, number, number, number, number, number]> = {
      0: [1, 0, 0, 1, 0, 0],
      90: [0, -1, 1, 0, 0, unH],
      180: [-1, 0, 0, -1, unW, unH],
      270: [0, 1, -1, 0, unW, 0],
    };
    const [a, b, c, d, e, f] = m[rot];
    ctx.setTransform(a * scale, b * scale, c * scale, d * scale, e * scale, f * scale);
    drawStrokes(ctx, strokes, W, H);

    const png = await out.embedPng(new Uint8Array(await (await canvasToBlob(canvas)).arrayBuffer()));
    const target = out.getPage(pageNum - 1);
    const box = target.getCropBox();
    target.drawImage(png, { x: box.x, y: box.y, width: box.width, height: box.height });
    onProgress?.(++done, pages.length);
  }

  const result = await out.save();
  const suffix = pages.length ? '_필기' : '';
  downloadBlob(new Blob([result as BlobPart], { type: 'application/pdf' }), `${safeName(docName)}${suffix}.pdf`);
}
