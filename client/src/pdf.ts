import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useStore } from './store.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Loaded PDFs by `<docId>@<rev>`: a page edit bumps the revision and the file changes. */
const cache = new Map<string, Promise<PDFDocumentProxy>>();

const revOf = (docId: string) => useStore.getState().docs.find((d) => d.id === docId)?.rev ?? 0;

export const docFileUrl = (docId: string, rev = revOf(docId)) =>
  `/api/docs/${encodeURIComponent(docId)}/file?v=${rev}`;

export function loadPdf(docId: string): Promise<PDFDocumentProxy> {
  const rev = revOf(docId);
  const key = `${docId}@${rev}`;
  let p = cache.get(key);
  if (!p) {
    forgetPdf(docId); // older revisions
    p = pdfjs.getDocument({
      url: docFileUrl(docId, rev),
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      iccUrl: '/pdfjs/iccs/',
    }).promise;
    cache.set(key, p);
    p.catch(() => cache.delete(key));
  }
  return p;
}

export function forgetPdf(docId: string) {
  for (const [key, p] of cache) {
    if (!key.startsWith(`${docId}@`)) continue;
    cache.delete(key);
    p.then((d) => d.loadingTask.destroy()).catch(() => {});
  }
}

/** Renders a page into a new canvas at the given CSS scale (multiplied by `pixelRatio`). */
export async function renderPageToCanvas(page: PDFPageProxy, scale: number, pixelRatio = 1) {
  const viewport = page.getViewport({ scale: scale * pixelRatio });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const task = page.render({ canvas, viewport });
  return { canvas, task };
}

/** Plain text of a page, used as context for the AI helper. */
export async function pageText(docId: string, pageNum: number): Promise<string> {
  const pdf = await loadPdf(docId);
  const page = await pdf.getPage(pageNum);
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    out += item.str + (item.hasEOL ? '\n' : ' ');
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}
