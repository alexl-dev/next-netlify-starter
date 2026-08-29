/**
 * Builds the conditions snapshot that gets stamped onto every pin and catch.
 *
 * Two rules shape this module:
 *
 * 1. Partial beats nothing. Sky-clock data is pure arithmetic and always
 *    succeeds; weather and gauge readings can fail independently. A snapshot
 *    with the moon but no river is still worth keeping, and the missing half
 *    can be filled in on a later pass.
 * 2. Nothing is ever fetched at the moment of capture. Capture writes a row
 *    with a place and a time; this runs afterwards, possibly days later from
 *    the couch, which is the only design that survives a river with no signal.
 */

import { astroSnapshot } from './astro.js';
import { fetchWeather } from './sources/openMeteo.js';
import { fetchGauge } from './sources/usgs.js';
import { fetchTide, fetchLakeLevel } from './sources/noaa.js';

export const SNAPSHOT_VERSION = 1;

/**
 * Snapshots are cached against a coarse key: a hundredth of a degree (about
 * 1km) and the hour. Six catches from the same run in the same hour share one
 * set of API calls.
 */
export function snapshotKey({ lat, lon, at, stationId }) {
  const when = at instanceof Date ? at : new Date(at);
  const hour = new Date(when);
  hour.setMinutes(0, 0, 0);
  return [lat.toFixed(2), lon.toFixed(2), hour.toISOString(), stationId || '-'].join('|');
}

async function settle(label, promise) {
  try {
    return { label, value: await promise, error: null };
  } catch (err) {
    return { label, value: null, error: err.message || String(err) };
  }
}

/**
 * @param {object} args
 * @param {number} args.lat
 * @param {number} args.lon
 * @param {Date|string|number} args.at
 * @param {object} [args.water] the bound water, carrying its station choice
 * @param {number} [args.tzOffsetMinutes] the angler's UTC offset, so "today's
 *   moonrise" means their day rather than the server's
 */
export async function buildSnapshot({ lat, lon, at, water, tzOffsetMinutes, fetchImpl = fetch }) {
  const when = at instanceof Date ? at : new Date(at);

  // Never fails, needs no network — so it is computed first and unconditionally.
  const astro = astroSnapshot(when, lat, lon, tzOffsetMinutes);

  const jobs = [settle('weather', fetchWeather({ lat, lon, at: when, fetchImpl }))];

  const station = water && water.station;
  if (station && station.provider === 'usgs') {
    jobs.push(settle('water', fetchGauge({ stationId: station.id, at: when, fetchImpl })));
  } else if (station && station.provider === 'noaa') {
    const call =
      station.kind === 'lake'
        ? fetchLakeLevel({ stationId: station.id, at: when, fetchImpl })
        : fetchTide({ stationId: station.id, at: when, fetchImpl });
    jobs.push(settle('water', call));
  }

  const results = await Promise.all(jobs);
  const byLabel = Object.fromEntries(results.map((r) => [r.label, r]));
  const errors = results.filter((r) => r.error).map((r) => `${r.label}: ${r.error}`);

  const weather = byLabel.weather ? byLabel.weather.value : null;
  const waterData = byLabel.water ? byLabel.water.value : null;

  // "enriched" means everything that was asked for arrived. Anything less stays
  // pending so a later pass retries it rather than silently leaving a hole.
  const expectedWater = Boolean(station);
  const complete = Boolean(weather) && (!expectedWater || Boolean(waterData));

  return {
    version: SNAPSHOT_VERSION,
    status: complete ? 'enriched' : 'partial',
    capturedFor: { lat, lon, at: when.toISOString(), waterId: water ? water.id : null },
    enrichedAt: new Date().toISOString(),
    astro,
    weather,
    water: waterData,
    errors,
  };
}

/**
 * A one-line reading of the conditions, in the words an angler would use.
 * This is what shows on a log entry before you open it.
 */
export function summarize(snapshot) {
  if (!snapshot) return '';
  const bits = [];
  const w = snapshot.weather;
  const a = snapshot.astro;
  const water = snapshot.water;

  if (w) {
    if (w.airTempF != null) bits.push(`${Math.round(w.airTempF)}°F`);
    if (w.conditions) bits.push(w.conditions.toLowerCase());
    if (w.pressure && w.pressure.direction !== 'steady') bits.push(`${w.pressure.direction} glass`);
    else if (w.pressureInHg != null) bits.push(`${w.pressureInHg.toFixed(2)}" steady`);
    if (w.windMph != null && w.windMph >= 4) {
      bits.push(`${Math.round(w.windMph)}mph ${w.windDirection || ''}`.trim());
    }
  }
  if (a) bits.push(`${a.moonPhaseName.toLowerCase()} ${Math.round(a.moonIlluminationPct)}%`);
  if (water) {
    if (water.dischargeCfs != null) {
      const pct = water.flow ? ` (${water.flow.pctOfMedian}% of median)` : '';
      bits.push(`${Math.round(water.dischargeCfs)} cfs${pct}`);
    }
    if (water.stage) bits.push(`tide ${water.stage}`);
    if (water.waterTempF != null) bits.push(`water ${Math.round(water.waterTempF)}°F`);
  }
  return bits.join(' · ');
}
