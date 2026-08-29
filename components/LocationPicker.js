import { useCallback, useEffect, useRef, useState } from 'react';
import { loadLeaflet, TILES } from '@components/leaflet';
import * as store from '@lib/store';
import * as app from '@lib/app';

/**
 * What to do when the phone will not say where you are.
 *
 * Permission denied, no fix under a bluff, a browser with location switched
 * off at the OS — all of it used to dead-end: no pin, no gauge search, and a
 * fish saved with null coordinates that could never be enriched. So instead of
 * an error message this offers the three things a person can actually answer
 * with: try again, pick a spot you have already fished, or point at the map.
 *
 * Whatever comes back is labelled with where it came from, because a spot
 * pointed at is not a spot measured and the log should not pretend otherwise.
 */

const coord = (n) => (Number.isFinite(n) ? n.toFixed(4) : '—');

export default function LocationPicker({
  message,
  retryable = false,
  options = [],
  center,
  busy = false,
  onPick,
  onRetry,
  onCancel,
}) {
  const [mapOpen, setMapOpen] = useState(options.length === 0);
  const [placed, setPlaced] = useState(null);

  return (
    <div className="card">
      <span className="label">Where are you?</span>
      <p className="small" style={{ marginTop: 6 }}>{message}</p>

      <div className="stack" style={{ marginTop: 12 }}>
        {retryable ? (
          <button type="button" className="wide" onClick={onRetry} disabled={busy}>
            {busy ? 'Trying again…' : 'Try the phone again'}
          </button>
        ) : null}

        {options.length ? (
          <>
            <span className="label">Somewhere you have been</span>
            <div className="list">
              {options.map((option) => (
                <button
                  type="button"
                  className="item"
                  key={option.id}
                  style={{ textAlign: 'left', minHeight: 0 }}
                  onClick={() =>
                    onPick({
                      lat: option.lat,
                      lon: option.lon,
                      accuracyM: option.accuracyM,
                      source: option.source,
                    })
                  }
                >
                  <div className="grow">
                    <b>{option.label}</b>
                    <span className="sub">
                      {option.detail}
                      {option.detail ? ' · ' : ''}
                      {coord(option.lat)}, {coord(option.lon)}
                    </span>
                  </div>
                  <span className="muted">›</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {mapOpen ? (
          <PlaceOnMap center={center} placed={placed} onPlace={setPlaced} />
        ) : (
          <button type="button" className="wide" onClick={() => setMapOpen(true)}>
            Show me a map instead
          </button>
        )}

        {mapOpen ? (
          <button
            type="button"
            className="primary wide"
            disabled={!placed}
            onClick={() =>
              onPick({
                lat: placed.lat,
                lon: placed.lon,
                accuracyM: null,
                source: app.POSITION_SOURCES.MAP,
              })
            }
          >
            {placed ? `Use ${coord(placed.lat)}, ${coord(placed.lon)}` : 'Tap the map to place it'}
          </button>
        ) : null}

        <button type="button" className="quiet" onClick={onCancel}>
          Not now
        </button>
      </div>

      <p className="tiny muted" style={{ marginTop: 10 }}>
        A spot you place by hand is saved as an approximate position — marked as
        placed, not measured — so it never gets read later as a GPS fix.
      </p>
    </div>
  );
}

/**
 * Tap-to-place map. Deliberately tall and marker-only: this gets used
 * one-handed, in sun, often with a rod under an arm, and the only gesture that
 * has to work is a single tap somewhere near where you are standing.
 */
function PlaceOnMap({ center, placed, onPlace, height = 320 }) {
  const nodeRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const [failed, setFailed] = useState(false);

  const place = useCallback(
    (lat, lon) => onPlace({ lat, lon }),
    [onPlace]
  );

  useEffect(() => {
    let cancelled = false;
    const start = center || app.DEFAULT_CENTER;

    loadLeaflet()
      .then((L) => {
        if (cancelled || !nodeRef.current || mapRef.current) return;
        const map = L.map(nodeRef.current, { attributionControl: true }).setView(
          [start.lat, start.lon],
          // A fix we already had is worth zooming into; a country-scale
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        The map could not load — that needs a signal too. Pick a spot you have fished before, or
        try the phone again once you are back in coverage.
      </p>
    );
  }

  return (
    <>
      <div ref={nodeRef} className="map" style={{ height }} />
      <p className="tiny muted">
        Tap where you are. Drag the marker to nudge it. Close enough is close enough — weather and
        river data do not change over a hundred metres.
      </p>
    </>
  );
}

/**
 * The controller the screens use: ask the device, and if it refuses, hand the
 * person the picker and wait for their answer.
 *
 * `resolvePosition()` resolves a `{ lat, lon, accuracyM, source }` or null if
 * they decline — a null means "carry on without a position", never an
 * exception, because every caller has something sensible to do with it.
 */
export function useLocationFallback() {
  const [request, setRequest] = useState(null);
  const [busy, setBusy] = useState(false);
  const settleRef = useRef(null);

  const settle = useCallback((position) => {
    const resolve = settleRef.current;
    settleRef.current = null;
    setRequest(null);
    setBusy(false);
    if (resolve) resolve(position);
  }, []);

  const ask = useCallback(async (failure, water) => {
    // Reading the log for options is IndexedDB, not the network — the picker
    // has to work in exactly the dead zone that broke the fix in the first place.
    const [pins, waters, trips] = await Promise.all([
      store.all('pins'), store.all('waters'), store.all('trips'),
    ]);
    const options = app.positionOptions({ pins, waters, trips });
    const center = app.initialCenter({
      lastPosition: app.lastKnownPosition(),
      water,
      recentPins: pins,
    });
    return new Promise((resolve) => {
      settleRef.current = resolve;
      setRequest({ ...failure, options, center });
    });
  }, []);

  const resolvePosition = useCallback(
    async ({ water = null, timeout } = {}) => {
      try {
        return await app.currentPosition(timeout ? { timeout } : undefined);
      } catch (err) {
        return ask(app.classifyLocationError(err), water);
      }
    },
    [ask]
  );

  const retry = useCallback(async () => {
    setBusy(true);
    try {
      const fix = await app.currentPosition();
      settle(fix);
    } catch (err) {
      const failure = app.classifyLocationError(err);
      setBusy(false);
      setRequest((prev) => (prev ? { ...prev, ...failure } : prev));
    }
  }, [settle]);

  const pickerProps = request
    ? { ...request, busy, onPick: settle, onRetry: retry, onCancel: () => settle(null) }
    : null;

  return { resolvePosition, pickerProps };
}
