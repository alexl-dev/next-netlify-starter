/**
 * River conditions from USGS Water Services — gauge height, discharge, water
 * temperature, turbidity.
 *
 * A note on why you bind a gauge by hand: there is no "nearest gauge" endpoint.
 * The site service filters by bounding box, not radius, and nearest-in-a-
 * straight-line is frequently a gauge on a different tributary, or above the
 * confluence that actually feeds the water you're standing in. So this module
 * offers candidates and ranks them; a person picks, and the choice is
 * remembered against that water forever.
 */

const SITE_URL = 'https://waterservices.usgs.gov/nwis/site/';
const IV_URL = 'https://waterservices.usgs.gov/nwis/iv/';
const STAT_URL = 'https://waterservices.usgs.gov/nwis/stat/';

export const PARAM = {
  discharge: '00060',   // cubic feet per second
  gaugeHeight: '00065', // feet
  waterTemp: '00010',   // celsius
  turbidity: '63680',   // FNU
};

const ALL_PARAMS = Object.values(PARAM).join(',');
const KM_PER_DEG_LAT = 111.32;

export function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Tab-delimited RDB: comment lines start with #, then a header row, then a type row. */
function parseRdb(text) {
  const lines = text.split('\n').filter((l) => l.length && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(2).map((line) => {
    const cells = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] === undefined ? '' : cells[i].trim();
    });
    return row;
  });
}

/**
 * Candidate gauges near a point, nearest first. `radiusKm` becomes a bounding
 * box because that is the only shape the service accepts.
 */
export async function searchStations({ lat, lon, radiusKm = 40, fetchImpl = fetch }) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const dLon = radiusKm / (KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));

  const params = new URLSearchParams({
    format: 'rdb',
    bBox: [
      (lon - dLon).toFixed(4),
      (lat - dLat).toFixed(4),
      (lon + dLon).toFixed(4),
      (lat + dLat).toFixed(4),
    ].join(','),
    parameterCd: `${PARAM.discharge},${PARAM.gaugeHeight}`,
    siteStatus: 'active',
    hasDataTypeCd: 'iv',
    siteOutput: 'expanded',
  });

  const res = await fetchImpl(`${SITE_URL}?${params}`);
  // The service answers 404 when a box simply contains no gauges — a normal
  // outcome on a small creek, not an error worth showing anyone.
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`USGS site service returned ${res.status}`);

  const rows = parseRdb(await res.text());
  return rows
    .filter((r) => r.site_no && r.dec_lat_va && r.dec_long_va)
    .map((r) => {
      const station = {
        id: r.site_no,
        name: tidyStationName(r.station_nm),
        rawName: r.station_nm,
        lat: Number(r.dec_lat_va),
        lon: Number(r.dec_long_va),
        drainageAreaSqMi: r.drain_area_va ? Number(r.drain_area_va) : null,
        siteType: r.site_tp_cd,
      };
      station.distanceKm = Math.round(haversineKm({ lat, lon }, station) * 10) / 10;
      return station;
    })
    .filter((s) => s.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** "ROOT RIVER AT RACINE, WI" reads better as "Root River at Racine, WI". */
function tidyStationName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(At|Nr|Near|Above|Below|Of|The|And)\b/g, (m) => m.toLowerCase())
    .replace(/\bNr\b/g, 'near')
    .replace(/,\s*([a-z]{2})$/i, (m, s) => `, ${s.toUpperCase()}`);
}

const seriesParam = (ts) => ts.variable.variableCode[0].value;

function readSeries(json) {
  const out = {};
  const series = (json.value && json.value.timeSeries) || [];
  for (const ts of series) {
    const code = seriesParam(ts);
    const values = (ts.values[0] && ts.values[0].value) || [];
    out[code] = values
      .filter((v) => v.value !== '' && Number(v.value) > -999999)
      .map((v) => ({ at: new Date(v.dateTime).getTime(), value: Number(v.value) }));
  }
  return out;
}

const nearestReading = (points, targetMs, toleranceMs) => {
  let best = null;
  let bestGap = Infinity;
  for (const p of points || []) {
    const gap = Math.abs(p.at - targetMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = p;
    }
  }
  return best && bestGap <= toleranceMs ? best : null;
};

/**
 * Rising or dropping water is often the whole story on a river — a gauge
 * reading in isolation tells you far less than which way it is moving.
 */
