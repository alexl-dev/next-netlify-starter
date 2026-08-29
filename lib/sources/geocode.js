/**
 * Place search — "Racine, WI" to a latitude and longitude.
 *
 * Open-Meteo's geocoding service, chosen for the same reason as its weather:
 * no key, no signup, and it is already the source this app leans on. Nominatim
 * would also work but asks callers to identify themselves and to keep the
 * volume down, which is a worse fit for a keyless app someone deploys from a
 * phone.
 *
 * This finds *towns*, not rivers. That is the right target: you know the town
 * you are driving to, and gauges are then ranked by distance from it.
 */

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

/**
 * Open-Meteo returns `admin1` spelled out ("Wisconsin"), but people type "WI".
 * Only the US and Canada are covered here — enough for the waters this app
 * targets, and an unrecognised token is simply matched as literal text.
 */
const REGIONS = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
  WY: 'Wyoming', DC: 'District of Columbia',
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador', NS: 'Nova Scotia', ON: 'Ontario',
  PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan',
};

/**
 * Split what someone typed into a place and an optional region.
 *
 * The API has no "state" parameter, so the region is stripped off before the
 * request and used to filter afterwards — otherwise "Racine, WI" returns
 * nothing at all, because no town is named "Racine, WI".
 */
export function parseQuery(input) {
  const raw = String(input || '').trim().replace(/\s+/g, ' ');
  if (!raw) return { name: '', region: null };

  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { name: raw, region: null };

  const tail = parts[parts.length - 1];
  const expanded = REGIONS[tail.toUpperCase()];
  return {
    name: parts.slice(0, -1).join(', '),
    region: expanded || tail,
  };
}

const sameRegion = (place, region) => {
  if (!region) return true;
  const wanted = region.toLowerCase();
  return [place.admin1, place.admin2, place.country]
    .filter(Boolean)
    .some((field) => String(field).toLowerCase() === wanted);
};

/** "Racine · Wisconsin, United States" — enough to tell two Racines apart. */
const describe = (place) =>
  [place.admin1, place.country].filter(Boolean).join(', ');

/**
 * Search for a place by name.
 *
 * Results keep the API's own relevance order, except that anything matching a
 * typed region is floated to the top — someone who bothered to type "WI" has
 * told you which Racine they mean.
 */
export async function searchPlaces({ query, count = 8, fetchImpl = fetch } = {}) {
  const { name, region } = parseQuery(query);
  // Open-Meteo needs at least two characters and returns nothing useful below
  // that; asking anyway just spends a request to be told so.
  if (name.length < 2) return [];

  const params = new URLSearchParams({
    name,
    count: String(Math.min(20, Math.max(count, region ? 20 : count))),
    language: 'en',
    format: 'json',
  });

  const res = await fetchImpl(`${GEOCODE_URL}?${params}`);
  if (!res.ok) throw new Error(`Place search returned ${res.status}`);
  const json = await res.json();

  const places = (json.results || []).map((place) => ({
    id: String(place.id),
    name: place.name,
    admin1: place.admin1 || null,
    admin2: place.admin2 || null,
    country: place.country || null,
    countryCode: place.country_code || null,
    lat: place.latitude,
    lon: place.longitude,
    population: place.population == null ? null : place.population,
    label: place.name,
    detail: describe(place),
  }));

  const matching = places.filter((p) => sameRegion(p, region));
  // A region that matches nothing is more likely a typo than a real filter, so
  // fall back to showing everything rather than an empty screen.
  const ranked = region && matching.length ? matching : places;
  return ranked.slice(0, count);
}
