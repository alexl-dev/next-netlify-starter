# Security and privacy for Riffle

Riffle is a fishing log. That framing makes it sound like a low-stakes app, and it
is not. What it actually accumulates, per person, is:

- Precise GPS coordinates — `lat`/`lon` as full IEEE doubles with an `accuracyM`
  in metres (`lib/model.js:36`, `lib/app.js:20-31`) — for every spot the user
  stood in.
- A timestamp to the minute for each of those coordinates (`droppedAt`, `at`).
- Trip start and end times (`lib/model.js:25-34`), which is a direct record of
  when the house was empty.
- Photographs, stored as raw blobs (`lib/store.js:98-111`).
- Free text: `notes`, `companions`, `gear`, `presentation`.

Any one entry is harmless. The aggregate is a high-resolution movement history of
a named individual, joined to a map of privately valuable fishing spots that
anglers guard more carefully than most of their other secrets. A leaked Riffle
database is a burglary schedule and a poaching map in one file. This document
treats it as sensitive personal data, because it is.

The app today has no accounts, no backend beyond two CORS proxies, no secrets,
and no environment variables. Most of what follows is therefore about *keeping*
that property, and about what has to be true if it is ever given up.

---

## 1. Threat model

Ranked by likelihood × impact for an app with a handful of users. The first two
are the ones that will actually happen; the rest are ordered by how bad they are
if they do.

### 1.1 The unlocked phone (high likelihood, high impact)

This is the realistic attack. The phone is handed to a friend to look at a photo,
left on a bar table, borrowed by a partner, lost, or taken by a thief who watched
the passcode get typed. Riffle is installed to the home screen (`components/Chrome.js:22-25`)
and opens straight into the log with no gate of any kind. Everything is in
IndexedDB in plaintext (`lib/store.js:19-40`), readable by anyone holding the
device and by any other origin-less inspection of the device's storage.

Nothing in the codebase mitigates this today. It is the single most likely path
to disclosure, and it is the one that posture (a) below is aimed at.

### 1.2 The person in the house (high likelihood, moderate-to-high impact)

A housemate, a partner, a family member, a colleague at a shared desk. They have
casual physical access, a plausible reason to pick up the phone, and — unlike the
opportunistic thief — a specific interest in the contents. "Where were you on
Tuesday evening" is answered exactly and irrevocably by `trips`. This threat is
not defeated by device encryption or a lock screen the person already knows the
code to; it needs an app-level gate with a credential they do not have.

### 1.3 A spot burglar or poacher with access to an export (moderate likelihood, high impact)

`exportJson` (`lib/store.js:190-193`) writes every coordinate at full precision
into one file, and the whole point of it is that the file leaves the browser. It
will end up in iCloud Drive, in an email to oneself, in a Slack DM to a fishing
partner, in a Dropbox that gets shared, in a gist. There is no coarsening, no
warning, and no option to export without coordinates. Once that file exists,
Riffle's privacy posture is whatever the user's file hygiene is.

The same applies to any future "share this trip" feature. Anglers *do* share trip
reports; the danger is that sharing a report currently means sharing 6-decimal
coordinates.

### 1.4 A compromised CDN dependency (low-moderate likelihood, catastrophic impact)

`components/PinMap.js:14-15` loads Leaflet's CSS and JS from `unpkg.com` at
runtime, injected into `document.head` (lines 20-38), with **no Subresource
Integrity attribute and no Content-Security-Policy anywhere in the repo** —
`netlify.toml` has no `[[headers]]` block and `next.config.js` has no `headers()`.

unpkg serves whatever the npm registry currently holds at that path. An attacker
who compromises the `leaflet` npm account, or unpkg itself, or the DNS in front
of it, gets arbitrary JavaScript execution on the Riffle origin. That script has
same-origin access to the entire IndexedDB log and to a geolocation permission
the user has already granted. It could quietly POST every coordinate anywhere it
liked and nobody would notice, because the app has no CSP to block the
exfiltration and no integrity check to block the load.

This is low-likelihood but it is the only vector in this document that hands an
attacker the *complete* log of *every* user at once, silently. Treat it as the
top-priority fix.

### 1.5 The API routes as an open proxy (moderate likelihood, low-moderate impact)

`pages/api/conditions.js` and `pages/api/stations.js` are unauthenticated,
unrate-limited, accept any HTTP method, and each call fans out to between one and
four upstream requests against free public services (Open-Meteo, USGS
waterservices, NOAA CO-OPS). `/api/stations?kind=salt` is the worst case: on a
cold function instance it triggers a download of NOAA's entire
`stations.json` metadata list (`lib/sources/noaa.js:26-39`), and that route sets
no `Cache-Control` at all.

Nobody steals data this way. What they do is use the deployment as free
compute and free reputation: bulk weather scraping attributed to the Netlify
site's IP, getting Riffle rate-limited or blocked by USGS/NOAA, and burning
Netlify function invocations. The impact is denial of service against the app's
own enrichment queue and a possible bill.

### 1.6 A breached backend (currently zero likelihood, catastrophic impact)

There is no backend today, so there is nothing to breach — this is the strongest
security property the app currently has and it should not be given up casually.
If posture (b) is adopted, this jumps to the top of the list, because it is the
only scenario in which *everyone's* log leaks at once, permanently, to someone
who never touched a device.

### 1.7 An over-broad or injectable API route (low likelihood today)

Covered in detail in §3.6. Short version: SSRF is **not** exploitable in the
current code, but the route does leak upstream error strings verbatim.

### 1.8 Stored XSS from the user's own notes (low likelihood today, high impact later)

