// Generates solid-color PNG icons with a centered white "N" glyph.
// No external deps — emits raw PNG chunks via zlib.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'public', 'icons');
mkdirSync(outDir, { recursive: true });

const BG = [0x0b, 0x0d, 0x10]; // #0b0d10
const FG = [0xff, 0xff, 0xff];
const ACCENT = [0x7a, 0xa2, 0xf7];

// 5x7 "N" glyph (1 = ink).
const GLYPH = ['1...1', '11..1', '1.1.1', '1..11', '1...1', '1...1', '1...1'];

function generate(size, { padding = 0.12, fg = FG, bg = BG } = {}) {
  // RGB pixel buffer.
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    px[i * 3] = bg[0];
    px[i * 3 + 1] = bg[1];
    px[i * 3 + 2] = bg[2];
  }

  // Center the 5x7 glyph in a padded box. Pixel = glyph cell rendered as a
  // solid block. Use integer math so the bars line up.
  const padPx = Math.floor(size * padding);
  const boxW = size - 2 * padPx;
  const boxH = size - 2 * padPx;
  // Letterbox preserving aspect (5:7).
  const cellW = Math.floor(boxW / 5);
  const cellH = Math.floor(boxH / 7);
  const cell = Math.min(cellW, cellH);
  const glyphW = cell * 5;
  const glyphH = cell * 7;
  const ox = Math.floor((size - glyphW) / 2);
  const oy = Math.floor((size - glyphH) / 2);

  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      if (GLYPH[r][c] !== '1') continue;
      for (let dy = 0; dy < cell; dy++) {
        for (let dx = 0; dx < cell; dx++) {
          const x = ox + c * cell + dx;
          const y = oy + r * cell + dy;
          const i = (y * size + x) * 3;
          px[i] = fg[0];
          px[i + 1] = fg[1];
          px[i + 2] = fg[2];
        }
      }
    }
  }

  return encodePng(size, size, px);
}

function encodePng(width, height, rgb) {
  // Add filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const idat = deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])) >>> 0, 0);
  return Buffer.concat([len, tag, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

for (const size of [192, 512]) {
  const buf = generate(size);
  writeFileSync(path.join(outDir, `icon-${size}.png`), buf);
}
// Maskable: full bleed accent background, smaller padding so the glyph fits
// inside the safe zone.
writeFileSync(
  path.join(outDir, 'icon-maskable.png'),
  generate(512, { padding: 0.22, bg: ACCENT }),
);
// Apple touch icon (180×180, square, no transparency).
writeFileSync(path.join(outDir, 'apple-touch-icon.png'), generate(180));
// Favicon stand-in.
writeFileSync(
  path.join(outDir, 'icon-32.png'),
  generate(32, { padding: 0.05 }),
);

console.log('Icons written to', outDir);
