import { openCamera } from './camera.js';
import { openCropEditor } from './crop.js';
import { blobKeys, db } from './db.js';
import { icon } from './icons.js';
import { buildPDF } from './pdf.js';
import { FILTERS, PAPER, prepareOriginal, renderPage } from './processing.js';
import { fmtBytes, fmtDate, h, nextFrame, safeFileName, uid } from './util.js';

const app = document.getElementById('app');

// MARK: - การตั้งค่า (เก็บในเครื่อง)

const SETTINGS_KEY = 'scansv.settings';
const settings = { paper: 'a4', filter: 'color', dpi: 200, ...readJSON(SETTINGS_KEY) };

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* โหมดส่วนตัว */ }
}

// MARK: - สถานะ

const state = {
  docs: [],
  route: { name: 'library' },
  processing: new Set(), // pageId ที่กำลังประมวลผล
};
const scrollMemo = new Map();

const findDoc = (id) => state.docs.find((d) => d.id === id);

function go(route) {
  state.route = route;
  render();
}

function routeKey(r) {
  return r.name === 'page' ? `page:${r.pageId}` : r.name === 'doc' ? `doc:${r.docId}` : 'library';
}

function render() {
  const content = app.querySelector('.content');
  if (content) scrollMemo.set(app.dataset.route, content.scrollTop);

  const r = state.route;
  const view = r.name === 'doc' ? docView(r) : r.name === 'page' ? pageView(r) : libraryView();
  const key = routeKey(state.route);
  app.dataset.route = key;
  app.replaceChildren(view);

  const next = app.querySelector('.content');
  if (next) next.scrollTop = scrollMemo.get(key) || 0;
}

// MARK: - ภาพจากฐานข้อมูล (cache เป็น object URL)

const urlCache = new Map();

function blobImage(pageId, kind, rev, className) {
  const img = h('img', { class: className, alt: '', draggable: 'false' });
  const key = `${pageId}/${kind}@${rev || 0}`;
  const cached = urlCache.get(key);
  if (cached) {
    img.src = cached;
  } else {
    db.getBlob(`${pageId}/${kind}`).then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      urlCache.set(key, url);
      img.src = url;
    });
  }
  return img;
}

function invalidateImages(pageId) {
  for (const [key, url] of urlCache) {
    if (key.startsWith(`${pageId}/`)) {
      URL.revokeObjectURL(url);
      urlCache.delete(key);
    }
  }
}

// MARK: - UI ทั่วไป

function header({ title, left, right, onTitle, large }) {
  return h('header', { class: `bar top${large ? ' large' : ''}` },
    h('div', { class: 'bar-side' }, left),
    h('div', { class: `bar-title${onTitle ? ' tappable' : ''}`, onclick: onTitle }, title),
    h('div', { class: 'bar-side right' }, right));
}

function iconButton(name, label, onclick, extra = {}) {
  return h('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick, ...extra }, icon(name));
}

function backButton(label, onclick) {
  return h('button', { class: 'btn text back', onclick }, icon('back'), label);
}

function segmented(options, value, onChange, disabled) {
  return h('div', { class: 'segmented', role: 'group' },
    Object.entries(options).map(([key, label]) =>
      h('button', {
        class: key === value ? 'selected' : '',
        disabled,
        'aria-pressed': key === value ? 'true' : 'false',
        onclick: () => key !== value && onChange(key),
      }, label)));
}

function busy(message) {
  let el = document.getElementById('busy');
  if (!message) { el?.remove(); return; }
  if (!el) {
    el = h('div', { id: 'busy', class: 'busy' },
      h('div', { class: 'busy-box' }, h('div', { class: 'spinner' }), h('div', { class: 'busy-msg' })));
    document.body.append(el);
  }
  el.querySelector('.busy-msg').textContent = message;
}

function toast(message) {
  const el = h('div', { class: 'toast' }, message);
  document.body.append(el);
  setTimeout(() => el.classList.add('hide'), 2200);
  setTimeout(() => el.remove(), 2600);
}

/** แผ่นเมนูจากด้านล่าง: items = [{ label, icon, danger, onClick }] */
function actionSheet(title, items) {
  const close = () => backdrop.remove();
  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e) => e.target === backdrop && close() },
    h('div', { class: 'sheet' },
      title && h('div', { class: 'sheet-title' }, title),
      items.map((item) => h('button', {
        class: `sheet-item${item.danger ? ' danger' : ''}`,
        onclick: () => { close(); item.onClick(); },
      }, item.icon && icon(item.icon, 20), item.label)),
      h('button', { class: 'sheet-item cancel', onclick: close }, 'ยกเลิก')));
  document.body.append(backdrop);
}