`components/PinMap.js:90-95` builds popup HTML by string interpolation:

```js
marker.bindPopup(
  `<b>${pin.name || `Spot ${i + 1}`}</b><br>${new Date(pin.droppedAt).toLocaleTimeString(...)}`
);
```

Leaflet's `bindPopup` with a string argument assigns it as `innerHTML`. `pin.name`
is user-entered free text and is not escaped. Today this is only self-XSS — the
attacker would have to type the payload into their own device — so the practical
risk is near zero. But React escapes everywhere else in this codebase; this is
the one place that does not, and the moment any sync, import, or shared-log
feature lands (which `lib/store.js:6-9` explicitly anticipates), it becomes a
genuine cross-user stored XSS against an origin that holds everyone's
coordinates. Fix it now while it costs one line.

### 1.9 Network eavesdropping (low likelihood, low impact)

Everything is HTTPS: Open-Meteo, USGS, NOAA, OpenStreetMap tiles, and the site
itself (mobile Safari will not grant geolocation otherwise). The residual leak is
not the transport, it is *who is on the other end* — see §3.5 on what Open-Meteo
and the tile server learn about where the user fishes.

---

## 2. The two postures

### (a) Device-local, with a lock

Keep IndexedDB as the source of truth. Add a WebAuthn/passkey gate on app open,
and encrypt the record values at rest with AES-GCM via WebCrypto, keyed from
material the passkey produces.

**What it actually protects against.** Threats 1.1 and 1.2 — the unlocked phone
and the housemate — which are the two most likely things that will ever happen to
this app. A passkey gate means the borrowed phone shows a Face ID prompt instead
of a map. Encryption at rest means that even a forensic dump of the IndexedDB
files (a jailbroken device, a desktop browser profile copied off a shared laptop,
a backup extraction) yields ciphertext rather than coordinates.

**What it does not protect against.** Almost everything else, and it is important
to be blunt about this:

- It does not help once the app is unlocked. After a successful passkey
  ceremony the decryption key is in JavaScript memory and the plaintext is on
  screen. An attacker who is holding the unlocked, unlocked-*app* phone gets
  everything. Encryption at rest defends data at rest, and only that.
- It does not defend against 1.4 at all. A malicious script running on the
  Riffle origin after unlock can call the same decrypt path the app calls.
- It does not defend against 1.3. An export is plaintext by definition.
- It does nothing about the API routes.

**Complexity cost.** Moderate but bounded, and — importantly — it does not break
the no-secrets, no-environment-variables constraint. WebAuthn in this mode is
purely client-side: there is no server to register credentials against, so the
"relying party" work reduces to storing the credential id and a salt in
`localStorage` and calling `navigator.credentials.get()`. The encryption work is
a wrapper around `lib/store.js`'s `put`/`get`/`all`, which is exactly the seam the
module was designed to have. Expect a few hundred lines, most of it in one new
`lib/crypto.js`.

**Interaction with offline-first capture.** Good, and this is the deciding
argument. Every operation stays local. `dropPin` still writes and returns without
touching the network (`lib/app.js:99-105`). The one real friction is that the
encryption key must be in memory before `drainOutbox` can read and rewrite queued
records (`lib/store.js:145-176`) — so background enrichment cannot run while the
app is locked. That is acceptable: enrichment already runs on page load and on
the `online` event (`pages/index.js:49-55`), both of which happen with the app
open. Do *not* work around this by caching the key somewhere durable; see §3.2.

WebAuthn itself needs no network (`userVerification` against a platform
authenticator is entirely local), so the lock still opens on a river with no
signal. This matters — a lock that fails closed when offline would be a bug that
loses a day's fishing.

### (b) Cloud accounts with sync

Supabase, Netlify Identity, Auth.js, or similar. Real accounts, real multi-device
sync, a shared log with fishing partners, and a backup that survives a dropped
phone.

**What it actually protects against.** Data loss, which is a real risk that
posture (a) does nothing about — today, a phone in the river takes the whole log
with it, and `exportJson` is the only backup mechanism. It also enables the
features the app clearly wants (`lib/store.js:6-9` names a shared backend as the
intended future).

**What it does not protect against.** It does not help with 1.1 or 1.2 unless a
lock is *also* built — a signed-in session on an unlocked phone is exactly as
exposed as today. And it introduces 1.6, which is strictly worse than every other
threat in this document combined: a single database compromise discloses every
user's complete coordinate history at once, to an attacker who never had physical
access to anything, and it cannot be undone.

**Complexity cost.** High, and it breaks three stated constraints at once. It
requires a service role key or equivalent, therefore environment variables,
therefore a Netlify dashboard, therefore an end to "deploying from a phone."
It requires the API routes to grow from stateless proxies into authenticated
endpoints with session handling. And it puts framework-coupled auth code
uncomfortably close to `lib/`, which the portability contract says must stay
dependency-free.

**Interaction with offline-first capture.** This is where it genuinely hurts, and
it is under-appreciated. Sync and offline-first capture are in direct tension:

- Sessions expire. A user who has been off-grid for a weekend comes back to an
  expired session. If capture depends on a valid session, capture breaks in
  exactly the scenario the app exists for. The rule in `CLAUDE.md` — write
  locally, enqueue, return — must extend to the sync push, meaning IndexedDB
  stays the source of truth and the server is a replica, not the other way
  round.
- The outbox becomes two queues: one for enrichment and one for upload. They
  fail independently.
- Conflict resolution appears. Two devices, one open trip, both offline. There
  is no good generic answer; last-writer-wins on a per-record basis is
  defensible here because records are append-mostly and single-author.

