import { openCamera } from './camera.js';
import { openCropEditor } from './crop.js';
import { blobKeys, db } from './db.js';
import { icon } from './icons.js';
import { buildPDF } from './pdf.js';
import { FILTERS, PAPER, prepareOriginal, renderPage } from './processing.js';
import { busy, confirmDialog, menuSheet, openDialog, promptDialog, toast } from './ui.js';
import { fmtBytes, fmtDate, h, nextFrame, safeFileName, uid } from './util.js';

const app = document.getElementById('app');
const PAPER_LABELS = Object.fromEntries(Object.entries(PAPER).map(([k, v]) => [k, v.label]));

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
  const content = app.querySelector('.app-content');
  if (content) scrollMemo.set(app.dataset.route, content.scrollTop);

  const r = state.route;
  const view = r.name === 'doc' ? docView(r) : r.name === 'page' ? pageView(r) : libraryView();
  const key = routeKey(state.route);
  app.dataset.route = key;
  app.replaceChildren(view);

  const next = app.querySelector('.app-content');
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

// MARK: - โครงหน้าจอ

function screen(...children) {
  return h('div', { class: 'app-screen' }, ...children);
}

/** แถบบนสีกรมท่าแบบ ds-header */
function appBar({ title, brand, left, right, onTitle }) {
  let center;
  if (brand) {
    center = h('div', { class: 'ds-brand app-bar__brand' });
    center.innerHTML = `${window.DS.logo('inverse')}<span class="ds-brand__name"><span>6Th</span>Sense</span>`;
    center.append(h('span', { class: 'ds-brand__suffix' }, 'สแกนเอกสาร'));
  } else if (onTitle) {
    center = h('button', { type: 'button', class: 'app-bar__title app-bar__title--button', onclick: onTitle },
      h('span', { class: 'ds-truncate' }, title), icon('pencil', 'sm'));
  } else {
    center = h('h1', { class: 'app-bar__title ds-truncate' }, title);
  }
  return h('header', { class: 'ds-header app-bar' },
    h('div', { class: 'app-bar__inner' },
      h('div', { class: 'app-bar__side' }, left),
      center,
      h('div', { class: 'app-bar__side app-bar__side--end' }, right)));
}

function barButton(iconName, label, onclick, extra = {}) {
  return h('button', {
    type: 'button', class: 'ds-btn ds-btn--ghost ds-btn--icon', 'aria-label': label, title: label, onclick, ...extra,
  }, icon(iconName));
}

function backButton(label, onclick) {
  return h('button', { type: 'button', class: 'ds-btn ds-btn--ghost app-bar__back', onclick }, icon('back'), label);
}

function content(...children) {
  return h('main', { class: 'app-content' }, h('div', { class: 'ds-container ds-container--narrow app-container' }, ...children));
}

function bottomBar(...buttons) {
  return h('footer', { class: 'app-bottom' }, h('div', { class: 'ds-container ds-container--narrow app-bottom__inner' }, ...buttons));
}

function segmented(label, options, value, onChange, disabled) {
  return h('div', { class: 'ds-field' },
    h('span', { class: 'ds-label' }, label),
    h('div', { class: 'ds-segmented ds-segmented--block', role: 'group', 'aria-label': label },
      Object.entries(options).map(([key, text]) =>
        h('button', {
          type: 'button',
          class: 'ds-segmented__item',
          'aria-pressed': key === value ? 'true' : 'false',
          disabled,
          onclick: () => key !== value && onChange(key),
        }, text))));
}

// MARK: - หน้ารายการเอกสาร

