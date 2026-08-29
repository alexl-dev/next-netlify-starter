/**
 * Local storage layer. IndexedDB is the source of truth, not a cache: capture
 * has to work with no signal, so nothing in the app ever waits on the network
 * to save a fish.
 *
 * Everything goes through this module rather than touching IndexedDB directly,
 * because this is the seam a shared backend gets bolted onto later. When you
 * and your fishing partners log to the same book, `syncOutbox` becomes a real
 * push to a server and the rest of the app does not change.
 */

const DB_NAME = 'riffle';
const DB_VERSION = 1;

export const STORES = ['waters', 'trips', 'pins', 'catches', 'photos', 'outbox'];

let dbPromise = null;

function openDb() {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is unavailable in this browser'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name === 'pins' || name === 'catches') store.createIndex('tripId', 'tripId');
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let result;
    try {
      result = work(store);
    } catch (err) {
      reject(err);
      return;
    }
    transaction.oncomplete = () => resolve(result && result.__request ? result.__request.result : result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

const asRequest = (request) => ({ __request: request });

export const put = (storeName, record) => tx(storeName, 'readwrite', (s) => {
  s.put(record);
  return record;
});

export const putMany = (storeName, records) => tx(storeName, 'readwrite', (s) => {
  records.forEach((r) => s.put(r));
  return records;
});

export const get = (storeName, id) =>
  tx(storeName, 'readonly', (s) => asRequest(s.get(id)));

export const all = (storeName) =>
  tx(storeName, 'readonly', (s) => asRequest(s.getAll()));

export const remove = (storeName, id) => tx(storeName, 'readwrite', (s) => {
  s.delete(id);
  return id;
});

export const byTrip = (storeName, tripId) =>
  tx(storeName, 'readonly', (s) => asRequest(s.index('tripId').getAll(tripId)));

/* --------------------------------------------------------------------------
   Photos
   -------------------------------------------------------------------------- */

/**
 * Photos are stored as blobs beside their location and time.
 *
 * The location is read from the device at the moment of capture and written
 * here deliberately — a photo taken inside a web page or an iOS app arrives
 * with its GPS EXIF stripped, so the coordinates have to be captured
 * separately or they are simply gone.
 */
export async function savePhoto({ blob, lat, lon, accuracyM, takenAt = new Date() }) {
  const record = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    blob,
    lat,
    lon,
    accuracyM,
    takenAt: new Date(takenAt).toISOString(),
    type: blob.type,
    bytes: blob.size,
  };
  await put('photos', record);
  return record;
}

export async function photoUrl(id) {
  const record = await get('photos', id);
  return record && record.blob ? URL.createObjectURL(record.blob) : null;
}

/* --------------------------------------------------------------------------
   The enrichment queue
   -------------------------------------------------------------------------- */

/**
 * Anything captured without conditions lands here. The queue drains whenever
 * the browser has a connection — which on a river trip means the drive home.
 */
export const enqueue = (job) =>
  put('outbox', { id: `${job.kind}:${job.recordId}`, ...job, queuedAt: new Date().toISOString(), attempts: 0 });

export const pending = () => all('outbox');

export const dequeue = (id) => remove('outbox', id);

export async function markAttempt(id, error) {
  const job = await get('outbox', id);
  if (!job) return null;
  const updated = { ...job, attempts: (job.attempts || 0) + 1, lastError: error || null };
  await put('outbox', updated);
  return updated;
}

/**
 * Drain the queue: fetch a snapshot for each pending record and write it back.
 * Safe to call repeatedly — it no-ops when offline and leaves failures queued.
 */
export async function drainOutbox({ fetchSnapshot, onProgress } = {}) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { drained: 0, remaining: (await pending()).length, offline: true };
  }

  const jobs = await pending();
  let drained = 0;

  for (const job of jobs) {
    // Give up loudly rather than hammering a source that keeps refusing.
    if (job.attempts >= 6) continue;
    try {
      const snapshot = await fetchSnapshot(job);
      const record = await get(job.store, job.recordId);
      if (record) {
        await put(job.store, { ...record, snapshot, snapshotStatus: snapshot.status });
      }
      // A partial snapshot stays queued so the missing half can arrive later.
      if (snapshot.status === 'enriched') {
        await dequeue(job.id);
        drained += 1;
      } else {
        await markAttempt(job.id, (snapshot.errors || []).join('; '));
      }
    } catch (err) {
      await markAttempt(job.id, err.message || String(err));
    }
    if (onProgress) onProgress(drained, jobs.length);
  }

  return { drained, remaining: (await pending()).length, offline: false };
}

/** Everything, for the trends page and for export. */
export async function loadAll() {
  const [waters, trips, pins, catches] = await Promise.all([
    all('waters'), all('trips'), all('pins'), all('catches'),
  ]);
  return { waters, trips, pins, catches };
}

/**
 * Export as JSON. Your log outliving this app is the point — the whole book
 * should walk out of the browser in one file.
 */
export async function exportJson() {
  const data = await loadAll();
  return JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2);
}
