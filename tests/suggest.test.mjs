/**
 * Dropdown ranking.
 *
 * The behaviour being pinned down here is what the autocomplete research is
 * consistent about: the empty state is the valuable one, matching is by
 * substring rather than prefix, and the list must never get in the way of
 * typing something new.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectHistory, describeUse, fold, matchQuality, matchRange, rankSuggestions, rankWaters,
} from '../lib/suggest.js';

const DAY = 86400000;
const at = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

/* -------------------------------------------------------------------------- */

test('folding ignores case, accents and stray whitespace', () => {
  assert.equal(fold('  Piqué '), 'pique');
  assert.equal(fold('Brown Trout'), 'brown trout');
});

test('match quality prefers the start of the value, then the start of a word', () => {
  assert.equal(matchQuality('Pheasant tail', 'phea'), 0);
  assert.equal(matchQuality('Pheasant tail', 'tail'), 1);
  assert.equal(matchQuality('Pheasant tail', 'eas'), 2);
  assert.equal(matchQuality('Pheasant tail', 'zzz'), null);
});

test('a hyphen or slash counts as a word boundary', () => {
  assert.equal(matchQuality('Copper-john', 'john'), 1);
  assert.equal(matchQuality('fly/spin', 'spin'), 1);
});

test('the match range points at the run to highlight', () => {
  assert.deepEqual(matchRange('Pheasant tail', 'tail'), { start: 9, end: 13 });
  assert.equal(matchRange('Pheasant tail', 'zzz'), null);
  assert.equal(matchRange('Pheasant tail', ''), null);
});

/* -------------------------------------------------------------------------- */

test('history counts uses and remembers the most recent spelling', () => {
  const history = collectHistory(
    [
      { species: 'brown trout', at: at(30) },
      { species: 'Brown Trout', at: at(1) },
      { species: 'Brook trout', at: at(10) },
      { species: '   ', at: at(2) },
      { species: null, at: at(2) },
      { notASpecies: 'x', at: at(2) },
    ],
    'species'
  );

  const brown = history.find((h) => fold(h.value) === 'brown trout');
  assert.equal(brown.count, 2);
  // The newer capitalisation wins, so fixing it once fixes the list.
  assert.equal(brown.value, 'Brown Trout');
  assert.equal(history.length, 2, 'blank and missing values contribute nothing');
});

test('with nothing typed, the most-used value leads', () => {
  const history = [
    { value: 'Brook trout', count: 2, lastUsedAt: Date.now() },
    { value: 'Brown trout', count: 9, lastUsedAt: Date.now() - 5 * DAY },
  ];
  const ranked = rankSuggestions({ history, query: '' });
  assert.deepEqual(ranked.map((r) => r.value), ['Brown trout', 'Brook trout']);
});

test('recency breaks a tie on frequency', () => {
  const history = [
    { value: 'Older', count: 3, lastUsedAt: Date.now() - 40 * DAY },
    { value: 'Newer', count: 3, lastUsedAt: Date.now() - 1 * DAY },
  ];
  assert.equal(rankSuggestions({ history, query: '' })[0].value, 'Newer');
});

test('typing matches inside a value, not just at the front', () => {
  const history = [
    { value: 'Pheasant tail', count: 1, lastUsedAt: 0 },
    { value: 'Copper john', count: 1, lastUsedAt: 0 },
  ];
  const ranked = rankSuggestions({ history, query: 'tail' });
  assert.deepEqual(ranked.map((r) => r.value), ['Pheasant tail']);
  assert.deepEqual(ranked[0].range, { start: 9, end: 13 });
});

test('a better match beats a more popular one', () => {
  const history = [
    { value: 'Elk hair caddis', count: 20, lastUsedAt: Date.now() },  // 'cad' mid-word
    { value: 'Caddis pupa', count: 1, lastUsedAt: 0 },                // 'cad' at the front
  ];
  assert.equal(rankSuggestions({ history, query: 'cad' })[0].value, 'Caddis pupa');
});

test('the list gets out of the way once the field already says the answer', () => {
  const history = [{ value: 'Brown trout', count: 5, lastUsedAt: Date.now() }];
  assert.deepEqual(rankSuggestions({ history, query: 'Brown trout' }), []);
  // Still offered while it is only a partial match.
  assert.equal(rankSuggestions({ history, query: 'Brown' }).length, 1);
});

test('something never logged before simply has no suggestions, and no error', () => {
  const history = [{ value: 'Brown trout', count: 5, lastUsedAt: Date.now() }];
  assert.deepEqual(rankSuggestions({ history, query: 'Tarpon' }), []);
  assert.deepEqual(rankSuggestions({}), []);
});

test('the list is capped so it cannot bury the keyboard', () => {
  const history = Array.from({ length: 40 }, (_, i) => ({
    value: `Fly ${i}`, count: 1, lastUsedAt: i,
  }));
  assert.equal(rankSuggestions({ history, query: '' }).length, 8);
  assert.equal(rankSuggestions({ history, query: '', limit: 3 }).length, 3);
});

/* -------------------------------------------------------------------------- */

test('use is described in a way that distinguishes two similar entries', () => {
  const now = Date.parse('2026-08-29T12:00:00Z');
  assert.equal(describeUse({ count: 1, lastUsedAt: now }, now), 'once · today');
  assert.equal(describeUse({ count: 12, lastUsedAt: now - DAY }, now), '12 times · yesterday');
  assert.equal(describeUse({ count: 3, lastUsedAt: now - 9 * DAY }, now), '3 times · 1 wk ago');
  assert.equal(describeUse({ count: 2, lastUsedAt: now - 400 * DAY }, now), '2 times · over a year ago');
  assert.equal(describeUse(null), '');
});

/* -------------------------------------------------------------------------- */

test('waters rank by trips taken, so last weekend’s river leads', () => {
  const waters = [
    { id: 'w1', name: 'Root River' },
    { id: 'w2', name: 'Menomonee River' },
    { id: 'w3', name: 'Never fished creek' },
  ];
  const trips = [
    { waterId: 'w2', startedAt: at(2) },
    { waterId: 'w1', startedAt: at(20) },
    { waterId: 'w1', startedAt: at(25) },
    { waterId: 'w1', startedAt: at(30) },
  ];

  const ranked = rankWaters({ waters, trips });
  assert.deepEqual(ranked.map((r) => r.value), ['Root River', 'Menomonee River', 'Never fished creek']);
  assert.equal(ranked[0].count, 3);
  // A water you added but have not fished is still offered, just last.
  assert.equal(ranked[2].count, 0);
});

test('typing filters waters and carries the water through for selection', () => {
  const waters = [{ id: 'w1', name: 'Root River' }, { id: 'w2', name: 'Menomonee River' }];
  const ranked = rankWaters({ waters, trips: [], query: 'meno' });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].water.id, 'w2');
});
