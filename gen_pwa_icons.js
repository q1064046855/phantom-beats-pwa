// 纯 Node 生成 PWA 图标：icon-192.png / icon-512.png / icon-maskable-512.png
// 复用项目既有手编 PNG 逻辑（无第三方库）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function makeIcon(S, maskable) {
  const buf = Buffer.alloc(S * S * 4);
  function set(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    const ba = buf[i + 3] / 255, na = a / 255;
    const oa = na + ba * (1 - na);
    if (oa <= 0) return;
    buf[i]     = Math.round((r * na + buf[i] * ba * (1 - na)) / oa);
    buf[i + 1] = Math.round((g * na + buf[i + 1] * ba * (1 - na)) / oa);
    buf[i + 2] = Math.round((b * na + buf[i + 2] * ba * (1 - na)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  }
  function hsl(h, s, l, a) {
    h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; } else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; } else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; } else { r = c; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255), a];
  }
  const cx = S / 2, cy = S / 2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    buf[i] = 10; buf[i + 1] = 10; buf[i + 2] = 20;
    buf[i + 3] = maskable ? 255 : 0; // 掩码图满铺不透明底
  }
  const scale = maskable ? 0.62 : 1; // 掩码图内容收进安全区
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - cx, dy = y - cy;
    const r = Math.sqrt(dx * dx + dy * dy) / scale;
    const ang = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    if (r > 60 && r < 96) {
      const edge = r < 70 ? (r - 60) / 10 : r > 86 ? (96 - r) / 10 : 1;
      const [R, G, B, A] = hsl(ang, 90, 60, 255 * Math.max(0, edge));
      set(x, y, R, G, B, A);
    }
    if (r < 52) {
      const [R, G, B, A] = hsl(220, 40, 70, 120 * (1 - r / 52));
      set(x, y, R, G, B, A);
    }
  }
  return buf;
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
  return ~c;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(S, px) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
const out = __dirname;
fs.writeFileSync(path.join(out, 'icon-192.png'), encodePNG(192, makeIcon(192, false)));
fs.writeFileSync(path.join(out, 'icon-512.png'), encodePNG(512, makeIcon(512, false)));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), encodePNG(512, makeIcon(512, true)));
console.log('PWA 图标已生成: icon-192.png / icon-512.png / icon-maskable-512.png');
