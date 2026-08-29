/**
 * Client-side actions — the verbs the screens call.
 *
 * The rule that shapes all of them: capture never awaits the network. A pin or
 * a catch is written to IndexedDB with its coordinates and timestamp, queued
 * for enrichment, and the screen updates immediately. Conditions arrive when
 * they arrive.
 */

import * as store from './store.js';
import { newTrip, newPin, newCatch, newWater } from './model.js';

/** Current position, with a deliberately short leash. */
export function currentPosition({ timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('This browser has no location access'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy == null ? null : Math.round(pos.coords.accuracy),
        }),
      (err) => reject(new Error(locationMessage(err))),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 }
    );
  });
}

function locationMessage(err) {
  if (err.code === 1) return 'Location permission is off. Turn it on in Settings › Safari to log where you fished.';
  if (err.code === 2) return 'No position fix — try again with a clearer view of the sky.';
  return 'Locating timed out.';
}

/* --------------------------------------------------------------------------
   Waters
   -------------------------------------------------------------------------- */

export async function addWater(fields) {
  const water = newWater(fields);
  await store.put('waters', water);
  return water;
}

export async function bindStation(waterId, station) {
  const water = await store.get('waters', waterId);
  if (!water) return null;
  const updated = { ...water, station };
  await store.put('waters', updated);
  return updated;
}

export async function findStations({ lat, lon, kind }) {
  const res = await fetch(`/api/stations?lat=${lat}&lon=${lon}&kind=${kind}`);
  if (!res.ok) throw new Error('Could not reach the station directory');
  const json = await res.json();
  return json.stations || [];
}

/* --------------------------------------------------------------------------
   Trips — the clock that makes every rate honest
   -------------------------------------------------------------------------- */

export async function startTrip({ waterId, waterName }) {
  const trip = newTrip({ waterId, waterName });
  await store.put('trips', trip);
  return trip;
}

export async function endTrip(tripId) {
  const trip = await store.get('trips', tripId);
  if (!trip) return null;
  const updated = { ...trip, endedAt: new Date().toISOString() };
  await store.put('trips', updated);
  return updated;
}

export async function updateTrip(tripId, patch) {
  const trip = await store.get('trips', tripId);
  if (!trip) return null;
  const updated = { ...trip, ...patch };
  await store.put('trips', updated);
  return updated;
}

export const openTrip = async () => {
  const trips = await store.all('trips');
  return trips.find((t) => !t.endedAt) || null;
};

/* --------------------------------------------------------------------------
   Pins and catches
   -------------------------------------------------------------------------- */

export async function dropPin({ tripId, name = '' }) {
  const position = await currentPosition();
  const pin = newPin({ tripId, name, ...position });
  await store.put('pins', pin);
  await store.enqueue({ kind: 'pin', store: 'pins', recordId: pin.id });
  return pin;
}

export async function movePin(pinId, lat, lon) {
  const pin = await store.get('pins', pinId);
  if (!pin) return null;
  // Moving a pin invalidates its conditions — they were fetched for the old spot.
  const updated = { ...pin, lat, lon, snapshot: null, snapshotStatus: 'pending', movedByHand: true };
  await store.put('pins', updated);
  await store.enqueue({ kind: 'pin', store: 'pins', recordId: pin.id });
  return updated;
}

/**
 * Log a fish. Position comes from the device right now — never from the photo,
 * whose GPS tags are stripped by the browser and by iOS alike.
 */
export async function logCatch({ tripId, pinId, fields, photoBlob }) {
  let position = null;
  try {
    position = await currentPosition({ timeout: 8000 });
  } catch {
    // A fish with no fix still gets logged. The pin's position covers for it.
    position = null;
  }

  const record = { ...newCatch({ tripId, pinId }), ...fields };
  if (position) {
    record.lat = position.lat;
    record.lon = position.lon;
  }

  if (photoBlob) {
    const photo = await store.savePhoto({
      blob: photoBlob,
      lat: position ? position.lat : null,
      lon: position ? position.lon : null,
      accuracyM: position ? position.accuracyM : null,
    });
    record.photoIds = [photo.id];
  }

  await store.put('catches', record);
  if (record.lat != null) {
    await store.enqueue({ kind: 'catch', store: 'catches', recordId: record.id });
  }
  return record;
}

export async function updateCatch(catchId, patch) {
  const record = await store.get('catches', catchId);
  if (!record) return null;
  const updated = { ...record, ...patch };
  await store.put('catches', updated);
  return updated;
}

/* --------------------------------------------------------------------------
   Enrichment
   -------------------------------------------------------------------------- */

function snapshotUrl({ lat, lon, at, station }) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    at: new Date(at).toISOString(),
    tz: String(new Date().getTimezoneOffset()),
  });
  if (station) {
    params.set('provider', station.provider);
    params.set('stationId', station.id);
    params.set('stationKind', station.kind || 'river');
  }
  return `/api/conditions?${params}`;
}

/** Conditions right here, right now — for the Today screen. */
export async function conditionsHere({ lat, lon, station }) {
  const res = await fetch(snapshotUrl({ lat, lon, at: new Date(), station }));
  if (!res.ok) throw new Error('Could not fetch conditions');
  return res.json();
}

/**
 * Work through everything captured without conditions. Called on load, when
 * the browser comes back online, and after any capture — so a trip logged in a
 * dead zone fills itself in on the drive home without anyone thinking about it.
 */
export async function runEnrichment() {
  const waters = await store.all('waters');
  const trips = await store.all('trips');
  const watersById = new Map(waters.map((w) => [w.id, w]));
  const tripsById = new Map(trips.map((t) => [t.id, t]));

  return store.drainOutbox({
    fetchSnapshot: async (job) => {
      const record = await store.get(job.store, job.recordId);
      if (!record) throw new Error('record vanished');
      const trip = tripsById.get(record.tripId);
      const water = trip && trip.waterId ? watersById.get(trip.waterId) : null;

      const res = await fetch(
        snapshotUrl({
          lat: record.lat,
          lon: record.lon,
          at: record.droppedAt || record.at,
          station: water ? water.station : null,
        })
      );
      if (!res.ok) throw new Error(`conditions service returned ${res.status}`);
      return res.json();
    },
  });
}
