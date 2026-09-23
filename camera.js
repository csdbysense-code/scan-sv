// หน้าจอกล้อง: ถ่ายได้หลายหน้า, แสดงกรอบกระดาษแบบสด, ไฟฉาย (ถ้าเครื่อง/เบราว์เซอร์รองรับ)
// และปุ่ม "กล้อง iPhone" สำหรับภาพความละเอียดเต็มพร้อมแฟลชของระบบ

import { detectQuad } from './detect.js';
import { icon } from './icons.js';
import { canvasToBlob, createCanvas, h, releaseCanvas } from './util.js';

/** คืนค่า Promise<Blob[] | null> */
export function openCamera() {
  return new Promise((resolve) => {
    const shots = []; // { blob, url }
    let stream = null;
    let track = null;
    let detectTimer = null;
    let liveQuad = null;
    let missed = 0;
    let torchOn = false;
    let closed = false;

    const video = h('video', { class: 'cam-video', playsinline: true, muted: true, autoplay: true });
    video.muted = true;
    const overlay = h('canvas', { class: 'cam-overlay' });
    const flashFx = h('div', { class: 'cam-flash' });
    const message = h('div', { class: 'cam-message', hidden: true });
    const resolutionLabel = h('span', { class: 'cam-res' });

    const torchButton = h('button', { class: 'cam-icon', hidden: true, 'aria-label': 'ไฟฉาย', onclick: toggleTorch }, icon('flash'));
    const thumb = h('button', { class: 'cam-thumb', disabled: true, onclick: openReview });
    const doneButton = h('button', { class: 'btn primary', disabled: true, onclick: finish }, 'เสร็จ');
    const shutter = h('button', { class: 'cam-shutter', 'aria-label': 'ถ่ายภาพ', onclick: capture }, h('span'));

    const nativeInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    nativeInput.addEventListener('change', () => {
      for (const file of nativeInput.files) addShot(file);
      nativeInput.value = '';
      start();
    });

    const root = h('div', { class: 'fullscreen camera' },
      h('div', { class: 'cam-top' },
        h('button', { class: 'cam-icon', 'aria-label': 'ปิด', onclick: cancel }, icon('close')),
        resolutionLabel,
        torchButton),
      h('div', { class: 'cam-stage' }, video, overlay, flashFx, message),
      h('div', { class: 'cam-bottom' },
        h('div', { class: 'cam-side' }, thumb),
        shutter,
        h('div', { class: 'cam-side right' }, doneButton)),
      h('div', { class: 'cam-extra' },
        h('button', { class: 'btn ghost small', onclick: openNativeCamera }, icon('aperture', 18), 'กล้อง iPhone (ละเอียดสูง + แฟลช)')),
      nativeInput);

    document.body.append(root);
    window.addEventListener('resize', drawOverlay);
    document.addEventListener('visibilitychange', onVisibility);
    start();

    async function start() {
      if (closed || (stream && track && track.readyState === 'live')) return;
      showMessage(null);
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 4032 },
            height: { ideal: 3024 },
          },
        });
      } catch (err) {
        console.error(err);
        showMessage('เปิดกล้องไม่ได้ — ตรวจสอบสิทธิ์กล้องใน Settings > Safari หรือใช้ปุ่ม "กล้อง iPhone" ด้านล่าง', true);
        return;
      }
      if (closed) { stopStream(); return; }
      track = stream.getVideoTracks()[0];
      track.addEventListener('ended', () => showMessage('กล้องหยุดทำงาน', true));
      video.srcObject = stream;
      await video.play().catch(() => {});

      const caps = track.getCapabilities ? track.getCapabilities() : {};
      torchButton.hidden = !caps.torch;
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
      const updateRes = () => { resolutionLabel.textContent = video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : ''; };
      video.addEventListener('loadedmetadata', updateRes, { once: true });
      updateRes();

      clearInterval(detectTimer);
      detectTimer = setInterval(detectLive, 150);
    }

    function stopStream() {
      clearInterval(detectTimer);
      detectTimer = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
      track = null;
      torchOn = false;
      liveQuad = null;
      drawOverlay();
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') start();
    }

    function showMessage(text, withRetry = false) {
      message.hidden = !text;
      message.replaceChildren();
      if (!text) return;
      message.append(h('p', null, text));
      if (withRetry) {
        message.append(h('button', { class: 'btn primary', onclick: () => { stopStream(); start(); } }, 'เปิดกล้องอีกครั้ง'));
      }
    }

    function detectLive() {
      if (!video.videoWidth || video.readyState < 2) return;
      const quad = detectQuad(video, video.videoWidth, video.videoHeight);
      if (quad) {
        missed = 0;
        // ทำให้กรอบนิ่งขึ้น (เฉลี่ยกับเฟรมก่อน)
        liveQuad = liveQuad
          ? quad.map((p, i) => ({ x: liveQuad[i].x * 0.5 + p.x * 0.5, y: liveQuad[i].y * 0.5 + p.y * 0.5 }))
          : quad;
      } else if (++missed > 4) {
        liveQuad = null;
      }
      drawOverlay();
    }

    /** กรอบวิดีโอที่แสดงจริง (object-fit: contain) */
    function videoRect() {
      const cw = overlay.clientWidth, ch = overlay.clientHeight;
      const vw = video.videoWidth || 3, vh = video.videoHeight || 4;
      const s = Math.min(cw / vw, ch / vh);
      return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
    }

    function drawOverlay() {
      const dpr = window.devicePixelRatio || 1;
      const cw = overlay.clientWidth, ch = overlay.clientHeight;
      if (overlay.width !== Math.round(cw * dpr) || overlay.height !== Math.round(ch * dpr)) {
        overlay.width = Math.round(cw * dpr);
        overlay.height = Math.round(ch * dpr);
      }
      const ctx = overlay.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      if (!liveQuad) return;
      const r = videoRect();
      ctx.beginPath();
      liveQuad.forEach((p, i) => {
        const x = r.x + p.x * r.w, y = r.y + p.y * r.h;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(59,130,246,0.22)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#3b82f6';
      ctx.stroke();
    }

    async function capture() {
      if (!video.videoWidth) return;
      shutter.disabled = true;
      flashFx.classList.remove('on');
      void flashFx.offsetWidth;
      flashFx.classList.add('on');
      if (navigator.vibrate) navigator.vibrate(20);
      const canvas = createCanvas(video.videoWidth, video.videoHeight);
      try {
        canvas.getContext('2d').drawImage(video, 0, 0);
        addShot(await canvasToBlob(canvas, 'image/jpeg', 0.92));
      } catch (err) {
        console.error(err);
      } finally {
        releaseCanvas(canvas);
        shutter.disabled = false;
      }
    }

    function openNativeCamera() {
      // ปิดกล้องในแอปก่อน เพราะ iOS ใช้กล้องได้ทีละแอป แล้วเปิดใหม่หลังถ่ายเสร็จ
      stopStream();
      showMessage('กำลังใช้กล้อง iPhone…', true);
      nativeInput.click();
    }

    async function toggleTorch() {
      if (!track) return;
      torchOn = !torchOn;
      try {
        await track.applyConstraints({ advanced: [{ torch: torchOn }] });
      } catch {
        torchOn = false;
      }
      torchButton.classList.toggle('active', torchOn);
    }

    function addShot(blob) {
      shots.push({ blob, url: URL.createObjectURL(blob) });
      updateBottom();
    }

    function updateBottom() {
      const last = shots[shots.length - 1];
      thumb.replaceChildren();
      thumb.disabled = !last;
      doneButton.disabled = !last;
      doneButton.textContent = shots.length ? `เสร็จ (${shots.length})` : 'เสร็จ';
      if (last) {
        thumb.append(h('img', { src: last.url, alt: '' }), h('span', { class: 'badge' }, String(shots.length)));
      }
    }

    function openReview() {
      const list = h('div', { class: 'review-list' });
      const render = () => {
        list.replaceChildren(...shots.map((shot, i) =>
          h('div', { class: 'review-item' },
            h('img', { src: shot.url, alt: `ภาพที่ ${i + 1}` }),
            h('span', { class: 'review-num' }, String(i + 1)),
            h('button', {
              class: 'review-del', 'aria-label': 'ลบภาพ',
              onclick: () => {
                URL.revokeObjectURL(shot.url);
                shots.splice(i, 1);
                updateBottom();
                if (!shots.length) panel.remove(); else render();
              },
            }, icon('trash', 18)))));
      };
      const panel = h('div', { class: 'review' },
        h('div', { class: 'review-head' },
          h('strong', null, 'ภาพที่ถ่ายแล้ว'),
          h('button', { class: 'btn small', onclick: () => panel.remove() }, 'ปิด')),
        list);
      render();
      root.append(panel);
    }

    function cleanup() {
      closed = true;
      stopStream();
      window.removeEventListener('resize', drawOverlay);
      document.removeEventListener('visibilitychange', onVisibility);
      shots.forEach((s) => URL.revokeObjectURL(s.url));
      root.remove();
    }

    function finish() {
      const blobs = shots.map((s) => s.blob);
      cleanup();
      resolve(blobs);
    }

    function cancel() {
      if (shots.length && !confirm(`ทิ้งภาพที่ถ่ายไว้ ${shots.length} ภาพ?`)) return;
      cleanup();
      resolve(null);
    }
  });
}