function libraryView() {
  const count = state.docs.length;
  const list = count
    ? h('div', { class: 'ds-card' },
      h('ul', { class: 'ds-list app-doc-list' }, state.docs.map(docRow)))
    : h('button', { type: 'button', class: 'ds-dropzone ds-dropzone--fill', onclick: () => startCamera(null) },
      h('span', { class: 'ds-dropzone__icon' }, icon('camera', 'lg')),
      h('span', { class: 'ds-dropzone__title' }, h('strong', null, 'แตะเพื่อสแกน'), ' เอกสารแรก'),
      h('span', { class: 'ds-dropzone__hint' }, 'หรือเลือกภาพที่มีอยู่แล้วจากปุ่ม "รูปภาพ" ด้านล่าง'));

  return screen(
    appBar({ brand: true, right: barButton('settings', 'ตั้งค่า', openSettings) }),
    content(
      h('div', { class: 'ds-page-header' },
        h('div', null,
          h('h1', { class: 'ds-page-header__title' }, 'เอกสาร'),
          h('p', { class: 'ds-page-header__desc' },
            count ? `${count} รายการ · เก็บไว้ในเครื่องนี้เท่านั้น` : 'สแกน ปรับเป็น A4 แล้วส่งเป็น PDF หรือรูปภาพ'))),
      installHint(),
      list),
    bottomBar(
      h('button', { type: 'button', class: 'ds-btn ds-btn--lg', onclick: () => pickPhotos(null) }, icon('image'), 'รูปภาพ'),
      h('button', { type: 'button', class: 'ds-btn ds-btn--primary ds-btn--lg app-grow', onclick: () => startCamera(null) },
        icon('camera'), 'สแกนเอกสาร')));
}

function docRow(doc) {
  const first = doc.pages[0];
  const open = () => go({ name: 'doc', docId: doc.id });
  return h('li', {
    class: 'ds-list-item app-doc-list__item', role: 'button', tabindex: '0',
    onclick: open,
    onkeydown: (e) => { if (e.key === 'Enter') open(); },
  },
  h('div', { class: 'ds-thumb app-doc-thumb' }, first && blobImage(first.id, 'thumb', first.rev)),
  h('div', { class: 'ds-list-item__body' },
    h('div', { class: 'ds-list-item__title' }, doc.name),
    h('div', { class: 'ds-list-item__meta' }, `${doc.pages.length} หน้า · ${fmtDate(doc.updatedAt)}`)),
  h('div', { class: 'ds-list-item__actions ds-text-secondary' }, icon('next')));
}

function installHint() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let hidden = false;
  try { hidden = !!localStorage.getItem('scansv.hideInstall'); } catch { /* */ }
  if (standalone || hidden) return null;
  const el = h('div', { class: 'ds-alert ds-alert--info app-hint' },
    icon('info'),
    h('div', { class: 'ds-alert__content' },
      h('div', { class: 'ds-alert__title' }, 'ติดตั้งเป็นแอป'),
      h('div', null, 'ใน Safari กดปุ่มแชร์ → "เพิ่มไปยังหน้าจอโฮม" เพื่อเปิดแบบเต็มจอและเก็บข้อมูลได้ถาวร')),
    h('button', {
      type: 'button', class: 'ds-btn ds-btn--ghost ds-btn--icon ds-btn--sm', 'aria-label': 'ปิด',
      onclick: () => { try { localStorage.setItem('scansv.hideInstall', '1'); } catch { /* */ } el.remove(); },
    }, icon('close')));
  return el;
}

// MARK: - หน้าเอกสาร (รายการหน้า)

