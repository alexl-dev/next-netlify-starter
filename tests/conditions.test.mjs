/**
 * Tests for the parts where bugs actually hide: deriving trends from a series,
 * parsing the two awkward wire formats (USGS tab-delimited RDB and its
 * WaterML-flavoured JSON), and — most importantly — the rate maths, where an
 * error would silently produce a plausible, wrong conclusion about fishing.
 *
 * Network is injected everywhere, so these run offline and deterministically.
 *
 *   node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { astroSnapshot, moonIllumination, sunTimes } from '../lib/astro.js';
import { fetchWeather } from '../lib/sources/openMeteo.js';
import { fetchGauge, searchStations } from '../lib/sources/usgs.js';
import {
  BUCKETS, catchRateBy, confidence, daysLikeToday, pinDurations, tripHours,
} from '../lib/model.js';

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const textResponse = (body) => ({ ok: true, status: 200, text: async () => body });

/* -------------------------------------------------------------------------- */

test('moon phases land on the right names at known new and full moons', () => {
  const full = moonIllumination(new Date('2025-03-14T06:55:00Z'));
  assert.equal(full.name, 'Full moon');
  assert.ok(full.fraction > 0.99, `expected a full disc, got ${full.fraction}`);

  const nw = moonIllumination(new Date('2025-01-29T12:36:00Z'));
  assert.equal(nw.name, 'New moon');
  assert.ok(nw.fraction < 0.01, `expected a dark disc, got ${nw.fraction}`);
});

test('sunrise and day length match the almanac for Milwaukee at both solstices', () => {
  const summer = sunTimes(new Date('2026-06-21T12:00:00Z'), 43.04, -87.91);
  const winter = sunTimes(new Date('2026-12-21T12:00:00Z'), 43.04, -87.91);
  // 15h22m and 9h00m, within a minute.
  assert.ok(Math.abs(summer.dayLengthHours - 15.37) < 0.02, summer.dayLengthHours);
  assert.ok(Math.abs(winter.dayLengthHours - 9.0) < 0.02, winter.dayLengthHours);
});

test("moonrise belongs to the angler's day, not the server's", () => {
  const at = new Date('2026-08-29T23:00:00Z');
  const central = astroSnapshot(at, 43.04, -87.91, 300);
  const utc = astroSnapshot(at, 43.04, -87.91, 0);
  assert.notEqual(central.moonrise, utc.moonrise);
});

/* -------------------------------------------------------------------------- */

/** Hourly series with pressure falling 1 hPa/h, ending at the target hour. */
function weatherFixture(targetIso) {
  const end = new Date(targetIso);
  const time = [];
  const pressure_msl = [];
  const precipitation = [];
  for (let i = 48; i >= 0; i--) {
    const t = new Date(end.getTime() - i * 3600000);
    time.push(t.toISOString().slice(0, 16));
    pressure_msl.push(1013 + i);
    precipitation.push(i === 30 ? 0.2 : 0);
  }
  const fill = (v) => time.map(() => v);
  return {
    utc_offset_seconds: 0,
    hourly: {
      time,
      pressure_msl,
      precipitation,
      temperature_2m: fill(61),
      apparent_temperature: fill(59),
      relative_humidity_2m: fill(70),
      dew_point_2m: fill(50),
      weather_code: fill(3),
      cloud_cover: fill(80),
      visibility: fill(16093),
      wind_speed_10m: fill(8),
      wind_direction_10m: fill(225),
      wind_gusts_10m: fill(15),
      surface_pressure: fill(1000),
    },
  };
}

test('pressure trend reads direction and deltas off the series, not one reading', async () => {
  const target = '2026-08-29T18:00:00Z';
  const weather = await fetchWeather({
    lat: 43, lon: -87.9, at: new Date(target),
    fetchImpl: async () => jsonResponse(weatherFixture(target)),
  });

  assert.equal(weather.pressure.direction, 'falling fast');
  assert.equal(weather.pressure.change3hHpa, -3);
  assert.equal(weather.pressure.change24hHpa, -24);
  assert.equal(weather.conditions, 'Overcast');
  assert.equal(weather.windDirection, 'SW');
  assert.ok(Math.abs(weather.pressureInHg - 29.91) < 0.02, weather.pressureInHg);
});