function trendOver(points, targetMs, hours) {
  const now = nearestReading(points, targetMs, 3 * 3600000);
  const then = nearestReading(points, targetMs - hours * 3600000, 3 * 3600000);
  if (!now || !then) return null;
  const change = Math.round((now.value - then.value) * 1000) / 1000;
  const pct = then.value === 0 ? null : (change / Math.abs(then.value)) * 100;
  let direction = 'steady';
  if (pct != null) {
    if (pct >= 10) direction = 'rising';
    else if (pct <= -10) direction = 'dropping';
  }
  return { change, changePct: pct == null ? null : Math.round(pct), direction };
}

/**
 * Where today's flow sits against the historical record for this calendar day.
 * "62% of median for August 29" travels between rivers in a way that raw cubic
 * feet per second never will — 300 cfs is a flood on one creek and a drought
 * on the next.
 */
export async function fetchFlowPercentile({ stationId, at, discharge, fetchImpl = fetch }) {
  if (discharge == null) return null;
  const when = at instanceof Date ? at : new Date(at);

  const params = new URLSearchParams({
    format: 'rdb',
    sites: stationId,
    statReportType: 'daily',
    statTypeCd: 'p10,p25,p50,p75,p90',
    parameterCd: PARAM.discharge,
  });

  let rows;
  try {
    const res = await fetchImpl(`${STAT_URL}?${params}`);
    if (!res.ok) return null;
    rows = parseRdb(await res.text());
  } catch {
    return null; // A gauge without a long record is common; not worth failing over.
  }

  const month = when.getMonth() + 1;
  const day = when.getDate();
  const row = rows.find((r) => Number(r.month_nu) === month && Number(r.day_nu) === day);
  if (!row || !row.p50_va) return null;

  const median = Number(row.p50_va);
  const bands = [
    { key: 'p10_va', label: 'much below normal', upper: 10 },
    { key: 'p25_va', label: 'below normal', upper: 25 },
    { key: 'p75_va', label: 'normal', upper: 75 },
    { key: 'p90_va', label: 'above normal', upper: 90 },
  ];

  let label = 'much above normal';
  for (const band of bands) {
    if (row[band.key] && discharge <= Number(row[band.key])) {
      label = band.label;
      break;
    }
  }

  return {
    medianCfs: median,
    pctOfMedian: Math.round((discharge / median) * 100),
    label,
    yearsOfRecord:
      row.begin_yr && row.end_yr ? Number(row.end_yr) - Number(row.begin_yr) + 1 : null,
  };
}

/** Gauge readings at a moment, with 24h and 72h trends and a flow percentile. */
export async function fetchGauge({ stationId, at, fetchImpl = fetch }) {
  const when = at instanceof Date ? at : new Date(at);
  const target = when.getTime();

  const params = new URLSearchParams({
    format: 'json',
    sites: stationId,
    parameterCd: ALL_PARAMS,
    startDT: new Date(target - 4 * 86400000).toISOString(),
    endDT: new Date(Math.min(Date.now(), target + 3600000)).toISOString(),
    siteStatus: 'all',
  });

  const res = await fetchImpl(`${IV_URL}?${params}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`USGS instantaneous values returned ${res.status}`);

  const series = readSeries(await res.json());
  const tolerance = 2 * 3600000;

  const discharge = nearestReading(series[PARAM.discharge], target, tolerance);
  const height = nearestReading(series[PARAM.gaugeHeight], target, tolerance);
  const tempC = nearestReading(series[PARAM.waterTemp], target, tolerance);
  const turbidity = nearestReading(series[PARAM.turbidity], target, tolerance);

  const flow = await fetchFlowPercentile({
    stationId,
    at: when,
    discharge: discharge ? discharge.value : null,
    fetchImpl,
  });

  return {
    source: 'usgs',
    stationId,
    readingAt: discharge ? new Date(discharge.at).toISOString() : height ? new Date(height.at).toISOString() : null,
    dischargeCfs: discharge ? discharge.value : null,
    gaugeHeightFt: height ? height.value : null,
    waterTempC: tempC ? tempC.value : null,
    waterTempF: tempC ? Math.round(((tempC.value * 9) / 5 + 32) * 10) / 10 : null,
    turbidityFnu: turbidity ? turbidity.value : null,
    dischargeTrend24h: trendOver(series[PARAM.discharge], target, 24),
    dischargeTrend72h: trendOver(series[PARAM.discharge], target, 72),
    heightTrend24h: trendOver(series[PARAM.gaugeHeight], target, 24),
    flow,
  };
}
