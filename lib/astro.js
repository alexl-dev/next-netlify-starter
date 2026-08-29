/**
 * Sun, moon and solunar math. Pure arithmetic from latitude, longitude and time
 * — no network, no API key. This is the one condition source that works at the
 * bottom of a canyon with no signal, so it must stay dependency-free and
 * framework-free: it is imported unchanged by the future native app.
 *
 * Algorithms follow the standard low-precision astronomical formulae
 * (Meeus, "Astronomical Algorithms", as popularised by SunCalc).
 */

const RAD = Math.PI / 180;
const DAY_MS = 1000 * 60 * 60 * 24;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = 23.4397 * RAD;

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
const toDays = (date) => toJulian(date) - J2000;

const rightAscension = (l, b) =>
  Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l, b) =>
  Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
const azimuth = (H, phi, dec) =>
  Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
const altitude = (H, phi, dec) =>
  Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
const siderealTime = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;

const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M) => {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = RAD * 102.9372;
  return M + C + P + Math.PI;
};

function sunCoords(d) {
  const M = solarMeanAnomaly(d);
  const L = eclipticLongitude(M);
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d); // ecliptic longitude
  const M = RAD * (134.963 + 13.064993 * d); // mean anomaly
  const F = RAD * (93.272 + 13.229350 * d); // mean distance
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  const dt = 385001 - 20905 * Math.cos(M); // km to the moon
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: dt };
}

/** Sun position (altitude/azimuth in radians) at a moment and place. */
export function sunPosition(date, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = sunCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  return { azimuth: azimuth(H, phi, c.dec), altitude: altitude(H, phi, c.dec) };
}

/** Moon position. `altitude` is corrected for refraction near the horizon. */
export function moonPosition(date, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const c = moonCoords(d);
  const H = siderealTime(d, lw) - c.ra;
  let h = altitude(H, phi, c.dec);
  h += RAD * 0.017 / Math.tan(h + RAD * 10.26 / (h / RAD + 5.10)); // refraction
  return { azimuth: azimuth(H, phi, c.dec), altitude: h, distance: c.dist };
}

const PHASE_NAMES = [
  'New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
  'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent',
];

/**
 * Moon illumination.
 * `phase` runs 0 (new) → 0.5 (full) → 1 (new again).
 * `fraction` is the illuminated fraction of the disc, 0–1.
 */
export function moonIllumination(date) {
  const d = toDays(date);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sdist = 149598000; // km to the sun

  const phi = Math.acos(
    Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra)
  );
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra)
  );
  const phase = 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI;

  // Eight named phases, each a 1/8 slice centred on its exact moment.
  const index = Math.round(phase * 8) % 8;
  const daysIntoCycle = phase * 29.530588853;

  return {
    phase,
    fraction: (1 + Math.cos(inc)) / 2,
    name: PHASE_NAMES[index],
    ageDays: daysIntoCycle,
    daysFromNew: Math.min(daysIntoCycle, 29.530588853 - daysIntoCycle),
    daysFromFull: Math.abs(daysIntoCycle - 14.765294427),
  };
}

/* --------------------------------------------------------------------------
   Rise / set times
   -------------------------------------------------------------------------- */

const J0 = 0.0009;
const julianCycle = (d, lw) => Math.round(d - J0 - lw / (2 * Math.PI));
const approxTransit = (Ht, lw, n) => J0 + (Ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds, M, L) =>
  J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h, phi, d) =>
  Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(d)) / (Math.cos(phi) * Math.cos(d)));

/**
 * Sunrise, sunset, and the twilight boundaries anglers actually care about.
 * Any value can be null inside the arctic/antarctic circles.
 */
export function sunTimes(date, lat, lon) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L, 0);
  const Jnoon = solarTransitJ(ds, M, L);

  const at = (angle) => {
    const w = hourAngle(angle * RAD, phi, dec);
    if (Number.isNaN(w)) return { rise: null, set: null };
    const a = approxTransit(w, lw, n);
    const Jset = solarTransitJ(a, M, L);
    return { rise: fromJulian(Jnoon * 2 - Jset), set: fromJulian(Jset) };
  };

  const official = at(-0.833);
  const civil = at(-6);
  const dayLengthMs =
    official.rise && official.set ? official.set - official.rise : null;

  return {
    solarNoon: fromJulian(Jnoon),
    sunrise: official.rise,
    sunset: official.set,
    dawn: civil.rise,
    dusk: civil.set,
    dayLengthHours: dayLengthMs == null ? null : dayLengthMs / 3600000,
  };
}

/**
 * Scan the moon's altitude across a local day at fine resolution. One pass
 * yields everything solunar tables need: rise, set, transit (moon overhead)
 * and underfoot (moon on the far side of the earth).
 */