**Recommendation.** Do posture (a) now. It addresses the two threats that will
actually occur, costs the least, and violates no constraint. Do posture (b) only
when multi-device sync is a real user requirement rather than a nice-to-have —
and when it happens, do it *in addition to* the lock, not instead of it, with
end-to-end encryption so that 1.6 degrades from "catastrophic" to "annoying."
Design (a) with (b) in mind: see §4.

---

## 3. Concrete recommendations

### 3.1 Session handling

Relevant only under posture (b); under (a) there is no session, which is the
point.

**Never put a session token in `localStorage` or `sessionStorage`.** The reason is
specific to this app rather than generic: Riffle already executes third-party
JavaScript from `unpkg.com` on every page that renders a map
(`components/PinMap.js:14-15`), with no CSP and no SRI. Anything readable by
JavaScript on that origin should be assumed readable by that script. A session
token in `localStorage` is one supply-chain incident away from being an
attacker's session token, and it would remain valid until expiry with no
revocation signal. An `httpOnly` cookie survives the same incident: the script can
*use* the session while the page is open, but it cannot read the token, cannot
exfiltrate it, and loses access the moment the tab closes.

Concretely, for the pages router:

```
Set-Cookie: riffle_session=<opaque id or signed JWT>;
  HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1209600
```

- `HttpOnly` — not readable from JS. Non-negotiable, for the reason above.
- `Secure` — HTTPS only. Free; the site is HTTPS-only anyway because mobile
  Safari requires it for geolocation.
- `SameSite=Lax` — blocks cross-site POSTs while still allowing top-level
  navigation into the app. Sufficient CSRF defence for this app's shape. If any
  state-changing endpoint ever accepts a top-level GET navigation, use `Strict`
  or add a token.
- `Path=/` and no `Domain` attribute, so the cookie is host-only and does not
  leak to any sibling subdomain of the Netlify site.

**Lifetime and refresh.** A fishing log is not a bank. Long sessions are the
correct trade here, because a session that expires mid-trip in a dead zone is a
bug that costs a day's data. Use a 14-day rolling session refreshed on use rather
than a short access token plus a refresh token — the short-token pattern exists to
limit the blast radius of a token readable by JavaScript, and if the token is
`httpOnly` it buys much less. Keep the session record server-side (or use a short
JWT with a server-side revocation list) so that "sign out of all devices"
actually works; a bare stateless JWT cannot be revoked, and for a dataset like
this, revocation matters.

**Logout must destroy local data.** This is the part that is usually got wrong.
Clearing the cookie is meaningless if the entire log is still sitting in
IndexedDB for the next person who opens the app. Logout must:

1. Clear the session cookie server-side (`Max-Age=0`).
2. Zero the in-memory decryption key.
3. Delete the IndexedDB database outright — `indexedDB.deleteDatabase('riffle')`,
   not a per-store clear, so no object store is missed. Note that `lib/store.js:17`
   caches `dbPromise` at module scope; it must be reset to `null` or the next open
   will resolve to a handle on a deleted database.
4. Revoke any outstanding blob object URLs. `photoUrl` (`lib/store.js:113-116`)
   calls `URL.createObjectURL` and nothing ever calls `revokeObjectURL`; those
   URLs remain live and readable for the lifetime of the document.
5. Clear the `localStorage` keys holding the WebAuthn credential id and salt.

Under posture (b) this is safe because the server holds a copy. Under posture (a)
there is no "logout" — there is only "erase," and it needs a confirmation dialog
that says so plainly. See §3.8.

### 3.2 Encryption at rest in IndexedDB

**Cipher.** AES-256-GCM via `crypto.subtle`. A fresh 96-bit IV per record,
generated with `crypto.getRandomValues`, stored alongside the ciphertext.
**Never reuse an IV under the same key** — GCM fails catastrophically on IV reuse,
leaking the authentication subkey, and the natural mistake here is to derive one
IV at unlock and use it for every write. Generate per write, no exceptions.

**What to encrypt.** Encrypt the record value, not the key. Keep `id`, `tripId`,
and the `droppedAt`/`at` timestamps in plaintext so that `keyPath: 'id'` and the
`tripId` index (`lib/store.js:31-33`) keep working, and encrypt everything else —
crucially `lat`, `lon`, `accuracyM`, `notes`, `species`, `companions`, and the
photo blob — as one opaque field. This means an attacker with the raw database
learns that the user fished on twelve occasions in June and how many fish they
caught, but not where. That is the right trade: it preserves the store's query
shape entirely, so `byTrip` and `all` need no changes, while protecting the field
that actually matters.

Do this by wrapping `put`/`putMany`/`get`/`all`/`byTrip` in `lib/store.js` rather
than by changing every caller. `lib/app.js` should not know encryption exists.

**Key derivation.** Two paths, and you need both because coverage is not
universal:

*Preferred — WebAuthn PRF.* The `prf` extension lets a passkey produce a
deterministic 32-byte secret from a stored salt during a normal authentication
ceremony. This is the right primitive: the key material is gated by the platform
authenticator (Face ID / Touch ID / Windows Hello), it never exists on disk, and
there is no password to forget or phish. As of 2026 support is good but not
complete: Android via Google Password Manager has it across Chrome, Edge and
Samsung Internet; Safari 18+ supports it for passkeys in iCloud Keychain (though
Apple still does not pass extension data to external roaming authenticators);
Windows Hello began returning PRF values after the February 2026 update. WebAuthn
Level 3, which specifies PRF, reached Proposed Recommendation in July 2026. Feature-detect
per credential rather than per browser — call `getClientExtensionResults()` and
check for a `prf.results.first` value — and fall back when it is absent.

