import { idbAvailable, STORE_BLOBS, STORE_QUEUE } from "./offline-db";

export async function putQueueAndPhoto<T extends { clientId: string }>(queueValue: T, photo: Blob): Promise<void> {
  if (!idbAvailable()) throw new Error("IndexedDB غير متاح");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("mizan-offline", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("تعذّر فتح قاعدة البيانات المحلية"));
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction([STORE_QUEUE, STORE_BLOBS], "readwrite");
    transaction.objectStore(STORE_QUEUE).put(queueValue as never);
    transaction.objectStore(STORE_BLOBS).put(photo, queueValue.clientId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("فشلت معاملة حفظ القراءة والصورة"));
    transaction.onabort = () => reject(transaction.error ?? new Error("أُلغيت معاملة حفظ القراءة والصورة"));
  });
}
