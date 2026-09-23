// ตรวจจับขอบกระดาษ 4 มุม
// แนวคิด: กระดาษมักสว่างและสีจืดกว่าพื้นหลัง → แยกด้วย Otsu threshold
// → หาก้อนสว่างที่ใหญ่ที่สุด → convex hull → ลดเหลือ 4 มุม

import { createCanvas, context2d } from './util.js';

const WORK_SIZE = 256;
let scratch;

/** คืนค่า [tl, tr, br, bl] เป็นพิกัด normalized (0..1) หรือ null ถ้าหาไม่เจอ */
export function detectQuad(source, sourceWidth, sourceHeight) {
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.min(1, WORK_SIZE / Math.max(sourceWidth, sourceHeight));
  const w = Math.max(16, Math.round(sourceWidth * scale));
  const h = Math.max(16, Math.round(sourceHeight * scale));

  if (!scratch) scratch = createCanvas(w, h);
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const ctx = context2d(scratch);
  ctx.drawImage(source, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;

  // ค่า "ความเป็นกระดาษ" = ความสว่าง − ความอิ่มสี
  let score = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < score.length; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    score[i] = 0.299 * r + 0.587 * g + 0.114 * b - 0.6 * (max - min);
  }
  score = boxBlur(score, w, h);
  score = boxBlur(score, w, h);

  const threshold = otsu(score);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = score[i] > threshold ? 1 : 0;

  const component = largestComponent(mask, w, h);
  if (!component || component.count < w * h * 0.08) return null;

  const hull = convexHull(component.points);
  if (hull.length < 4) return null;
  const quad = simplifyToQuad(hull);
  if (!quad || polygonArea(quad) < w * h * 0.08) return null;

  return orderCorners(quad).map((p) => ({
    x: Math.min(1, Math.max(0, (p.x + 0.5) / w)),
    y: Math.min(1, Math.max(0, (p.y + 0.5) / h)),
  }));
}

function boxBlur(src, w, h) {
  const tmp = new Uint8ClampedArray(src.length);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = x > 0 ? i - 1 : i, r = x < w - 1 ? i + 1 : i;
      tmp[i] = (src[l] + src[i] + src[r]) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = y > 0 ? i - w : i, d = y < h - 1 ? i + w : i;
      out[i] = (tmp[u] + tmp[i] + tmp[d]) / 3;
    }
  }
  return out;
}

function otsu(values) {
  const hist = new Array(256).fill(0);
  for (const v of values) hist[v]++;
  const total = values.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** ก้อนพิกเซลที่ติดกันใหญ่ที่สุด → คืนจุดซ้ายสุด/ขวาสุดของแต่ละแถว (พอสำหรับ convex hull) */
function largestComponent(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = null, label = 0;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    label++;
    let top = 0, count = 0;
    const rowMin = new Map(), rowMax = new Map();
    stack[top++] = start;
    labels[start] = label;
    while (top) {
      const i = stack[--top];
      count++;
      const x = i % w, y = (i - x) / w;
      if (!rowMin.has(y) || x < rowMin.get(y)) rowMin.set(y, x);
      if (!rowMax.has(y) || x > rowMax.get(y)) rowMax.set(y, x);
      if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = label; stack[top++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = label; stack[top++] = i + 1; }
      if (y > 0 && mask[i - w] && !labels[i - w]) { labels[i - w] = label; stack[top++] = i - w; }
      if (y < h - 1 && mask[i + w] && !labels[i + w]) { labels[i + w] = label; stack[top++] = i + w; }
    }
    if (!best || count > best.count) {
      const points = [];
      for (const [y, x] of rowMin) points.push({ x, y });
      for (const [y, x] of rowMax) points.push({ x, y });
      best = { count, points };
    }
  }
  return best;
}

function cross(o, a, b) {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function convexHull(points) {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower = [], upper = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** ตัดจุดที่ทำให้พื้นที่หายน้อยที่สุดออกทีละจุด จนเหลือ 4 มุม */
function simplifyToQuad(hull) {
  const p = hull.slice();
  while (p.length > 4) {
    let minArea = Infinity, index = -1;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
      const area = Math.abs(cross(a, b, c));
      if (area < minArea) {
        minArea = area;
        index = i;
      }
    }
    p.splice(index, 1);
  }
  return p.length === 4 ? p : null;
}

export function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/** เรียงเป็น ซ้ายบน, ขวาบน, ขวาล่าง, ซ้ายล่าง */
export function orderCorners(pts) {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let first = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].x + sorted[i].y < sorted[first].x + sorted[first].y) first = i;
  }
  return sorted.slice(first).concat(sorted.slice(0, first));
}
