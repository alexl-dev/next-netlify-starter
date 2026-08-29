/**
 * Entities and the analysis built on them.
 *
 * The one non-obvious decision in here: every rate is per hour fished, never a
 * raw count. Counting catches tells you when you go fishing, not when fish
 * bite — you fish weekends and evenings before fronts, so a catch-count chart
 * mostly rediscovers your own calendar. Hours come from the trip clock, blank
 * trips included, which is why ending a trip matters as much as starting one.
 */

export const uid = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export const WATER_KINDS = ['river', 'lake', 'salt'];

export const newWater = ({ name, kind = 'river', station = null, notes = '' }) => ({
  id: uid(),
  name,
  kind,
  station, // { provider: 'usgs'|'noaa', id, name, kind, distanceKm }
  notes,
  createdAt: new Date().toISOString(),
});

export const newTrip = ({ waterId = null, waterName = '', startedAt = new Date() }) => ({
  id: uid(),
  waterId,
  waterName,
  startedAt: new Date(startedAt).toISOString(),
  endedAt: null,
  companions: '',
  notes: '',
  createdAt: new Date().toISOString(),
});

export const newPin = ({ tripId, lat, lon, name = '', accuracyM = null }) => ({
  id: uid(),
  tripId,
  lat,
  lon,
  name,
  accuracyM,
  droppedAt: new Date().toISOString(),
  snapshot: null,
  snapshotStatus: 'pending',
  notes: '',
});

export const newCatch = ({ tripId, pinId = null, species = '', at = new Date() }) => ({
  id: uid(),
  tripId,
  pinId,
  species,
  lengthIn: null,
  weightLb: null,
  method: '',      // fly | spin | bait ...
  gear: '',        // pattern or lure
  presentation: '',
  depthFt: null,
  released: true,
  notes: '',
  photoIds: [],
  at: new Date(at).toISOString(),
  lat: null,
  lon: null,
  snapshot: null,
  snapshotStatus: 'pending',
});

/* --------------------------------------------------------------------------
   Derived values
   -------------------------------------------------------------------------- */

/** Hours fished. An open trip counts up to now so the live display moves. */
export function tripHours(trip, now = Date.now()) {
  if (!trip || !trip.startedAt) return 0;
  const start = Date.parse(trip.startedAt);
  const end = trip.endedAt ? Date.parse(trip.endedAt) : now;
  return Math.max(0, (end - start) / 3600000);
}

/**
 * Minutes spent on each pin, derived from when the next pin was dropped (or
 * the trip ended). No second timer to remember — dropping a pin is the only
 * action, and the durations fall out of the sequence.
 */
export function pinDurations(trip, pins) {
  const ordered = [...pins].sort((a, b) => Date.parse(a.droppedAt) - Date.parse(b.droppedAt));
  const tripEnd = trip.endedAt ? Date.parse(trip.endedAt) : Date.now();
  return ordered.map((pin, i) => {
    const next = ordered[i + 1] ? Date.parse(ordered[i + 1].droppedAt) : tripEnd;
    return { ...pin, minutes: Math.max(0, Math.round((next - Date.parse(pin.droppedAt)) / 60000)) };
  });
}

/* --------------------------------------------------------------------------
   Buckets — the axes every trend chart is sliced on
   -------------------------------------------------------------------------- */

const tempBand = (f) => {
  if (f == null) return null;
  if (f < 45) return 'under 45°F';
  if (f < 55) return '45–55°F';
  if (f < 65) return '55–65°F';
  if (f < 75) return '65–75°F';
  return 'over 75°F';
};

export const BUCKETS = {
  pressure: {
    label: 'Barometric trend',
    of: (s) => (s && s.weather && s.weather.pressure ? s.weather.pressure.direction : null),
    order: ['falling fast', 'falling', 'steady', 'rising', 'rising fast'],
  },
  moon: {
    label: 'Moon phase',
    of: (s) => (s && s.astro ? s.astro.moonPhaseName : null),
    order: ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
      'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'],
  },
  timeOfDay: {
    label: 'Time of day',
    of: (s) => (s && s.astro ? s.astro.timeOfDay : null),
    order: ['first light', 'midday', 'last light', 'night'],
  },
  flow: {
    label: 'Flow vs. normal',
    of: (s) => (s && s.water && s.water.flow ? s.water.flow.label : null),
    order: ['much below normal', 'below normal', 'normal', 'above normal', 'much above normal'],
  },
  waterTemp: {
    label: 'Water temperature',
    of: (s) => tempBand(s && s.water ? s.water.waterTempF : null),
    order: ['under 45°F', '45–55°F', '55–65°F', '65–75°F', 'over 75°F'],
  },
  solunar: {
    label: 'Solunar period',
    of: (s) => (s && s.astro && s.astro.solunar ? s.astro.solunar.activeNow || 'outside' : null),
    order: ['major', 'minor', 'outside'],
  },
};

/**
 * Catch rate by bucket. `trips` supply the hours (the denominator), `catches`
 * the numerator; a trip's bucket comes from the conditions on its first pin,
 * because that is the condition you actually chose to fish in.
 *
 * Every row carries `trips` — the sample size. Never render one of these
 * without showing it.
 */
