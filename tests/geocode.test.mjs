/**
 * Place search and station reuse.
 *
 * The interesting cases here are all about what someone types. "Racine, WI" is
 * how every website works and how nobody's geocoding API works — the region has
 * to be split off before the request and applied as a filter afterwards, or the
 * search returns nothing at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseQuery, searchPlaces } from '../lib/sources/geocode.js';
import { stationsInUse } from '../lib/app.js';

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

const place = (id, name, admin1, country = 'United States') => ({
  id, name, admin1, country, latitude: 42.7, longitude: -87.8, country_code: 'US',
});

/* -------------------------------------------------------------------------- */

test('a bare place name has no region', () => {
  assert.deepEqual(parseQuery('Racine'), { name: 'Racine', region: null });
});

test('a two-letter state is expanded to the name the API actually returns', () => {
  assert.deepEqual(parseQuery('Racine, WI'), { name: 'Racine', region: 'Wisconsin' });
  assert.deepEqual(parseQuery('racine,wi'), { name: 'racine', region: 'Wisconsin' });
  assert.deepEqual(parseQuery('Banff, AB'), { name: 'Banff', region: 'Alberta' });
});

test('a spelled-out region is kept as typed', () => {
  assert.deepEqual(parseQuery('Portland, Oregon'), { name: 'Portland', region: 'Oregon' });
});

test('an unrecognised tail is still treated as a region, not silently dropped', () => {
  assert.deepEqual(parseQuery('Cairo, Egypt'), { name: 'Cairo', region: 'Egypt' });
});

test('whitespace and empty input do not become a search', async () => {
  assert.deepEqual(parseQuery('   '), { name: '', region: null });
  const places = await searchPlaces({
    query: 'a',
    fetchImpl: async () => {
      throw new Error('should never have been called');
    },
  });
  assert.deepEqual(places, []);
});

/* -------------------------------------------------------------------------- */

test('the region is stripped from the request and applied as a filter', async () => {
  let requested = null;
  const places = await searchPlaces({
    query: 'Racine, WI',
    fetchImpl: async (url) => {
      requested = url;
      return jsonResponse({
        results: [
          place(1, 'Racine', 'Ohio'),
          place(2, 'Racine', 'Wisconsin'),
          place(3, 'Racine', 'Missouri'),
        ],
      });
    },
  });

  // The API is asked for "Racine" — asking it for "Racine, WI" finds nothing.
  assert.ok(requested.includes('name=Racine'), requested);
  assert.ok(!requested.includes('WI'), requested);

  assert.equal(places.length, 1);
  assert.equal(places[0].admin1, 'Wisconsin');
  assert.equal(places[0].detail, 'Wisconsin, United States');
});

test('a region matching nothing shows every result rather than an empty screen', async () => {
  const places = await searchPlaces({
    query: 'Racine, XZ',
    fetchImpl: async () => jsonResponse({ results: [place(1, 'Racine', 'Wisconsin')] }),
  });
  assert.equal(places.length, 1, 'a likely typo should not blank the list');
});

test('no region keeps the API relevance order untouched', async () => {
  const places = await searchPlaces({
    query: 'Racine',
    fetchImpl: async () => jsonResponse({
      results: [place(1, 'Racine', 'Wisconsin'), place(2, 'Racine', 'Ohio')],
    }),
  });
  assert.deepEqual(places.map((p) => p.admin1), ['Wisconsin', 'Ohio']);
});

test('an empty result set is not an error', async () => {
  const places = await searchPlaces({
    query: 'Zzzzzz',
    fetchImpl: async () => jsonResponse({}),
  });
  assert.deepEqual(places, []);
});

test('a failing place search says so rather than returning nothing', async () => {
  await assert.rejects(
    () => searchPlaces({ query: 'Racine', fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /Place search returned 503/
  );
});

/* --------------------------------------------------------------------------
   Reusing a station you already bound
   -------------------------------------------------------------------------- */

const water = (id, name, station) => ({ id, name, kind: 'river', station });
const gauge = (gid, name, kind = 'river') => ({ provider: 'usgs', id: gid, name, kind });

test('the same gauge on two waters is offered once, naming both', () => {
  const rows = stationsInUse({
    waters: [
      water('w1', 'Root River — lower', gauge('04087240', 'Root River near Franklin')),
      water('w2', 'Root River — Lincoln Park', gauge('04087240', 'Root River near Franklin')),
      water('w3', 'Menomonee', gauge('04087030', 'Menomonee at Wauwatosa')),
    ],
  });

  assert.equal(rows.length, 2);
  // Most-reused first — that is the one most likely wanted again.
  assert.equal(rows[0].id, '04087240');
  assert.deepEqual(rows[0].usedBy, ['Root River — lower', 'Root River — Lincoln Park']);
});

test('waters with no station bound contribute nothing', () => {
  const rows = stationsInUse({
    waters: [water('w1', 'Unbound creek', null), water('w2', 'Root', gauge('04087240', 'Root'))],
  });
  assert.equal(rows.length, 1);
});

test('a water is never offered its own station back as a suggestion', () => {
  const rows = stationsInUse({
    waters: [water('w1', 'Root', gauge('04087240', 'Root'))],
    excludeWaterId: 'w1',
  });
  assert.deepEqual(rows, []);
});

test('a tide station is not offered as a candidate for a river', () => {
  const rows = stationsInUse({
    waters: [
      { id: 'w1', name: 'Lake Michigan', kind: 'lake', station: { provider: 'noaa', id: '9087057', name: 'Milwaukee', kind: 'lake' } },
      water('w2', 'Root River', gauge('04087240', 'Root River near Franklin')),
    ],
    kind: 'river',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'usgs');
});
