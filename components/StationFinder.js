import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PlaceOnMap from '@components/PlaceOnMap';
import Combobox from '@components/Combobox';
import * as app from '@lib/app';

/**
 * Finding the gauge for a water.
 *
 * The first version of this could only search from wherever you were standing,
 * which is the one situation you are usually *not* in when setting a water up —
 * you add rivers at the kitchen table, and you plan trips to water you have
 * never seen. So there are four ways in, in the order people actually reach
 * for them:
 *
 *   1. A station already bound to another water. Most anglers rebind the same
 *      few gauges, and a second stretch of a river wants the first stretch's
 *      gauge. One tap, no search.
 *   2. Type a town. "Racine, WI" — the way every other site on earth works.
 *   3. Point at a map, for water you cannot name but can find.
 *   4. Use my location, for when you are standing in it.
 *
 * Whichever route, the result is the same: a point, then ranked candidates,
 * then a person choosing. Never an auto-pick — the nearest gauge in a straight
 * line is frequently on the wrong tributary.
 */

const km = (n) => (n == null ? '' : `${n} km away`);

export default function StationFinder({ water, waters, onBind, onCancel }) {
  const [origin, setOrigin] = useState(null);
  const [originLabel, setOriginLabel] = useState('');
  const [stations, setStations] = useState(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState([]);
  const [searching, setSearching] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [placed, setPlaced] = useState(null);
  const searchSeq = useRef(0);

  const previous = useMemo(
    () => app.stationsInUse({ waters, kind: water.kind, excludeWaterId: water.id }),
    [waters, water.kind, water.id]
  );

  /** Search for gauges around a point, whatever produced that point. */
  const searchFrom = useCallback(
    async (point, label) => {
      setBusy(true);
      setOrigin(point);
      setOriginLabel(label);
      setStatus('Looking for gauges…');
      setStations(null);
      try {
        const found = await app.findStations({
          lat: point.lat,
          lon: point.lon,
          kind: water.kind,
        });
        setStations(found);
        setStatus(
          found.length
            ? 'Pick the one that is actually on your water — the closest is not always the right one.'
            : 'No gauges within range of there. Small creeks often have none, and the rest of the log still works without one.'
        );
      } catch (err) {
        setStatus(err.message);
      } finally {
        setBusy(false);
      }
    },
    [water.kind]
  );

  // Debounced place search, so typing does not fire a request per keystroke.
  // The sequence guard drops responses that arrive out of order — a slow
  // "Rac" must never overwrite the results for "Racine".
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setPlaces([]);
      setSearching(false);
      return undefined;
    }

    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      app
        .findPlaces(trimmed)
        .then((found) => {
          if (seq !== searchSeq.current) return;
          setPlaces(found);
          setSearching(false);
        })
        .catch(() => {
          if (seq !== searchSeq.current) return;
          setPlaces([]);
          setSearching(false);
        });
    }, 350);

    return () => clearTimeout(timer);
  }, [query]);

  async function handleUseMyLocation() {
    setBusy(true);
    setStatus('Finding your position…');
    try {
      const pos = await app.currentPosition();
      await searchFrom({ lat: pos.lat, lon: pos.lon }, 'where you are now');
    } catch (err) {
      // No picker here — this screen already *is* the fallback, with three
      // other ways to name a point.
      setStatus(`${err.message} Try typing a town, or use the map.`);
      setBusy(false);
    }
  }

  const mapCenter = origin
    ? { lat: origin.lat, lon: origin.lon, from: 'search' }
    : app.initialCenter({ lastPosition: app.lastKnownPosition(), water });

  return (
    <div className="card">
      <span className="label">Find a gauge for {water.name}</span>

      {previous.length ? (
        <div style={{ marginTop: 12 }}>
          <span className="label">Stations you already use</span>
          <div className="list" style={{ marginTop: 6 }}>
            {previous.map((station) => (
              <button
                type="button"
                className="item"
                key={station.key}
                style={{ textAlign: 'left', minHeight: 0 }}
                onClick={() => onBind(station)}
              >
                <div className="grow">
                  <b>{station.name || station.id}</b>
                  <span className="sub">
                    on {station.usedBy.join(', ')} ·{' '}
                    {station.provider === 'usgs' ? 'USGS' : 'NOAA'} {station.id}
                  </span>
                </div>
                <span className="muted">›</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="stack" style={{ marginTop: 16 }}>
        <Combobox
          label="Search by town"
          value={query}
          onChange={setQuery}
          onSelect={(option) => {
            const place = option.place;
            setPlaces([]);
            searchFrom({ lat: place.lat, lon: place.lon }, place.name);
          }}
          options={places.map((place) => ({
            id: place.id,
            // The field keeps the region, so it is obvious afterwards which
            // of the four Racines the gauges below belong to.
            value: `${place.name}${place.admin1 ? `, ${place.admin1}` : ''}`,
            label: place.label,
            detail: place.detail,
            place,
          }))}
          loading={searching}
          placeholder="Racine, WI"
          autoCapitalize="words"
          emptyMessage={
            query.trim().length >= 2
              ? 'No town by that name. Try adding the state — “Racine, WI” — or use the map.'
              : null
          }
          hint="Gauges are ranked by distance from the town you pick."
        />

        <div className="row">
          <button type="button" onClick={handleUseMyLocation} disabled={busy}>
            Use my location
          </button>
          <button type="button" onClick={() => setMapOpen((open) => !open)}>
            {mapOpen ? 'Hide the map' : 'Search on a map'}
          </button>
        </div>

        {mapOpen ? (
          <>
            <PlaceOnMap
              center={mapCenter}
              placed={placed}
              onPlace={setPlaced}
              hint="Tap anywhere near the water. Gauges within about 50 km of that point are listed."
            />
            <button
              type="button"
              className="primary wide"
              disabled={!placed || busy}
              onClick={() => searchFrom(placed, 'the spot you tapped')}
            >
              {placed ? 'Search here' : 'Tap the map to choose a spot'}
            </button>
          </>
        ) : null}
      </div>

      {status ? <p className="small muted" style={{ marginTop: 12 }}>{status}</p> : null}

      {stations && stations.length ? (
        <div style={{ marginTop: 12 }}>
          <span className="label">
            Gauges near {originLabel || 'there'}
          </span>
          <div className="list" style={{ marginTop: 6 }}>
            {stations.map((station) => (
              <button
                type="button"
                className="item"
                key={station.id}
                style={{ textAlign: 'left', minHeight: 0 }}
                onClick={() => onBind(station)}
              >
                <div className="grow">
                  <b>{station.name}</b>
                  <span className="sub">
                    {km(station.distanceKm)} · {station.provider === 'usgs' ? 'USGS' : 'NOAA'}{' '}
                    {station.id}
                    {station.drainageAreaSqMi
                      ? ` · drains ${Math.round(station.drainageAreaSqMi)} sq mi`
                      : ''}
                  </span>
                </div>
                <span className="muted">›</span>
              </button>
            ))}
          </div>
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Drainage area is the useful tiebreaker: a gauge on the main stem drains far more than
            one on a feeder creek, so it tells you which is really your river.
          </p>
        </div>
      ) : null}

      <button type="button" className="quiet" onClick={onCancel} style={{ marginTop: 10 }}>
        Done
      </button>
    </div>
  );
}
