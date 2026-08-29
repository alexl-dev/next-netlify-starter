import { buildSnapshot } from '@lib/conditions';

/**
 * One endpoint, one snapshot.
 *
 * This exists only because a browser cannot call USGS and NOAA directly
 * (neither sends permissive CORS headers), and because keeping the fetches on
 * one side makes them cacheable. The native build skips this entirely and
 * calls lib/conditions from the phone — which is why every module it uses is
 * plain JavaScript with no framework imports.
 */
export default async function handler(req, res) {
  const { lat, lon, at, tz, provider, stationId, stationKind } = req.query;

  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime())) {
    return res.status(400).json({ error: 'at must be a valid date' });
  }

  const water = provider && stationId
    ? { id: null, station: { provider, id: stationId, kind: stationKind || 'river' } }
    : null;

  try {
    const snapshot = await buildSnapshot({
      lat: latitude,
      lon: longitude,
      at: when,
      water,
      tzOffsetMinutes: tz === undefined ? undefined : Number(tz),
    });

    // Conditions for a past hour never change; today's are worth a short cache.
    const isHistorical = Date.now() - when.getTime() > 3 * 3600000;
    res.setHeader(
      'Cache-Control',
      isHistorical ? 'public, max-age=86400, s-maxage=604800' : 'public, max-age=300, s-maxage=600'
    );
    return res.status(200).json(snapshot);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Could not build a snapshot' });
  }
}
