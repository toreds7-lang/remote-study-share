import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
// Settings and data: the project root, or STUDYSHARE_HOME. The installed app sets that to
// %ProgramData%\StudyShare, since its own folder under Program Files is read-only.
const HOME = process.env.STUDYSHARE_HOME ? path.resolve(process.env.STUDYSHARE_HOME) : ROOT;

// Load .env (preferred) or env.txt from HOME. Variables already set
// in the real environment win.
for (const file of ['.env', 'env.txt']) {
  const p = path.join(HOME, file);
  if (fs.existsSync(p)) {
    const before = { ...process.env };
    process.loadEnvFile(p);
    Object.assign(process.env, before);
  }
}

const dataDir = path.resolve(HOME, process.env.DATA_DIR ?? 'data');
const port = Number(process.env.PORT ?? 3000);

export const config = {
  port,
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
  screen: {
    enabled: process.env.SCREEN_SHARE !== 'off',
    /** WebRTC port (UDP, and TCP as a fallback); the 99 UDP ports after it carry pipes to relay PCs. */
    port: Number(process.env.SCREEN_PORT || port + 1),
    /** Addresses offered to viewers; empty = every IPv4 address of this PC. */
    ips: (process.env.SCREEN_IP ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    /** How many students this PC serves before relay PCs take the rest (a share, not a limit). */
    directSeats: Math.max(1, Number(process.env.SCREEN_DIRECT_SEATS || 10)),
    /** Password relay PCs connect with; empty = generated once and kept in DATA_DIR/relay.key. */
    relayKey: process.env.RELAY_KEY ?? '',
  },
};

fs.mkdirSync(config.uploadsDir, { recursive: true });