function docView(r) {
  const doc = findDoc(r.docId);
  if (!doc) return libraryView();
  const arranging = !!r.arranging;
  if (!arranging && !doc.pages.some((p) => state.processing.has(p.id))) warmExports(doc.pages, doc.name);

  const cards = doc.pages.map((page, i) => {
    const open = () => go({ name: 'page', docId: doc.id, pageId: page.id });
    const card = h('div', { class: 'ds-media-card app-page-card' },
      h('div', { class: 'ds-media-card__media app-page-card__media' },
        blobImage(page.id, 'thumb', page.rev),
        h('span', { class: 'ds-media-card__corner ds-media-card__corner--left' },
          h('span', { class: 'ds-badge ds-badge--primary' }, String(i + 1))),
        state.processing.has(page.id) && h('span', { class: 'ds-media-card__corner' },
          h('span', { class: 'ds-badge' }, h('span', { class: 'ds-spinner' })))),
      h('div', { class: 'ds-media-card__body' },
        h('div', { class: 'ds-media-card__text' },
          h('div', { class: 'ds-media-card__title' }, `หน้า ${i + 1}`),
          h('div', { class: 'ds-media-card__meta' }, `${PAPER_LABELS[page.paper]} · ${FILTERS[page.filter]}`))));

    if (arranging) {
      card.append(h('div', { class: 'app-page-card__actions' },
        h('button', { type: 'button', class: 'ds-btn ds-btn--sm ds-btn--icon', 'aria-label': 'เลื่อนไปก่อนหน้า', disabled: i === 0, onclick: () => movePage(doc, i, -1) }, icon('prev')),
        h('button', { type: 'button', class: 'ds-btn ds-btn--danger-ghost ds-btn--sm ds-btn--icon', 'aria-label': 'ลบหน้า', onclick: () => deletePage(doc, page.id) }, icon('trash')),
        h('button', { type: 'button', class: 'ds-btn ds-btn--sm ds-btn--icon', 'aria-label': 'เลื่อนไปถัดไป', disabled: i === doc.pages.length - 1, onclick: () => movePage(doc, i, 1) }, icon('next'))));
    } else {
      card.classList.add('is-tappable');
      card.tabIndex = 0;
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    }
    return card;
  });

  return screen(
    appBar({
      title: doc.name,
      onTitle: () => renameDoc(doc),
      left: backButton('เอกสาร', () => go({ name: 'library' })),
      right: arranging
        ? h('button', { type: 'button', class: 'ds-btn ds-btn--secondary ds-btn--sm', onclick: () => go({ ...r, arranging: false }) }, icon('check'), 'เสร็จ')
        : [
          barButton('reorder', 'จัดเรียง / ลบหน้า', () => go({ ...r, arranging: true }), { disabled: !doc.pages.length }),
          barButton('more', 'เพิ่มเติม', () => menuSheet(doc.name, [
            { label: 'เปลี่ยนชื่อ', icon: 'pencil', onClick: () => renameDoc(doc) },
            { label: 'ลบเอกสาร', icon: 'trash', danger: true, onClick: () => deleteDoc(doc) },
          ])),
        ],
    }),
    content(
      arranging && h('div', { class: 'ds-alert ds-alert--info app-hint' },
        icon('info'),
        h('div', { class: 'ds-alert__content' }, 'ใช้ปุ่มลูกศรเพื่อเรียงหน้า หรือปุ่มถังขยะเพื่อลบหน้า แล้วกด "เสร็จ"')),
      doc.pages.length
        ? h('div', { class: 'ds-grid ds-grid--auto app-page-grid' }, cards)
        : h('div', { class: 'ds-card ds-empty' }, 'ยังไม่มีหน้า — กด "เพิ่มหน้า" ด้านล่าง')),
    bottomBar(
      h('button', {
        type: 'button', class: 'ds-btn ds-btn--lg',
        onclick: () => menuSheet('เพิ่มหน้า', [
          { label: 'ถ่ายด้วยกล้อง', icon: 'camera', onClick: () => startCamera(doc.id) },
          { label: 'เลือกจากรูปภาพ', icon: 'image', onClick: () => pickPhotos(doc.id) },
        ]),
      }, icon('plus'), 'เพิ่มหน้า'),
      h('button', {
        type: 'button', class: 'ds-btn ds-btn--primary ds-btn--lg app-grow',
        disabled: !doc.pages.length, onclick: () => exportMenu(doc.pages, doc.name),
      }, icon('share'), 'แชร์ / บันทึก')));
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
  const pageName = `${doc.name} หน้า ${index + 1}`;
  if (!isBusy) warmExports([page], pageName);

  const preview = h('div', { class: `app-preview${isBusy ? ' is-busy' : ''}` },
    blobImage(page.id, 'proc', page.rev, 'app-preview__img'),
    isBusy && h('span', { class: 'app-preview__spinner' }, h('span', { class: 'ds-spinner ds-spinner--lg' })),
    index > 0 && h('button', { type: 'button', class: 'ds-btn ds-btn--icon app-preview__nav app-preview__nav--prev', 'aria-label': 'หน้าก่อน', onclick: () => goTo(index - 1) }, icon('prev')),
    index < total - 1 && h('button', { type: 'button', class: 'ds-btn ds-btn--icon app-preview__nav app-preview__nav--next', 'aria-label': 'หน้าถัดไป', onclick: () => goTo(index + 1) }, icon('next')));

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

  const level = page.bwLevel ?? 0.72;
  const levelValue = h('span', { class: 'ds-label__value' }, `${Math.round(level * 100)}%`);
  const bwControl = page.filter === 'bw' && h('div', { class: 'ds-field' },
    h('label', { class: 'ds-label', for: 'bw-level' }, 'ความเข้มขาวดำ', levelValue),
    h('input', {
      id: 'bw-level', class: 'ds-range', type: 'range', min: '0.5', max: '0.95', step: '0.01', value: String(level),
      disabled: isBusy,
      oninput: (e) => { levelValue.textContent = `${Math.round(Number(e.target.value) * 100)}%`; },
      onchange: (e) => update({ bwLevel: Number(e.target.value) }),
    }));

  return screen(
    appBar({
      title: `หน้า ${index + 1} จาก ${total}`,
      left: backButton('หน้าทั้งหมด', () => go({ name: 'doc', docId: doc.id })),
      right: barButton('more', 'เพิ่มเติม', () => menuSheet(`หน้า ${index + 1}`, [
        { label: 'แชร์ / บันทึกหน้านี้', icon: 'share', onClick: () => exportMenu([page], pageName) },
        { label: 'ใช้ขนาดและฟิลเตอร์นี้กับทุกหน้า', icon: 'layers', onClick: () => applyToAll(doc, page) },
        { label: 'ลบหน้านี้', icon: 'trash', danger: true, onClick: () => deletePage(doc, page.id) },
      ]), { disabled: isBusy }),
    }),
    h('main', { class: 'app-editor' },
      preview,
      h('section', { class: 'app-controls' },
        h('div', { class: 'ds-container ds-container--narrow ds-stack ds-stack--md' },
          segmented('ฟิลเตอร์', FILTERS, page.filter, (filter) => update({ filter }), isBusy),
          bwControl,
          segmented('ขนาดกระดาษ', PAPER_LABELS, page.paper, (paper) => update({ paper }), isBusy),
          h('div', { class: 'app-tools' },
            toolButton('crop', 'ปรับขอบ', () => cropPage(doc, page), isBusy),
            toolButton('rotateLeft', 'หมุนซ้าย', () => update({ rotation: ((page.rotation || 0) + 3) % 4 }), isBusy),
            toolButton('rotateRight', 'หมุนขวา', () => update({ rotation: ((page.rotation || 0) + 1) % 4 }), isBusy),
            toolButton('share', 'แชร์', () => exportMenu([page], pageName), isBusy))))));
}