// MARK: - หน้ารายการเอกสาร

function libraryView() {
  const list = state.docs.length
    ? h('div', { class: 'doc-list' }, state.docs.map(docCard))
    : h('div', { class: 'empty' },
      icon('scan', 56),
      h('h2', null, 'ยังไม่มีเอกสาร'),
      h('p', null, 'กด "สแกนเอกสาร" ด้านล่างเพื่อเริ่ม'));

  return h('div', { class: 'screen' },
    header({ title: 'เอกสาร', large: true, right: iconButton('settings', 'ตั้งค่า', openSettings) }),
    h('main', { class: 'content' }, installHint(), list),
    h('footer', { class: 'bar bottom' },
      h('button', { class: 'btn primary grow', onclick: () => startCamera(null) }, icon('camera'), 'สแกนเอกสาร'),
      h('button', { class: 'btn', onclick: () => pickPhotos(null) }, icon('image'), 'รูปภาพ')));
}

function docCard(doc) {
  const first = doc.pages[0];
  return h('button', { class: 'doc-card', onclick: () => go({ name: 'doc', docId: doc.id }) },
    h('div', { class: 'doc-thumb' }, first && blobImage(first.id, 'thumb', first.rev)),
    h('div', { class: 'doc-info' },
      h('div', { class: 'doc-name' }, doc.name),
      h('div', { class: 'doc-meta' }, `${doc.pages.length} หน้า · ${fmtDate(doc.updatedAt)}`)),
    icon('next', 18));
}

function installHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || localStorage.getItem('scansv.hideInstall')) return null;
  const el = h('div', { class: 'hint' },
    h('div', null,
      h('strong', null, 'ติดตั้งเป็นแอป'),
      h('p', null, 'ใน Safari กด ', icon('share', 16), ' แชร์ → "เพิ่มไปยังหน้าจอโฮม" เพื่อเปิดแบบเต็มจอและเก็บข้อมูลได้ถาวร')),
    h('button', {
      class: 'icon-btn', 'aria-label': 'ปิด',
      onclick: () => { try { localStorage.setItem('scansv.hideInstall', '1'); } catch { /* */ } el.remove(); },
    }, icon('close', 18)));
  return el;
}

// MARK: - หน้าเอกสาร (รายการหน้า)