Do not use the PRF output directly as the AES key. Run it through HKDF-SHA-256
with a per-install salt and an info string (`'riffle-record-v1'`) so that you can
rotate the derived key later without re-enrolling the passkey.

*Fallback — passphrase.* Where PRF is unavailable, derive from a user passphrase.
WebCrypto exposes PBKDF2 and nothing better; Argon2id is the current OWASP
recommendation but is not available in `crypto.subtle`, and getting it means a
WASM build, which would put a dependency inside `lib/` and break the portability
contract. So: PBKDF2-HMAC-SHA-256, **600,000 iterations minimum** (the current
OWASP figure), 16-byte random salt stored in `localStorage`. Be honest in the UI
that this is weaker than the passkey path and that a short passphrase is not
protection — PBKDF2 is not memory-hard and is cheap to attack on a GPU, so the
strength here is almost entirely the entropy of what the user types. On the
native iOS build, replace this whole path with a Keychain-stored key protected by
`kSecAccessControlBiometryCurrentSet`, which is strictly better than anything the
web can do.

**Where the key can and cannot live.**

- **Can:** in a JavaScript variable in module scope for the lifetime of the
  unlocked session, held as a non-extractable `CryptoKey` (`extractable: false`
  in `importKey`/`deriveKey`), so that even a script running on the origin can
  use it but cannot read out the bytes and mail them home.
- **Cannot:** `localStorage`, `sessionStorage`, IndexedDB, a cookie, a URL, or a
  service worker cache. Storing the key next to the ciphertext it protects makes
  the encryption decorative. This includes "just for the outbox" — resist the
  temptation to persist the key so that background enrichment can run while
  locked. Salt, IV, credential id, and iteration count are all fine to store in
  plaintext; only the key is not.

**The honest limits.** With the device unlocked and the app unlocked, an attacker
gets everything, full stop. Encryption at rest buys you: a stolen device that is
powered off or locked, a forensic image, a copied browser profile, a device
backup, and a shared computer where the browser profile persists. It buys you
nothing against someone watching over a shoulder, someone handed the running app,
malware with the ability to script the page, or a compromised `unpkg` script after
unlock. Say this in the UI if the UI makes any claim at all. "Encrypted on your
device" invites users to believe things that are not true.

### 3.3 Row-level authorization, if a backend appears

Only under posture (b). The rule is simple and absolute: **every row carries an
owner column, every query filters on it, and the filter is enforced by the
server, never by the client.**

With Supabase this means Postgres RLS, which is the reason to pick it:

```sql
alter table pins enable row level security;

create policy "owner reads own pins" on pins
  for select using (user_id = auth.uid());

create policy "owner writes own pins" on pins
  for insert with check (user_id = auth.uid());

create policy "owner updates own pins" on pins
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

create index on pins (user_id);
```

The details that bite:

- Enable RLS on **every** table in the public schema. A table without RLS is
  readable by anyone holding the project URL and the anon key, both of which ship
  in the client bundle by design. Enabling RLS defaults to deny-all, which is the
  correct default and will look like a bug the first time you hit it.
- `select` policies use `using`; `insert` policies use `with check`; `update`
  needs both. Getting this wrong produces a policy that reads correctly and
  enforces nothing on write.
- Use `auth.uid()`, never a `user_id` sent by the client. A client-supplied owner
  id is not authorization, it is a suggestion.
- Index the owner column. `user_id = auth.uid()` on an unindexed column becomes a
  sequential scan on every request.
- Test through the client SDK as an authenticated user. The Supabase SQL editor
  runs as `postgres`, which bypasses RLS entirely and will cheerfully tell you
  your broken policies work.
- Never ship the service role key to the client, and never put it in
  `NEXT_PUBLIC_*`. It bypasses RLS by design.

If the backend is hand-rolled in `pages/api/*` instead, the same rule applies with
no framework help: resolve the user from the `httpOnly` session cookie on every
request, and derive the owner id from that resolution only. Any endpoint that
takes an id from the request body and does not re-check ownership against the
session is an IDOR, and with this dataset an IDOR means enumerating other
people's fishing spots.

### 3.4 Photos and blobs

**Strip EXIF before storage, not just before upload.** `savePhoto`
(`lib/store.js:98-111`) writes `blob` verbatim. `CLAUDE.md` correctly notes that
iOS and mobile browsers strip GPS from in-app camera captures — but that is only
true for the camera path. A user who picks an existing photo from their library
via a file input gets the original file, EXIF intact: GPS coordinates, original
capture timestamp, camera make/model/serial, and sometimes a lens and firmware
version. Those coordinates may be from a completely different place than the pin,
and the device serial is a cross-app identifier.

Re-encode on capture rather than trying to parse and delete EXIF tags. Draw the
image to a `<canvas>` at the target size and call `canvas.toBlob(cb, 'image/jpeg', 0.85)`;
the canvas encoder emits no EXIF at all, so this is strip-by-construction and
cannot miss a tag. It also caps the storage cost, which IndexedDB will thank you
for. The one caveat is orientation: read the EXIF orientation flag before
discarding it and bake the rotation into the canvas transform, or portrait photos
come out sideways.

Note that this cannot live in `lib/` — `canvas` is a browser global and
`lib/store.js` is one of the two modules already exempted by the portability
contract, but adding image processing to it muddies that. Put the re-encode in the
UI layer, before `savePhoto` is called, and have `savePhoto` reject any blob it
was not handed by that path if you want a belt-and-braces guarantee.

