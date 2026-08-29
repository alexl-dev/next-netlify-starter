import { useCallback, useEffect, useState } from 'react';
import Chrome from '@components/Chrome';
import Conditions from '@components/Conditions';
import * as store from '@lib/store';
import * as app from '@lib/app';
import { BUCKETS, catchRateBy, confidence, daysLikeToday, tripHours } from '@lib/model';

const BUCKET_KEYS = ['pressure', 'moon', 'timeOfDay', 'flow', 'waterTemp', 'solunar'];

/**
 * One variable at a time, always with the sample size showing.
 *
 * Slicing pressure by moon by species would leave two trips per cell and draw
 * a confident-looking lie. A single axis with n printed beside every bar is
 * what a season of personal data can honestly support.
 */
function BarChart({ rows }) {
  const max = Math.max(...rows.map((r) => r.perHour || 0), 0.001);
  return (
    <div className="bars">
      {rows.map((row) => (
        <div className="bar-row" key={row.bucket}>
          <span>{row.bucket}</span>
          <div className="bar-track">
            <div
              className={row.trips >= 3 ? 'bar-fill' : 'bar-fill thin'}
              style={{ width: `${Math.max(2, ((row.perHour || 0) / max) * 100)}%` }}
            />
          </div>
          <span className="bar-n">
            {row.perHour == null ? '—' : row.perHour.toFixed(2)}/h · n={row.trips}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Trends() {
  const [data, setData] = useState({ trips: [], pins: [], catches: [], waters: [] });
  const [target, setTarget] = useState(null);
  const [status, setStatus] = useState('');

  const refresh = useCallback(async () => {
    setData(await store.loadAll());
  }, []);

  useEffect(() => {
    refresh().catch((err) => setStatus(err.message));
  }, [refresh]);

  const finished = data.trips.filter((t) => t.endedAt);
  const totalHours = finished.reduce((n, t) => n + tripHours(t), 0);
  const blanks = finished.filter(
    (t) => !data.catches.some((c) => c.tripId === t.id)
  ).length;

  async function handleLookup() {
    setStatus('Reading conditions here…');
    try {
      const pos = await app.currentPosition();
      const water = data.waters.find((w) => w.station);
      const snap = await app.conditionsHere({
        lat: pos.lat,
        lon: pos.lon,
        station: water ? water.station : null,
      });
      setTarget(snap);
      setStatus('');
    } catch (err) {
      setStatus(err.message);
    }
  }

  const similar = target ? daysLikeToday(target, data) : [];

  return (
    <Chrome title="Trends">
      <div className="card">
        <h2>Your log so far</h2>
        <div className="readout">
          <div className="cell">
            <span className="v">{finished.length}</span>
            <span className="k">trips finished</span>
          </div>
          <div className="cell">
            <span className="v">{totalHours.toFixed(0)}</span>
            <span className="k">hours fished</span>
          </div>
          <div className="cell">
            <span className="v">{data.catches.length}</span>
            <span className="k">fish</span>
          </div>
          <div className="cell">
            <span className="v">{blanks}</span>
            <span className="k">blank trips</span>
          </div>
        </div>
        <p className="tiny muted" style={{ marginTop: 10 }}>
          Blank trips are the ones that make every rate below trustworthy. If that number stays at
          zero across a season, the charts are flattering you rather than teaching you.
        </p>
      </div>

      <div className="card">
        <h2>Days like today</h2>
        <p className="small muted">
          Not a prediction — a lookup. What happened the last times the water and sky looked like
          this. Useful from about a dozen trips, long before any chart is worth reading.
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={handleLookup}>Match conditions here</button>
        </div>
        {status ? <p className="small muted" style={{ marginTop: 8 }}>{status}</p> : null}

        {target ? (
          <div style={{ marginTop: 14 }}>
            <Conditions snapshot={target} compact />
          </div>
        ) : null}

        {similar.length ? (
          <div className="list" style={{ marginTop: 14 }}>
            {similar.map((match) => (
              <div className="item" key={match.trip.id}>
                <div className="grow">
                  <b>
                    {match.trip.waterName} ·{' '}
                    {new Date(match.trip.startedAt).toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </b>
                  <span className="sub">
                    {match.similarity}% alike · {match.catches} fish in {match.hours} h
                    {match.perHour != null ? ` · ${match.perHour.toFixed(2)}/h` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : target ? (
          <p className="small muted" style={{ marginTop: 12 }}>
            No comparable trips in the log yet.
          </p>
        ) : null}
      </div>

      {BUCKET_KEYS.map((key) => {
        const rows = catchRateBy(key, data).filter((r) => r.trips > 0);
        if (!rows.length) return null;
        const conf = confidence(rows);
        return (
          <div className="card" key={key}>
            <h2>{BUCKETS[key].label}</h2>
            <p className="tiny muted" style={{ marginBottom: 12 }}>
              Fish per hour fished. {conf.message}
            </p>
            <BarChart rows={rows} />
            {conf.level === 'none' || conf.level === 'weak' ? (
              <p className="tiny muted" style={{ marginTop: 10 }}>
                Faint bars are buckets with fewer than three trips behind them.
              </p>
            ) : null}
          </div>
        );
      })}

      {!finished.length ? (
        <p className="muted small">
          Nothing to chart yet. Finish a trip — start to end — and the first numbers appear here.
        </p>
      ) : null}
    </Chrome>
  );
}
