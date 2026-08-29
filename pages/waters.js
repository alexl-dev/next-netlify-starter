import { useCallback, useEffect, useState } from 'react';
import Chrome from '@components/Chrome';
import LocationPicker, { useLocationFallback } from '@components/LocationPicker';
import * as store from '@lib/store';
import * as app from '@lib/app';
import { WATER_KINDS } from '@lib/model';

const KIND_LABEL = {
  river: 'River or stream — USGS gauge (flow, height, water temp)',
  lake: 'Lake — NOAA water level where one is gauged',
  salt: 'Salt water — NOAA tide station',
};

export default function Waters() {
  const [waters, setWaters] = useState([]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('river');
  const [candidates, setCandidates] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [status, setStatus] = useState('');
  const { resolvePosition, pickerProps } = useLocationFallback();

  const refresh = useCallback(async () => {
    setWaters(await store.all('waters'));
  }, []);

  useEffect(() => {
    refresh().catch((err) => setStatus(err.message));
  }, [refresh]);

  async function handleAdd(event) {
    event.preventDefault();
    if (!name.trim()) return;
    await app.addWater({ name: name.trim(), kind });
    setName('');
    await refresh();
  }

  /**
   * Station search runs from wherever you are standing, which is why this is a
   * first-run flow rather than a preloaded list — it has to work on a river you
   * have never fished before, three states from home.
   */
  async function handleFindStations(water) {
    setBusyId(water.id);
    setStatus('Finding your position…');
    try {
      // The search is a bounding box around a point — and any point on the
      // right stretch of river will do, so a refused fix opens the picker
      // rather than leaving the water permanently ungauged.
      const pos = await resolvePosition({ water });
      if (!pos) {
        setStatus('No spot chosen, so there was nowhere to search from.');
        return;
      }
      setStatus('Searching for gauges nearby…');
      const stations = await app.findStations({ lat: pos.lat, lon: pos.lon, kind: water.kind });
      setCandidates((prev) => ({ ...prev, [water.id]: stations }));
      setStatus(
        stations.length
          ? 'Pick the one that is actually on your water — the closest is not always the right one.'
          : 'No gauges within range. Small creeks often have none; the rest of the log still works.'
      );
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function handleBind(waterId, station) {
    await app.bindStation(waterId, {
      provider: station.provider,
      id: station.id,
      name: station.name,
      kind: station.kind,
      distanceKm: station.distanceKm,
    });
    setCandidates((prev) => ({ ...prev, [waterId]: null }));
    setStatus('Bound. Every trip on this water will carry that station from now on.');
    await refresh();
  }

  return (
    <Chrome title="Waters">
      <div className="banner info">
        A water is bound to its gauge once, by hand. There is no reliable “nearest gauge” lookup —
        the closest one in a straight line is often on a different tributary, or above the
        confluence that feeds the run you actually fish.
      </div>

      <form className="card" onSubmit={handleAdd}>
        <h2>Add a water</h2>
        <div className="stack">
          <label className="field">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Root River — Lincoln Park stretch"
              autoComplete="off"
            />
          </label>
          <label className="field">
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {WATER_KINDS.map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k]}</option>
              ))}
            </select>
          </label>
          <button className="primary wide" type="submit" disabled={!name.trim()}>
            Add water
          </button>
        </div>
      </form>

      {status ? <p className="small muted">{status}</p> : null}

      {pickerProps ? <LocationPicker {...pickerProps} /> : null}

      {waters.map((water) => (
        <div className="card" key={water.id}>
          <h2 style={{ marginBottom: 4 }}>{water.name}</h2>
          <p className="tiny muted" style={{ marginBottom: 10 }}>{water.kind}</p>

          {water.station ? (
            <p className="small">
              <span className="pill ok">bound</span>{' '}
              {water.station.name || water.station.id}{' '}
              <span className="muted">
                · {water.station.provider === 'usgs' ? 'USGS' : 'NOAA'} {water.station.id}
                {water.station.distanceKm != null ? ` · ${water.station.distanceKm} km away` : ''}
              </span>
            </p>
          ) : (
            <p className="small muted">
              No station bound. Trips here will still record weather and moon, just no water data.
            </p>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => handleFindStations(water)} disabled={busyId === water.id}>
              {water.station ? 'Change station' : 'Find a station near me'}
            </button>
          </div>

          {candidates[water.id] && candidates[water.id].length ? (
            <div className="list" style={{ marginTop: 12 }}>
              {candidates[water.id].map((station) => (
                <button
                  className="item"
                  key={station.id}
                  onClick={() => handleBind(water.id, station)}
                  style={{ textAlign: 'left', minHeight: 0 }}
                >
                  <div className="grow">
                    <b>{station.name}</b>
                    <span className="sub">
                      {station.distanceKm} km away · {station.provider === 'usgs' ? 'USGS' : 'NOAA'}{' '}
                      {station.id}
                      {station.drainageAreaSqMi
                        ? ` · drains ${Math.round(station.drainageAreaSqMi)} sq mi`
                        : ''}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      {!waters.length ? (
        <p className="muted small">No waters yet. Add the one you fish most.</p>
      ) : null}
    </Chrome>
  );
}
