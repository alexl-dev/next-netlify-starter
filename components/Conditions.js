/**
 * The conditions readout.
 *
 * Ordered by how much each number actually changes a decision, not by which
 * API it came from: barometric trend first, then water, then the sky clock.
 * A bare pressure reading is nearly useless, so the trend gets the hero cell
 * and the absolute value rides along underneath it.
 */

const arrow = (direction) => {
  if (!direction) return '';
  if (direction.startsWith('rising')) return '↑';
  if (direction.startsWith('falling')) return '↓';
  return '→';
};

const Cell = ({ k, v, sub, hero }) => (
  <div className={hero ? 'cell hero' : 'cell'}>
    <span className={sub ? 'v sm' : 'v'}>{v}</span>
    <span className="k">{k}</span>
    {sub ? <span className="k">{sub}</span> : null}
  </div>
);

export default function Conditions({ snapshot, compact = false }) {
  if (!snapshot) {
    return <p className="small muted">Conditions not fetched yet.</p>;
  }

  const w = snapshot.weather;
  const a = snapshot.astro;
  const water = snapshot.water;
  const cells = [];

  if (w && w.pressure) {
    cells.push(
      <Cell
        key="trend"
        hero
        k="Barometer"
        v={`${arrow(w.pressure.direction)} ${w.pressure.direction}`}
        sub={
          w.pressure.change3hHpa != null
            ? `${w.pressure.change3hHpa > 0 ? '+' : ''}${w.pressure.change3hHpa} hPa / 3h · ${
                w.pressureInHg != null ? `${w.pressureInHg.toFixed(2)}"` : ''
              }`
            : null
        }
      />
    );
  }

  if (w) {
    if (w.airTempF != null) {
      cells.push(
        <Cell
          key="air"
          k="Air"
          v={`${Math.round(w.airTempF)}°`}
          sub={w.conditions || null}
        />
      );
    }
    if (w.windMph != null) {
      cells.push(
        <Cell
          key="wind"
          k="Wind"
          v={`${Math.round(w.windMph)}`}
          sub={`mph ${w.windDirection || ''}${
            w.windGustMph != null && w.windGustMph > w.windMph + 4
              ? ` · gusts ${Math.round(w.windGustMph)}`
              : ''
          }`}
        />
      );
    }
    if (w.cloudCoverPct != null) {
      cells.push(<Cell key="cloud" k="Cloud" v={`${Math.round(w.cloudCoverPct)}%`} />);
    }
  }

  if (water) {
    if (water.dischargeCfs != null) {
      cells.push(
        <Cell
          key="flow"
          k="Flow"
          v={`${Math.round(water.dischargeCfs)}`}
          sub={
            water.flow
              ? `cfs · ${water.flow.pctOfMedian}% of median (${water.flow.label})`
              : 'cfs'
          }
        />
      );
    }
    if (water.gaugeHeightFt != null) {
      cells.push(
        <Cell
          key="stage"
          k="Gauge"
          v={`${water.gaugeHeightFt.toFixed(2)}′`}
          sub={water.heightTrend24h ? `${water.heightTrend24h.direction} 24h` : null}
        />
      );
    }
    if (water.waterTempF != null) {
      cells.push(<Cell key="wtemp" k="Water" v={`${Math.round(water.waterTempF)}°`} />);
    }
    if (water.stage) {
      cells.push(
        <Cell
          key="tide"
          k="Tide"
          v={water.stage}
          sub={
            water.nextEvent
              ? `${water.nextEvent.type} at ${new Date(water.nextEvent.at).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
              : null
          }
        />
      );
    }
    if (water.waterLevelFt != null) {
      cells.push(<Cell key="level" k="Lake level" v={`${water.waterLevelFt.toFixed(2)}′`} />);
    }
  }

  if (a && !compact) {
    cells.push(
      <Cell
        key="moon"
        k="Moon"
        v={`${Math.round(a.moonIlluminationPct)}%`}
        sub={a.moonPhaseName}
      />
    );
    if (a.solunar) {
      const next = [...a.solunar.major, ...a.solunar.minor]
        .filter((p) => Date.parse(p.peak) > Date.now())
        .sort((x, y) => Date.parse(x.peak) - Date.parse(y.peak))[0];
      cells.push(
        <Cell
          key="solunar"
          k="Solunar"
          v={a.solunar.activeNow ? a.solunar.activeNow : 'outside'}
          sub={
            next
              ? `next ${new Date(next.peak).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}`
              : null
          }
        />
      );
    }
    if (a.sunset) {
      cells.push(
        <Cell
          key="light"
          k="Light"
          v={a.timeOfDay}
          sub={`sets ${new Date(a.sunset).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}`}
        />
      );
    }
  }

  return (
    <>
      <div className="readout">{cells}</div>
      {snapshot.status === 'partial' && snapshot.errors && snapshot.errors.length ? (
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Partly filled in — {snapshot.errors.join('; ')}. It will retry.
        </p>
      ) : null}
    </>
  );
}