**If photos ever leave the device**, under posture (b):

- Private bucket, no public read. Not "hard to guess URL" — actually private.
- Short-lived signed URLs, minutes not days, generated per request against the
  session's user id. A signed URL is a bearer token; it will end up in browser
  history and in the `Referer` header of anything the page loads afterwards.
- Object paths keyed by an unguessable id, `{user_id}/{random}`, so that bucket
  path enumeration reveals nothing even if a listing endpoint is misconfigured.
- Storage-level RLS as well as bucket policy, so a leaked anon key does not grant
  a directory listing.
- Never derive the object path from the coordinates or the water name.

### 3.5 Location hygiene

This is the part most specific to Riffle, and the part most likely to be
overlooked because coordinates do not *feel* like credentials.

**Reduce precision on everything that is ever shared or exported.** Decimal
degrees at these latitudes: 5 places ≈ 1 m, 4 ≈ 11 m, 3 ≈ 110 m, 2 ≈ 1.1 km,
1 ≈ 11 km. A shared trip report needs 2 places at most; a public one needs 1, or
no coordinates at all. Full precision belongs only in the local database and in a
deliberate full-fidelity export the user has been warned about.

`lib/conditions.js:27-32` already establishes the pattern — `snapshotKey` rounds
to `toFixed(2)` because a hundredth of a degree is the resolution at which
conditions are actually meaningful. Reuse that judgement: build a
`coarsen(lat, lon, places)` helper in `lib/model.js` and route every outbound
coordinate through it.

**Coarsen what goes to third parties, too.** Today the app sends more precision
than any upstream can use:

- `lib/sources/openMeteo.js:62-63` sends `lat.toFixed(4)` / `lon.toFixed(4)` —
  roughly 11 metres — to Open-Meteo. Weather models run on 1-11 km grids; four
  decimal places is meaningless to them and precisely locating to a third party.
  Two places loses nothing and gives Open-Meteo a 1 km box instead of a
  building.
- `pages/api/stations.js:22` searches a 50 km bounding box, so the request itself
  is coarse — but the centre point is the user's exact position, passed through
  from `lib/app.js:58` at full float precision in a query string.
- `components/PinMap.js:55` loads OpenStreetMap tiles. Tile requests reveal the
  viewport to `tile.openstreetmap.org` at whatever zoom the user is at, along
  with a `Referer` header naming the page. Tiles at zoom 14-19 over a specific
  river bend are as good as coordinates. This is unavoidable with any hosted tile
  server; it is worth knowing, and it is another argument for the native build's
  MapKit.

**Exact coordinates must never reach logs, analytics, or error reports.** Three
specific problems in the current code:

1. `snapshotUrl` (`lib/app.js:165-178`) puts full-precision `lat` and `lon` and a
   minute-precision ISO timestamp into a **query string**. Query strings are
   logged by default at every hop — Netlify's edge access logs, the function
   invocation logs, and anything sitting in front of them. Every enrichment pass
   for every pin writes the user's exact position into a server log they cannot
   see or purge. For an app that describes itself as device-local, this is the
   largest quiet privacy gap in the repo. Move the parameters into a `POST` body,
   or at minimum coarsen `lat`/`lon` to two decimal places before they go into
   the URL — nothing downstream needs more.

2. `pages/api/conditions.js:41-44` sets `Cache-Control: public, max-age=86400,
   s-maxage=604800` on those same URLs. Netlify's shared CDN honours `s-maxage`
   and keys by full URL, so exact coordinates become **shared-CDN cache keys held
   for a week**. Caching the conditions response is a good idea and should be
   kept — but key it on something coarse. Round the coordinates before building
   the upstream key, exactly as `snapshotKey` already does, and the cache hit rate
   goes *up* while the leak goes away.

3. Both routes echo upstream error strings straight to the client
   (`pages/api/conditions.js:47`, `pages/api/stations.js:33`). Node's `fetch`
   failures embed the full request URL in `err.message`, which means a transient
   USGS outage returns a JSON body containing the coordinates that were queried.
   Log the detail server-side (coarsened) and return a fixed string.

If any error-reporting or analytics SDK is ever added, add a scrubber for
`lat`, `lon`, `accuracyM`, and anything matching a decimal-degree pattern in a
URL, and verify it against a real captured event. Sentry-style breadcrumb capture
of `fetch` URLs will otherwise ship coordinates to a third party by default.

### 3.6 Securing `pages/api/*`

**Input validation.** Both routes coerce with `Number()` and check
`Number.isFinite` (`conditions.js:16-19`, `stations.js:16-18`), which is the right
instinct but incomplete. Add range checks — `lat` in [-90, 90], `lon` in
[-180, 180] — and validate the rest:

- `stationId` should match `/^[A-Za-z0-9]{1,20}$/`. USGS site numbers are 8-15
  digits; NOAA station ids are 7 digits.
- `provider` should be `'usgs' | 'noaa'` from an allowlist. It is already
  effectively allowlisted by the `if/else if` in `lib/conditions.js:60-68`, but
  rejecting at the edge is clearer and cheaper.
- `kind` should be `'river' | 'lake' | 'salt'`; `stations.js:30` currently
  defaults anything unrecognised to `'lake'`.
- `at` should be bounded — reject dates more than a few years past or more than a
  day in the future. `new Date(at)` accepts a wide range and an absurd date
  produces a large upstream query.
- `tz` is passed to `Number()` (`conditions.js:36`) with no validation and lands
  in `astroSnapshot`. Bound it to ±840 minutes.

