// ลากมุมทั้ง 4 ให้ตรงขอบกระดาษ มีแว่นขยายช่วยตอนลาก

import { detectQuad } from './detect.js';
import { FULL_QUAD } from './processing.js';
import { icon } from './icons.js';
import { clamp, h, releaseCanvas, scaleCanvas } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const LOUPE = 120; // px (CSS)
const ZOOM = 2.5;

/** คืนค่า Promise<quad | null> */
export function openCropEditor(originalBlob, initialQuad) {
  return new Promise((resolve) => {
    let quad = initialQuad.map((p) => ({ ...p }));
    let rect = { w: 1, h: 1 }; // ขนาดภาพบนจอ (px)
    let drag = null;

    const url = URL.createObjectURL(originalBlob);
    const img = h('img', { class: 'crop-img', src: url, alt: '', draggable: 'false' });
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.classList.add('crop-svg');
    const polygon = document.createElementNS(SVG_NS, 'polygon');
    svg.append(polygon);
    const handles = quad.map((_, i) => h('div', { class: 'crop-handle', 'data-i': i }));
    const stage = h('div', { class: 'crop-stage' }, img, svg, ...handles);
    const dpr = window.devicePixelRatio || 1;
    const loupe = h('canvas', { class: 'loupe', width: LOUPE * dpr, height: LOUPE * dpr, hidden: true });
    const area = h('div', { class: 'crop-area' }, stage, loupe);
    const autoButton = h('button', { class: 'btn', onclick: autoDetect }, icon('wand', 18), 'หาขอบอัตโนมัติ');

    const root = h('div', { class: 'fullscreen crop' },
      h('header', { class: 'bar top dark' },
        h('button', { class: 'btn text', onclick: () => close(null) }, 'ยกเลิก'),
        h('div', { class: 'bar-title' }, 'ปรับขอบกระดาษ'),
        h('button', { class: 'btn text strong', onclick: () => close(quad) }, 'ตกลง')),
      area,
      h('footer', { class: 'bar bottom dark' },
        autoButton,
        h('button', { class: 'btn', onclick: () => { quad = FULL_QUAD.map((p) => ({ ...p })); draw(); } },
          icon('expand', 18), 'ทั้งภาพ')));

    document.body.append(root);
    window.addEventListener('resize', layout);
    img.decode().catch(() => {}).then(layout);

    handles.forEach((el, i) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        drag = { i, startX: e.clientX, startY: e.clientY, start: { ...quad[i] } };
        el.classList.add('active');
        loupe.hidden = false;
        updateLoupe();
      });
      el.addEventListener('pointermove', (e) => {
        if (!drag || drag.i !== i) return;
        quad[i] = {
          x: clamp(drag.start.x + (e.clientX - drag.startX) / rect.w, 0, 1),
          y: clamp(drag.start.y + (e.clientY - drag.startY) / rect.h, 0, 1),
        };
        draw();
        updateLoupe();
      });
      const end = () => {
        drag = null;
        el.classList.remove('active');
        loupe.hidden = true;
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });

    function layout() {
      if (!img.naturalWidth) return;
      const pad = 28;
      const aw = Math.max(50, area.clientWidth - pad * 2);
      const ah = Math.max(50, area.clientHeight - pad * 2);
      const s = Math.min(aw / img.naturalWidth, ah / img.naturalHeight);
      rect = { w: img.naturalWidth * s, h: img.naturalHeight * s };
      stage.style.width = `${rect.w}px`;
      stage.style.height = `${rect.h}px`;
      svg.setAttribute('viewBox', `0 0 ${rect.w} ${rect.h}`);
      draw();
    }

    function draw() {
      polygon.setAttribute('points', quad.map((p) => `${p.x * rect.w},${p.y * rect.h}`).join(' '));
      handles.forEach((el, i) => {
        el.style.transform = `translate(${quad[i].x * rect.w}px, ${quad[i].y * rect.h}px)`;
      });
    }

    function updateLoupe() {
      if (!drag) return;
      const p = quad[drag.i];
      const ctx = loupe.getContext('2d');
      const size = loupe.width;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);

      // พื้นที่ในภาพต้นฉบับ (px) ที่จะแสดง — ตัดให้อยู่ในภาพ เพราะ Safari ไม่วาดถ้าเกินขอบ
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const region = (LOUPE / ZOOM) * (nw / rect.w);
      const scale = size / region;
      let sx = p.x * nw - region / 2, sy = p.y * nh - region / 2;
      const x0 = Math.max(0, sx), y0 = Math.max(0, sy);
      const x1 = Math.min(nw, sx + region), y1 = Math.min(nh, sy + region);
      if (x1 > x0 && y1 > y0) {
        ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0,
          (x0 - sx) * scale, (y0 - sy) * scale, (x1 - x0) * scale, (y1 - y0) * scale);
      }
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 2 * dpr;
      ctx.beginPath();
      ctx.moveTo(size / 2, size / 2 - 12 * dpr); ctx.lineTo(size / 2, size / 2 + 12 * dpr);
      ctx.moveTo(size / 2 - 12 * dpr, size / 2); ctx.lineTo(size / 2 + 12 * dpr, size / 2);
      ctx.stroke();

      loupe.classList.toggle('right', p.x < 0.5);
    }

    function autoDetect() {
      const canvas = scaleCanvas(img, 1200);
      const found = detectQuad(canvas, canvas.width, canvas.height);
      releaseCanvas(canvas);
      if (found) {
        quad = found;
        draw();
      } else {
        autoButton.classList.add('shake');
        setTimeout(() => autoButton.classList.remove('shake'), 500);
      }
    }

    function close(result) {
      window.removeEventListener('resize', layout);
      URL.revokeObjectURL(url);
      root.remove();
      resolve(result);
    }
  });
}
