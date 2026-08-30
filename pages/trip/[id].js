import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Chrome from '@components/Chrome';
import Conditions from '@components/Conditions';
import PinMap from '@components/PinMap';
import LocationPicker, { useLocationFallback } from '@components/LocationPicker';
import Combobox from '@components/Combobox';
import * as store from '@lib/store';
import * as app from '@lib/app';
import { pinDurations, tripHours } from '@lib/model';
import { collectHistory, describeUse, rankSuggestions } from '@lib/suggest';

const time = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const EMPTY_CATCH = {
  species: '', lengthIn: '', method: '', gear: '', presentation: '', depthFt: '',
  released: true, notes: '',
};

export default function TripScreen() {
  const router = useRouter();
  const { id } = router.query;

  const [trip, setTrip] = useState(null);
  const [pins, setPins] = useState([]);
  const [catches, setCatches] = useState([]);
  const [photos, setPhotos] = useState({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_CATCH);
  const [photoBlob, setPhotoBlob] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [activePin, setActivePin] = useState('');
  // Suggestions come from the whole log, not just this trip — the fly that
  // worked last October is exactly the one worth offering again.
  const [allCatches, setAllCatches] = useState([]);
  const fileRef = useRef(null);
  const { resolvePosition, pickerProps } = useLocationFallback();

  const refresh = useCallback(async () => {
    if (!id) return;
    const [t, p, c, everything] = await Promise.all([
      store.get('trips', id), store.byTrip('pins', id), store.byTrip('catches', id),
      store.all('catches'),
    ]);
    setAllCatches(everything || []);
    setTrip(t || null);
    const ordered = (p || []).sort((a, b) => Date.parse(a.droppedAt) - Date.parse(b.droppedAt));
    setPins(ordered);
    setCatches((c || []).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
    if (!activePin && ordered.length) setActivePin(ordered[ordered.length - 1].id);

    // Resolve thumbnails for anything with a photo.
    const urls = {};
    for (const record of c || []) {
      for (const photoId of record.photoIds || []) {
        const url = await store.photoUrl(photoId);
        if (url) urls[photoId] = url;
      }
    }
    setPhotos(urls);
  }, [id, activePin]);

  useEffect(() => {
    refresh().catch((err) => setStatus(err.message));
  }, [refresh]);

  async function handleDropPin() {
    setBusy(true);
    setStatus('Getting a fix…');
    try {
      // If the phone will not say where we are, the picker takes over rather
      // than the spot being lost. Only a deliberate "not now" drops nothing.
      const position = await resolvePosition();
      if (!position) {
        setStatus('No spot chosen, so no pin was dropped.');
        return;
      }
      const pin = await app.dropPin({ tripId: id, name: '', position });
      setActivePin(pin.id);
      setStatus(
        position.source === 'gps'
          ? 'Pin dropped. Conditions will attach in the background.'
          : 'Pin dropped where you placed it. Conditions will attach in the background.'
      );
      await refresh();
      app.runEnrichment().then(refresh).catch(() => {});
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleMovePin(pinId, lat, lon) {
    await app.movePin(pinId, lat, lon);
    await refresh();
    app.runEnrichment().then(refresh).catch(() => {});
  }

  function handlePhoto(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    setPhotoBlob(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  async function handleLogCatch(event) {
    event.preventDefault();
    setBusy(true);
    setStatus('Finding where you are…');
    try {
      // A fish logged with location off used to be saved with null coordinates
      // and never enriched — permanently condition-less. Asking here means a
      // hand-picked spot still earns the fish its weather and river reading.
      const position = await resolvePosition({ timeout: 8000 });
      setStatus('Saving…');
      await app.logCatch({
        tripId: id,
        pinId: activePin || null,
        photoBlob,
        position,
        askDevice: false,
        fields: {
          species: form.species.trim(),
          lengthIn: form.lengthIn === '' ? null : Number(form.lengthIn),
          method: form.method.trim(),
          gear: form.gear.trim(),
          presentation: form.presentation.trim(),
          depthFt: form.depthFt === '' ? null : Number(form.depthFt),
          released: form.released,
          notes: form.notes.trim(),
        },
      });
      // Keep method and gear — the next fish usually comes on the same thing.
      setForm({ ...EMPTY_CATCH, method: form.method, gear: form.gear });
      setPhotoBlob(null);
      setPhotoPreview(null);
      if (fileRef.current) fileRef.current.value = '';
      setStatus('Logged.');
      await refresh();
      app.runEnrichment().then(refresh).catch(() => {});
    } catch (err) {
      setStatus(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleEnd() {
    await app.endTrip(id);
    await refresh();
  }

  if (!trip) {
    return (
      <Chrome title="Trip">
        <p className="muted">{status || 'Loading…'}</p>
        <Link href="/">Back to today</Link>
      </Chrome>
    );
  }

  const timed = pinDurations(trip, pins);
  const pinCount = pins.length;

  const suggestFor = (field, typed) => {
    const history = collectHistory(allCatches, field);
    return rankSuggestions({ history, query: typed }).map((entry) => ({
      id: entry.value,
      value: entry.value,
      range: entry.range,
      detail: describeUse(entry),
    }));
  };

  return (
    <Chrome title={trip.waterName || 'Trip'}>
      <div className="card">
        <span className="label">{trip.endedAt ? 'Finished' : 'On the water'}</span>
        <p className="small" style={{ marginTop: 6 }}>
          {new Date(trip.startedAt).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
          {' · '}{time(trip.startedAt)}
          {trip.endedAt ? `–${time(trip.endedAt)}` : ''}
          {' · '}{tripHours(trip).toFixed(1)} h · {catches.length} fish · {pinCount}{' '}
          {pinCount === 1 ? 'spot' : 'spots'}
        </p>
        {!trip.endedAt ? (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" onClick={handleDropPin} disabled={busy}>
              Drop a pin here
            </button>
            <button onClick={handleEnd}>End trip</button>
          </div>
        ) : null}
        {status ? <p className="small muted" style={{ marginTop: 10 }}>{status}</p> : null}
      </div>

      {pickerProps ? <LocationPicker {...pickerProps} /> : null}

      {pins.length ? (
        <div className="card">
          <h2>Where you fished</h2>
          <PinMap pins={pins} onMovePin={handleMovePin} />
          <p className="tiny muted" style={{ marginTop: 8 }}>
            Drag a pin if the fix landed you in the trees. Moving one re-reads its conditions.
          </p>
          <div className="list" style={{ marginTop: 12 }}>
            {timed.map((pin, i) => (
              <div className="item" key={pin.id}>
                <div className="grow">
                  <b>{pin.name || `Spot ${i + 1}`}</b>
                  <span className="sub">
                    {time(pin.droppedAt)} · {pin.minutes} min here ·{' '}
                    {catches.filter((c) => c.pinId === pin.id).length} fish
                    {pin.snapshotStatus !== 'enriched' ? ' · conditions pending' : ''}
                    {pin.source && pin.source !== 'gps' ? ' · placed by hand' : ''}
                  </span>
                  {pin.snapshot ? (
                    <div style={{ marginTop: 8 }}>
                      <Conditions snapshot={pin.snapshot} compact />
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="banner info">
          Drop a pin when you start fishing a spot. Every pin gets its own weather, moon and river
          reading — the pool you fish at noon is not the one you fish at dusk.
        </div>
      )}

      {!trip.endedAt ? (
        <form className="card" onSubmit={handleLogCatch}>
          <h2>Log a fish</h2>
          <div className="stack">
            {pins.length > 1 ? (
              <label className="field">
                Spot
                <select value={activePin} onChange={(e) => setActivePin(e.target.value)}>
                  {timed.map((pin, i) => (
                    <option key={pin.id} value={pin.id}>
                      {pin.name || `Spot ${i + 1}`} · {time(pin.droppedAt)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <div className="grid2">
              <Combobox
                label="Species"
                value={form.species}
                onChange={(species) => setForm({ ...form, species })}
                options={suggestFor('species', form.species)}
                placeholder="Brown trout"
                autoCapitalize="words"
                emptyMessage={
                  allCatches.length ? 'Nothing logged by that name yet — type it anyway.' : null
                }
              />
              <label className="field">
                Length (in)
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.5"
                  value={form.lengthIn}
                  onChange={(e) => setForm({ ...form, lengthIn: e.target.value })}
                />
              </label>
            </div>

            <div className="grid2">
              <Combobox
                label="Method"
                value={form.method}
                onChange={(method) => setForm({ ...form, method })}
                options={suggestFor('method', form.method)}
                placeholder="fly / spin"
              />
              <Combobox
                label="Fly or lure"
                value={form.gear}
                onChange={(gear) => setForm({ ...form, gear })}
                options={suggestFor('gear', form.gear)}
                placeholder="#16 pheasant tail"
              />
            </div>

            <label className="field">
              Notes
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Deep seam below the willow, took it on the swing"
              />
            </label>

            <label className="field">
              Photo
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handlePhoto}
              />
            </label>
            {photoPreview ? (
              <div className="thumbs">
                <img src={photoPreview} alt="The fish you just logged" />
              </div>
            ) : null}

            <button className="primary wide" type="submit" disabled={busy}>
              Log it
            </button>
            <p className="tiny muted">
              Location is read from the phone as you save — a photo's own GPS tag is stripped by the
              browser, so it cannot be trusted to remember the spot. If the phone cannot say, you
              will be asked to pick the spot instead, and the fish still gets its conditions.
            </p>
          </div>
        </form>
      ) : null}

      {catches.length ? (
        <>
          <span className="label">Fish</span>
          <div className="list" style={{ marginTop: 8 }}>
            {catches.map((c) => (
              <div className="item" key={c.id}>
                {(c.photoIds || []).map((pid) =>
                  photos[pid] ? (
                    <img
                      key={pid}
                      src={photos[pid]}
                      alt={c.species || 'Logged fish'}
                      style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4 }}
                    />
                  ) : null
                )}
                <div className="grow">
                  <b>
                    {c.species || 'Unnamed fish'}
                    {c.lengthIn ? ` · ${c.lengthIn}"` : ''}
                  </b>
                  <span className="sub">
                    {time(c.at)}
                    {c.gear ? ` · ${c.gear}` : ''}
                    {c.released ? ' · released' : ''}
                  </span>
                  {c.notes ? <p className="small" style={{ margin: '6px 0 0' }}>{c.notes}</p> : null}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Chrome>
  );
}