function scanMoonDay(date, lat, lon, tzOffsetMinutes) {
  // "Today" must mean the angler's day, not the server's. tzOffsetMinutes uses
  // the same sign convention as Date#getTimezoneOffset (minutes to add to local
  // time to reach UTC), so a phone in CDT sends 300.
  const offset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : date.getTimezoneOffset();
  const localMs = date.getTime() - offset * 60000;
  const localDayStart = Math.floor(localMs / DAY_MS) * DAY_MS;
  const start = new Date(localDayStart + offset * 60000);
  const stepMinutes = 10;
  const steps = (24 * 60) / stepMinutes;

  const samples = [];
  for (let i = 0; i <= steps; i++) {
    const t = new Date(start.getTime() + i * stepMinutes * 60000);
    samples.push({ t, alt: moonPosition(t, lat, lon).altitude });
  }

  let rise = null;
  let set = null;
  let transit = samples[0];
  let underfoot = samples[0];

  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev.alt < 0 && cur.alt >= 0 && !rise) rise = interpolateCrossing(prev, cur);
    if (prev.alt >= 0 && cur.alt < 0 && !set) set = interpolateCrossing(prev, cur);
    if (cur.alt > transit.alt) transit = cur;
    if (cur.alt < underfoot.alt) underfoot = cur;
  }

  return {
    rise,
    set,
    transit: transit.t,
    underfoot: underfoot.t,
    alwaysUp: rise === null && set === null && samples[0].alt > 0,
    alwaysDown: rise === null && set === null && samples[0].alt <= 0,
  };
}

function interpolateCrossing(a, b) {
  const ratio = Math.abs(a.alt) / (Math.abs(a.alt) + Math.abs(b.alt));
  return new Date(a.t.getTime() + ratio * (b.t.getTime() - a.t.getTime()));
}

/** Moonrise and moonset for the angler's local day containing `date`. */
export function moonTimes(date, lat, lon, tzOffsetMinutes) {
  const s = scanMoonDay(date, lat, lon, tzOffsetMinutes);
  return { rise: s.rise, set: s.set, alwaysUp: s.alwaysUp, alwaysDown: s.alwaysDown };
}

const window = (center, minutes) =>
  center
    ? {
        start: new Date(center.getTime() - minutes * 30000),
        peak: center,
        end: new Date(center.getTime() + minutes * 30000),
      }
    : null;

/**
 * Solunar periods for the day. The convention every solunar table uses:
 * major periods are the two hours around moon transit (overhead) and moon
 * underfoot; minor periods are the hour around moonrise and moonset.
 *
 * Treat these as a well-known folk model that most fishing apps display —
 * not as settled science. Logging them is what lets you check them against
 * your own catch rate later, which is the entire point.
 */
export function solunarPeriods(date, lat, lon, tzOffsetMinutes) {
  const s = scanMoonDay(date, lat, lon, tzOffsetMinutes);
  return {
    major: [window(s.transit, 120), window(s.underfoot, 120)].filter(Boolean),
    minor: [window(s.rise, 60), window(s.set, 60)].filter(Boolean),
  };
}

const within = (period, at) => period && at >= period.start && at <= period.end;

/** Everything sky-clock, for one moment and place. */
export function astroSnapshot(at, lat, lon, tzOffsetMinutes) {
  const date = at instanceof Date ? at : new Date(at);
  const sun = sunTimes(date, lat, lon);
  const moon = moonTimes(date, lat, lon, tzOffsetMinutes);
  const illum = moonIllumination(date);
  const solunar = solunarPeriods(date, lat, lon, tzOffsetMinutes);

  const activePeriod = solunar.major.some((p) => within(p, date))
    ? 'major'
    : solunar.minor.some((p) => within(p, date))
      ? 'minor'
      : null;

  return {
    sunrise: sun.sunrise ? sun.sunrise.toISOString() : null,
    sunset: sun.sunset ? sun.sunset.toISOString() : null,
    dawn: sun.dawn ? sun.dawn.toISOString() : null,
    dusk: sun.dusk ? sun.dusk.toISOString() : null,
    solarNoon: sun.solarNoon.toISOString(),
    dayLengthHours: sun.dayLengthHours,
    sunAltitudeDeg: sunPosition(date, lat, lon).altitude / RAD,
    moonrise: moon.rise ? moon.rise.toISOString() : null,
    moonset: moon.set ? moon.set.toISOString() : null,
    moonPhase: illum.phase,
    moonPhaseName: illum.name,
    moonIlluminationPct: Math.round(illum.fraction * 1000) / 10,
    moonAgeDays: Math.round(illum.ageDays * 10) / 10,
    daysFromNewMoon: Math.round(illum.daysFromNew * 10) / 10,
    daysFromFullMoon: Math.round(illum.daysFromFull * 10) / 10,
    moonAltitudeDeg: moonPosition(date, lat, lon).altitude / RAD,
    solunar: {
      major: solunar.major.map(serializePeriod),
      minor: solunar.minor.map(serializePeriod),
      activeNow: activePeriod,
    },
    timeOfDay: describeTimeOfDay(date, sun),
  };
}

const serializePeriod = (p) => ({
  start: p.start.toISOString(),
  peak: p.peak.toISOString(),
  end: p.end.toISOString(),
});

/**
 * Buckets that survive being compared across seasons — "first light" means the
 * same thing in June and October, where "6am" does not.
 */
function describeTimeOfDay(date, sun) {
  if (!sun.sunrise || !sun.sunset) return 'unknown';
  const t = date.getTime();
  const rise = sun.sunrise.getTime();
  const set = sun.sunset.getTime();
  const hour = 3600000;

  if (t < rise - hour) return 'night';
  if (t < rise + hour) return 'first light';
  if (t < set - 2 * hour) return 'midday';
  if (t < set + hour) return 'last light';
  return 'night';
}
