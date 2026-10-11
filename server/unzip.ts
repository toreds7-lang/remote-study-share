// Minimal ZIP reader for HTML 교안 uploaded as a .zip (a page plus its images, scripts
// and audio). Handles stored and deflated entries, which is what common zip tools write.
import zlib from 'node:zlib';
import { ApiError } from './errors.ts';

export interface UnzippedFile {
  /** Relative path with forward slashes; it can't leave the archive's folder. */
  path: string;
  data: Buffer;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const eucKr = new TextDecoder('euc-kr');

/** Names are UTF-8 when flagged. Unflagged names are usually UTF-8 too, but Korean Windows writes CP949. */
function decodeName(raw: Buffer, utf8Flag: boolean): string {
  if (utf8Flag) return raw.toString('utf8');
  try {
    return utf8.decode(raw);
  } catch {
    return eucKr.decode(raw);
  }
}

/** A safe relative path, or null for entries to skip (folders, macOS metadata, unsafe names). */
function safePath(name: string): string | null {
  if (name.endsWith('/') || name.endsWith('\\')) return null;
  const parts = name.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (!parts.length || parts.some((p) => p === '..' || /[\u0000-\u001f<>:"|?*]/.test(p))) return null;
  if (parts[0] === '__MACOSX' || parts.at(-1) === '.DS_Store') return null;
  return parts.join('/');
}

export function readZip(buf: Buffer, limits: { maxFiles: number; maxBytes: number }): UnzippedFile[] {
  const corrupt = () => new ApiError(400, 'ZIP 파일을 읽을 수 없어요.');
  try {
    // The end-of-central-directory record is the last 22 bytes plus an optional comment.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw corrupt();
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || p === 0xffffffff) throw new ApiError(400, 'ZIP64 형식은 지원하지 않아요.');
    if (count > limits.maxFiles) throw new ApiError(413, `ZIP 안의 파일이 너무 많아요. (최대 ${limits.maxFiles}개)`);

    const files: UnzippedFile[] = [];
    let total = 0;
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) throw corrupt();
      const flags = buf.readUInt16LE(p + 8);
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const local = buf.readUInt32LE(p + 42);
      const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
      p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);

      const rel = safePath(name);
      if (!rel) continue;
      if (flags & 1) throw new ApiError(400, '암호가 걸린 ZIP은 열 수 없어요.');
      total += size;
      if (total > limits.maxBytes) throw new ApiError(413, 'ZIP을 풀면 너무 커요.');

      // Sizes come from the central directory; the local header's may be zero (streamed zips).
      if (buf.readUInt32LE(local) !== 0x04034b50) throw corrupt();
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + compSize);
      if (raw.length !== compSize) throw corrupt();
      let data: Buffer;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      else throw new ApiError(400, '지원하지 않는 ZIP 압축 방식이에요. 일반 ZIP으로 다시 압축해 주세요.');
      if (data.length !== size) throw corrupt();
      files.push({ path: rel, data });
    }
    return files;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw corrupt(); // out-of-range reads and inflate errors
  }
}
