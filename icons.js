// ไอคอนจาก 6ThSense Design System (Lucide) — เพิ่มไอคอนใหม่ที่ 6ThSense-DesignSystem/tools/build-icons.mjs

const NAMES = {
  back: 'chevron-left',
  prev: 'chevron-left',
  next: 'chevron-right',
  camera: 'camera',
  image: 'image',
  images: 'images',
  settings: 'sliders-horizontal',
  plus: 'plus',
  share: 'share',
  send: 'send',
  trash: 'trash-2',
  rotateLeft: 'rotate-ccw',
  rotateRight: 'rotate-cw',
  crop: 'crop',
  more: 'ellipsis',
  close: 'x',
  check: 'check',
  flash: 'zap',
  wand: 'wand-sparkles',
  expand: 'maximize',
  reorder: 'arrow-up-down',
  file: 'file-text',
  scan: 'scan-line',
  download: 'download',
  pencil: 'pencil',
  layers: 'layers',
  aperture: 'aperture',
  info: 'info',
};

/** size: 'sm' (16) | ไม่ระบุ (20) | 'lg' (24) | 'xl' (40) */
export function icon(name, size) {
  const template = document.createElement('template');
  template.innerHTML = window.DS.icon(NAMES[name] || name, size ? { size } : undefined);
  return template.content.firstElementChild || document.createTextNode('');
}
