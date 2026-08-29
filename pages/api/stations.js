import { searchStations } from '@lib/sources/usgs';
import { searchTideStations } from '@lib/sources/noaa';

/**
 * Candidate gauges near a point, for binding a station to a water.
 *
 * Deliberately a list and not a pick: the closest gauge in a straight line is
 * often on the wrong tributary, or above the confluence that feeds the run you
 * fish. A person looks at the names and chooses once per water.
 */
export default async function handler(req, res) {
  const { lat, lon, kind = 'river' } = req.query;

  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'lat and lon are required' });
  }

  try {
    if (kind === 'river') {
      const stations = await searchStations({ lat: latitude, lon: longitude, radiusKm: 50 });
      return res.status(200).json({
        stations: stations.slice(0, 12).map((s) => ({ ...s, provider: 'usgs', kind: 'river' })),
      });
    }

    const stations = await searchTideStations({ lat: latitude, lon: longitude, radiusKm: 80 });
    return res.status(200).json({
      stations: stations.map((s) => ({ ...s, provider: 'noaa', kind: kind === 'salt' ? 'salt' : 'lake' })),
    });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Station search failed' });
  }
}
