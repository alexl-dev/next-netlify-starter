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

/* --------------------------------------------------------------------------
   Position — the one input the whole log is built on
   -------------------------------------------------------------------------- */

/**
 * Why a fix could not be read. Screens branch on these codes rather than on
 * the message text: a denied permission is a dead end worth routing straight
 * to the map, whereas a timeout under a canopy is worth one more try before
 * making someone tap.
 */
export const LOCATION_ERRORS = {
  UNSUPPORTED: 'unsupported',
  DENIED: 'denied',
  UNAVAILABLE: 'unavailable',
  TIMEOUT: 'timeout',
};

/**
 * Where a set of coordinates came from. This rides along on every pin and
 * catch because a spot pointed at on a map is not the same evidence as a
 * measured fix, and the trends maths must never be able to confuse them.
 */
export const POSITION_SOURCES = {
  GPS: 'gps',       // the device's own fix
  MAP: 'map',       // placed by hand on a map
  RECENT: 'recent', // reused from a pin already dropped
  WATER: 'water',   // the coordinates of a water already defined
};

/** Where the map opens when nothing else is known — central Wisconsin. */
export const DEFAULT_CENTER = { lat: 44.5, lon: -89.5 };

// The wording here is deliberate and field-tested; keep it when adding codes.
const GEOLOCATION_ERRORS = {
  1: {
    reason: LOCATION_ERRORS.DENIED,
    retryable: false,
    message: 'Location permission is off. Turn it on in Settings › Safari to log where you fished.',
  },
  2: {
    reason: LOCATION_ERRORS.UNAVAILABLE,
    retryable: true,
    message: 'No position fix — try again with a clearer view of the sky.',
  },
  3: {
    reason: LOCATION_ERRORS.TIMEOUT,
    retryable: true,
    message: 'Locating timed out.',
  },
};

const UNSUPPORTED = {
  reason: LOCATION_ERRORS.UNSUPPORTED,
  retryable: false,
  message: 'This browser has no location access',
};

/**
 * Turn anything thrown by the location path into `{ reason, message,
 * retryable }`. Pure, so the branching the UI depends on is testable without
 * a browser.
 */
export function classifyLocationError(err) {
  if (err && LOCATION_ERRORS[String(err.reason || '').toUpperCase()]) {
    return { reason: err.reason, message: err.message, retryable: Boolean(err.retryable) };
  }
  if (err && typeof err.code === 'number') {
    // An unrecognised code from a geolocation callback reads as a timeout,
    // which is what it has always looked like to the person holding the phone.
    return { ...(GEOLOCATION_ERRORS[err.code] || GEOLOCATION_ERRORS[3]) };
  }
  return {
    reason: LOCATION_ERRORS.UNAVAILABLE,
    retryable: true,
    message: (err && err.message) || 'Could not read your location.',
  };
}

function locationError({ reason, message, retryable }) {
  const err = new Error(message);
  err.reason = reason;
  err.retryable = retryable;
  return err;
}

// The last fix the device gave us this session. Used to centre the manual
// picker: even a stale fix from ten minutes ago puts the map on the right
// river, which is the difference between one tap and a lot of pinching.
let lastFix = null;

export const lastKnownPosition = () => lastFix;

/**
 * Current position, with a deliberately short leash.
 *
 * Resolves `{ lat, lon, accuracyM, source: 'gps' }`. Rejects with an Error
 * carrying `.reason` (one of LOCATION_ERRORS) and `.retryable`, so a caller
 * can offer the map instead of dead-ending.
 */
export function currentPosition({ timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(locationError(UNSUPPORTED));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const fix = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy == null ? null : Math.round(pos.coords.accuracy),
          source: POSITION_SOURCES.GPS,
        };
        lastFix = fix;
        resolve(fix);
      },
      (err) => reject(locationError(classifyLocationError(err))),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 }
    );
  });
}

/* -------- picking a position by hand -------------------------------------- */

const EARTH_R = 6371000;

