// Minimal streaming ZIP writer. Entries are stored uncompressed: most class files
// (zip, png, pdf) are already compressed, and storing lets us send an exact
// Content-Length so the browser shows download progress. CRCs are computed at
// upload time, so each file is read only once here.
import fs from 'node:fs';
import { Readable } from 'node:stream';

export interface ZipEntry {
  /** Name inside the archive (UTF-8, no directories). */
  name: string;
  path: string;
  size: number;
  crc32: number;
  mtime: number;
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const UTF8_FLAG = 0x0800;

/** Total archive size in bytes, or null when it would need ZIP64 (≥ 4 GiB). */
export function zipSize(entries: ZipEntry[]): number | null {
  let total = END_RECORD;
  for (const e of entries) {
    const nameLen = Buffer.byteLength(e.name);
    total += LOCAL_HEADER + CENTRAL_HEADER + 2 * nameLen + e.size;
  }
  return total < 0xffffffff ? total : null;
}

function dosDateTime(ms: number) {
  const d = new Date(ms);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function header(e: ZipEntry, name: Buffer, central: boolean, offset: number): Buffer {
  const { time, date } = dosDateTime(e.mtime);
  const b = Buffer.alloc(central ? CENTRAL_HEADER : LOCAL_HEADER);
  let o = 0;
  b.writeUInt32LE(central ? 0x02014b50 : 0x04034b50, o);
  o += 4;
  if (central) {
    b.writeUInt16LE(20, o); // version made by
    o += 2;
  }
  b.writeUInt16LE(20, o); // version needed (2.0)
  b.writeUInt16LE(UTF8_FLAG, o + 2);
  b.writeUInt16LE(0, o + 4); // method: stored
  b.writeUInt16LE(time, o + 6);
  b.writeUInt16LE(date, o + 8);
  b.writeUInt32LE(e.crc32 >>> 0, o + 10);
  b.writeUInt32LE(e.size, o + 14); // compressed size
  b.writeUInt32LE(e.size, o + 18); // uncompressed size
  b.writeUInt16LE(name.length, o + 22);
  // Extra field length (and, in the central directory, comment length, disk number
  // and file attributes) stay 0.
  if (central) b.writeUInt32LE(offset, 42);
  return b;
}

async function* chunks(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    yield Buffer.concat([header(e, name, false, 0), name]);
    for await (const chunk of fs.createReadStream(e.path)) yield chunk as Buffer;
    central.push(header(e, name, true, offset), name);
    offset += LOCAL_HEADER + name.length + e.size;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(END_RECORD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); // entries on this disk
  end.writeUInt16LE(entries.length, 10); // entries in total
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  yield Buffer.concat([dir, end]);
}

/** A readable stream of the archive. Stops reading files if the consumer goes away. */
export const zipStream = (entries: ZipEntry[]) => Readable.from(chunks(entries), { objectMode: false });
