# Riffle

A fishing log that records the conditions for you.

Take a photo, drop a pin, write a note — Riffle attaches the weather, the
barometric trend, the moon and solunar periods, and the river gauge readings
that stood over that exact spot at that exact minute. Later it tells you what
your own log actually says about them, without pretending twelve trips are a
finding.

This is the **web prototype**. It runs in a phone browser today; the parts worth
keeping (`lib/`) are plain JavaScript with no framework imports, so they move to
a native build unchanged.

## Running it

```bash
npm install
npm run dev      # http://localhost:3000
npm test         # 20 tests, no network required
```

## Testing it on a phone

Geolocation and the camera need **HTTPS** in mobile Safari — hitting a laptop's
LAN address over plain `http://` silently fails, which looks like a broken app.
So use a deployed URL rather than a local one:

1. Push this branch and let Netlify build it (this repo is already wired to
   Netlify), or run `npx netlify deploy --build` for a one-off preview URL.
2. Open the URL in Safari on the phone.
3. **Share › Add to Home Screen.** It then opens without browser chrome, which
   is as close as a web build gets to the real thing.
4. Add a water, bind its gauge, start a trip, drop a pin, log a fish.

Allow location when asked. Photos come from the normal camera sheet.

## How it fits together

```
lib/astro.js            sun, moon, solunar — pure arithmetic, no network, no key
lib/sources/openMeteo.js  weather + barometric trend + historical back-fill
lib/sources/usgs.js       gauge height, discharge, water temp, flow percentile
lib/sources/noaa.js       tide stage and Great Lakes water level
lib/conditions.js       assembles one snapshot; partial beats nothing
lib/model.js            entities, buckets, catch-rate maths, "days like today"
lib/store.js            IndexedDB — the source of truth, plus the enrich queue
lib/app.js              the verbs the screens call
pages/api/*             thin proxies, only because browsers cannot call USGS/NOAA directly
```

### Three decisions worth knowing

**Capture never waits on the network.** A pin is a place and a time written to
IndexedDB; conditions are fetched afterwards, possibly days later from the
couch. Rivers do not have signal, and an app that needs it at the water is an
app that loses the day. This is why Open-Meteo was chosen over OpenWeather —
its historical archive means a back-fill four days later returns exactly the
weather that stood over you.

**Photo GPS is captured from the device, never read from the photo.** iOS and
mobile browsers both strip location from in-app camera captures. Trusting EXIF
here would quietly lose "where was I?" for an entire season.

**Every rate is per hour fished, blanks included.** Counting catches mostly
rediscovers your own calendar — you fish weekends and evenings before fronts,
so of course most fish were caught then. The trip clock is what turns the log
into something that can answer a question. Ending a trip matters as much as
starting one.

### What the numbers will and will not tell you

The Trends screen prints the sample size beside every bar and says plainly when
there is not enough to compare. At twenty to forty trips a year, single-variable
bars are the most any personal log can honestly support — which is why
**Days like today** exists: it makes no causal claim, it just finds the past
trips whose water and sky resembled now, and shows what happened. That is
useful at a dozen trips, long before a chart is.

## Not built yet

- **Shared logs.** `lib/store.js` is the seam: it is the only module that
  touches storage, so a backend goes there. Needs a Supabase project and keys.
- **Offline map tiles.** Packaging tiles is a project of its own; the cheap
  version is pre-caching the trip area before leaving the driveway.
- **Native build.** `lib/` ports as-is; the screens and the Leaflet map do not.

Weather data by [Open-Meteo](https://open-meteo.com/) (CC BY 4.0). River data
from [USGS Water Services](https://waterservices.usgs.gov/). Tides and lake
levels from [NOAA CO-OPS](https://api.tidesandcurrents.noaa.gov/). Maps
&copy; OpenStreetMap contributors.
