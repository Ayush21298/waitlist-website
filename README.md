# R2P Openlab — Waitlist Platform

One backend, one admin panel, and a separate frontend for each app. Products
share the API, the database and the admin panel, but each keeps its own
landing page, its own numbering and its own statistics.

The whole site sits behind an access password, so holding the link is not
enough to see anything. The admin panel sits behind a second, separate
password on top of that.

```
                        ┌─────────────────────────────────┐
   visitor ────────────▶│  site gate   (password #1)      │
                        └───────────────┬─────────────────┘
                                        │
              ┌─────────────────────────┼──────────────────────────┐
              ▼                         ▼                          ▼
      /a/pages/            /a/<other-app>/              /admin  (password #2)
      landing page          landing page                admin panel
              │                         │                          │
              └─────────────┬───────────┘                          │
                            ▼                                      ▼
                   POST /api/v1/apps/:slug/waitlist       /api/v1/admin/*
                            │                                      │
                            └──────────────┬───────────────────────┘
                                           ▼
                              SQLite file  or  Postgres
```

---

## Quick start

```bash
npm run setup                 # installs backend dependencies
cp .env.example .env
npm run generate-secrets      # paste the two secrets into .env
#                             # then set SITE_GATE_PASSWORD and ADMIN_PASSWORD
npm start
```

Then open <http://localhost:8080>. You will be asked for the site password
first; the landing page is behind it.

The admin panel is at **`/admin`**.

With Docker instead:

```bash
docker compose up --build
```

---

## What is where

| Path | What it is |
|---|---|
| `backend/src/` | The API server. Nothing here is app-specific. |
| `backend/test/` | End-to-end tests, run against a real server. |
| `frontend/gate/` | The site password page — the only unauthenticated screen. |
| `frontend/admin/` | The admin panel (statistics, list, activity log, exports). |
| `frontend/apps/<slug>/` | One landing page per app, served at `/a/<slug>/`. |
| `scripts/` | Smoke test, load test, secret generation. |
| `data/`, `logs/` | Runtime state. Both gitignored. |

---

## Adding a second app

The backend already supports it; nothing in it needs changing.

1. **Register the app** — in the admin panel under *Apps*, or by adding it to
   `backend/src/seed.js` so it is created on first boot.
2. **Add its landing page** at `frontend/apps/<slug>/index.html`. Copy the
   Pages one as a starting point.
3. **Point it at its own slug.** In the page's script:

   ```js
   var APP_SLUG = 'your-slug';
   var API = '/api/v1/apps/' + APP_SLUG;
   ```

It is then served at `/a/<slug>/`, numbers its own waitlist from 1, and shows
up in the admin panel beside the others. Because every frontend is served
from the same origin as the API, cookies and CSRF work with no cross-origin
configuration at all.

---

## The admin panel

Sign in at `/admin` with the admin password.

- **Overview** — totals, a daily-signups chart, a per-app breakdown, and where
  signups are coming from.
- **Waitlist** — every entry with name, email, phone, position and status.
  Search across name, email and phone; filter by app and status; change a
  status or add a note inline.
- **Activity log** — a searchable record of everything that has happened:
  signups, rejections, admin actions, failed logins, lockouts, rate limiting.
- **Apps** — register a new app or deactivate one.

**Exports** are on the Waitlist and Activity tabs, in CSV, Excel (`.xlsx`),
TSV, JSON and NDJSON. An export honours whatever filters are on screen, so
"pending signups for Pages" exports exactly that. Tick *Include source &
device columns* to add attribution fields.

Statuses are `pending` → `invited` → `joined`, plus `removed`. A `removed`
entry drops out of the public counter but keeps its record — prefer it to
deletion, which is irreversible.

---

## Configuration

Everything is environment variables; `.env.example` documents all of them.
The ones that matter:

| Variable | Notes |
|---|---|
| `SITE_GATE_PASSWORD` | Guards the whole site. Required. |
| `ADMIN_PASSWORD` | Guards the admin panel. Required, and must differ from the above. |
| `SESSION_SECRET` | Signs sessions. Required in production, ≥32 chars. |
| `IP_HASH_SECRET` | Keys the IP pseudonyms in the logs. Required in production. |
| `DATABASE_URL` | Empty → SQLite on disk. Set → Postgres. |
| `TRUST_PROXY_HOPS` | Number of proxies in front. Getting this wrong breaks rate limiting — see [DEPLOYMENT.md](DEPLOYMENT.md). |

