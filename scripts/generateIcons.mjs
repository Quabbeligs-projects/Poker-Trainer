/**
 * Generates the PWA icons as PNGs with no external dependency and no network:
 * raw RGBA scanlines, deflated with node's zlib, wrapped in PNG chunks.
 *
 *   npm run icons
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x, y, size);
      const i = rowStart + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Felt-dark ground with a chip-gold spade, matching the app's palette.
const GROUND = [15, 26, 24];
const GOLD = [217, 164, 65];

/**
 * Spade silhouette.
 *
 * The classic heart curve `(u^2+v^2-1)^3 - u^2 v^3 <= 0` has its cusp at -v and
 * its two lobes at +v. Image coordinates grow downward, so feeding y straight in
 * puts the cusp at the TOP and the lobes at the bottom, which is exactly a
 * spade. The stem is a trapezoid widening toward the base.
 */
function inSpade(px, py, s) {
  const x = (px / s) * 2 - 1;
  const y = (py / s) * 2 - 1;
  const u = x * 1.9;
  const v = (y + 0.19) * 1.9;
  const t = u * u + v * v - 1;
  if (t * t * t - u * u * v * v * v <= 0) return true;
  const sy = y + 0.19;
  if (sy > 0.44 && sy < 0.90) {
    const half = 0.048 + (sy - 0.44) * 0.44;
    if (Math.abs(x) <= half) return true;
  }
  return false;
}

mkdirSync('public', { recursive: true });

for (const size of [192, 512]) {
  const buf = png(size, (x, y, s) => {
    const inset = s * 0.085;
    const radius = s * 0.22;
    // Rounded-square mask so the icon looks right when iOS does not mask it.
    const cx = Math.min(Math.max(x, inset + radius), s - inset - radius);
    const cy = Math.min(Math.max(y, inset + radius), s - inset - radius);
    const d = Math.hypot(x - cx, y - cy);
    if (x < inset || y < inset || x > s - inset || y > s - inset || d > radius) {
      return [0, 0, 0, 0];
    }
    return inSpade(x, y, s) ? [...GOLD, 255] : [...GROUND, 255];
  });
  writeFileSync(`public/icon-${size}.png`, buf);
  console.log(`public/icon-${size}.png  ${(buf.length / 1024).toFixed(1)} KB`);
}

// Maskable icon: same art, full bleed so iOS/Android can crop safely.
const maskable = png(512, (x, y, s) =>
  (inSpade(x, y, s) ? [...GOLD, 255] : [...GROUND, 255]));
writeFileSync('public/icon-512-maskable.png', maskable);
console.log(`public/icon-512-maskable.png  ${(maskable.length / 1024).toFixed(1)} KB`);

// Apple touch icon: iOS uses this for the home screen, opaque, no transparency.
const apple = png(180, (x, y, s) =>
  (inSpade(x, y, s) ? [...GOLD, 255] : [...GROUND, 255]));
writeFileSync('public/apple-touch-icon.png', apple);
console.log(`public/apple-touch-icon.png  ${(apple.length / 1024).toFixed(1)} KB`);
