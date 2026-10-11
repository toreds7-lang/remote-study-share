import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

// Load .env (preferred) or env.txt from the project root. Variables already set
// in the real environment win.
for (const file of ['.env', 'env.txt']) {
  const p = path.join(ROOT, file);
  if (fs.existsSync(p)) {
    const before = { ...process.env };
    process.loadEnvFile(p);
    Object.assign(process.env, before);
  }
}

const dataDir = path.resolve(ROOT, process.env.DATA_DIR ?? 'data');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  prod: process.argv.includes('--prod') || process.env.NODE_ENV === 'production',
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB ?? 200),
  /** When set, creating a room requires this password. */
  adminPassword: process.env.ADMIN_PASSWORD ?? '',
  openaiKey: process.env.OPENAI_API_KEY ?? '',
  llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
  /** Office → PDF conversion for 교안: auto (Microsoft Office, then LibreOffice), msoffice, libreoffice or off. */
  officeConverter: (['msoffice', 'libreoffice', 'off'] as const).find((m) => m === process.env.OFFICE_CONVERTER) ?? 'auto',
  /** LibreOffice's soffice binary, if it isn't found on PATH or in the usual install folders. */
  sofficePath: process.env.SOFFICE_PATH ?? '',
  /** Set to 1 behind a reverse proxy (nginx, Caddy) so client IPs and https are detected. */
  trustProxy: process.env.TRUST_PROXY === '1',
};

fs.mkdirSync(config.uploadsDir, { recursive: true });