function docView(r) {
  const doc = findDoc(r.docId);
  if (!doc) return libraryView();
  const arranging = !!r.arranging;

  const tiles = doc.pages.map((page, i) => {
    const tile = h('div', { class: `tile${state.processing.has(page.id) ? ' processing' : ''}` },
      h('div', { class: 'tile-img' }, blobImage(page.id, 'thumb', page.rev)),
      h('div', { class: 'tile-label' },
        h('span', { class: 'tile-num' }, String(i + 1)),
        h('span', null, `${PAPER[page.paper]?.label} · ${FILTERS[page.filter]}`)));
    if (arranging) {
      tile.append(h('div', { class: 'tile-actions' },
        iconButton('prev', 'เลื่อนไปก่อนหน้า', () => movePage(doc, i, -1), { disabled: i === 0 }),
        iconButton('trash', 'ลบหน้า', () => deletePage(doc, page.id), { class: 'icon-btn danger' }),
        iconButton('next', 'เลื่อนไปถัดไป', () => movePage(doc, i, 1), { disabled: i === doc.pages.length - 1 })));
    } else {
      tile.addEventListener('click', () => go({ name: 'page', docId: doc.id, pageId: page.id }));
      tile.classList.add('tappable');
    }
    return tile;
  });

  return h('div', { class: 'screen' },
    header({
      title: doc.name,
      onTitle: () => renameDoc(doc),
      left: backButton('เอกสาร', () => go({ name: 'library' })),
      right: arranging
        ? h('button', { class: 'btn text strong', onclick: () => go({ ...r, arranging: false }) }, 'เสร็จ')
        : [
          iconButton('reorder', 'จัดเรียง / ลบหน้า', () => go({ ...r, arranging: true })),
          iconButton('more', 'เพิ่มเติม', () => actionSheet(doc.name, [
            { label: 'เปลี่ยนชื่อ', icon: 'pencil', onClick: () => renameDoc(doc) },
            { label: 'ลบเอกสาร', icon: 'trash', danger: true, onClick: () => deleteDoc(doc) },
          ])),
        ],
    }),
    h('main', { class: 'content' },
      arranging && h('p', { class: 'note' }, 'ใช้ปุ่มลูกศรเพื่อเรียงหน้า หรือถังขยะเพื่อลบหน้า'),
      doc.pages.length ? h('div', { class: 'page-grid' }, tiles) : h('div', { class: 'empty' }, h('p', null, 'ไม่มีหน้า — กด "เพิ่มหน้า"'))),
    h('footer', { class: 'bar bottom' },
      h('button', {
        class: 'btn',
        onclick: () => actionSheet('เพิ่มหน้า', [
          { label: 'ถ่ายด้วยกล้อง', icon: 'camera', onClick: () => startCamera(doc.id) },
          { label: 'เลือกจากรูปภาพ', icon: 'image', onClick: () => pickPhotos(doc.id) },
        ]),
      }, icon('plus'), 'เพิ่มหน้า'),
      h('button', { class: 'btn primary grow', disabled: !doc.pages.length, onclick: () => exportPDF(doc, doc.pages, doc.name) }, icon('file'), 'แชร์ PDF'),
      h('button', { class: 'btn', disabled: !doc.pages.length, onclick: () => exportImages(doc, doc.pages, doc.name) }, icon('image'), 'รูป')));
}

// MARK: - หน้าแก้ไขหน้าเดียว

