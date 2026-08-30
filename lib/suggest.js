/**
 * Ranking for the app's dropdowns.
 *
 * Every field you fill in on the bank — species, method, fly or lure, which
 * water — is something you have almost certainly entered before. The research
 * on autocomplete is consistent that the highest-value moment is the *empty*
 * one: showing likely answers before a character is typed is what turns typing
 * into tapping. Fishbrain ranks its species list the same way, from what you
 * have recently logged.
 *
 * So this ranks by what you actually do: how often you have used a value, then
 * how recently. Free text always wins over the list — a fish you have never
 * caught before must never be harder to log than one you have.
 *
 * Framework-free and network-free on purpose: the native build gets the same
 * ranking without a rewrite.
 */

/** Lowercase and strip accents, so "piqué" matches "pique". */
export function fold(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Where `query` appears in `text`, for highlighting the matched run.
 * Returns null when it does not appear at all.
 */
export function matchRange(text, query) {
  const haystack = fold(text);
  const needle = fold(query);
  if (!needle) return null;
  const index = haystack.indexOf(needle);
  if (index === -1) return null;
  return { start: index, end: index + needle.length };
}

/**
 * How good a match is, lower being better:
 *   0 the value starts with what was typed
 *   1 a word inside it starts with what was typed ("pheasant tail" for "tail")
 *   2 it merely contains it
 * Anything else is not a match at all.
 */
export function matchQuality(text, query) {
  const haystack = fold(text);
  const needle = fold(query);
  if (!needle) return 0;
  const index = haystack.indexOf(needle);
  if (index === -1) return null;
  if (index === 0) return 0;
  return /\s|-|\//.test(haystack[index - 1]) ? 1 : 2;
}

/**
 * Roll a list of records up into the distinct values of one field, with how
 * often and how recently each was used.
 *
 * Values keep the spelling of their most recent use, so correcting
 * "brown trout" to "Brown Trout" once fixes what the list offers from then on.
 */
export function collectHistory(records = [], field, { timeField = 'at' } = {}) {
  const byKey = new Map();

  for (const record of records) {
    const raw = record && record[field];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;

    const key = fold(value);
    const usedAt = Date.parse(record[timeField]) || 0;
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, { value, count: 1, lastUsedAt: usedAt });
      continue;
    }
    existing.count += 1;
    if (usedAt >= existing.lastUsedAt) {
      existing.lastUsedAt = usedAt;
      existing.value = value;
    }
  }

  return [...byKey.values()];
}

/**
 * The list to show under a field.
 *
 * With no query this is the empty-state list — most used first, most recent
 * breaking ties — because that is the list that saves the most taps. With a
 * query it is filtered by substring (not just prefix: people type the
 * distinctive word, "tail" for a pheasant tail nymph) and ordered by match
 * quality before popularity.
 */
export function rankSuggestions({ history = [], query = '', limit = 8 } = {}) {
  const typed = String(query || '').trim();

  const scored = [];
  for (const entry of history) {
    const quality = matchQuality(entry.value, typed);
    if (quality === null) continue;
    scored.push({ ...entry, quality, range: matchRange(entry.value, typed) });
  }

  scored.sort((a, b) => {
    if (a.quality !== b.quality) return a.quality - b.quality;
    if (a.count !== b.count) return b.count - a.count;
    if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    return a.value.localeCompare(b.value);
  });

  // An exact match needs no suggesting — the field already says it, and a list
  // showing one row identical to the input is noise sitting over the keyboard.
  const exact = scored.length === 1 && fold(scored[0].value) === fold(typed);
  return exact ? [] : scored.slice(0, limit);
}

/** "used 12 times · last Tuesday" — enough to tell two similar entries apart. */
export function describeUse(entry, now = Date.now()) {
  if (!entry || !entry.count) return '';
  const times = entry.count === 1 ? 'once' : `${entry.count} times`;
  if (!entry.lastUsedAt) return times;

  const days = Math.floor((now - entry.lastUsedAt) / 86400000);
  if (days <= 0) return `${times} · today`;
  if (days === 1) return `${times} · yesterday`;
  if (days < 7) return `${times} · ${days} days ago`;
  if (days < 30) return `${times} · ${Math.floor(days / 7)} wk ago`;
  if (days < 365) return `${times} · ${Math.floor(days / 30)} mo ago`;
  return `${times} · over a year ago`;
}

/**
 * Waters, ranked for the "where are you fishing" picker.
 *
 * Same idea as the fields above, but the signal is trips rather than a text
 * field: the water you fished last weekend is overwhelmingly the one you are
 * about to fish again.
 */
export function rankWaters({ waters = [], trips = [], query = '', limit = 8 } = {}) {
  const stats = new Map();
  for (const trip of trips) {
    if (!trip.waterId) continue;
    const at = Date.parse(trip.startedAt) || 0;
    const existing = stats.get(trip.waterId);
    if (!existing) {
      stats.set(trip.waterId, { count: 1, lastUsedAt: at });
    } else {
      existing.count += 1;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, at);
    }
  }

  const history = waters.map((water) => {
    const stat = stats.get(water.id) || { count: 0, lastUsedAt: 0 };
    return {
      value: water.name,
      count: stat.count,
      lastUsedAt: stat.lastUsedAt,
      water,
    };
  });

  return rankSuggestions({ history, query, limit });
}
