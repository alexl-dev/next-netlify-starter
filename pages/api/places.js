import { searchPlaces } from '@lib/sources/geocode';

/**
 * Place search, proxied for the same reason as the other sources: one place to
 * cache, and the native build drops it and calls lib/sources/geocode directly.
 */
export default async function handler(req, res) {
  const { q, count } = req.query;
  if (!q || String(q).trim().length < 2) {
    return res.status(200).json({ places: [] });
  }

  try {
    const places = await searchPlaces({
      query: String(q),
      count: Math.min(20, Number(count) || 8),
    });
    // Town coordinates do not move. Cache them hard.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=604800');
    return res.status(200).json({ places });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Place search failed' });
  }
}