test('rain totals and hours-since-rain look only backwards from the target', async () => {
  const target = '2026-08-29T18:00:00Z';
  const weather = await fetchWeather({
    lat: 43, lon: -87.9, at: new Date(target),
    fetchImpl: async () => jsonResponse(weatherFixture(target)),
  });
  assert.equal(weather.precipitation.last24hIn, 0);   // the shower was 30h back
  assert.equal(weather.precipitation.last72hIn, 0.2);
  assert.equal(weather.precipitation.hoursSinceRain, 30);
});

test('a series that does not reach the requested hour is an error, not a wrong answer', async () => {
  const stale = weatherFixture('2026-08-20T18:00:00Z');
  await assert.rejects(
    () => fetchWeather({
      lat: 43, lon: -87.9, at: new Date('2026-08-29T18:00:00Z'),
      fetchImpl: async () => jsonResponse(stale),
    }),
    /no observation near that time/
  );
});

/* -------------------------------------------------------------------------- */

const SITE_RDB = `# comment line
agency_cd\tsite_no\tstation_nm\tsite_tp_cd\tdec_lat_va\tdec_long_va\tdrain_area_va
5s\t15s\t50s\t7s\t16s\t16s\t8s
USGS\t04087240\tROOT RIVER NEAR FRANKLIN, WI\tST\t42.8869\t-87.9895\t49.2
USGS\t04087030\tMENOMONEE RIVER AT WAUWATOSA, WI\tST\t43.0450\t-88.0020\t123
`;

test('USGS RDB parsing skips the type row and ranks candidates by distance', async () => {
  const stations = await searchStations({
    lat: 42.89, lon: -87.99, radiusKm: 40,
    fetchImpl: async () => textResponse(SITE_RDB),
  });

  assert.equal(stations.length, 2);
  assert.equal(stations[0].id, '04087240');
  assert.equal(stations[0].name, 'Root River near Franklin, WI');
  assert.ok(stations[0].distanceKm < stations[1].distanceKm);
  assert.equal(stations[0].drainageAreaSqMi, 49.2);
});

test('an empty bounding box is a normal answer, not a failure', async () => {
  const stations = await searchStations({
    lat: 42.89, lon: -87.99,
    fetchImpl: async () => ({ ok: false, status: 404 }),
  });
  assert.deepEqual(stations, []);
});

/** Discharge dropping from 200 to 120 cfs over three days. */
function gaugeFixture(targetIso) {
  const end = new Date(targetIso);
  const values = [];
  for (let i = 72; i >= 0; i--) {
    values.push({
      dateTime: new Date(end.getTime() - i * 3600000).toISOString(),
      value: String(120 + i * (80 / 72)),
    });
  }
  return {
    value: {
      timeSeries: [
        {
          variable: { variableCode: [{ value: '00060' }] },
          values: [{ value: values }],
        },
        {
          variable: { variableCode: [{ value: '00010' }] },
          values: [{ value: [{ dateTime: targetIso, value: '14.5' }] }],
        },
      ],
    },
  };
}

const STAT_RDB = `# stats
agency_cd\tsite_no\tparameter_cd\tmonth_nu\tday_nu\tbegin_yr\tend_yr\tp10_va\tp25_va\tp50_va\tp75_va\tp90_va
5s\t15s\t5s\t2n\t2n\t4n\t4n\t8s\t8s\t8s\t8s\t8s
USGS\t04087240\t00060\t8\t29\t1964\t2025\t40\t80\t200\t400\t800
`;