**SSRF: not exploitable today, and here is why.** I traced every path where
user input reaches a URL:

- `lib/sources/usgs.js:75, 178, 229` — base URLs are module constants
  (`SITE_URL`, `IV_URL`, `STAT_URL`) and user input reaches them only through
  `new URLSearchParams({...})`, appended after a literal `?`.
- `lib/sources/noaa.js:63` — same shape, with `DATA_URL` as a constant.
- `lib/sources/openMeteo.js:81, 88` — `FORECAST_URL` / `ARCHIVE_URL` constants,
  and `lat`/`lon` have already been through `Number()` and `.toFixed(4)`.

`URLSearchParams` serialises as `application/x-www-form-urlencoded`, which
percent-encodes everything outside `[A-Za-z0-9*-._]` — including `/`, `:`, `?`,
`#`, and `@`. A `stationId` of `../../evil` or `x?redirect=http://169.254.169.254`
arrives at USGS as an inert encoded query value. There is no path traversal, no
host substitution, and no second-request injection. **The station id is not an
SSRF vector as the code stands.** The property that makes this safe is the
constant base URL plus `URLSearchParams` — if either is ever replaced with
template-string URL building, the analysis flips immediately, so add a comment
saying so at each call site.

**Rate limiting and open-proxy prevention.** This is the actual exposure. Both
routes are anonymous, methodless, and unlimited, and `/api/stations?kind=salt`
can force a repeated download of NOAA's full station list on cold instances. Do
all of:

- Reject anything that is not `GET` with a 405 and an `Allow` header. Free, and
  it removes a class of abuse immediately.
- Rate-limit per client IP (`x-nf-client-connection-ip` on Netlify), something
  like 60 requests per minute per IP for `/api/conditions` and 10 for
  `/api/stations`. Netlify offers rate limiting at the edge; for a
  handful-of-users app, a small in-memory token bucket in the function is not
  perfect across instances but raises the cost enough to matter.
- Add a `Cache-Control` header to `/api/stations` — it has none. Station
  candidate lists for a coarsened point are stable for months. `public,
  s-maxage=86400` cuts the abuse value of that route to nearly nothing.
- Check the `Origin` header and reject cross-origin requests. These routes exist
  solely to be called by this app's own pages (`CLAUDE.md`: "exist only for
  CORS"); they should not be usable from anywhere else. Do not add permissive
  CORS headers to them — the current absence of `Access-Control-Allow-Origin` is
  correct and load-bearing.
- Keep the upstream allowlist implicit-by-construction (constant base URLs) and
  never add a `url` or `endpoint` parameter to these routes. That is the single
  change that would turn them into a genuine open proxy.

**One more thing.** `lib/sources/noaa.js:24` holds `stationCache` in module scope,
which in a serverless function is shared across every request handled by that
warm instance. It caches public station metadata, so it is harmless today. It is
worth a comment, because the same pattern applied to anything user-specific —
a snapshot cache keyed by coordinates, say — would leak one user's data to the
next request on the same instance.

### 3.7 Security headers and CSP

There are no security headers configured anywhere: `netlify.toml` has only a
`[build]` block and the plugin declaration, and `next.config.js` (lines 1-7) sets
only `reactStrictMode` and `swcMinify`. Add them.

On Netlify with `@netlify/plugin-nextjs`, headers set in `netlify.toml` are
applied after the build and take precedence over framework-emitted headers, which
makes `netlify.toml` the more reliable place for these than `next.config.js`'s
`headers()`. A starting policy:

```toml
[[headers]]
  for = "/*"
  [headers.values]
    Content-Security-Policy = """
      default-src 'self';
      script-src 'self' 'unsafe-inline' https://unpkg.com;
      style-src 'self' 'unsafe-inline' https://unpkg.com;
      img-src 'self' data: blob: https://tile.openstreetmap.org https://unpkg.com;
      connect-src 'self';
      font-src 'self';
      frame-ancestors 'none';
      base-uri 'none';
      form-action 'none';
      object-src 'none'
    """
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "no-referrer"
    Permissions-Policy = "geolocation=(self), camera=(self), microphone=(), interest-cohort=()"
    Strict-Transport-Security = "max-age=31536000; includeSubDomains"
```

Notes on the choices:

- `connect-src 'self'` is the important line. The client only ever fetches its own
  `/api/*` routes (`lib/app.js:58, 182, 205`) — every upstream call happens
  server-side. So a strict `connect-src` costs nothing and is precisely the
  control that stops a compromised Leaflet from exfiltrating the log. Verify
  before shipping: `img-src` needs `blob:` for `photoUrl`'s object URLs
  (`lib/store.js:115`) and `data:` for Leaflet's inlined marker icons.
- `Referrer-Policy: no-referrer` stops the app's own URLs — which include
  `/trip/{id}` — from reaching `unpkg.com` and `tile.openstreetmap.org`.
- `'unsafe-inline'` in `script-src` is required by Next.js's hydration inline
  script in the pages router. Removing it means nonces, which means
  `_document.js` and a middleware; worth doing eventually, not a blocker now.
- `frame-ancestors 'none'` plus `X-Frame-Options: DENY` — the app has nothing
  clickjackable today, but it will (a delete button, an export button).

**The unpkg dependency.** Assessed at 1.4 above as the highest-impact vector in
the app. Two fixes, in order of preference:

