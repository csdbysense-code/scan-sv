// ตัวช่วยทั่วไป: สร้าง DOM, canvas, blob

export const uid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

/** สร้าง element: h('div', { class: 'x', onclick: fn }, child1, child2) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'html') el.innerHTML = value; // ใช้กับไอคอน SVG ที่เขียนไว้เองเท่านั้น
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** รอให้เบราว์เซอร์วาดหน้าจอก่อน (ให้ข้อความ "กำลังประมวลผล" แสดงขึ้น) */
export const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(finish, 0));
  setTimeout(finish, 60); // rAF ไม่ทำงานเมื่อหน้าอยู่เบื้องหลัง
});

export function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/** คืนหน่วยความจำของ canvas (สำคัญบน iOS ที่จำกัดหน่วยความจำ canvas รวม) */
export function releaseCanvas(canvas) {
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function context2d(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true });
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), type, quality));
}

/** โหลดภาพ (หมุนตาม EXIF ให้อัตโนมัติ) แล้ววาดลง canvas โดยย่อไม่ให้ด้านยาวเกิน maxSide */
export async function blobToCanvas(blob, maxSide = Infinity) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = createCanvas(
      Math.max(1, Math.round(img.naturalWidth * scale)),
      Math.max(1, Math.round(img.naturalHeight * scale)));
    const ctx = context2d(canvas);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** ย่อ canvas/img ให้ด้านยาวไม่เกิน maxSide (ใช้ขนาดจริงของภาพ ไม่ใช่ขนาดที่แสดงบนจอ) */
export function scaleCanvas(source, maxSide) {
  const sw = source.naturalWidth || source.width;
  const sh = source.naturalHeight || source.height;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const canvas = createCanvas(
    Math.max(1, Math.round(sw * scale)),
    Math.max(1, Math.round(sh * scale)));
  const ctx = context2d(canvas);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDate(ms) {
  return new Date(ms).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

export function safeFileName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|%]+/g, '-').trim();
  return cleaned || 'Scan';
}
