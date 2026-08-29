import { useCallback, useEffect, useState } from 'react';
import Chrome from '@components/Chrome';
import StationFinder from '@components/StationFinder';
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
  const [finding, setFinding] = useState(null);
  const [status, setStatus] = useState('');

  const refresh = useCallback(async () => {
    setWaters(await store.all('waters'));
  }, []);

  useEffect(() => {
    refresh().catch((err) => setStatus(err.message));
  }, [refresh]);

  async function handleAdd(event) {
    event.preventDefault();
    if (!name.trim()) return;
    const water = await app.addWater({ name: name.trim(), kind });
    setName('');
    await refresh();
    // Straight into the finder: a water without a gauge is the thing this
    // screen exists to fix, and making someone hunt for a second button to
    // finish the job they just started is how waters end up unbound.
    setFinding(water);
  }

  async function handleBind(waterId, station) {
    await app.bindStation(waterId, {
      provider: station.provider,
      id: station.id,
      name: station.name,
      kind: station.kind,
      distanceKm: station.distanceKm == null ? null : station.distanceKm,
    });
    setFinding(null);
    setStatus(
      `Bound to ${station.name || station.id}. Every trip on this water carries it from now on.`
    );
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
            <button
              onClick={() => setFinding(finding && finding.id === water.id ? null : water)}
            >
              {water.station ? 'Change station' : 'Find a gauge'}
            </button>
          </div>

          {finding && finding.id === water.id ? (
            <div style={{ marginTop: 14 }}>
              <StationFinder
                water={water}
                waters={waters}
                onBind={(station) => handleBind(water.id, station)}
                onCancel={() => setFinding(null)}
              />
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