1. **Bundle it.** `npm i leaflet@1.9.4`, `import 'leaflet'` and
   `import 'leaflet/dist/leaflet.css'`, delete `loadLeaflet` entirely. The
   version is then pinned in `package-lock.json`, integrity-checked by npm on
   install, and served from the app's own origin — so `script-src` and
   `style-src` can drop `https://unpkg.com` and become plain `'self'`, and the
   supply-chain risk drops to "the same risk as every other dependency," which is
   the risk you already accept for React. The stated objection
   (`components/PinMap.js:4-7`) is that Leaflet does not survive into the native
   MapKit build and so "earns no place in the dependency tree" — but that
   argument is about `lib/`, and `components/` is explicitly disposable prototype
   UI. A prototype-only dependency in a prototype-only directory violates nothing
   in the portability contract. This is the recommended fix.

2. **If it stays on the CDN, add SRI.** `<script integrity="sha384-..."
   crossorigin="anonymous">`, set as properties on the elements created at
   `PinMap.js:22` and `PinMap.js:35`. Compute the hashes yourself rather than
   copying them from a blog post — the whole point is to verify:

   ```
   curl -sS https://unpkg.com/leaflet@1.9.4/dist/leaflet.js \
     | openssl dgst -sha384 -binary | openssl base64 -A
   ```

   Note that SRI on the stylesheet only protects the CSS bytes; a CSS file cannot
   execute script, but it can exfiltrate via background-image URLs, so include it.
   Also add `require-sri-for script style` intent by keeping the CDN host in the
   CSP allowlist as narrowly as possible. SRI is strictly worse than bundling —
   it pins the bytes but leaves availability and the `Referer` leak in a third
   party's hands — but it closes the arbitrary-execution hole, which is what
   matters.

**Also fix the popup XSS** (`components/PinMap.js:90-95`) while in that file.
Either escape `pin.name`, or better, build the popup as a DOM node and use
`textContent`:

```js
const el = document.createElement('div');
const b = document.createElement('b');
b.textContent = pin.name || `Spot ${i + 1}`;
el.append(b, document.createElement('br'),
  document.createTextNode(new Date(pin.droppedAt).toLocaleTimeString(...)));
marker.bindPopup(el);
```

Leaflet accepts an `HTMLElement` and will not parse it as markup.

### 3.8 Export and deletion

**Export is the user's right to leave, and it is incomplete.** `exportJson`
(`lib/store.js:190-193`) serialises `waters`, `trips`, `pins`, and `catches` via
`loadAll` (lines 179-184). It omits the `photos` store entirely and the pending
`outbox`. A user who exports, wipes, and re-imports loses every photograph and
every not-yet-enriched job. That is a data-loss bug wearing a portability
feature's clothes.

Fix it as a zip or a JSON-with-base64 bundle, and offer two modes with the
difference stated plainly in the UI:

- **Full fidelity** — exact coordinates, all photos. For backup and migration.
  Warn at the point of export that the file contains precise locations and should
  be treated like a password file.
- **Shareable** — coordinates coarsened to two decimal places via the `coarsen`
  helper from §3.5, photos re-encoded with EXIF stripped, `companions` and
  `notes` optional. For sending a season summary to a friend.

Under posture (a), also make export the *only* backup, and say so — the honest
version of "your data never leaves your device" is "your data never leaves your
device, including when the device goes in the river."

**Deletion has to be real.** There is currently no way to delete anything beyond
a single record: `lib/store.js` exports `remove` (lines 78-81) and nothing else.
There is no "delete this trip and its pins and catches and photos," and no
"erase everything."

Add both. Cascading trip deletion needs to walk `pins`, `catches`, and the
`photoIds` on each catch (`lib/model.js:62`), plus any `outbox` entries keyed
`pin:{id}` / `catch:{id}` (`lib/store.js:127`), or the queue will keep retrying
enrichment for records that no longer exist — `drainOutbox` currently handles this
gracefully (`lib/app.js:201` throws `'record vanished'`, which increments
`attempts` until it hits the cap at `lib/store.js:155`), but it will retry six
times first, and those retries put the deleted record's coordinates back into the
server logs. Dequeue on delete.

Full erase should be `indexedDB.deleteDatabase('riffle')` plus resetting the
cached `dbPromise` (`lib/store.js:17`) plus clearing the crypto salt and
credential id from `localStorage`. Do not implement it as a loop of per-record
deletes: IndexedDB tombstones and page-level artefacts can leave recoverable
fragments, and deleting the database is both simpler and more thorough.

Be honest about what "irrecoverable" means. Deleting the database does not
overwrite the underlying disk blocks, and on flash storage nothing you can do
from JavaScript will. It is unrecoverable through the browser, and recoverable in
principle by forensic tooling on an unencrypted device. If the records were
encrypted at rest per §3.2, destroying the key material makes deletion
cryptographically final, which is the strongest guarantee available — another
argument for doing (a) before (b).

Under posture (b), deletion must propagate: a server-side delete, and an
acknowledgement that backups may retain the data for their retention window. Say
the retention window out loud in whatever privacy text exists.

---

## 4. Migration: from ownerless local records to account-scoped

Every record created so far has no owner. `newWater`, `newTrip`, `newPin`, and
`newCatch` (`lib/model.js:16-68`) produce a `uid()` and no `userId`, and
`lib/store.js` has `DB_VERSION = 1` (line 13) with a single upgrade path that only
creates stores (lines 27-35). Whatever posture is chosen, do the schema work
*now*, while there is one user and no sync — it is nearly free today and
genuinely painful later.

