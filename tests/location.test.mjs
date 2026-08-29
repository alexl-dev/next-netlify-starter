/**
 * Tests for the position-resolution seam: what happens when the phone will not
 * say where you are.
 *
 * The interesting logic is all pure — classifying the failure, ranking and
 * deduplicating the spots offered as an alternative, and choosing where the
 * map opens — so none of it needs a browser. `navigator` is injected as a
 * global only where geolocation itself is under test.
 *
 *   node --test tests/location.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CENTER, LOCATION_ERRORS, POSITION_SOURCES, classifyLocationError,
  currentPosition, initialCenter, lastKnownPosition, metersBetween,
  positionOptions, relativeAge, snapshotUrl, waterCoords,
} from '../lib/app.js';

/* --------------------------------------------------------------------------
   Classifying the failure — the branch the whole fallback hangs on
   -------------------------------------------------------------------------- */

test('a denied permission is not retryable, and says how to fix it', () => {
  const denied = classifyLocationError({ code: 1 });
  assert.equal(denied.reason, LOCATION_ERRORS.DENIED);
  assert.equal(denied.retryable, false);
  assert.match(denied.message, /Location permission is off/);
});

test('a missing fix and a timeout are both worth trying again', () => {
  const noFix = classifyLocationError({ code: 2 });
  assert.equal(noFix.reason, LOCATION_ERRORS.UNAVAILABLE);
  assert.equal(noFix.retryable, true);
  assert.match(noFix.message, /clearer view of the sky/);

  const timedOut = classifyLocationError({ code: 3 });
  assert.equal(timedOut.reason, LOCATION_ERRORS.TIMEOUT);
  assert.equal(timedOut.retryable, true);
  assert.equal(timedOut.message, 'Locating timed out.');
});

test('an unrecognised geolocation code reads as a timeout, as it always did', () => {
  assert.equal(classifyLocationError({ code: 99 }).message, 'Locating timed out.');
});

test('an already-classified error survives a second pass unchanged', () => {
  const once = classifyLocationError({ code: 1 });
  const twice = classifyLocationError(Object.assign(new Error(once.message), once));
  assert.deepEqual(twice, once);
});

test('something that is not a geolocation error at all still classifies', () => {
  const other = classifyLocationError(new Error('IndexedDB is unavailable in this browser'));
  assert.equal(other.reason, LOCATION_ERRORS.UNAVAILABLE);
  assert.equal(other.message, 'IndexedDB is unavailable in this browser');
});

test('a browser with no geolocation rejects with a code the UI can branch on', async () => {
  const saved = globalThis.navigator;
  // A browser object with no `geolocation` — an old Android WebView, or Safari
  // with location services switched off at the OS.
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  try {
    await assert.rejects(currentPosition(), (err) => {
      assert.equal(err.reason, LOCATION_ERRORS.UNSUPPORTED);
      assert.equal(err.retryable, false);
      assert.equal(err.message, 'This browser has no location access');
      return true;
    });
  } finally {
    if (saved === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
  }
});

test('a fix carries its provenance and is remembered for the map to centre on', async () => {
  const saved = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      geolocation: {
        getCurrentPosition: (ok) =>
          ok({ coords: { latitude: 42.8869, longitude: -87.9895, accuracy: 12.4 } }),
      },
    },
  });
  try {
    const fix = await currentPosition();
    assert.deepEqual(fix, {
      lat: 42.8869, lon: -87.9895, accuracyM: 12, source: POSITION_SOURCES.GPS,
    });
    assert.deepEqual(lastKnownPosition(), fix);
  } finally {
    if (saved === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, 'navigator', { value: saved, configurable: true });
  }
});

/* --------------------------------------------------------------------------
   The spots offered instead
   -------------------------------------------------------------------------- */

const NOW = Date.parse('2026-08-29T18:00:00Z');
const agoMin = (m) => new Date(NOW - m * 60000).toISOString();

