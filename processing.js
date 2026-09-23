// ขั้นตอนประมวลผลหน้า:
// ภาพต้นฉบับ → Perspective Correction → ขนาด A4/A5/ต้นฉบับ → ฟิลเตอร์ → หมุน

import { detectQuad } from './detect.js';
import {
  blobToCanvas, canvasToBlob, context2d, createCanvas, releaseCanvas, scaleCanvas,
} from './util.js';

export const PAPER = {
  a4: { label: 'A4', mm: [210, 297] },
  a5: { label: 'A5', mm: [148, 210] },
  original: { label: 'ต้นฉบับ', mm: null },
};

export const FILTERS = {
  original: 'ต้นฉบับ',
  color: 'สี',
  gray: 'เทา',
  bw: 'ขาวดำ',
};

export const FULL_QUAD = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/** ด้านยาวสูงสุดของภาพต้นฉบับที่เก็บไว้ */
const ORIGINAL_MAX_SIDE = 3600;

/** ทำให้ภาพตั้งตรง ย่อขนาด บันทึกเป็น JPEG และหาขอบกระดาษ */
export async function prepareOriginal(blob, detect) {
  const canvas = await blobToCanvas(blob, ORIGINAL_MAX_SIDE);
  try {
    const quad = (detect && detectQuad(canvas, canvas.width, canvas.height)) || FULL_QUAD;
    const original = await canvasToBlob(canvas, 'image/jpeg', 0.92);
    return { original, quad };
  } finally {
    releaseCanvas(canvas);
  }
}

