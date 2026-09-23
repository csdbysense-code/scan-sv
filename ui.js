// ส่วนประกอบ UI ที่สร้างจาก 6ThSense Design System (ds-modal, ds-menu, ds-field, DS.toast, DS.confirm)

import { icon } from './icons.js';
import { h } from './util.js';

export const toast = (message, type = 'info') => window.DS.toast(message, type);
export const confirmDialog = (options) => window.DS.confirm(options);

/** dialog.ds-modal แบบกำหนดเนื้อหาเอง → { dialog, close } */
export function openDialog({ title, iconName, variant, body, footer, dismissible = true, onClose }) {
  const dialog = h('dialog', { class: 'ds-modal app-dialog' });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    onClose?.();
  };

  if (title) {
    dialog.append(h('div', { class: 'ds-modal__header' },
      iconName && h('span', { class: `ds-modal__icon${variant ? ` ds-modal__icon--${variant}` : ''}` }, icon(iconName)),
      h('h2', { class: 'ds-modal__title' }, title)));
  }
  if (body) dialog.append(h('div', { class: 'app-dialog__body' }, body));
  if (footer) dialog.append(h('div', { class: 'ds-modal__footer' }, footer));

  dialog.addEventListener('cancel', (e) => {
    e.preventDefault();
    if (dismissible) close();
  });
  dialog.addEventListener('click', (e) => {
    if (dismissible && e.target === dialog) close(); // แตะพื้นหลัง
  });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

/**
 * เมนูตัวเลือก: items = [{ label, sub, icon, danger, onClick }]
 * onClick ถูกเรียกทันทีในแตะเดียวกัน (จำเป็นสำหรับ navigator.share บน iOS)
 */
export function menuSheet(title, items) {
  const { close } = openDialog({
    title,
    body: h('div', { class: 'app-menu', role: 'menu' },
      items.map((item) => h('button', {
        type: 'button',
        role: 'menuitem',
        class: `ds-menu__item app-menu__item${item.danger ? ' ds-menu__item--danger' : ''}`,
        onclick: () => { close(); item.onClick(); },
      },
      item.icon && icon(item.icon),
      h('span', { class: 'app-menu__text' },
        h('span', null, item.label),
        item.sub && h('span', { class: 'ds-text-caption ds-text-secondary' }, item.sub))))),
    footer: h('button', { type: 'button', class: 'ds-btn ds-btn--block', onclick: () => close() }, 'ยกเลิก'),
  });
}

/** ถามข้อความ (แทน window.prompt) → Promise<string | null> */
export function promptDialog({ title, label, value = '', confirmText = 'บันทึก' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { class: 'ds-input', type: 'text', value, enterkeyhint: 'done' });
    const form = h('form', {
      class: 'ds-field',
      onsubmit: (e) => { e.preventDefault(); result = input.value; close(); },
    }, h('label', { class: 'ds-label' }, label), input);
    const { close } = openDialog({
      title,
      iconName: 'pencil',
      body: form,
      footer: [
        h('button', { type: 'button', class: 'ds-btn', onclick: () => close() }, 'ยกเลิก'),
        h('button', { type: 'button', class: 'ds-btn ds-btn--primary', onclick: () => form.requestSubmit() }, confirmText),
      ],
      onClose: () => resolve(result),
    });
    input.focus();
    input.select();
  });
}

/** หน้าต่าง "กำลังประมวลผล" ที่ปิดเองไม่ได้ — busy(null) เพื่อปิด */
let busyState = null;
export function busy(message) {
  if (!message) {
    busyState?.close();
    busyState = null;
    return;
  }
  if (!busyState) {
    const text = h('span', { class: 'ds-text-body' });
    const { close } = openDialog({
      dismissible: false,
      body: h('div', { class: 'ds-row ds-row--nowrap app-busy', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'ds-spinner ds-spinner--lg' }), text),
    });
    busyState = { close, text };
  }
  busyState.text.textContent = message;
}
