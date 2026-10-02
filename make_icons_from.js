/**
 * 用投稿 logo 生成扩展各尺寸图标
 * node make_icons_from.js <源logo.png> [输出目录]
 *
 * 源图为透明底黑色图形（160×160）。本脚本：
 *   1. 读取源图每个像素的 alpha 通道作为"墨量"
 *   2. 铺到目标画布上（保持比例，居中）
 *   3. 用 iOS 风格圆角方形底 + 白色墨迹输出各尺寸
 *   4. 同时输出一版纯黑（透明底）供浅色背景使用
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------------- PNG 读写 ---------------- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
function chunk(type, data) {
  const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([l, td, c]);
}
function writePNG(file, w, h, rgba) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** 解析 PNG，返回 { w, h, get(x,y) -> [r,g,b,a] } */
function readPNG(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 1, 4) !== 'PNG') throw new Error('不是 PNG 文件');
  let p = 8, w = 0, h = 0, depth = 0, ct = 0, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('ascii', p + 4, p + 8);
    if (type === 'IHDR') {
      w = b.readUInt32BE(p + 8); h = b.readUInt32BE(p + 12);
      depth = b[p + 16]; ct = b[p + 17];
    } else if (type === 'IDAT') idat.push(b.slice(p + 8, p + 8 + len));
    p += 12 + len;
  }
  if (depth !== 8) throw new Error('仅支持 8 位位深，当前为 ' + depth);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  if (ch < 2) throw new Error('源图无 alpha 通道，无法提取墨迹');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch + 1;
  // 逐行反滤波（支持 filter type 0-4）
  const out = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * stride];
    const row = raw.slice(y * stride + 1, y * stride + 1 + w * ch);
    const cur = out.slice(y * w * ch, (y + 1) * w * ch);
    const prev = y > 0 ? out.slice((y - 1) * w * ch, y * w * ch) : Buffer.alloc(w * ch);
    for (let i = 0; i < w * ch; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const bq = prev[i];
      const c = i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += bq;
      else if (ft === 3) v += (a + bq) >> 1;
      else if (ft === 4) {
        const pp = a + bq - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - bq), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bq : c);
      }
      cur[i] = v & 0xFF;
    }
  }
  return { w, h, ch, data: out };
}

/* ---------------- 绘制 ---------------- */
function sdRoundRect(px, py, w, h, r) {
  const qx = Math.abs(px - w / 2) - (w / 2 - r);
  const qy = Math.abs(py - h / 2) - (h / 2 - r);
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * @param {object} src readPNG 结果
 * @param {number} S 输出尺寸
 * @param {'light'|'dark'} style light=彩色底白墨迹；dark=白底黑墨迹（纯黑版）
 */
function makeShader(src, S, style) {
  // 源图墨迹：取 alpha
  const alphaAt = (x, y) => {
    const cx = Math.floor(x), cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= src.w || cy >= src.h) return 0;
    const o = (cy * src.w + cx) * src.ch;
    return src.ch === 4 || src.ch === 2 ? src.data[o + src.ch - 1] : 255;
  };
  // 墨迹缩放：占画布 62%，居中
  const target = S * 0.62;
  const scale = target / src.w;
  const offX = (S - src.w * scale) / 2;
  const offY = (S - src.h * scale) / 2;
  const ink = (fx, fy) => {
    const sx = (fx - offX) / scale;
    const sy = (fy - offY) / scale;
    if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) return 0;
    // 双线性采样，缩小时更平滑
    const x0 = Math.floor(sx), y0 = Math.floor(sy);
    const x1 = Math.min(x0 + 1, src.w - 1), y1 = Math.min(y0 + 1, src.h - 1);
    const tx = sx - x0, ty = sy - y0;
    const a = alphaAt(x0, y0), b = alphaAt(x1, y0), c = alphaAt(x0, y1), d = alphaAt(x1, y1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };

  const radius = S * 0.2237; // iOS squircle
  const SS = 3;

  return (x, y) => {
    let accR = 0, accG = 0, accB = 0, accA = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
        let cr = 0, cg = 0, cb = 0, ca = 0;

        const inside = sdRoundRect(fx, fy, S, S, radius) < 0;
        if (inside || style === 'dark') {
          if (style === 'dark') {
            // 纯黑墨迹 + 透明底（供浅色背景直接用）
            const k = ink(fx, fy) / 255;
            cr = cg = cb = 0;
            ca = Math.round(k * 255);
          } else {
            // systemBlue → systemIndigo 渐变底
            const t = fy / S;
            cr = Math.round(10 + (94 - 10) * t);
            cg = Math.round(132 + (92 - 132) * t);
            cb = 255;
            ca = 255;
            // 白色墨迹
            const k = ink(fx, fy) / 255;
            if (k > 0) {
              const sa = k;
              cr = cr * (1 - sa) + 255 * sa;
              cg = cg * (1 - sa) + 255 * sa;
              cb = cb * (1 - sa) + 255 * sa;
            }
          }
        }
        const sa = ca / 255;
        accR = accR * (1 - sa) + cr * sa;
        accG = accG * (1 - sa) + cg * sa;
        accB = accB * (1 - sa) + cb * sa;
        accA = accA * (1 - sa) + sa;
      }
    }
    if (accA === 0) return [0, 0, 0, 0];
    return [
      Math.round(accR / accA), Math.round(accG / accA),
      Math.round(accB / accA), Math.round(Math.min(1, accA) * 255),
    ];
  };
}

function render(file, size, shader) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = shader(x, y);
      const o = (y * size + x) * 4;
      buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = c[3];
    }
  }
  writePNG(file, size, size, buf);
}

/* ---------------- 主流程 ---------------- */
const srcFile = process.argv[2];
const outDir = process.argv[3] || path.join(__dirname, 'extension');
if (!srcFile) {
  console.error('用法: node make_icons_from.js <源logo.png> [输出目录]');
  process.exit(1);
}
const src = readPNG(srcFile);
console.log(`源图: ${path.basename(srcFile)}  ${src.w}×${src.h}  通道${src.ch}`);

[16, 32, 48, 128].forEach((s) => {
  const f = path.join(outDir, `icon${s}.png`);
  render(f, s, makeShader(src, s, 'light'));
  console.log(`  icon${s}.png  ${fs.statSync(f).size} 字节`);
});

// 商店 logo 300×300
const logo = path.join(outDir, 'store-logo-300.png');
render(logo, 300, makeShader(src, 300, 'light'));
console.log(`  store-logo-300.png  ${fs.statSync(logo).size} 字节`);

// 纯黑透明底版（供浅色背景/文档使用）
const black = path.join(outDir, 'icon-black-128.png');
render(black, 128, makeShader(src, 128, 'dark'));
console.log(`  icon-black-128.png  ${fs.statSync(black).size} 字节`);
