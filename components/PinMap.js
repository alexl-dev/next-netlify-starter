import { useEffect, useRef } from 'react';
import { loadLeaflet, TILES } from '@components/leaflet';

/**
 * Leaflet map with one marker per pin. The loader lives in `leaflet.js`
 * because the manual location picker needs the same script.
 *
 * Markers are draggable on purpose. GPS under a tree canopy or in a steep
 * valley is routinely off by a good cast, and the person standing there knows
 * better than the phone does.
 */

export default function PinMap({ pins = [], center, onMovePin, height = 300 }) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());

  useEffect(() => {
    let cancelled = false;

    loadLeaflet()
      .then((L) => {
        if (cancelled || !nodeRef.current || mapRef.current) return;
        const start = center || (pins[0] ? [pins[0].lat, pins[0].lon] : [44.5, -89.5]);
        const map = L.map(nodeRef.current, { attributionControl: true }).setView(start, 14);
        L.tileLayer(TILES.url, TILES.options).addTo(map);
        mapRef.current = map;
        syncMarkers(L, map);
      })
      .catch(() => {
        /* No map is survivable — the coordinates are already saved. */
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function syncMarkers(L, map) {
    const seen = new Set();

    pins.forEach((pin, i) => {
      seen.add(pin.id);
      let marker = markersRef.current.get(pin.id);
      if (!marker) {
        marker = L.marker([pin.lat, pin.lon], { draggable: Boolean(onMovePin) }).addTo(map);
        if (onMovePin) {
          marker.on('dragend', () => {
            const { lat, lng } = marker.getLatLng();
            onMovePin(pin.id, lat, lng);
          });
        }
        markersRef.current.set(pin.id, marker);
      } else {
        marker.setLatLng([pin.lat, pin.lon]);
      }
      marker.bindPopup(
        `<b>${pin.name || `Spot ${i + 1}`}</b><br>${new Date(pin.droppedAt).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })}`
      );
    });

    for (const [id, marker] of markersRef.current) {
      if (!seen.has(id)) {
        map.removeLayer(marker);
        markersRef.current.delete(id);
      }
    }

    if (pins.length === 1) {
      map.setView([pins[0].lat, pins[0].lon], Math.max(map.getZoom(), 14));
    } else if (pins.length > 1) {
      map.fitBounds(pins.map((p) => [p.lat, p.lon]), { padding: [40, 40], maxZoom: 16 });
    }
  }

  useEffect(() => {
    if (mapRef.current && window.L) syncMarkers(window.L, mapRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins]);

  return <div ref={nodeRef} className="map" style={{ height }} />;
}