function pageView(r) {
  const doc = findDoc(r.docId);
  const index = doc ? doc.pages.findIndex((p) => p.id === r.pageId) : -1;
  if (index < 0) return doc ? docView({ name: 'doc', docId: doc.id }) : libraryView();
  const page = doc.pages[index];
  const total = doc.pages.length;
  const isBusy = state.processing.has(page.id);
  const goTo = (i) => go({ name: 'page', docId: doc.id, pageId: doc.pages[i].id });
  const update = (changes) => updatePage(doc, page, changes);

  const preview = h('div', { class: `preview${isBusy ? ' processing' : ''}` },
    blobImage(page.id, 'proc', page.rev, 'preview-img'),
    isBusy && h('div', { class: 'preview-spinner' }, h('div', { class: 'spinner' })),
    index > 0 && h('button', { class: 'nav-arrow left', 'aria-label': 'หน้าก่อน', onclick: () => goTo(index - 1) }, icon('prev')),
    index < total - 1 && h('button', { class: 'nav-arrow right', 'aria-label': 'หน้าถัดไป', onclick: () => goTo(index + 1) }, icon('next')));

  // ปัดซ้าย/ขวาเพื่อเปลี่ยนหน้า
  let touchX = null;
  preview.addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  preview.addEventListener('touchend', (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    if (dx < -60 && index < total - 1) goTo(index + 1);
    if (dx > 60 && index > 0) goTo(index - 1);
  });

  const bwControl = page.filter === 'bw' && h('label', { class: 'slider' },
    h('span', null, 'จาง'),
    h('input', {
      type: 'range', min: '0.5', max: '0.95', step: '0.01', value: String(page.bwLevel ?? 0.72),
      disabled: isBusy,
      onchange: (e) => update({ bwLevel: Number(e.target.value) }),
    }),
    h('span', null, 'เข้ม'));

  return h('div', { class: 'screen' },
    header({
      title: `หน้า ${index + 1}/${total}`,
      left: backButton('หน้าทั้งหมด', () => go({ name: 'doc', docId: doc.id })),
      right: iconButton('more', 'เพิ่มเติม', () => actionSheet(`หน้า ${index + 1}`, [
        { label: 'แชร์หน้านี้เป็น PDF', icon: 'file', onClick: () => exportPDF(doc, [page], `${doc.name} หน้า ${index + 1}`) },
        { label: 'แชร์หน้านี้เป็นรูปภาพ', icon: 'image', onClick: () => exportImages(doc, [page], `${doc.name} หน้า ${index + 1}`) },
        { label: 'ใช้ขนาดและฟิลเตอร์นี้กับทุกหน้า', icon: 'layers', onClick: () => applyToAll(doc, page) },
        { label: 'ลบหน้านี้', icon: 'trash', danger: true, onClick: () => deletePage(doc, page.id) },
      ]), { disabled: isBusy }),
    }),
    h('main', { class: 'editor' },
      preview,
      h('div', { class: 'controls' },
        segmented(FILTERS, page.filter, (filter) => update({ filter }), isBusy),
        bwControl,
        segmented(Object.fromEntries(Object.entries(PAPER).map(([k, v]) => [k, v.label])), page.paper, (paper) => update({ paper }), isBusy),
        h('div', { class: 'tools' },
          toolButton('crop', 'ปรับขอบ', () => cropPage(doc, page), isBusy),
          toolButton('rotateLeft', 'หมุนซ้าย', () => update({ rotation: ((page.rotation || 0) + 3) % 4 }), isBusy),
          toolButton('rotateRight', 'หมุนขวา', () => update({ rotation: ((page.rotation || 0) + 1) % 4 }), isBusy),
          toolButton('share', 'แชร์', () => exportPDF(doc, [page], `${doc.name} หน้า ${index + 1}`), isBusy)))));
}

function toolButton(iconName, label, onclick, disabled) {
  return h('button', { class: 'tool', onclick, disabled }, icon(iconName), h('span', null, label));
}

// MARK: - การทำงานกับเอกสาร

async function saveDoc(doc) {
  doc.updatedAt = Date.now();
  await db.putDoc(doc);
  if (!findDoc(doc.id)) state.docs.push(doc);
  state.docs.sort((a, b) => b.updatedAt - a.updatedAt);
}

