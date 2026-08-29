import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import Chrome from '@components/Chrome';
import Conditions from '@components/Conditions';
import * as store from '@lib/store';
import * as app from '@lib/app';
import { tripHours } from '@lib/model';

const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

export default function Today() {
  const [ready, setReady] = useState(false);
  const [waters, setWaters] = useState([]);
  const [trips, setTrips] = useState([]);
  const [catches, setCatches] = useState([]);
  const [current, setCurrent] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [position, setPosition] = useState(null);
  const [status, setStatus] = useState('');
  const [queued, setQueued] = useState(0);
  const [waterId, setWaterId] = useState('');
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    const [w, t, c, pendingJobs] = await Promise.all([
      store.all('waters'), store.all('trips'), store.all('catches'), store.pending(),
    ]);
    setWaters(w);
    setTrips(t.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)));
    setCatches(c);
    setCurrent(t.find((trip) => !trip.endedAt) || null);
    setQueued(pendingJobs.length);
    setReady(true);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setStatus(err.message));
  }, [refresh]);

  // Keep the running clock honest without re-reading the database every second.
  useEffect(() => {
    if (!current) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, [current]);

  // Drain whatever was captured out of signal, now and whenever we get it back.
  useEffect(() => {
    if (!ready) return undefined;
    const drain = () => app.runEnrichment().then(refresh).catch(() => {});
    drain();
    window.addEventListener('online', drain);
    return () => window.removeEventListener('online', drain);
  }, [ready, refresh]);

  const locate = useCallback(async () => {
    setStatus('Locating…');
    try {
      const pos = await app.currentPosition();
      setPosition(pos);
      const water = waters.find((w) => w.id === (current ? current.waterId : waterId));
      setStatus('Reading conditions…');
      const snap = await app.conditionsHere({
        lat: pos.lat,
        lon: pos.lon,
        station: water ? water.station : null,
      });
      setSnapshot(snap);
      setStatus('');
    } catch (err) {
      setStatus(err.message);
    }
  }, [waters, current, waterId]);

  async function handleStart() {
    const water = waters.find((w) => w.id === waterId);
    const trip = await app.startTrip({
      waterId: water ? water.id : null,
      waterName: water ? water.name : 'Unnamed water',
    });
    await refresh();
    window.location.href = `/trip/${trip.id}`;
  }

  async function handleEnd() {
    await app.endTrip(current.id);
    await refresh();
  }

  const catchesFor = (tripId) => catches.filter((c) => c.tripId === tripId).length;

  return (
    <Chrome title="Riffle">
      {!ready ? <p className="muted">Opening your logbook…</p> : null}

      {current ? (
        <div className="card">
          <span className="label">On the water</span>
          <h2 style={{ marginTop: 6 }}>{current.waterName}</h2>
          <p className="small muted" data-tick={tick}>
            Started {new Date(current.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ·{' '}
            {tripHours(current).toFixed(1)} h · {catchesFor(current.id)} fish
          </p>
          <div className="row" style={{ marginTop: 12 }}>
            <Link className="btn primary" href={`/trip/${current.id}`}>Open trip</Link>
            <button onClick={handleEnd}>End trip</button>
          </div>
          <p className="tiny muted" style={{ marginTop: 10 }}>
            Ending the trip is what turns your catches into a rate. A blank day counts — log it anyway.
          </p>
        </div>
      ) : ready ? (
        <div className="card">
          <span className="label">Start fishing</span>
          <div className="stack" style={{ marginTop: 10 }}>
            <label className="field">
              Water
              <select value={waterId} onChange={(e) => setWaterId(e.target.value)}>
                <option value="">Pick a water…</option>
                {waters.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                    {w.station ? '' : ' (no gauge bound)'}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary wide" onClick={handleStart} disabled={!waters.length}>
              Start trip
            </button>
            {!waters.length ? (
              <p className="small muted">
                Add a water first — <Link href="/waters">Waters</Link> — so your trips get gauge and tide
                data attached.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="card">
        <h2>Conditions here</h2>
        {snapshot ? (
          <Conditions snapshot={snapshot} />
        ) : (
          <p className="small muted">
            Nothing read yet. This needs your location, and it works best outside.
          </p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={locate}>{snapshot ? 'Refresh' : 'Read conditions'}</button>
        </div>
        {status ? <p className="small muted" style={{ marginTop: 8 }}>{status}</p> : null}
        {position ? (
          <p className="tiny muted" style={{ marginTop: 8 }}>
            {position.lat.toFixed(4)}, {position.lon.toFixed(4)}
            {position.accuracyM ? ` · ±${position.accuracyM} m` : ''}
          </p>
        ) : null}
      </div>

      {queued > 0 ? (
        <div className="banner">
          {queued} {queued === 1 ? 'entry is' : 'entries are'} waiting on conditions. They will fill
          themselves in once you have a signal — nothing is lost.
        </div>
      ) : null}

      {trips.length ? (
        <>
          <span className="label">Recent trips</span>
          <div className="list" style={{ marginTop: 8 }}>
            {trips.slice(0, 12).map((trip) => (
              <Link className="item" key={trip.id} href={`/trip/${trip.id}`}>
                <div className="grow">
                  <b>{trip.waterName}</b>
                  <span className="sub">
                    {fmtDate(trip.startedAt)} · {tripHours(trip).toFixed(1)} h ·{' '}
                    {catchesFor(trip.id)} fish
                    {trip.endedAt ? '' : ' · still open'}
                  </span>
                </div>
                <span className="muted">›</span>
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </Chrome>
  );
}
