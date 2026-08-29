import { useCallback, useEffect, useRef, useState } from 'react';
import { loadLeaflet, TILES } from '@components/leaflet';
import * as app from '@lib/app';

/**
 * Tap-to-place map.
 *
 * Deliberately marker-only: this gets used one-handed, in sun, often with a rod
 * under an arm, and the only gesture that has to work is a single tap somewhere
 * near the right place.
 *
 * Shared by the location picker (where are you standing) and the station finder
 * (where should I search for a gauge), because those are the same interaction
 * asked for two reasons.
 */
export default function PlaceOnMap({
  center,
  placed,
  onPlace,
  height = 320,
  hint = 'Tap where you are. Drag the marker to nudge it. Close enough is close enough — weather and river data do not change over a hundred metres.',
}) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const [failed, setFailed] = useState(false);

  const place = useCallback((lat, lon) => onPlace({ lat, lon }), [onPlace]);

  useEffect(() => {
    let cancelled = false;
    const start = center || app.DEFAULT_CENTER;

    loadLeaflet()
      .then((L) => {
        if (cancelled || !nodeRef.current || mapRef.current) return;
        const map = L.map(nodeRef.current, { attributionControl: true }).setView(
          [start.lat, start.lon],
          // Somewhere we actually know is worth zooming into; a country-scale
          // fallback is not, and lands you somewhere you cannot recognise.
          start.from === 'fallback' ? 7 : 14
        );
        L.tileLayer(TILES.url, TILES.options).addTo(map);
        map.on('click', (event) => place(event.latlng.lat, event.latlng.lng));
        mapRef.current = map;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      // This map comes and goes with every refused fix or reopened search.
      // Leaving Leaflet attached to a detached node leaks a listener each time.
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recentre when the caller moves the map somewhere new — picking a town from
  // a search should fly the map there rather than leaving it where it opened.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center || center.from === 'fallback') return;
    map.setView([center.lat, center.lon], Math.max(map.getZoom(), 11));
  }, [center]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !placed || !window.L) return;
    if (!markerRef.current) {
      markerRef.current = window.L.marker([placed.lat, placed.lon], { draggable: true }).addTo(map);
      markerRef.current.on('dragend', () => {
        const { lat, lng } = markerRef.current.getLatLng();
        place(lat, lng);
      });
    } else {
      markerRef.current.setLatLng([placed.lat, placed.lon]);
    }
  }, [placed, place]);

  if (failed) {
    return (
      <p className="small muted">
        The map could not load — that needs a signal too.
      </p>
    );
  }

  return (
    <>
      <div ref={nodeRef} className="map" style={{ height }} />
      {hint ? <p className="tiny muted">{hint}</p> : null}
    </>
  );
}
