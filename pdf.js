// สร้างไฟล์ PDF เอง โดยฝังไฟล์ JPEG ลงไปตรง ๆ (ไม่บีบอัดซ้ำ ไฟล์จึงเล็กและคมเท่าเดิม)

import { PAPER } from './processing.js';

const encoder = new TextEncoder();
const MM_TO_PT = 72 / 25.4;

/**
 * pages: [{ blob: JPEG Blob, paper: 'a4' | 'a5' | 'original', dpi }]
 * ขนาดหน้า: A4/A5 ตามมาตรฐาน (แนวตั้ง/แนวนอนตามภาพ), ต้นฉบับ = ขนาดพิกเซลที่ dpi ที่ใช้เรนเดอร์
 */
export async function buildPDF(pages, title) {
  const chunks = [];
  const offsets = [];
  let offset = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  };
  const begin = (num) => {
    offsets[num] = offset;
    push(`${num} 0 obj\n`);
  };

  const n = pages.length;
  const total = 3 + n * 3; // 1 catalog, 2 pages, 3 info, แล้วหน้าละ 3 object (page, content, image)

  push('%PDF-1.4\n');
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  begin(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  begin(2);
  push(`<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`);

  begin(3);
  push(`<< /Title ${pdfText(title)} /Producer (Scan SV) /CreationDate (D:${pdfDate(new Date())}) >>\nendobj\n`);

  for (let i = 0; i < n; i++) {
    const jpeg = new Uint8Array(await pages[i].blob.arrayBuffer());
    const info = jpegInfo(jpeg);
    if (!info) throw new Error('Invalid JPEG');
    const [wPt, hPt] = pageSize(info.width, info.height, pages[i].paper, pages[i].dpi);
    const w = wPt.toFixed(2), h = hPt.toFixed(2);
    const colorSpace = info.components === 1 ? '/DeviceGray' : '/DeviceRGB';

    begin(4 + i * 3);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /XObject << /Im0 ${6 + i * 3} 0 R >> /ProcSet [/PDF /ImageC] >> ` +
      `/Contents ${5 + i * 3} 0 R >>\nendobj\n`);

    const content = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`;
    begin(5 + i * 3);
    push(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    begin(6 + i * 3);
    push(`<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} ` +
      `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    push(jpeg);
    push('\nendstream\nendobj\n');
  }

  const xrefOffset = offset;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let k = 1; k <= total; k++) xref += `${String(offsets[k]).padStart(10, '0')} 00000 n \n`;
  push(xref);
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}

function pageSize(widthPx, heightPx, paperKey, dpi) {
  const paper = PAPER[paperKey];
  if (paper && paper.mm) {
    const short = paper.mm[0] * MM_TO_PT, long = paper.mm[1] * MM_TO_PT;
    return widthPx > heightPx ? [long, short] : [short, long];
  }
  const ptPerPx = 72 / (dpi || 200);
  return [widthPx * ptPerPx, heightPx * ptPerPx];
}

/** อ่านขนาดภาพจาก header ของ JPEG (SOF marker) */
function jpegInfo(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        components: bytes[i + 9],
      };
    }
    i += 2 + length;
  }
  return null;
}

/** ข้อความภาษาไทยใน PDF ต้องเป็น UTF-16BE */
function pdfText(text) {
  let hex = 'FEFF';
  for (const ch of text) {
    let cp = ch.codePointAt(0);
    if (cp > 0xffff) {
      cp -= 0x10000;
      hex += (0xd800 + (cp >> 10)).toString(16).padStart(4, '0');
      hex += (0xdc00 + (cp & 0x3ff)).toString(16).padStart(4, '0');
    } else {
      hex += cp.toString(16).padStart(4, '0');
    }
  }
  return `<${hex.toUpperCase()}>`;
}

function pdfDate(date) {
  const p = (v) => String(v).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
