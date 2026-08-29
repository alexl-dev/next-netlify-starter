/**
 * Leaflet, fetched from a CDN at runtime rather than bundled.
 *
 * The map is the one piece of this prototype that does not survive into the
 * native build (which uses MapKit), so it earns no place in the dependency
 * tree. Shared by every component that shows a map, because two copies of this
 * script-injection dance is one copy too many.
 */

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

/** OpenStreetMap raster tiles — no key, which is the whole point. */
export const TILES = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  options: { maxZoom: 19, attribution: '&copy; OpenStreetMap' },
};

export function loadLeaflet() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.L) return Promise.resolve(window.L);

  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);
  }

  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${LEAFLET_JS}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.L));
      existing.addEventListener('error', reject);
      return;
    }
    const script = document.createElement('script');
    script.src = LEAFLET_JS;
    script.onload = () => resolve(window.L);
    script.onerror = () => reject(new Error('Leaflet failed to load'));
    document.head.appendChild(script);
  });
}