/** Straight-line metres between two points. Local so `lib/sources/*` stays a leaf. */
export function metersBetween(a, b) {
  if (!a || !b) return Infinity;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

const usable = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon);

/** Coordinates for a water: its bound gauge if one is bound, else its own. */
export function waterCoords(water) {
  if (!water) return null;
  if (usable(water.station)) return { lat: water.station.lat, lon: water.station.lon };
  if (usable(water)) return { lat: water.lat, lon: water.lon };
  return null;
}

/** "20 min ago", "3 days ago" — enough to recognise a spot, no more. */
export function relativeAge(iso, now = Date.now()) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.round((now - then) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks} weeks ago`;
  const months = Math.round(days / 30);
  return `${months} ${months === 1 ? 'month' : 'months'} ago`;
}

/**
 * Positions the angler can simply pick, newest first: the pins already
 * dropped, then the waters already defined.
 *
 * Pins are deduplicated by rough proximity, because a morning working one pool
 * leaves twenty pins inside a cast of each other and a list of twenty
 * identical rows is no list at all. `minSeparationM` defaults to 75 m — about
 * the length of a run, and comfortably wider than a phone's error under trees.
 */
export function positionOptions({
  pins = [],
  waters = [],
  trips = [],
  now = Date.now(),
  limit = 6,
  minSeparationM = 75,
} = {}) {
  const waterNameByTrip = new Map();
  for (const trip of trips) waterNameByTrip.set(trip.id, trip.waterName || '');

  const chosen = [];
  const far = (candidate) =>
    chosen.every((taken) => metersBetween(taken, candidate) > minSeparationM);

  const recent = pins
    .filter(usable)
    .sort((a, b) => Date.parse(b.droppedAt) - Date.parse(a.droppedAt));

  for (const pin of recent) {
    if (chosen.length >= limit) break;
    if (!far(pin)) continue;
    const waterName = waterNameByTrip.get(pin.tripId) || '';
    chosen.push({
      id: `pin:${pin.id}`,
      lat: pin.lat,
      lon: pin.lon,
      accuracyM: pin.accuracyM == null ? null : pin.accuracyM,
      source: POSITION_SOURCES.RECENT,
      label: pin.name || waterName || 'A spot you fished',
      detail: [relativeAge(pin.droppedAt, now), pin.name && waterName ? waterName : '']
        .filter(Boolean)
        .join(' · '),
      at: pin.droppedAt || null,
    });
  }

  for (const water of waters) {
    if (chosen.length >= limit) break;
    const coords = waterCoords(water);
    if (!coords || !far(coords)) continue;
    chosen.push({
      id: `water:${water.id}`,
      lat: coords.lat,
      lon: coords.lon,
      accuracyM: null,
      source: POSITION_SOURCES.WATER,
      label: water.name,
      detail: water.station && water.station.name ? `at ${water.station.name}` : 'water you added',
      at: null,
    });
  }

  return chosen;
}

/**
 * Where the manual picker should open. Nearest thing to the truth first: a fix
 * we already had, then the water being worked on, then the last place a pin
 * was actually dropped, and only then a fallback that is really just a
 * starting point for panning.
 */
export function initialCenter({
  lastPosition = null,
  water = null,
  recentPins = [],
  fallback = DEFAULT_CENTER,
} = {}) {
  if (usable(lastPosition)) {
    return { lat: lastPosition.lat, lon: lastPosition.lon, from: 'device' };
  }
  const coords = waterCoords(water);
  if (coords) return { ...coords, from: 'water' };

  const newest = recentPins
    .filter(usable)
    .sort((a, b) => Date.parse(b.droppedAt) - Date.parse(a.droppedAt))[0];
  if (newest) return { lat: newest.lat, lon: newest.lon, from: 'pin' };

  return { lat: fallback.lat, lon: fallback.lon, from: 'fallback' };
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

/**
 * Drop a pin. `position` is optional: pass one the person picked on the map or
 * off the recent list and the device is never asked. Without it we ask the
 * device, and the caller is expected to catch the rejection and offer the
 * picker — a denied permission must never mean no pin at all.
 */
export async function dropPin({ tripId, name = '', position = null }) {
  const fix = position || (await currentPosition());
  const pin = newPin({
    tripId,
    name,
    lat: fix.lat,
    lon: fix.lon,
    accuracyM: fix.accuracyM == null ? null : fix.accuracyM,
    source: fix.source || POSITION_SOURCES.GPS,
  });
  await store.put('pins', pin);
  await store.enqueue({ kind: 'pin', store: 'pins', recordId: pin.id });
  return pin;
}

export async function movePin(pinId, lat, lon) {
  const pin = await store.get('pins', pinId);
  if (!pin) return null;
  // Moving a pin invalidates its conditions — they were fetched for the old spot.
  // Dragged to where the angler says it was, so the provenance changes with it.
  const updated = {
    ...pin, lat, lon, snapshot: null, snapshotStatus: 'pending', movedByHand: true,
    source: POSITION_SOURCES.MAP, accuracyM: null,
  };
  await store.put('pins', updated);
  await store.enqueue({ kind: 'pin', store: 'pins', recordId: pin.id });
  return updated;
}

/**
 * Log a fish. Position comes from the device right now — never from the photo,
 * whose GPS tags are stripped by the browser and by iOS alike.
 *
 * Pass `position` when the person has already chosen one (the map, or a spot
 * off the recent list). A hand-picked position is a real position: it gets
 * written onto the record and enqueued for enrichment like any other, because
 * a fish landed indoors-of-permission used to sit condition-less forever.
 */
export async function logCatch({
  tripId, pinId, fields, photoBlob, position = null, askDevice = true,
}) {
  let fix = position;
  // `askDevice: false` says the screen already asked and was turned down — no
  // point burning another eight-second timeout with a fish out of the water.
  if (!fix && askDevice) {
    try {
      fix = await currentPosition({ timeout: 8000 });
    } catch {
      // A fish with no fix still gets logged. The pin's position covers for it.
      fix = null;
    }
  }

  const record = { ...newCatch({ tripId, pinId }), ...fields };
  if (fix) {
    record.lat = fix.lat;
    record.lon = fix.lon;
    record.source = fix.source || POSITION_SOURCES.GPS;
  }

  if (photoBlob) {
    const photo = await store.savePhoto({
      blob: photoBlob,
      lat: fix ? fix.lat : null,
      lon: fix ? fix.lon : null,
      accuracyM: fix ? fix.accuracyM : null,
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

/**
 * Coordinates that leave the device are rounded to a hundredth of a degree —
 * about a kilometre. Do not "fix" this back to full precision.
 *
 * The reason is not accuracy, it is that `/api/conditions` sets an `s-maxage`
 * of a week on anything older than three hours, and a shared CDN keys its
 * cache on the whole URL. At full precision every pool an angler has ever
 * fished becomes a cache entry and a line in edge logs they cannot see or
 * purge — an exact record of where one person stands, held by someone else,
 * from an app that otherwise never leaves the phone.
 *
 * Nothing is lost by coarsening: `snapshotKey` in lib/conditions.js already
 * buckets to the same hundredth of a degree, so every point inside the cell is
 * already treated as the same place; Open-Meteo's grid is about that coarse;
 * a bound gauge is a station id, not a point; and sun and moon are
 * indistinguishable over a kilometre. It also raises the hit rate, since six
 * catches from one run now share a single cache entry.
 *
 * The full-precision lat/lon stay on the record in IndexedDB — the map has to
 * draw the pin where it actually was. This coarsens the request, not the log.
 *
 * The timestamp is deliberately NOT rounded: solunar periods and sun position
 * are computed for that exact minute, so an hour-rounded `at` would come back
 * with different data.
 */
const COARSE = (n) => Number(n).toFixed(2);

export function snapshotUrl({ lat, lon, at, station }) {
  const params = new URLSearchParams({
    lat: COARSE(lat),
    lon: COARSE(lon),
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