The server refuses to start on a bad configuration rather than starting up
insecure: a missing secret, a secret that is too short, or the two passwords
being identical are all fatal at boot.

---

## Showing it to someone

To open the site on your phone, or hand it to a colleague for ten minutes:

```bash
npm run share
```

That publishes the local server on a temporary public HTTPS URL via a
Cloudflare quick tunnel — no account, no card, no signup. The site password
still applies, so the URL being public does not make the site public. Stop it
with Ctrl-C and the URL disappears.

It exists mainly to get two settings right that are silently wrong otherwise:
`TRUST_PROXY_HOPS`, without which every visitor looks like one client, and
`CORS_ALLOWED_ORIGINS`, because Cloudflare rewrites the `Host` header and the
server would otherwise refuse every write as cross-origin.

> If the URL does not open, it is almost always DNS filtering on your own
> network rather than a broken tunnel — many ISP and corporate resolvers block
> `*.trycloudflare.com` because those tunnels are abused for phishing. The
> script detects exactly that and prints the fixes. See
> [DEPLOYMENT.md](DEPLOYMENT.md#if-the-tunnel-url-does-not-open).

## Testing

```bash
npm test              # 50 end-to-end API tests against a real server (SQLite)
npm run test:postgres # the same suite against a disposable Postgres container
npm run ui-test -- --gate-password ... --admin-password ... --shots ./shots
npm run smoke -- --base https://your-deployment --gate-password ... --admin-password ...
npm run loadtest -- --devices 25 --seconds 20 --gate-password ...
```

The API tests boot a genuine server on an ephemeral port and drive it over
HTTP, because the defects worth catching — a session that does not stick, a
CSRF check that never fires, a position handed out twice under load — only
appear when the real middleware, the real cookie jar and the real database
are all in play.

`ui-test` goes a layer further: it drives the actual pages in Chromium the way
a person would — unlock the gate, sign up, open the admin panel, change a
status, export a CSV, sign out — and can save screenshots. It asserts what an
API test structurally cannot, namely that the pages are wired to the backend
at all. It requires Playwright's browser, installed once with:

```bash
npx playwright install chromium
```

Both of the bugs found late in development were found this way: a counter
animation that overwrote a new signup's position, and HSTS being withheld on
a real HTTPS connection.

`smoke.mjs` is safe against production: it creates one clearly-labelled entry
and tells you how to remove it.

### Measured behaviour

With 60 simulated devices continuously loading the page, polling the counter
and signing up (server-side timings, from its own log):

| Endpoint | Requests | p50 | p99 | max |
|---|---:|---:|---:|---:|
| Counter poll | 11,658 | 0.20 ms | 0.60 ms | 1.22 ms |
| Landing page (1.4 MB) | 3,886 | 0.36 ms | 1.06 ms | 74 ms |
| Signup | 40 | 0.70 ms | 2.20 ms | 2.20 ms |

Zero errors, ~1,030 requests/second sustained. Comfortably more than the ten
concurrent devices this needs to support.

The browser suite has also been run end to end against a live public tunnel
over real HTTPS, not only against localhost, so proxy headers, `Secure`
cookies and HSTS are exercised on the path a real visitor takes.

---

## Logging

Two records, for two different jobs.

**The log file** (`logs/waitlist.log`, and stdout) is the firehose: one JSON
object per line, size-rotated, with a request id on every line so all the
records for one request can be pulled out together. Sensitive keys are
redacted, so an accidental log of a request body cannot leak a password.

```bash
tail -f logs/waitlist.log | jq 'select(.level != "info")'
```

**The activity trail** in the database is the searchable record, and it is
what the admin panel's Activity tab shows: signups, rejections, duplicates,
honeypot hits, every admin action, failed logins, lockouts, rate limiting.
It is exportable like any other table.

Visitor IP addresses are never stored raw. They are recorded as keyed HMAC
pseudonyms, which still lets you tell "these ten signups came from one
address" without retaining the address itself.

---

## Security

The short version: two separate password perimeters, scrypt-hashed and never
stored in plaintext; sessions that are revocable and stored only as digests;
CSRF defended three ways; strict security headers; rate limiting and
exponential lockout that survive a restart; and every value validated before
it reaches the database.

The long version, including what is *not* defended against, is in
[SECURITY.md](SECURITY.md).

---

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for hosting options, the checklist, and
what to do about backups.
