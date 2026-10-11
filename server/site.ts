// Live HTML 교안. The uploaded page (and, from a .zip, its images, scripts and audio) is
// served from /api/site/<doc>/<token>/... into a sandboxed iframe. The sandbox gives the
// page an opaque origin, so its scripts can't read the app's cookies or call the API as
// the viewer. Such a frame sends no cookies either, so access is granted by a signed,
// expiring token in the path. A bridge script injected into each HTML page reports the
// slide and scroll position, which is how students follow the teacher.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { fileExt } from '../shared/files.ts';
import { config, ROOT } from './config.ts';
import type { DocRow } from './db.ts';
import { ApiError } from './errors.ts';
import * as repo from './repo.ts';
import { readZip } from './unzip.ts';

/** Folder (inside the uploads folder) holding a 교안's site. */
export const siteDirName = (docId: string) => `${docId}.site`;

const isHtml = (name: string) => ['html', 'htm'].includes(fileExt(name));
const depth = (p: string) => p.split('/').length;

/** The page to open: the shallowest index.html, else the shallowest HTML file. */
function pickEntry(paths: string[]): string | null {
  const isIndex = (p: string) => (/(^|\/)index\.html?$/i.test(p) ? 0 : 1);
  const pages = paths.filter(isHtml);
  pages.sort((a, b) => depth(a) - depth(b) || isIndex(a) - isIndex(b) || a.localeCompare(b));
  return pages[0] ?? null;
}

/** Writes an uploaded .html, or the files in a .zip, as the 교안's site. Returns the entry page relative to the uploads folder. */
export async function storeSite(docId: string, name: string, data: Buffer): Promise<string> {
  const files = isHtml(name)
    ? [{ path: 'index.html', data }]
    : readZip(data, { maxFiles: 5000, maxBytes: config.maxUploadMb * 4 * 1024 * 1024 });
  const entry = pickEntry(files.map((f) => f.path));
  if (!entry) throw new ApiError(400, 'ZIP 안에 HTML 파일이 없어요. index.html이 들어 있는지 확인하세요.');
  const root = path.join(config.uploadsDir, siteDirName(docId));
  try {
    for (const f of files) {
      const target = path.join(root, ...f.path.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, f.data);
    }
  } catch (err) {
    await fsp.rm(root, { recursive: true, force: true });
    console.warn('[site]', err);
    throw new ApiError(400, 'ZIP 안의 파일을 저장하지 못했어요. 파일 이름을 확인하세요.');
  }
  return `${siteDirName(docId)}/${entry}`;
}

// ---- access tokens ----

function loadSecret(): Buffer {
  const file = path.join(config.dataDir, 'site.key');
  try {
    const key = fs.readFileSync(file);
    if (key.length >= 32) return key;
  } catch {
    // First run: create it below.
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}
const secret = loadSecret();
const DAY_MS = 86_400_000;

const sign = (docId: string, exp: string) =>
  crypto.createHmac('sha256', secret).update(`${docId}.${exp}`).digest('base64url').slice(0, 24);

function validToken(docId: string, token: string): boolean {
  const [exp, mac] = token.split('.');
  if (!exp || !mac || !(parseInt(exp, 36) * DAY_MS > Date.now())) return false;
  const expected = Buffer.from(sign(docId, exp));
  return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), expected);
}

/** URL of the 교안's entry page. Valid for 1–2 days; it changes once a day, so caching still works. */
export function siteUrl(doc: DocRow): string {
  const exp = (Math.floor(Date.now() / DAY_MS) + 2).toString(36);
  const entry = doc.file.slice(siteDirName(doc.id).length + 1).split('/').map(encodeURIComponent).join('/');
  return `/api/site/${doc.id}/${exp}.${sign(doc.id, exp)}/${entry}`;
}

// ---- serving ----

/** Same flags as the iframe's sandbox attribute in HtmlViewer, so opening the URL directly is just as contained. */
const SANDBOX =
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

const HEADERS = {
  'Content-Security-Policy': SANDBOX,
  'X-Content-Type-Options': 'nosniff',
  // The page's origin is opaque, so its module scripts, fonts and fetches count as cross-origin.
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'private, max-age=3600',
  'Referrer-Policy': 'no-referrer',
};

const BRIDGE = Buffer.from(`<script>${fs.readFileSync(path.join(ROOT, 'server', 'site-bridge.js'), 'utf8')}</script>`);

/** Puts the bridge first in <head> (after <!doctype>, which must stay first). Works on bytes, so any charset survives. */
function injectBridge(html: Buffer): Buffer {
  const start = html.toString('latin1', 0, Math.min(html.length, 64 * 1024));
  const m = /<head(\s[^>]*)?>/i.exec(start) ?? /<html(\s[^>]*)?>/i.exec(start) ?? /<!doctype[^>]*>/i.exec(start);
  const at = m ? m.index + m[0].length : 0;
  return Buffer.concat([html.subarray(0, at), BRIDGE, html.subarray(at)]);
}

export async function serveSite(req: Request, res: Response) {
  const notFound = () => res.status(404).type('text/plain').send('Not found');
  const id = String(req.params.id);
  const doc = repo.getDoc(id);
  if (!doc || doc.kind !== 'html' || !validToken(id, String(req.params.token))) return notFound();
  const root = path.join(config.uploadsDir, siteDirName(id));
  const segments = req.params.path as unknown as string[] | undefined;
  const rel = segments?.length ? segments.join('/') : doc.file.slice(siteDirName(id).length + 1);

  if (!isHtml(rel)) {
    // `root` makes send() refuse paths that climb out of the site folder.
    return res.sendFile(rel, { root, headers: HEADERS }, (err) => {
      if (err && !res.headersSent) notFound();
    });
  }
  const file = path.join(root, rel);
  const html = file.startsWith(root + path.sep) ? await fsp.readFile(file).catch(() => null) : null;
  if (!html) return notFound();
  const declared = /<meta[^>]+charset/i.test(html.toString('latin1', 0, 4096));
  res.set(HEADERS);
  res.setHeader('Content-Type', declared ? 'text/html' : 'text/html; charset=utf-8');
  res.send(injectBridge(html));
}
