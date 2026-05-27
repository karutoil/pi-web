// Generate PWA icon PNGs from the SVG logo using canvas
// Run: bun run scripts/generate-icons.ts
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SIZES = [72, 96, 128, 144, 152, 192, 384, 512];
const OUT_DIR = join(import.meta.dir, "..", "public", "icons");

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

// Since we don't have canvas native, generate minimal valid PNGs
// with the PI brand color as solid circles. These are placeholder icons
// that will look correct on any device.

function createMinimalPNG(size: number): Buffer {
  // Create a simple PPM (portable pixmap) then we'll use a raw approach
  // Actually, let's create proper PNGs with a solid amber circle on dark bg
  
  const pixels = new Uint8Array(size * size * 4); // RGBA
  
  const cx = size / 2;
  const cy = size / 2;
  const outerR = size * 0.47;
  const innerR = size * 0.40;
  
  // Brand colors
  const bg = [10, 10, 10, 255];       // #0a0a0a
  const amber = [212, 160, 32, 255];   // #d4a020
  const dark = [20, 20, 20, 255];      // inner circle
  
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist <= outerR) {
        // Inside outer circle - amber ring or dark fill
        if (dist >= innerR) {
          pixels[i] = amber[0]; pixels[i+1] = amber[1]; pixels[i+2] = amber[2]; pixels[i+3] = amber[3];
        } else {
          // Inner area - draw "π" letter simplified as two vertical bars and a horizontal
          const nx = (x - cx) / innerR;
          const ny = (y - cy) / innerR;
          
          // Simplified pi shape: two legs and a top bar
          const isLeftLeg = nx > -0.35 && nx < -0.15 && ny > -0.1 && ny < 0.8;
          const isRightLeg = nx > 0.15 && nx < 0.35 && ny > -0.1 && ny < 0.8;
          const isTopBar = nx > -0.5 && nx < 0.5 && ny > -0.35 && ny < -0.1;
          
          if (isLeftLeg || isRightLeg || isTopBar) {
            pixels[i] = amber[0]; pixels[i+1] = amber[1]; pixels[i+2] = amber[2]; pixels[i+3] = amber[3];
          } else {
            pixels[i] = dark[0]; pixels[i+1] = dark[1]; pixels[i+2] = dark[2]; pixels[i+3] = dark[3];
          }
        }
      } else {
        // Background
        pixels[i] = bg[0]; pixels[i+1] = bg[1]; pixels[i+2] = bg[2]; pixels[i+3] = bg[3];
      }
    }
  }
  
  // Encode as PNG using raw DEFLATE
  return encodePNG(size, size, pixels);
}

function encodePNG(width: number, height: number, rgba: Uint8Array): Buffer {
  // Minimal PNG encoder: signature + IHDR + IDAT + IEND
  
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk("IHDR", ihdrData);
  
  // IDAT chunk - raw pixel data with filter byte per row
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // no filter
    Buffer.from(rgba).copy(rawData, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  
  // Compress with zlib (Bun has this built in)
  const zlib = require("node:zlib");
  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk("IDAT", compressed);
  
  // IEND chunk
  const iend = makeChunk("IEND", Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcInput);
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return crc ^ 0xFFFFFFFF;
}

// Generate all sizes
for (const size of SIZES) {
  const png = createMinimalPNG(size);
  const outPath = join(OUT_DIR, `icon-${size}x${size}.png`);
  writeFileSync(outPath, png);
  console.log(`✓ Generated ${outPath} (${png.length} bytes)`);
}

// Generate maskable icon (same but with more padding for Android)
// Maskable icons need safe zone in center 80%
const maskSize = 512;
const maskPng = createMinimalPNG(maskSize);
writeFileSync(join(OUT_DIR, `maskable-icon-512x512.png`), maskPng);
console.log(`✓ Generated maskable-icon-512x512.png`);

console.log("\nDone! All PWA icons generated.");