test('gauge readings carry a trend and a flow percentile with a label', async () => {
  const target = '2026-08-29T18:00:00Z';
  const gauge = await fetchGauge({
    stationId: '04087240', at: new Date(target),
    fetchImpl: async (url) =>
      url.includes('/stat/') ? textResponse(STAT_RDB) : jsonResponse(gaugeFixture(target)),
  });

  assert.equal(Math.round(gauge.dischargeCfs), 120);
  assert.equal(gauge.waterTempC, 14.5);
  assert.equal(gauge.waterTempF, 58.1);
  assert.equal(gauge.dischargeTrend24h.direction, 'dropping');
  assert.equal(gauge.flow.medianCfs, 200);
  assert.equal(gauge.flow.pctOfMedian, 60);
  // USGS classes the 25th-75th percentile band as "normal", and 120 cfs sits
  // between p25 (80) and p50 (200) — below the median is not below normal.
  assert.equal(gauge.flow.label, 'normal');
  assert.equal(gauge.flow.yearsOfRecord, 62);
});

test('flow below the 25th percentile is classed below normal', async () => {
  const target = '2026-08-29T18:00:00Z';
  const low = gaugeFixture(target);
  // Flatten the series to 60 cfs, between p10 (40) and p25 (80).
  low.value.timeSeries[0].values[0].value =
    low.value.timeSeries[0].values[0].value.map((v) => ({ ...v, value: '60' }));

  const gauge = await fetchGauge({
    stationId: '04087240', at: new Date(target),
    fetchImpl: async (url) =>
      url.includes('/stat/') ? textResponse(STAT_RDB) : jsonResponse(low),
  });
  assert.equal(gauge.flow.label, 'below normal');
  assert.equal(gauge.flow.pctOfMedian, 30);
  assert.equal(gauge.dischargeTrend24h.direction, 'steady');
});

test('a gauge with no long-term record still returns readings, just no percentile', async () => {
  const target = '2026-08-29T18:00:00Z';
  const gauge = await fetchGauge({
    stationId: '99999999', at: new Date(target),
    fetchImpl: async (url) =>
      url.includes('/stat/') ? { ok: false, status: 404 } : jsonResponse(gaugeFixture(target)),
  });
  assert.equal(gauge.flow, null);
  assert.ok(gauge.dischargeCfs > 0);
});

/* --------------------------------------------------------------------------
   The rate maths — where a bug would produce a confident, wrong belief
   -------------------------------------------------------------------------- */

const snapshotWith = (direction) => ({
  weather: { pressure: { direction } },
  astro: { moonPhaseName: 'Full moon', timeOfDay: 'midday' },
  water: null,
});

function scenario() {
  // Two trips on falling pressure totalling 10 hours and 4 fish (0.4/h);
  // one trip on rising pressure of 2 hours and 3 fish (1.5/h).
  // Counting catches would crown "falling"; counting rates crowns "rising".
  const trips = [
    { id: 't1', startedAt: '2026-05-01T12:00:00Z', endedAt: '2026-05-01T18:00:00Z' },
    { id: 't2', startedAt: '2026-05-08T12:00:00Z', endedAt: '2026-05-08T16:00:00Z' },
    { id: 't3', startedAt: '2026-05-15T12:00:00Z', endedAt: '2026-05-15T14:00:00Z' },
  ];
  const pins = [
    { id: 'p1', tripId: 't1', droppedAt: '2026-05-01T12:05:00Z', snapshot: snapshotWith('falling') },
    { id: 'p2', tripId: 't2', droppedAt: '2026-05-08T12:05:00Z', snapshot: snapshotWith('falling') },
    { id: 'p3', tripId: 't3', droppedAt: '2026-05-15T12:05:00Z', snapshot: snapshotWith('rising') },
  ];
  const catches = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, tripId: 't1', snapshot: null })),
    { id: 'c3', tripId: 't2', snapshot: null },
    ...Array.from({ length: 3 }, (_, i) => ({ id: `d${i}`, tripId: 't3', snapshot: null })),
  ];
  return { trips, pins, catches };
}

test('catch rate is per hour fished, so more fish does not mean a better bucket', () => {
  const rows = catchRateBy('pressure', scenario());
  const falling = rows.find((r) => r.bucket === 'falling');
  const rising = rows.find((r) => r.bucket === 'rising');

  assert.equal(falling.catches, 4);
  assert.equal(falling.hours, 10);
  assert.equal(falling.perHour, 0.4);

  assert.equal(rising.catches, 3);
  assert.equal(rising.hours, 2);
  assert.equal(rising.perHour, 1.5);

  // The whole point: fewer fish, better fishing.
  assert.ok(rising.perHour > falling.perHour);
});

