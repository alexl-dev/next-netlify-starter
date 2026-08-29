# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Riffle — a personal fishing log. You photograph a fish, drop a map pin, and write
a note; the app attaches the weather, barometric trend, moon phase, solunar
periods and river gauge readings that stood over that exact spot at that exact
minute, then reports what your own log says about them.

This is the **web prototype**, built on the Next.js 14 pages router and deployed
to Netlify. A native iOS build is the intended destination — see the portability
contract below, which constrains how `lib/` may be written.

## Commands

```bash
npm run dev      # localhost:3000
npm run build    # next build
npm test         # the whole suite

# one test — the flag MUST precede the path or it is silently ignored
# and the full suite runs while reporting success
node --test --test-name-pattern "flow below the 25th" tests/conditions.test.mjs
```

`node --test tests/` (a directory) fails: `lib/package.json` makes Node treat
nearby directories as package roots. Always name the file.

Tests need no network — every source is injected via `fetchImpl`.

## The portability contract

`lib/` is plain JavaScript with **no framework imports and no dependencies**, so
it moves to the native build unchanged. `components/` and `pages/` are prototype
UI and are expected to be thrown away.

- `lib/package.json` is `{"type": "module"}`. That is what lets Node's test
  runner import `lib/*.js` as ESM from a CommonJS root package. Don't remove it.
- Relative imports inside `lib/` carry explicit `.js` extensions so the modules
  run unbundled under Node, not just through webpack.
- Never import React, Next, or a browser global into `lib/`, except in
  `lib/store.js` (IndexedDB) and `lib/app.js` (geolocation, fetch), which are
  the two modules a native build is expected to replace.

## Architecture

```
lib/astro.js            sun, moon, solunar — pure arithmetic, no network, no key
lib/sources/openMeteo.js  weather + barometric trend + historical back-fill
lib/sources/usgs.js       gauge height, discharge, water temp, flow percentile
lib/sources/noaa.js       tide stage, Great Lakes water level
lib/conditions.js       assembles one snapshot from the above
lib/model.js            entities, condition buckets, catch-rate maths
lib/store.js            IndexedDB + the enrichment queue
lib/app.js              the verbs the screens call
pages/api/*             thin proxies; exist only because browsers cannot call USGS/NOAA
```

### Capture never awaits the network

This is the constraint everything else bends around: rivers have no signal.

Capture writes a place and a time to IndexedDB and returns. It never blocks on a
fetch. `lib/app.js` then enqueues a job in the `outbox` store; `drainOutbox` in
`lib/store.js` works through it on page load, on the browser's `online` event,
and after each capture. A trip logged in a dead zone fills itself in on the
drive home.

This is why Open-Meteo was chosen over OpenWeather — its historical archive
means a back-fill four days later returns the weather that actually stood over
you, not today's.

When adding any capture path, follow the same shape: write locally, enqueue,
return. Do not await a snapshot in a UI handler.

### Snapshot status is a two-state contract

`buildSnapshot` returns `status: 'enriched' | 'partial'`. Astro data is pure
arithmetic and always present; weather and water can each fail independently.

`partial` means something expected did not arrive, and the job **stays queued**
so a later pass can complete it. Only `enriched` dequeues. Preserve this — a
snapshot that silently reports success with a hole in it produces a chart drawn
from data that isn't there.

### Location comes from the device, never from the photo

iOS and mobile browsers both strip GPS from EXIF on in-app camera captures.
`logCatch` reads coordinates from geolocation at save time and writes them onto
the record. Never reintroduce EXIF as a position source; it fails silently and
loses a whole season of "where was I?".

### Every rate is per hour fished

`catchRateBy` in `lib/model.js` divides by hours from the trip clock, blank
trips included. Catch counts alone mostly rediscover the angler's calendar —
they fish weekends and evenings before fronts, so of course most fish were
caught then.

Consequences encoded in that function, all covered by tests:

- Trips without `endedAt` contribute no hours and no bucket.
- Trips whose snapshot never arrived sit out rather than distorting a bucket.
- A trip's bucket comes from its first pin's snapshot — the condition the
  angler chose to fish in.
- Time on a pin is *derived* from when the next pin was dropped, never entered.
  There is deliberately no second timer to remember.

Charts must render `trips` (the sample size) beside every bar, and `confidence`
must be shown. Never add a multi-variable breakdown: at 20–40 trips a year it
yields single-digit cells and a confident-looking lie. `daysLikeToday` is the
honest alternative and works from about a dozen trips.

### Stations are bound by hand, once per water

There is no "nearest gauge" endpoint. USGS filters by bounding box, not radius,
and the nearest gauge in a straight line is frequently on a different tributary
or above the confluence that feeds the fished run. `pages/api/stations.js`
returns ranked *candidates*; a person picks, and the choice is stored on the
water. Don't replace this with an auto-pick.

## Constraints worth knowing

- **No API keys, no environment variables.** Open-Meteo needs no signup; USGS
  and NOAA are public; sun and moon are computed on-device. Keep it that way —
  it is what makes deploying from a phone possible.
- **The `pages/api/*` routes exist only for CORS**, not for secrets. The native
  build calls `lib/` directly and drops them.
- Node 20 (`.nvmrc`). Netlify builds via `@netlify/plugin-nextjs`.
- Mobile Safari requires HTTPS for geolocation and camera, so phone testing must
  use a deployed URL — a LAN address over plain HTTP fails silently.

## Legacy from the Next.js starter template

`OpenWeatherAPI/`, `functions/weather.js`, `components/Header.js` and
`components/Footer.js` are leftovers from the template this repo began as. They
are unused and unreferenced. `functions/weather.js` also requires `node-fetch`,
which is not a dependency.
