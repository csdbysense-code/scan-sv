// เก็บข้อมูลใน IndexedDB ของเบราว์เซอร์ (อยู่ในเครื่องเท่านั้น)
//   docs  : { id, name, createdAt, updatedAt, pages: [...] }
//   blobs : `${pageId}/orig` | `${pageId}/proc` | `${pageId}/thumb` → Blob

const DB_NAME = 'scansv';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

async function run(storeName, mode, fn) {
  const db = await open();
  const tx = db.transaction(storeName, mode);
  const result = fn(tx.objectStore(storeName));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result instanceof IDBRequest ? result.result : result;
}

export const db = {
  allDocs: () => run('docs', 'readonly', (s) => s.getAll()),
  putDoc: (doc) => run('docs', 'readwrite', (s) => s.put(doc)),
  deleteDoc: (id) => run('docs', 'readwrite', (s) => s.delete(id)),
  getBlob: (key) => run('blobs', 'readonly', (s) => s.get(key)),
  /** บันทึกหลายไฟล์ใน transaction เดียว: { key: blob } */
  putBlobs: (entries) => run('blobs', 'readwrite', (s) => {
    for (const [key, blob] of Object.entries(entries)) s.put(blob, key);
  }),
  deleteBlobs: (keys) => run('blobs', 'readwrite', (s) => {
    for (const key of keys) s.delete(key);
  }),
};

export const blobKeys = (pageId) => [`${pageId}/orig`, `${pageId}/proc`, `${pageId}/thumb`];