/** เรนเดอร์หน้า → { processed, thumb } */
export async function renderPage(page, originalBlob, dpi) {
  const source = await blobToCanvas(originalBlob);
  let working = source;
  const canvases = [source];
  try {
    let pts = page.quad.map((p) => ({ x: p.x * source.width, y: p.y * source.height }));
    const [tl, tr, br, bl] = pts;
    const widthPx = (dist(tl, tr) + dist(bl, br)) / 2;
    const heightPx = (dist(tl, bl) + dist(tr, br)) / 2;
    const [outW, outH] = outputSize(widthPx, heightPx, page.paper, dpi);

    // ถ้าต้นฉบับใหญ่กว่าผลลัพธ์มาก ย่อก่อน เพื่อให้ตัวหนังสือคมและทำงานเร็วขึ้น
    const ratio = Math.max(widthPx / outW, heightPx / outH);
    if (ratio > 1.5) {
      const s = 1.2 / ratio;
      working = scaleCanvas(source, Math.max(source.width, source.height) * s);
      canvases.push(working);
      const sx = working.width / source.width, sy = working.height / source.height;
      pts = pts.map((p) => ({ x: p.x * sx, y: p.y * sy }));
    }

    const warped = warpPerspective(working, pts, outW, outH);
    canvases.push(warped);
    applyFilter(warped, page.filter, page.bwLevel);
    const final = rotateCanvas(warped, page.rotation || 0);
    if (final !== warped) canvases.push(final);

    const processed = await canvasToBlob(final, 'image/jpeg', 0.85);
    const thumbCanvas = scaleCanvas(final, 360);
    canvases.push(thumbCanvas);
    const thumb = await canvasToBlob(thumbCanvas, 'image/jpeg', 0.8);
    return { processed, thumb };
  } finally {
    canvases.forEach(releaseCanvas);
  }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function outputSize(widthPx, heightPx, paperKey, dpi) {
  const landscape = widthPx > heightPx;
  const paper = PAPER[paperKey] || PAPER.a4;
  if (paper.mm) {
    const short = Math.round((paper.mm[0] / 25.4) * dpi);
    const long = Math.round((paper.mm[1] / 25.4) * dpi);
    return landscape ? [long, short] : [short, long];
  }
  const maxLong = Math.round((297 / 25.4) * dpi);
  const s = Math.min(1, maxLong / Math.max(widthPx, heightPx));
  return [Math.max(1, Math.round(widthPx * s)), Math.max(1, Math.round(heightPx * s))];
}

// MARK: Perspective correction

/** homography ที่แปลงจุดปลายทาง (u,v) → จุดต้นทาง (x,y) */
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x: u, y: v } = dst[i], { x, y } = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solve(A, b);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function warpPerspective(source, srcPts, outW, outH) {
  const sw = source.width, sh = source.height;
  const src = context2d(source).getImageData(0, 0, sw, sh).data;
  const dstPts = [{ x: 0, y: 0 }, { x: outW, y: 0 }, { x: outW, y: outH }, { x: 0, y: outH }];
  const [a, b, c, d, e, f, g, hh] = homography(dstPts, srcPts);

  const out = createCanvas(outW, outH);
  const outCtx = context2d(out);
  const image = outCtx.createImageData(outW, outH);
  const o = image.data;
  const maxX = sw - 1, maxY = sh - 1;

  let k = 0;
  for (let v = 0; v < outH; v++) {
    const vy = v + 0.5;
    const X0 = b * vy + c, Y0 = e * vy + f, Z0 = hh * vy + 1;
    for (let u = 0; u < outW; u++, k += 4) {
      const ux = u + 0.5;
      const z = g * ux + Z0;
      let x = (a * ux + X0) / z - 0.5;
      let y = (d * ux + Y0) / z - 0.5;
      if (x < 0) x = 0; else if (x > maxX) x = maxX;
      if (y < 0) y = 0; else if (y > maxY) y = maxY;
      const x0 = x | 0, y0 = y | 0;
      const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
      const fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      o[k] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      o[k + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      o[k + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      o[k + 3] = 255;
    }
  }
  outCtx.putImageData(image, 0, 0);
  return out;
}

function rotateCanvas(canvas, turns) {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return canvas;
  const w = canvas.width, h = canvas.height;
  const out = t === 2 ? createCanvas(w, h) : createCanvas(h, w);
  const ctx = out.getContext('2d');
  if (t === 1) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  if (t === 2) { ctx.translate(w, h); ctx.rotate(Math.PI); }
  if (t === 3) { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(canvas, 0, 0);
  return out;
}

// MARK: Filters

/**
 * ทุกฟิลเตอร์ (ยกเว้นต้นฉบับ) หารภาพด้วย "สีพื้นกระดาษ" ที่ประมาณได้ก่อน
 * → ลบเงาและแสงไม่สม่ำเสมอ ทำให้พื้นกระดาษเป็นสีขาว
 */
export function applyFilter(canvas, filter, bwLevel = 0.72) {
  if (filter === 'original') return;
  const W = canvas.width, H = canvas.height;
  const ctx = context2d(canvas);
  const image = ctx.getImageData(0, 0, W, H);
  const d = image.data;
  const bg = backgroundEstimate(canvas);
  const n = d.length;

  if (filter === 'color') {
    const lut = ratioLUT(1.35);
    for (let i = 0; i < n; i += 4) {
      for (let c = 0; c < 3; c++) {
        const r = (d[i + c] * 1024) / (bg[i + c] || 1);
        d[i + c] = lut[r > 1024 ? 1024 : r | 0];
      }
      // เพิ่มความสดของสีเล็กน้อย
      const avg = (d[i] + d[i + 1] + d[i + 2]) / 3;
      d[i] = avg + (d[i] - avg) * 1.25;
      d[i + 1] = avg + (d[i + 1] - avg) * 1.25;
      d[i + 2] = avg + (d[i + 2] - avg) * 1.25;
    }
  } else {
    const lut = ratioLUT(1.3);
    const cut = Math.round(bwLevel * 1024);
    const bw = filter === 'bw';
    for (let i = 0; i < n; i += 4) {
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const lumBg = bg[i] * 0.299 + bg[i + 1] * 0.587 + bg[i + 2] * 0.114 || 1;
      let r = (lum * 1024) / lumBg;
      r = r > 1024 ? 1024 : r | 0;
      const v = bw ? (r < cut ? 0 : 255) : lut[r];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** ค่า ratio (0..1024 = 0..1) → 0..255: สว่างกว่า 92% ถือเป็นขาว, ส่วนเข้มถูกทำให้เข้มขึ้น */
function ratioLUT(gamma) {
  const lut = new Uint8ClampedArray(1025);
  for (let i = 0; i <= 1024; i++) {
    const t = Math.min(1, i / 1024 / 0.92);
    lut[i] = Math.round(Math.pow(t, gamma) * 255);
  }
  return lut;
}

/** ประมาณสีพื้นกระดาษ: ย่อภาพ → ขยายส่วนสว่าง (ลบตัวอักษร) → เบลอ → ขยายกลับเต็มขนาด */
function backgroundEstimate(canvas) {
  const W = canvas.width, H = canvas.height;
  const s = 320 / Math.max(W, H);
  const w = Math.max(4, Math.round(W * s)), h = Math.max(4, Math.round(H * s));
  const small = createCanvas(w, h);
  const big = createCanvas(W, H);
  try {
    const sctx = context2d(small);
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, w, h);
    const im = sctx.getImageData(0, 0, w, h);
    separable(im.data, w, h, 3, Math.max);
    separable(im.data, w, h, 4, null);
    separable(im.data, w, h, 4, null);
    sctx.putImageData(im, 0, 0);

    const bctx = context2d(big);
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(small, 0, 0, W, H);
    return bctx.getImageData(0, 0, W, H).data;
  } finally {
    releaseCanvas(small);
    releaseCanvas(big);
  }
}

/** ฟิลเตอร์แยกแกน (แนวนอนแล้วแนวตั้ง): op = Math.max → dilate, null → ค่าเฉลี่ย (box blur) */
function separable(d, w, h, r, op) {
  const tmp = new Uint8ClampedArray(d.length);
  const pass = (src, dst, horizontal) => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let acc = 0, count = 0;
          for (let k = -r; k <= r; k++) {
            const xx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
            const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
            const v = src[(yy * w + xx) * 4 + c];
            if (op) acc = op(acc, v); else { acc += v; count++; }
          }
          dst[(y * w + x) * 4 + c] = op ? acc : acc / count;
        }
        dst[(y * w + x) * 4 + 3] = 255;
      }
    }
  };
  pass(d, tmp, true);
  pass(tmp, d, false);
}