export function catchRateBy(bucketKey, { trips, pins, catches }) {
  const bucket = BUCKETS[bucketKey];
  if (!bucket) throw new Error(`Unknown bucket ${bucketKey}`);

  const pinsByTrip = new Map();
  for (const pin of pins) {
    if (!pinsByTrip.has(pin.tripId)) pinsByTrip.set(pin.tripId, []);
    pinsByTrip.get(pin.tripId).push(pin);
  }

  const rows = new Map();
  const bump = (key, patch) => {
    const row = rows.get(key) || { bucket: key, trips: 0, hours: 0, catches: 0 };
    row.trips += patch.trips || 0;
    row.hours += patch.hours || 0;
    row.catches += patch.catches || 0;
    rows.set(key, row);
  };

  const tripBucket = new Map();
  for (const trip of trips) {
    if (!trip.endedAt) continue; // an open trip has no final hour count yet
    const tripPins = (pinsByTrip.get(trip.id) || []).sort(
      (a, b) => Date.parse(a.droppedAt) - Date.parse(b.droppedAt)
    );
    const snapshot = tripPins.map((p) => p.snapshot).find(Boolean);
    const key = bucket.of(snapshot);
    if (!key) continue; // unenriched trips sit out rather than distorting a bucket
    tripBucket.set(trip.id, key);
    bump(key, { trips: 1, hours: tripHours(trip) });
  }

  for (const c of catches) {
    // Prefer the catch's own conditions; fall back to its trip's.
    const key = bucket.of(c.snapshot) || tripBucket.get(c.tripId);
    if (!key || !rows.has(key)) continue;
    bump(key, { catches: 1 });
  }

  const order = bucket.order || [];
  return [...rows.values()]
    .map((r) => ({
      ...r,
      hours: Math.round(r.hours * 10) / 10,
      perHour: r.hours > 0 ? Math.round((r.catches / r.hours) * 100) / 100 : null,
    }))
    .sort((a, b) => {
      const ai = order.indexOf(a.bucket);
      const bi = order.indexOf(b.bucket);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
}

/**
 * How much any of this can be trusted yet. Being blunt about a thin log is the
 * feature — a chart drawn from nine trips looks exactly as confident as one
 * drawn from nine hundred, and that is how people fool themselves.
 */
export function confidence(rows) {
  const trips = rows.reduce((n, r) => n + r.trips, 0);
  const populated = rows.filter((r) => r.trips >= 3).length;
  if (trips < 10) {
    return { level: 'none', trips, message: 'Too few trips to compare anything yet. Keep logging.' };
  }
  if (trips < 30 || populated < 2) {
    return {
      level: 'weak',
      trips,
      message: `${trips} trips logged. Treat this as a hint, not a finding — one good afternoon still moves every bar.`,
    };
  }
  if (trips < 80) {
    return {
      level: 'suggestive',
      trips,
      message: `${trips} trips. Differences smaller than about 2× are still noise at this sample size.`,
    };
  }
  return {
    level: 'usable',
    trips,
    message: `${trips} trips. Large, consistent gaps here are probably real.`,
  };
}

/* --------------------------------------------------------------------------
   Days like today
   -------------------------------------------------------------------------- */

const near = (a, b, tolerance) =>
  a == null || b == null ? 0 : Math.max(0, 1 - Math.abs(a - b) / tolerance);

/**
 * Find past trips whose conditions resemble a target snapshot — tomorrow's
 * forecast, usually. This is the honest version of a trends dashboard: it
 * makes no claim about causation, it just shows you what happened the last
 * times it looked like this. It is useful at a dozen trips, where a chart is not.
 */
export function daysLikeToday(target, { trips, pins, catches }, limit = 5) {
  if (!target) return [];

  const pinsByTrip = new Map();
  for (const pin of pins) {
    if (!pinsByTrip.has(pin.tripId)) pinsByTrip.set(pin.tripId, []);
    pinsByTrip.get(pin.tripId).push(pin);
  }
  const catchCount = new Map();
  for (const c of catches) catchCount.set(c.tripId, (catchCount.get(c.tripId) || 0) + 1);

  const tw = target.weather || {};
  const ta = target.astro || {};
  const twater = target.water || {};

  return trips
    .map((trip) => {
      const snapshot = (pinsByTrip.get(trip.id) || [])
        .map((p) => p.snapshot)
        .find(Boolean);
      if (!snapshot) return null;

      const w = snapshot.weather || {};
      const a = snapshot.astro || {};
      const water = snapshot.water || {};

      const parts = [
        { weight: 3, score: w.pressure && tw.pressure && w.pressure.direction === tw.pressure.direction ? 1 : 0 },
        { weight: 2, score: near(w.pressureHpa, tw.pressureHpa, 20) },
        { weight: 2, score: near(a.moonIlluminationPct, ta.moonIlluminationPct, 50) },
        { weight: 2, score: near(w.airTempF, tw.airTempF, 25) },
        { weight: 1, score: a.timeOfDay === ta.timeOfDay ? 1 : 0 },
        { weight: 3, score: near(water.flow && water.flow.pctOfMedian, twater.flow && twater.flow.pctOfMedian, 100) },
        { weight: 2, score: near(water.waterTempF, twater.waterTempF, 15) },
      ];

      const applicable = parts.filter((p) => p.score > 0 || p.weight <= 2);
      const total = applicable.reduce((n, p) => n + p.weight, 0);
      const score = total === 0 ? 0 : applicable.reduce((n, p) => n + p.weight * p.score, 0) / total;

      const hours = tripHours(trip);
      const fish = catchCount.get(trip.id) || 0;
      return {
        trip,
        snapshot,
        similarity: Math.round(score * 100),
        catches: fish,
        hours: Math.round(hours * 10) / 10,
        perHour: hours > 0 ? Math.round((fish / hours) * 100) / 100 : null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}