function toolButton(iconName, label, onclick, disabled) {
  return h('button', { type: 'button', class: 'ds-btn app-tool', onclick, disabled }, icon(iconName), h('span', null, label));
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
      busy(`กำลังประมวลผลหน้า ${i + 1}/${blobs.length}…`);
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
        toast(`ภาพที่ ${i + 1} ประมวลผลไม่สำเร็จ`, 'error');
      }
    }
    if (added) {
      await saveDoc(doc);
      state.route = { name: 'doc', docId: doc.id };
      toast(`เพิ่ม ${added} หน้าแล้ว`, 'success');
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
    toast('ประมวลผลไม่สำเร็จ', 'error');
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
  if (!targets.length) {
    toast('ทุกหน้าใช้ค่านี้อยู่แล้ว', 'info');
    return;
  }
  try {
    for (let i = 0; i < targets.length; i++) {
      busy(`กำลังปรับหน้า ${i + 1}/${targets.length}…`);
      Object.assign(targets[i], { paper: source.paper, filter: source.filter, bwLevel: source.bwLevel });
      await rerender(targets[i]);
    }
    await saveDoc(doc);
    toast(`ปรับ ${targets.length} หน้าแล้ว`, 'success');
  } catch (err) {
    console.error(err);
    toast('ปรับบางหน้าไม่สำเร็จ', 'error');
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
  const ok = await confirmDialog({
    title: 'ลบหน้านี้?', message: 'หน้านี้จะถูกลบออกจากเอกสาร และกู้คืนไม่ได้',
    confirmText: 'ลบหน้า', variant: 'danger',
  });
  if (!ok) return;
  doc.pages = doc.pages.filter((p) => p.id !== pageId);
  await db.deleteBlobs(blobKeys(pageId));
  invalidateImages(pageId);
  await saveDoc(doc);
  if (state.route.name === 'page') state.route = { name: 'doc', docId: doc.id, arranging: false };
  render();
  toast('ลบหน้าแล้ว', 'success');
}

async function renameDoc(doc) {
  const name = await promptDialog({ title: 'เปลี่ยนชื่อเอกสาร', label: 'ชื่อเอกสาร', value: doc.name });
  if (name == null || !name.trim() || name.trim() === doc.name) return;
  doc.name = name.trim();
  await saveDoc(doc);
  render();
}

async function deleteDoc(doc) {
  const ok = await confirmDialog({
    title: 'ลบเอกสารนี้?', message: `"${doc.name}" และทั้ง ${doc.pages.length} หน้าจะถูกลบ และกู้คืนไม่ได้`,
    confirmText: 'ลบเอกสาร', variant: 'danger',
  });
  if (!ok) return;
  await db.deleteBlobs(doc.pages.flatMap((p) => blobKeys(p.id)));
  doc.pages.forEach((p) => invalidateImages(p.id));
  await db.deleteDoc(doc.id);
  state.docs = state.docs.filter((d) => d.id !== doc.id);
  go({ name: 'library' });
  toast('ลบเอกสารแล้ว', 'success');
}

// MARK: - ส่งออก / แชร์
//
// iOS เปิดเมนูแชร์ได้เฉพาะ "ทันที" ที่ผู้ใช้แตะปุ่ม จึงเตรียมไฟล์ไว้ล่วงหน้าตอนเปิดหน้าเอกสาร/หน้า
// เมื่อแตะแชร์จะเรียก navigator.share ได้ทันทีในแตะเดียว

const exportCache = new Map(); // signature → { files, promise }

function exportEntry(kind, pages, name) {
  const sig = `${kind}|${name}|${pages.map((p) => `${p.id}:${p.rev || 0}:${p.paper}:${p.dpi}`).join(',')}`;
  let entry = exportCache.get(sig);
  if (!entry) {
    entry = { files: null };
    entry.promise = (kind === 'pdf' ? makePdfFiles(pages, name) : makeImageFiles(pages, name))
      .then((files) => { entry.files = files; return files; })
      .catch((err) => { exportCache.delete(sig); throw err; });
    exportCache.set(sig, entry);
    while (exportCache.size > 8) exportCache.delete(exportCache.keys().next().value);
  }
  return entry;
}

/** เตรียมไฟล์ไว้เบื้องหลัง (เรียกซ้ำได้ ไม่ทำงานซ้ำถ้าไม่มีอะไรเปลี่ยน) */
function warmExports(pages, name) {
  if (!pages.length) return;
  setTimeout(() => {
    exportEntry('pdf', pages, name).promise.catch(() => {});
    exportEntry('images', pages, name).promise.catch(() => {});
  }, 400);
}

async function makePdfFiles(pages, name) {
  const items = [];
  for (const page of pages) {
    const blob = await db.getBlob(`${page.id}/proc`);
    if (blob) items.push({ blob, paper: page.paper, dpi: page.dpi || settings.dpi });
  }
  if (!items.length) throw new Error('no pages');
  const pdf = await buildPDF(items, name);
  return [new File([pdf], `${safeFileName(name)}.pdf`, { type: 'application/pdf' })];
}

async function makeImageFiles(pages, name) {
  const files = [];
  for (let i = 0; i < pages.length; i++) {
    const blob = await db.getBlob(`${pages[i].id}/proc`);
    const suffix = pages.length > 1 ? `_${i + 1}` : '';
    if (blob) files.push(new File([blob], `${safeFileName(name)}${suffix}.jpg`, { type: 'image/jpeg' }));
  }
  if (!files.length) throw new Error('no pages');
  return files;
}

/** ต้องเรียกจาก event แตะโดยตรง (ห้ามมี await ก่อนหน้า) */
function shareNow(kind, pages, name, hint) {
  const entry = exportEntry(kind, pages, name);
  if (entry.files && navigator.share) {
    navigator.share({ files: entry.files }).catch((err) => {
      if (err.name === 'AbortError') return;
      console.warn(err);
      showShareDialog(entry.files, hint); // ให้แตะอีกครั้งจากหน้าต่างนี้
    });
    return;
  }
  busy(kind === 'pdf' ? 'กำลังสร้าง PDF…' : 'กำลังเตรียมรูปภาพ…');
  entry.promise.then(
    (files) => { busy(null); showShareDialog(files, hint); },
    (err) => { console.error(err); busy(null); toast('เตรียมไฟล์ไม่สำเร็จ', 'error'); });
}

const SAVE_PHOTOS_HINT = 'ในเมนูที่ขึ้นมา เลือก "บันทึกรูปภาพ"';
const SAVE_FILES_HINT = 'ในเมนูที่ขึ้นมา เลือก "บันทึกไปยังไฟล์"';

/** เมนูแชร์หลัก */
function exportMenu(pages, name) {
  warmExports(pages, name);
  menuSheet(pages.length === 1 ? 'แชร์หน้านี้' : `แชร์ ${pages.length} หน้า`, [
    { label: 'ส่งเข้า LINE', sub: 'ส่งเป็นรูปภาพ หรือไฟล์ PDF', icon: 'send', onClick: () => lineGuide(pages, name) },
    { label: 'บันทึกลงคลังภาพ', sub: SAVE_PHOTOS_HINT, icon: 'image', onClick: () => shareNow('images', pages, name, SAVE_PHOTOS_HINT) },
    { label: 'แชร์ PDF', sub: 'Mail, AirDrop, บันทึกไปยังไฟล์ และแอปอื่น', icon: 'file', onClick: () => shareNow('pdf', pages, name) },
  ]);
}

/** LINE ไม่รับ PDF จากเว็บแอปโดยตรง → ส่งเป็นรูป หรือบันทึก PDF ลงแอปไฟล์แล้วแนบจาก LINE */
function lineGuide(pages, name) {
  const step = (num, title, desc, action) =>
    h('li', { class: 'app-step' },
      h('span', { class: 'ds-badge ds-badge--primary' }, num),
      h('div', { class: 'ds-stack ds-stack--sm app-step__body' },
        h('div', null,
          h('div', { class: 'ds-text-label' }, title),
          h('div', { class: 'ds-help' }, desc)),
        action));

  const { close } = openDialog({
    title: 'ส่งเข้า LINE',
    iconName: 'send',
    body: h('div', { class: 'ds-stack' },
      h('section', { class: 'app-option ds-stack ds-stack--md' },
        h('div', { class: 'ds-row' },
          h('span', { class: 'ds-text-heading' }, 'แบบรูปภาพ'),
          h('span', { class: 'ds-badge ds-badge--success' }, 'ง่ายที่สุด')),
        h('p', { class: 'ds-help' }, 'แตะแล้วเลือก LINE ในเมนูแชร์ได้ทันที'),
        h('button', {
          type: 'button', class: 'ds-btn ds-btn--primary ds-btn--lg ds-btn--block',
          onclick: () => { close(); shareNow('images', pages, name); },
        }, icon('image'), pages.length > 1 ? `ส่ง ${pages.length} รูปเข้า LINE` : 'ส่งรูปเข้า LINE')),
      h('section', { class: 'app-option ds-stack ds-stack--md' },
        h('div', { class: 'ds-row' },
          h('span', { class: 'ds-text-heading' }, 'แบบไฟล์ PDF'),
          h('span', { class: 'ds-badge' }, '2 ขั้นตอน')),
        h('ol', { class: 'app-steps' },
          step('1', 'บันทึก PDF ลงแอปไฟล์', SAVE_FILES_HINT,
            h('button', { type: 'button', class: 'ds-btn ds-btn--block', onclick: () => shareNow('pdf', pages, name, SAVE_FILES_HINT) },
              icon('download'), 'บันทึก PDF')),
          step('2', 'แนบไฟล์ในแชท LINE', 'เลือกแชท → กด + → ไฟล์ → เลือก PDF ที่บันทึกไว้',
            h('a', { class: 'ds-btn ds-btn--block', href: 'line://nv/chat' }, icon('send'), 'เปิด LINE')))),
      h('p', { class: 'ds-help' }, 'ไม่เห็น LINE ในเมนูแชร์? เลื่อนแถวแอปไปทางขวาสุด → "เพิ่มเติม" → เปิด LINE')),
    footer: h('button', { type: 'button', class: 'ds-btn', onclick: () => close() }, 'ปิด'),
  });
}

/** สำรอง: ใช้เมื่อไฟล์ยังไม่พร้อมตอนแตะ หรือแชร์ครั้งแรกไม่สำเร็จ */
function showShareDialog(files, hint) {
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const isPdf = files[0].type === 'application/pdf';

  const share = async () => {
    try {
      await navigator.share({ files });
      close();
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error(err);
        toast('แชร์ไม่สำเร็จ', 'error');
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
    close();
  };

  const { close } = openDialog({
    title: 'ไฟล์พร้อมแล้ว',
    iconName: 'check',
    variant: 'success',
    body: h('div', { class: 'ds-stack ds-stack--md' },
      h('div', { class: 'ds-list-item' },
        h('span', { class: 'ds-file-icon' }, icon(isPdf ? 'file' : 'images')),
        h('div', { class: 'ds-list-item__body' },
          h('div', { class: 'ds-list-item__title' }, files.length === 1 ? files[0].name : `${files.length} ไฟล์`),
          h('div', { class: 'ds-list-item__meta' }, fmtBytes(totalSize)))),
      hint && h('div', { class: 'ds-alert ds-alert--info' }, icon('info'), h('div', { class: 'ds-alert__content' }, hint))),
    footer: [
      h('button', { type: 'button', class: 'ds-btn', onclick: () => close() }, 'ปิด'),
      navigator.share
        ? h('button', { type: 'button', class: 'ds-btn ds-btn--primary', onclick: share }, icon('share'), 'แชร์')
        : h('button', { type: 'button', class: 'ds-btn ds-btn--primary', onclick: download }, icon('download'), 'ดาวน์โหลด'),
    ],
  });
}

// MARK: - ตั้งค่า

function openSettings() {
  const field = (id, label, options, key, cast = String) =>
    h('div', { class: 'ds-field' },
      h('label', { class: 'ds-label', for: id }, label),
      h('select', {
        id, class: 'ds-select',
        onchange: (e) => { settings[key] = cast(e.target.value); saveSettings(); },
      }, Object.entries(options).map(([value, text]) =>
        h('option', { value, selected: String(settings[key]) === value }, text))));

  const storage = h('p', { class: 'ds-help' }, `เอกสาร ${state.docs.length} รายการ`);
  if (navigator.storage?.estimate) {
    navigator.storage.estimate().then(({ usage }) => {
      storage.textContent = `เอกสาร ${state.docs.length} รายการ · ใช้พื้นที่ ${fmtBytes(usage || 0)}`;
    });
  }

  const { close } = openDialog({
    title: 'ตั้งค่า',
    iconName: 'settings',
    body: h('div', { class: 'ds-stack' },
      field('set-paper', 'ขนาดกระดาษเริ่มต้น', PAPER_LABELS, 'paper'),
      field('set-filter', 'ฟิลเตอร์เริ่มต้น', FILTERS, 'filter'),
      field('set-dpi', 'ความละเอียด', { 150: '150 dpi (ไฟล์เล็ก)', 200: '200 dpi (แนะนำ)', 300: '300 dpi (คมที่สุด)' }, 'dpi', Number),
      h('p', { class: 'ds-help' }, 'ใช้กับหน้าที่สแกนใหม่ และปรับแต่ละหน้าภายหลังได้'),
      storage),
    footer: h('button', { type: 'button', class: 'ds-btn ds-btn--primary', onclick: () => close() }, 'เสร็จ'),
  });
}

// MARK: - เริ่มต้น

async function init() {
  try {
    state.docs = (await db.allDocs()).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (err) {
    console.error(err);
    toast('เปิดฐานข้อมูลไม่ได้', 'error');
  }
  render();
  // ขอให้เบราว์เซอร์เก็บข้อมูลถาวร ไม่ลบอัตโนมัติ
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW', err));
  }
}

init();
