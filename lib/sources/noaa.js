/**
 * Tides and lake levels from NOAA CO-OPS.
 *
 * This covers two of the three water types: salt water (tide stage, the number
 * that matters more than almost anything else on the coast) and the Great
 * Lakes, which CO-OPS also gauges — so a Lake Michigan trip gets real water
 * level and water temperature rather than nothing.
 */

const DATA_URL = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const META_URL = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json';

import { haversineKm } from './usgs.js';

const stampUtc = (d) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate()
  ).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(
    d.getUTCMinutes()
  ).padStart(2, '0')}`;

// The station metadata list is large and effectively static; hold it for the
// life of the process so station search costs one download per deploy.
let stationCache = null;

async function allStations(fetchImpl) {
  if (stationCache) return stationCache;
  const res = await fetchImpl(`${META_URL}?type=tidepredictions`);
  if (!res.ok) throw new Error(`NOAA station list returned ${res.status}`);
  const json = await res.json();
  stationCache = (json.stations || []).map((s) => ({
    id: s.id,
    name: s.name,
    state: s.state,
    lat: Number(s.lat),
    lon: Number(s.lng),
  }));
  return stationCache;
}

/** Tide/water-level stations near a point, nearest first. */
export async function searchTideStations({ lat, lon, radiusKm = 60, fetchImpl = fetch }) {
  const stations = await allStations(fetchImpl);
  return stations
    .map((s) => ({ ...s, distanceKm: Math.round(haversineKm({ lat, lon }, s) * 10) / 10 }))
    .filter((s) => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, 12);
}

async function getProduct({ stationId, product, at, hours, fetchImpl, extra = {} }) {
  const params = new URLSearchParams({
    product,
    station: stationId,
    begin_date: stampUtc(new Date(at.getTime() - hours * 3600000)),
    end_date: stampUtc(new Date(at.getTime() + hours * 3600000)),
    units: 'english',
    time_zone: 'gmt',
    format: 'json',
    application: 'riffle-fishing-log',
    ...extra,
  });
  const res = await fetchImpl(`${DATA_URL}?${params}`);
  if (!res.ok) return null;
  const json = await res.json();
  // CO-OPS reports "no data" as a 200 with an error object rather than a status.
  if (json.error) return null;
  return json;
}

const parseCoopsTime = (s) => Date.parse(`${s.replace(' ', 'T')}:00Z`);

/**
 * Tide state at a moment: the stage (flooding or ebbing), how far through the
 * cycle you are, and the next high and low. Stage matters more than height —
 * "two hours into the flood" is a fishing instruction in a way that "3.1 feet"
 * is not.
 */
export async function fetchTide({ stationId, at, fetchImpl = fetch }) {
  const when = at instanceof Date ? at : new Date(at);
  const target = when.getTime();

  const [hilo, temp] = await Promise.all([
    getProduct({
      stationId, product: 'predictions', at: when, hours: 24, fetchImpl,
      extra: { datum: 'MLLW', interval: 'hilo' },
    }),
    getProduct({
      stationId, product: 'water_temperature', at: when, hours: 2, fetchImpl,
    }).catch(() => null),
  ]);

  const events = ((hilo && hilo.predictions) || [])
    .map((p) => ({ at: parseCoopsTime(p.t), heightFt: Number(p.v), type: p.type === 'H' ? 'high' : 'low' }))
    .sort((a, b) => a.at - b.at);

  const previous = [...events].reverse().find((e) => e.at <= target) || null;
  const next = events.find((e) => e.at > target) || null;

  let stage = null;
  let throughCyclePct = null;
  if (previous && next) {
    stage = previous.type === 'low' ? 'flooding' : 'ebbing';
    throughCyclePct = Math.round(((target - previous.at) / (next.at - previous.at)) * 100);
  }

  const waterTempF =
    temp && temp.data && temp.data.length ? Number(temp.data[temp.data.length - 1].v) : null;

  return {
    source: 'noaa-coops',
    stationId,
    stage,
    throughCyclePct,
    previousEvent: previous
      ? { type: previous.type, at: new Date(previous.at).toISOString(), heightFt: previous.heightFt }
      : null,
    nextEvent: next
      ? { type: next.type, at: new Date(next.at).toISOString(), heightFt: next.heightFt }
      : null,
    waterTempF: Number.isFinite(waterTempF) ? waterTempF : null,
  };
}

/**
 * Great Lakes stations report a water level against a lake datum rather than a
 * tide. Same station, different question — "is the lake up or down this month"
 * instead of "which way is the tide running".
 */
export async function fetchLakeLevel({ stationId, at, fetchImpl = fetch }) {
  const when = at instanceof Date ? at : new Date(at);
  const [level, temp] = await Promise.all([
    getProduct({ stationId, product: 'water_level', at: when, hours: 3, fetchImpl, extra: { datum: 'IGLD' } }),
    getProduct({ stationId, product: 'water_temperature', at: when, hours: 3, fetchImpl }).catch(() => null),
  ]);

  const readings = (level && level.data) || [];
  const closest = readings
    .map((d) => ({ at: parseCoopsTime(d.t), value: Number(d.v) }))
    .filter((d) => Number.isFinite(d.value))
    .sort((a, b) => Math.abs(a.at - when.getTime()) - Math.abs(b.at - when.getTime()))[0];

  const waterTempF =
    temp && temp.data && temp.data.length ? Number(temp.data[temp.data.length - 1].v) : null;

  return {
    source: 'noaa-coops',
    stationId,
    waterLevelFt: closest ? closest.value : null,
    readingAt: closest ? new Date(closest.at).toISOString() : null,
    waterTempF: Number.isFinite(waterTempF) ? waterTempF : null,
  };
}