**Step 1 — add the field before it is needed.** Bump `DB_VERSION` to 2 and add an
`onupgradeneeded` branch that walks every record in `waters`, `trips`, `pins`,
`catches`, and `photos` and stamps `ownerId: 'local'` on any record lacking one.
`'local'` is a deliberate sentinel: it means "created before accounts existed on
this device." Add an `ownerId` index on each store at the same time. Have
`newWater`/`newTrip`/`newPin`/`newCatch` default `ownerId` to the current owner or
`'local'`. Nothing else changes; the app carries on working exactly as it does.

Note that `openDb` (`lib/store.js:19-40`) caches `dbPromise` at module scope and
the upgrade runs once per device. Make the migration idempotent — check for the
field's absence rather than assuming a clean run — because a partially-completed
upgrade after a crashed tab is a real state.

**Step 2 — claim, don't merge.** When the user first signs in on a device holding
`ownerId: 'local'` records, do not silently attach them to the account. Show a
count — "You have 43 trips and 210 catches on this device. Add them to your
account?" — and on confirmation rewrite `ownerId` from `'local'` to the real user
id in a single IndexedDB transaction per store. The reason to ask rather than
assume: a shared or borrowed device may hold someone else's log, and silently
uploading a housemate's fishing spots to your account is exactly the failure this
whole document is about.

Preserve the existing `uid()` values as the primary key rather than reissuing
ids. Everything is joined by them — `tripId` on pins and catches, `pinId` on
catches, `photoIds` on catches, `waterId` on trips, and the `outbox` id format
`{kind}:{recordId}` (`lib/store.js:127`) — and reissuing means rewriting all of
it under a partial-failure window. Server-side, make the primary key
`(owner_id, id)` or keep `id` as a text column with a unique constraint scoped by
owner; do not assume `uid()` is globally unique, because it is not. Which leads
to:

**Step 3 — fix `uid()` before ids cross a trust boundary.** `lib/model.js:11-12`:

```js
export const uid = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
```

`Math.random()` is not a CSPRNG, and six base-36 characters is about 31 bits of
(non-cryptographic) entropy on top of a millisecond timestamp. As a local
IndexedDB key on a single device this is fine and I would not touch it in
isolation. It stops being fine the moment an id appears in a URL, a share link, a
signed photo URL, or a server-side row key — at that point it is guessable, and
guessable ids plus any authorization gap equals enumeration of other people's
coordinates. Replace it with `crypto.randomUUID()`, which is available in all
current browsers and in Node 20, needs no dependency, and keeps `lib/` clean.
Existing short ids can stay; only new records need the new format, since ids are
opaque strings everywhere they are consumed.

**Step 4 — sync respects the capture rule.** IndexedDB stays the source of truth.
Add a second outbox kind (`kind: 'sync'`) alongside the existing enrichment jobs
so that `drainOutbox` (`lib/store.js:145-176`) handles both, and keep the same
contract: a failed push stays queued, only a confirmed server ack dequeues. Do not
introduce a code path where a capture handler awaits an upload — that is the one
rule in `CLAUDE.md` that everything else is built around, and an auth check is
just as much a network round trip as a snapshot fetch.

**Step 5 — never let migration be the thing that loses a log.** Before the first
sync push, and before any destructive migration step, write a full-fidelity
export to a file the user downloads. A migration bug that drops records is more
likely than any attack in §1, and it is the failure users will never forgive.

---

## Summary of concrete findings

| # | Location | Issue |
|---|---|---|
| 1 | `pages/api/conditions.js:41-44`, `lib/app.js:165-178` | Exact coordinates and minute timestamps in query strings, cached `public` with `s-maxage=604800` in a shared CDN and written to server access logs |
| 2 | `components/PinMap.js:14-15, 20-38` | Leaflet loaded from unpkg with no SRI and no CSP; arbitrary JS on an origin holding the whole log |
| 3 | `components/PinMap.js:90-95` | `bindPopup` interpolates unescaped `pin.name` into HTML — stored XSS, self-only today |
| 4 | `lib/store.js:19-40` | Entire log stored in plaintext IndexedDB with no app-level lock |
| 5 | `lib/store.js:98-111` | Photo blobs stored verbatim; library picks retain GPS EXIF and device serial |
| 6 | `lib/store.js:190-193` | `exportJson` omits photos and the outbox — incomplete portability, silent data loss on wipe-and-restore |
| 7 | `lib/store.js` (absent) | No cascading delete and no full erase; `remove` (78-81) is per-record only |
| 8 | `lib/model.js:11-12` | `uid()` uses `Math.random()` — fine locally, unsafe as soon as an id is a URL or a row key |
| 9 | `pages/api/conditions.js:47`, `pages/api/stations.js:33` | Upstream error strings echoed to the client; `fetch` errors embed the queried URL and therefore coordinates |
| 10 | `pages/api/*` | No method check, no rate limit, no `Origin` check; `/api/stations` sets no `Cache-Control` and can force repeated NOAA station-list downloads |
| 11 | `netlify.toml`, `next.config.js` | No security headers of any kind — no CSP, HSTS, `Referrer-Policy`, or `Permissions-Policy` |
| 12 | `lib/sources/noaa.js:24` | Module-scope `stationCache` shared across requests in a warm serverless instance; harmless for public data, a leak pattern for anything else |
| 13 | `lib/store.js:113-116` | `createObjectURL` with no matching `revokeObjectURL`; blob URLs stay live for the document's lifetime |

**Assessed and found not exploitable:** SSRF via `stationId`, `provider`, or
coordinates. Every upstream URL is built from a module-constant base plus
`URLSearchParams`, which percent-encodes all URL-significant characters. See
§3.6 for the reasoning and for what would break it.