/** Roughly `m` metres north of a point — near enough for a dedup test. */
const north = (lat, m) => lat + m / 111320;

test('twenty pins in one pool collapse into one offer', () => {
  const pins = Array.from({ length: 20 }, (_, i) => ({
    id: `p${i}`,
    tripId: 't1',
    lat: north(42.8869, i * 2), // a 40 m spread — one pool
    lon: -87.9895,
    droppedAt: agoMin(i + 1),
  }));
  const options = positionOptions({ pins, trips: [{ id: 't1', waterName: 'Root River' }], now: NOW });
  assert.equal(options.length, 1);
  assert.equal(options[0].label, 'Root River');
  assert.equal(options[0].source, POSITION_SOURCES.RECENT);
});

test('spots a run apart stay separate offers, newest first', () => {
  const pins = [
    { id: 'old', tripId: 't1', lat: 42.8869, lon: -87.9895, droppedAt: agoMin(4000), name: 'Bridge pool' },
    { id: 'new', tripId: 't1', lat: north(42.8869, 400), lon: -87.9895, droppedAt: agoMin(30), name: 'Cedar bend' },
  ];
  const options = positionOptions({ pins, trips: [{ id: 't1', waterName: 'Root River' }], now: NOW });
  assert.deepEqual(options.map((o) => o.label), ['Cedar bend', 'Bridge pool']);
  assert.equal(options[0].detail, '30 min ago · Root River');
  assert.match(options[1].detail, /days ago/);
});

test('pins with no usable coordinates are never offered', () => {
  const pins = [
    { id: 'a', tripId: 't1', lat: null, lon: null, droppedAt: agoMin(5) },
    { id: 'b', tripId: 't1', lat: 42.8869, lon: -87.9895, droppedAt: agoMin(9) },
  ];
  const options = positionOptions({ pins, now: NOW });
  assert.equal(options.length, 1);
  assert.equal(options[0].id, 'pin:b');
});

test('waters follow the pins, and only when they carry coordinates', () => {
  const waters = [
    { id: 'w1', name: 'Root River', station: { name: 'Root River near Franklin, WI', lat: 42.90, lon: -88.05 } },
    { id: 'w2', name: 'Some creek', station: { name: 'no coordinates stored', id: '123' } },
  ];
  const pins = [{ id: 'p', tripId: 't1', lat: 42.8869, lon: -87.9895, droppedAt: agoMin(20) }];
  const options = positionOptions({ pins, waters, now: NOW });
  assert.deepEqual(options.map((o) => o.id), ['pin:p', 'water:w1']);
  assert.equal(options[1].source, POSITION_SOURCES.WATER);
  assert.equal(options[1].detail, 'at Root River near Franklin, WI');
});

test('a water sitting on top of a pin is not offered twice', () => {
  const pins = [{ id: 'p', tripId: 't1', lat: 42.8869, lon: -87.9895, droppedAt: agoMin(20) }];
  const waters = [{ id: 'w1', name: 'Root River', lat: north(42.8869, 20), lon: -87.9895 }];
  assert.equal(positionOptions({ pins, waters, now: NOW }).length, 1);
});

test('the list stays short enough to read one-handed', () => {
  const pins = Array.from({ length: 30 }, (_, i) => ({
    id: `p${i}`, tripId: 't1', lat: north(42.8869, i * 500), lon: -87.9895, droppedAt: agoMin(i + 1),
  }));
  assert.equal(positionOptions({ pins, now: NOW }).length, 6);
  assert.equal(positionOptions({ pins, now: NOW, limit: 3 }).length, 3);
});

test('nothing logged yet is an empty list, not a crash', () => {
  assert.deepEqual(positionOptions(), []);
});

/* --------------------------------------------------------------------------
   Where the map opens
   -------------------------------------------------------------------------- */

test('a fix we already had beats everything else', () => {
  const center = initialCenter({
    lastPosition: { lat: 42.8869, lon: -87.9895 },
    water: { station: { lat: 44, lon: -89 } },
    recentPins: [{ lat: 45, lon: -90, droppedAt: agoMin(1) }],
  });
  assert.deepEqual(center, { lat: 42.8869, lon: -87.9895, from: 'device' });
});