function defaultName() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `สแกน ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

async function startCamera(docId) {
  const blobs = await openCamera();
  if (blobs && blobs.length) await importImages(blobs, docId, true);
}

function pickPhotos(docId) {
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  input.addEventListener('change', async () => {
    const files = [...input.files];
    input.remove();
    if (files.length) await importImages(files, docId, true);
  });
  document.body.append(input);
  input.click();
}

async function importImages(blobs, docId, detect) {
  let doc = docId ? findDoc(docId) : null;
  const isNew = !doc;
  if (isNew) doc = { id: uid(), name: defaultName(), createdAt: Date.now(), updatedAt: Date.now(), pages: [] };
  let added = 0;
  try {
    for (let i = 0; i < blobs.length; i++) {
      busy(`กำลังประมวลผลหน้า ${i + 1}/${blobs.length}`);
      await nextFrame();
      try {
        const { original, quad } = await prepareOriginal(blobs[i], detect);
        const page = {
          id: uid(), quad, paper: settings.paper, filter: settings.filter,
          bwLevel: 0.72, rotation: 0, rev: 0, dpi: settings.dpi,
        };
        const { processed, thumb } = await renderPage(page, original, page.dpi);
        await db.putBlobs({ [`${page.id}/orig`]: original, [`${page.id}/proc`]: processed, [`${page.id}/thumb`]: thumb });
        doc.pages.push(page);
        added++;
      } catch (err) {
        console.error(err);
        toast(`ภาพที่ ${i + 1} ประมวลผลไม่สำเร็จ`);
      }
    }
    if (added) {
      await saveDoc(doc);
      state.route = { name: 'doc', docId: doc.id };
    }
  } finally {
    busy(null);
    render();
  }
}

async function updatePage(doc, page, changes) {
  Object.assign(page, changes);
  state.processing.add(page.id);
  render();
  try {
    await rerender(page);
  } catch (err) {
    console.error(err);
    toast('ประมวลผลไม่สำเร็จ');
  } finally {
    state.processing.delete(page.id);
    await saveDoc(doc);
    render();
  }
}

async function rerender(page) {
  const original = await db.getBlob(`${page.id}/orig`);
  if (!original) throw new Error('missing original');
  page.dpi = settings.dpi;
  await nextFrame();
  const { processed, thumb } = await renderPage(page, original, page.dpi);
  await db.putBlobs({ [`${page.id}/proc`]: processed, [`${page.id}/thumb`]: thumb });
  invalidateImages(page.id);
  page.rev = (page.rev || 0) + 1;
}

async function cropPage(doc, page) {
  const original = await db.getBlob(`${page.id}/orig`);
  if (!original) return;
  const quad = await openCropEditor(original, page.quad);
  if (quad) await updatePage(doc, page, { quad });
}

async function applyToAll(doc, source) {
  const targets = doc.pages.filter((p) =>
    p.id !== source.id && (p.paper !== source.paper || p.filter !== source.filter || p.bwLevel !== source.bwLevel));
  try {
    for (let i = 0; i < targets.length; i++) {
      busy(`กำลังปรับหน้า ${i + 1}/${targets.length}`);
      Object.assign(targets[i], { paper: source.paper, filter: source.filter, bwLevel: source.bwLevel });
      await rerender(targets[i]);
    }
    await saveDoc(doc);
    toast(targets.length ? `ปรับ ${targets.length} หน้าแล้ว` : 'ทุกหน้าใช้ค่านี้อยู่แล้ว');
  } catch (err) {
    console.error(err);
    toast('ปรับบางหน้าไม่สำเร็จ');
  } finally {
    busy(null);
    render();
  }
}

async function movePage(doc, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= doc.pages.length) return;
  const [page] = doc.pages.splice(index, 1);
  doc.pages.splice(target, 0, page);
  await saveDoc(doc);
  render();
}

async function deletePage(doc, pageId) {
  if (!confirm('ลบหน้านี้?')) return;
  doc.pages = doc.pages.filter((p) => p.id !== pageId);
  await db.deleteBlobs(blobKeys(pageId));
  invalidateImages(pageId);
  await saveDoc(doc);
  if (state.route.name === 'page') state.route = { name: 'doc', docId: doc.id, arranging: false };
  render();
}

async function renameDoc(doc) {
  const name = prompt('ชื่อเอกสาร', doc.name);
  if (name == null || !name.trim()) return;
  doc.name = name.trim();
  await saveDoc(doc);
  render();
}

async function deleteDoc(doc) {
  if (!confirm(`ลบ "${doc.name}" และทุกหน้าในเอกสารนี้?`)) return;
  await db.deleteBlobs(doc.pages.flatMap((p) => blobKeys(p.id)));
  doc.pages.forEach((p) => invalidateImages(p.id));
  await db.deleteDoc(doc.id);
  state.docs = state.docs.filter((d) => d.id !== doc.id);
  go({ name: 'library' });
}

// MARK: - ส่งออก / แชร์

async function exportPDF(doc, pages, name) {
  busy('กำลังสร้าง PDF…');
  await nextFrame();
  try {
    const items = [];
    for (const page of pages) {
      const blob = await db.getBlob(`${page.id}/proc`);
      if (blob) items.push({ blob, paper: page.paper, dpi: page.dpi || settings.dpi });
    }
    const pdf = await buildPDF(items, name);
    busy(null);
    showShareSheet([new File([pdf], `${safeFileName(name)}.pdf`, { type: 'application/pdf' })]);
  } catch (err) {
    console.error(err);
    busy(null);
    toast('สร้าง PDF ไม่สำเร็จ');
  }
}

async function exportImages(doc, pages, name) {
  const files = [];
  for (let i = 0; i < pages.length; i++) {
    const blob = await db.getBlob(`${pages[i].id}/proc`);
    const suffix = pages.length > 1 ? `_${i + 1}` : '';
    if (blob) files.push(new File([blob], `${safeFileName(name)}${suffix}.jpg`, { type: 'image/jpeg' }));
  }
  if (files.length) showShareSheet(files);
}

/**
 * iOS อนุญาตให้เปิดเมนูแชร์เฉพาะตอนผู้ใช้แตะปุ่มโดยตรง
 * จึงเตรียมไฟล์ให้เสร็จก่อน แล้วให้ผู้ใช้แตะ "แชร์" อีกครั้ง
 */
function showShareSheet(files) {
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const canShare = !!(navigator.canShare && navigator.canShare({ files }));
  const close = () => backdrop.remove();

  const share = async () => {
    try {
      await navigator.share({ files });
      close();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        toast('แชร์ไม่สำเร็จ ลองใช้ "บันทึกไฟล์"');
      }
    }
  };

  const download = () => {
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const a = h('a', { href: url, download: file.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }
  };

  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e) => e.target === backdrop && close() },
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet-title' }, 'ไฟล์พร้อมแล้ว'),
      h('div', { class: 'file-summary' },
        icon(files[0].type === 'application/pdf' ? 'file' : 'image', 28),
        h('div', null,
          h('div', { class: 'file-name' }, files.length === 1 ? files[0].name : `${files.length} ไฟล์`),
          h('div', { class: 'file-size' }, fmtBytes(totalSize)))),
      canShare && h('button', { class: 'btn primary block', onclick: share }, icon('share'), 'แชร์ (LINE, AirDrop, …)'),
      h('button', { class: 'btn block', onclick: download }, icon('download'), 'บันทึกไฟล์'),
      h('button', { class: 'sheet-item cancel', onclick: close }, 'ปิด')));
  document.body.append(backdrop);
}

// MARK: - ตั้งค่า

async function openSettings() {
  const close = () => backdrop.remove();
  const select = (label, options, key, cast = String) =>
    h('label', { class: 'field' },
      h('span', null, label),
      h('select', {
        onchange: (e) => { settings[key] = cast(e.target.value); saveSettings(); },
      }, Object.entries(options).map(([value, text]) =>
        h('option', { value, selected: String(settings[key]) === value }, text))));

  const storage = h('p', { class: 'muted' }, '');
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage }) => {
      storage.textContent = `พื้นที่ที่ใช้: ${fmtBytes(usage || 0)} · เอกสาร ${state.docs.length} รายการ`;
    });
  }

  const backdrop = h('div', { class: 'sheet-backdrop', onclick: (e) => e.target === backdrop && close() },
    h('div', { class: 'sheet' },
      h('div', { class: 'sheet-title' }, 'ตั้งค่า'),
      h('div', { class: 'fields' },
        select('ขนาดกระดาษเริ่มต้น', Object.fromEntries(Object.entries(PAPER).map(([k, v]) => [k, v.label])), 'paper'),
        select('ฟิลเตอร์เริ่มต้น', FILTERS, 'filter'),
        select('ความละเอียด', { 150: '150 dpi (ไฟล์เล็ก)', 200: '200 dpi (แนะนำ)', 300: '300 dpi (คมที่สุด)' }, 'dpi', Number)),
      h('p', { class: 'muted' }, 'ค่าเหล่านี้ใช้กับหน้าที่สแกนใหม่ และปรับแต่ละหน้าภายหลังได้'),
      storage,
      h('button', { class: 'sheet-item cancel', onclick: close }, 'เสร็จ')));
  document.body.append(backdrop);
}

// MARK: - เริ่มต้น

async function init() {
  try {
    state.docs = (await db.allDocs()).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    console.error(err);
    toast('เปิดฐานข้อมูลไม่ได้');
  }
  render();
  // ขอให้เบราว์เซอร์เก็บข้อมูลถาวร ไม่ลบอัตโนมัติ
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW', err));
  }
}

init();