test('blank trips count towards the hours, dragging a bucket down as they should', () => {
  const data = scenario();
  data.trips.push({ id: 't4', startedAt: '2026-05-22T12:00:00Z', endedAt: '2026-05-22T22:00:00Z' });
  data.pins.push({ id: 'p4', tripId: 't4', droppedAt: '2026-05-22T12:05:00Z', snapshot: snapshotWith('rising') });

  const rows = catchRateBy('pressure', data);
  const rising = rows.find((r) => r.bucket === 'rising');
  assert.equal(rising.trips, 2);
  assert.equal(rising.hours, 12);
  assert.equal(rising.perHour, 0.25); // 3 fish / 12 h, down from 1.5
});

test('an unfinished trip contributes no hours and no bucket', () => {
  const data = scenario();
  data.trips.push({ id: 't5', startedAt: '2026-05-29T12:00:00Z', endedAt: null });
  data.pins.push({ id: 'p5', tripId: 't5', droppedAt: '2026-05-29T12:05:00Z', snapshot: snapshotWith('steady') });
  const rows = catchRateBy('pressure', data);
  assert.equal(rows.find((r) => r.bucket === 'steady'), undefined);
});

test('trips whose conditions never arrived sit out rather than distorting a bucket', () => {
  const data = scenario();
  data.trips.push({ id: 't6', startedAt: '2026-06-01T12:00:00Z', endedAt: '2026-06-01T20:00:00Z' });
  data.pins.push({ id: 'p6', tripId: 't6', droppedAt: '2026-06-01T12:05:00Z', snapshot: null });
  const before = catchRateBy('pressure', scenario());
  const after = catchRateBy('pressure', data);
  assert.deepEqual(after.map((r) => r.hours), before.map((r) => r.hours));
});

test('buckets come back in a meaningful order, not alphabetically', () => {
  const rows = catchRateBy('pressure', scenario());
  const order = rows.map((r) => r.bucket);
  assert.ok(order.indexOf('falling') < order.indexOf('rising'), order.join(','));
  assert.deepEqual(BUCKETS.pressure.order[0], 'falling fast');
});

test('confidence refuses to endorse a thin log', () => {
  assert.equal(confidence([{ trips: 4 }, { trips: 3 }]).level, 'none');
  assert.equal(confidence([{ trips: 8 }, { trips: 7 }]).level, 'weak');
  assert.equal(confidence([{ trips: 30 }, { trips: 25 }]).level, 'suggestive');
  assert.equal(confidence([{ trips: 60 }, { trips: 50 }]).level, 'usable');
});

/* -------------------------------------------------------------------------- */

test('time on a spot is derived from the next pin, with no second timer', () => {
  const trip = { id: 't1', startedAt: '2026-05-01T12:00:00Z', endedAt: '2026-05-01T15:00:00Z' };
  const pins = [
    { id: 'b', tripId: 't1', droppedAt: '2026-05-01T13:00:00Z' },
    { id: 'a', tripId: 't1', droppedAt: '2026-05-01T12:00:00Z' },
  ];
  const timed = pinDurations(trip, pins);
  assert.deepEqual(timed.map((p) => p.id), ['a', 'b']);
  assert.equal(timed[0].minutes, 60);
  assert.equal(timed[1].minutes, 120); // runs to the end of the trip
});

test('an open trip counts up to now', () => {
  const started = new Date(Date.now() - 90 * 60000).toISOString();
  const hours = tripHours({ startedAt: started, endedAt: null });
  assert.ok(Math.abs(hours - 1.5) < 0.02, String(hours));
});

test('days like today ranks by resemblance and reports what happened', () => {
  const data = scenario();
  const target = snapshotWith('rising');
  const matches = daysLikeToday(target, data, 3);

  assert.equal(matches[0].trip.id, 't3');
  assert.equal(matches[0].catches, 3);
  assert.equal(matches[0].perHour, 1.5);
  assert.ok(matches[0].similarity > matches[matches.length - 1].similarity);
});