test("the water's bound gauge comes next", () => {
  const center = initialCenter({
    water: { station: { lat: 42.90, lon: -88.05 } },
    recentPins: [{ lat: 45, lon: -90, droppedAt: agoMin(1) }],
  });
  assert.deepEqual(center, { lat: 42.90, lon: -88.05, from: 'water' });
});

test('then the last pin actually dropped, whatever order the pins arrive in', () => {
  const center = initialCenter({
    recentPins: [
      { lat: 45, lon: -90, droppedAt: agoMin(9000) },
      { lat: 43, lon: -88, droppedAt: agoMin(10) },
    ],
  });
  assert.deepEqual(center, { lat: 43, lon: -88, from: 'pin' });
});

test('a first-ever run falls back to somewhere, flagged as a guess', () => {
  const center = initialCenter();
  assert.deepEqual(center, { ...DEFAULT_CENTER, from: 'fallback' });
});

test('a water with a station but no stored coordinates falls through, it does not centre on NaN', () => {
  const center = initialCenter({ water: { station: { id: '04087240', name: 'Root River' } } });
  assert.equal(center.from, 'fallback');
  assert.equal(waterCoords({ station: { id: '04087240' } }), null);
});

/* -------------------------------------------------------------------------- */

test('distance is real metres, not degrees', () => {
  const a = { lat: 42.8869, lon: -87.9895 };
  assert.ok(Math.abs(metersBetween(a, { lat: north(42.8869, 100), lon: -87.9895 }) - 100) < 1);
  assert.equal(metersBetween(a, null), Infinity);
});

test('ages read the way someone would say them out loud', () => {
  assert.equal(relativeAge(agoMin(1), NOW), 'just now');
  assert.equal(relativeAge(agoMin(45), NOW), '45 min ago');
  assert.equal(relativeAge(agoMin(300), NOW), '5 h ago');
  assert.equal(relativeAge(agoMin(60 * 24 * 3), NOW), '3 days ago');
  assert.equal(relativeAge(agoMin(60 * 24 * 21), NOW), '3 weeks ago');
  assert.equal(relativeAge(agoMin(60 * 24 * 120), NOW), '4 months ago');
  assert.equal(relativeAge(undefined, NOW), '');
});

/* --------------------------------------------------------------------------
   What leaves the device
   -------------------------------------------------------------------------- */

test('the conditions request carries no more than a kilometre of precision', () => {
  const url = snapshotUrl({
    lat: 42.886912345, lon: -87.989587654, at: '2026-08-29T18:07:00Z',
  });
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));

  assert.equal(params.get('lat'), '42.89');
  assert.equal(params.get('lon'), '-87.99');
  for (const key of ['lat', 'lon']) {
    const decimals = (params.get(key).split('.')[1] || '').length;
    assert.ok(decimals <= 2, `${key} leaked ${decimals} decimals: ${params.get(key)}`);
  }
  // Full precision must not survive anywhere else in the URL either.
  assert.ok(!url.includes('42.8869'), url);
  assert.ok(!url.includes('87.9895'), url);
});

test('the timestamp keeps its minute, because solunar maths depends on it', () => {
  const url = snapshotUrl({ lat: 42.88, lon: -87.98, at: '2026-08-29T18:07:00Z' });
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(params.get('at'), '2026-08-29T18:07:00.000Z');
});

test('a bound station still rides along, since a station id is not a location', () => {
  const url = snapshotUrl({
    lat: 42.886912, lon: -87.989587, at: '2026-08-29T18:07:00Z',
    station: { provider: 'usgs', id: '04087240', kind: 'river' },
  });
  const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(params.get('stationId'), '04087240');
  assert.equal(params.get('provider'), 'usgs');
  assert.equal(params.get('lat'), '42.89');
});
