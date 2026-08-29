/**
 * Weather from Open-Meteo. No API key, no sign-up, free for non-commercial use,
 * and — the reason it was chosen over OpenWeather — a deep historical archive.
 * That archive is what makes back-filling work: log a trip with no signal on
 * Saturday, and Tuesday's enrichment pass can still fetch exactly the weather
 * that stood over you at 6:42am Saturday.
 *
 * Data © Open-Meteo, CC BY 4.0.
 */

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

const HOURLY_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'dew_point_2m',
  'precipitation',
  'weather_code',
  'pressure_msl',
  'surface_pressure',
  'cloud_cover',
  'visibility',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
];

const DAY_MS = 86400000;
const HPA_TO_INHG = 0.02952998;

const WEATHER_CODES = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle',
  55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain',
  67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Violent showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm',
  96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export const compassPoint = (deg) =>
  deg == null ? null : COMPASS[Math.round(deg / 22.5) % 16];

/**
 * Open-Meteo returns hourly timestamps as local wall-clock strings without a
 * zone ("2026-08-29T14:00"). Pair each with its UTC offset to compare against
 * a real instant.
 */
const parseSeriesTime = (stamp, utcOffsetSeconds) =>
  Date.parse(`${stamp}:00Z`) - utcOffsetSeconds * 1000;

function buildUrl(lat, lon, at) {
  const now = Date.now();
  const target = at.getTime();
  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: HOURLY_FIELDS.join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
  });

  const daysAgo = Math.floor((now - target) / DAY_MS);

  // The forecast endpoint carries up to 92 days of past hours and is the
  // freshest source, so prefer it. Only fall back to the reanalysis archive
  // for genuinely old trips — it lags real time by several days.
  if (daysAgo > 90) {
    const start = new Date(target - 2 * DAY_MS).toISOString().slice(0, 10);
    const end = new Date(target + DAY_MS).toISOString().slice(0, 10);
    params.set('start_date', start);
    params.set('end_date', end);
    return `${ARCHIVE_URL}?${params}`;
  }

  // Always ask for two extra days behind the target: the 24-hour pressure
  // trend needs hours that precede it.
  params.set('past_days', String(Math.min(92, Math.max(2, daysAgo + 2))));
  params.set('forecast_days', daysAgo > 0 ? '1' : '2');
  return `${FORECAST_URL}?${params}`;
}

/** Index of the hourly sample closest to `at`, or -1 if the series misses it. */
function closestIndex(times, utcOffsetSeconds, at) {
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < times.length; i++) {
    const gap = Math.abs(parseSeriesTime(times[i], utcOffsetSeconds) - at.getTime());
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  // More than 90 minutes away means the series does not really cover this time.
  return bestGap <= 90 * 60000 ? best : -1;
}

/**
 * Barometric trend — the single most predictive number in the whole snapshot,
 * and the one a plain pressure reading cannot give you. Fish respond to a
 * falling glass hours before the front lands.
 */
function pressureTrend(series, utcOffsetSeconds, at, index) {
  const pressures = series.pressure_msl || [];
  const times = series.time || [];
  const current = pressures[index];
  if (current == null) return null;

  const deltaOver = (hours) => {
    const targetMs = at.getTime() - hours * 3600000;
    let best = null;
    let bestGap = Infinity;
    for (let i = 0; i < times.length; i++) {
      if (pressures[i] == null) continue;
      const gap = Math.abs(parseSeriesTime(times[i], utcOffsetSeconds) - targetMs);
      if (gap < bestGap) {
        bestGap = gap;
        best = pressures[i];
      }
    }
    if (best == null || bestGap > 90 * 60000) return null;
    return Math.round((current - best) * 10) / 10;
  };

  const change3h = deltaOver(3);
  const change6h = deltaOver(6);
  const change12h = deltaOver(12);
  const change24h = deltaOver(24);

  // 1 hPa over three hours is the threshold the marine forecasters use to call
  // a barometer "rising" or "falling" rather than steady.
  const basis = change3h != null ? change3h : change6h;
  let direction = 'steady';
  if (basis != null) {
    if (basis >= 1.5) direction = 'rising fast';
    else if (basis >= 0.5) direction = 'rising';
    else if (basis <= -1.5) direction = 'falling fast';
    else if (basis <= -0.5) direction = 'falling';
  }

  return {
    direction,
    change3hHpa: change3h,
    change6hHpa: change6h,
    change12hHpa: change12h,
    change24hHpa: change24h,
    change3hInHg: change3h == null ? null : Math.round(change3h * HPA_TO_INHG * 1000) / 1000,
  };
}

/** Rain totals behind you — what put colour and height in the river. */
function precipitationTotals(series, utcOffsetSeconds, at) {
  const times = series.time || [];
  const precip = series.precipitation || [];
  const sumSince = (hours) => {
    const from = at.getTime() - hours * 3600000;
    let total = 0;
    let seen = false;
    for (let i = 0; i < times.length; i++) {
      const t = parseSeriesTime(times[i], utcOffsetSeconds);
      if (t >= from && t <= at.getTime() && precip[i] != null) {
        total += precip[i];
        seen = true;
      }
    }
    return seen ? Math.round(total * 100) / 100 : null;
  };

  // Hours since the last hour that actually produced measurable rain.
  let lastWet = null;
  for (let i = 0; i < times.length; i++) {
    const t = parseSeriesTime(times[i], utcOffsetSeconds);
    if (t <= at.getTime() && precip[i] > 0.005) lastWet = t;
  }

  return {
    last24hIn: sumSince(24),
    last72hIn: sumSince(72),
    hoursSinceRain: lastWet == null ? null : Math.round((at.getTime() - lastWet) / 3600000),
  };
}

/**
 * Weather at one place and moment, with the derived numbers that make a log
 * entry comparable to every other entry.
 */
export async function fetchWeather({ lat, lon, at, fetchImpl = fetch }) {
  const when = at instanceof Date ? at : new Date(at);
  const url = buildUrl(lat, lon, when);

  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Open-Meteo returned ${res.status}`);
  const data = await res.json();

  const series = data.hourly;
  if (!series || !series.time) throw new Error('Open-Meteo returned no hourly series');

  const offset = data.utc_offset_seconds || 0;
  const i = closestIndex(series.time, offset, when);
  if (i === -1) {
    throw new Error('Open-Meteo has no observation near that time yet');
  }

  const at_ = (field) => (series[field] ? series[field][i] : null);
  const pressureHpa = at_('pressure_msl');
  const code = at_('weather_code');

  return {
    source: 'open-meteo',
    observedAt: new Date(parseSeriesTime(series.time[i], offset)).toISOString(),
    airTempF: at_('temperature_2m'),
    feelsLikeF: at_('apparent_temperature'),
    humidityPct: at_('relative_humidity_2m'),
    dewPointF: at_('dew_point_2m'),
    pressureHpa,
    pressureInHg: pressureHpa == null ? null : Math.round(pressureHpa * HPA_TO_INHG * 100) / 100,
    surfacePressureHpa: at_('surface_pressure'),
    pressure: pressureTrend(series, offset, when, i),
    cloudCoverPct: at_('cloud_cover'),
    visibilityMi: at_('visibility') == null ? null : Math.round(at_('visibility') / 160.934) / 10,
    windMph: at_('wind_speed_10m'),
    windGustMph: at_('wind_gusts_10m'),
    windDirectionDeg: at_('wind_direction_10m'),
    windDirection: compassPoint(at_('wind_direction_10m')),
    conditions: WEATHER_CODES[code] || null,
    weatherCode: code,
    precipitation: precipitationTotals(series, offset, when),
  };
}
