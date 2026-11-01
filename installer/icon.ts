// The app icon as a Windows .ico, for the setup, its shortcuts and Apps & Features. It draws the
// page's favicon (client/index.html): three white lines on a green rounded square, in a 32×32 box.

const GREEN = [0x17, 0x8a, 0x6a];
const LINES = [
  [8, 24, 11],
  [8, 24, 16],
  [8, 18, 21],
]; // x from, x to, y; 3 wide with round caps
const SIZES = [16, 24, 32, 48, 256];
const SAMPLES = 4; // per pixel and axis, for smooth edges

function inSquare(x: number, y: number) {
  const qx = Math.abs(x - 16) - 8;
  const qy = Math.abs(y - 16) - 8;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= 8;
}

function inLine(x: number, y: number) {
  return LINES.some(([x1, x2, ly]) => Math.hypot(Math.max(x1 - x, 0, x - x2), y - ly) <= 1.5);
}

/** One size as a 32-bit DIB: BGRA rows bottom-up, then an empty AND mask (the alpha is used). */
function image(size: number): Buffer {
  const maskRow = Math.ceil(size / 32) * 4;
  const dib = Buffer.alloc(40 + size * size * 4 + maskRow * size);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8); // the colour rows and the mask
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let square = 0;
      let line = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = ((px + (sx + 0.5) / SAMPLES) * 32) / size;
          const y = ((py + (sy + 0.5) / SAMPLES) * 32) / size;
          if (inSquare(x, y)) {
            square++;
            if (inLine(x, y)) line++;
          }
        }
      }
      if (!square) continue;
      const white = line / square;
      const o = 40 + ((size - 1 - py) * size + px) * 4;
      for (let c = 0; c < 3; c++) dib[o + 2 - c] = Math.round(GREEN[c] + (255 - GREEN[c]) * white);
      dib[o + 3] = Math.round((255 * square) / SAMPLES ** 2);
    }
  }
  return dib;
}

export function makeIco(): Buffer {
  const images = SIZES.map(image);
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  images.forEach((img, i) => {
    const e = 6 + 16 * i;
    dir[e] = dir[e + 1] = SIZES[i] % 256; // 0 means 256
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(img.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.length;
  });
  return Buffer.concat([dir, ...images]);
}
