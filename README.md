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

## Running it on any machine

Two commands, from nothing:

```bash
./scripts/bootstrap.sh        # installs Node, npm, git, curl, build tools if missing
npm start
```

`bootstrap.sh` is shell rather than Node on purpose — it has to be able to
install Node itself. It detects your OS and package manager (apt, dnf, yum,
pacman, zypper, apk, Homebrew), works out exactly what is missing, **shows you
the plan and asks before touching anything**, then installs it and hands off to
`npm run setup`. If it cannot use a package manager it falls back to `nvm`,
which needs no root at all.

```bash
./scripts/bootstrap.sh --dry-run       # show the plan, change nothing
./scripts/bootstrap.sh --yes           # no prompts, for scripted installs
./scripts/bootstrap.sh --with-browser  # also install Chromium for the UI tests
```

`npm run setup` handles the project itself: installs dependencies, writes a
`.env` with **freshly generated secrets**, asks for your two passwords, and
then proves the server actually boots before telling you it worked. It never
overwrites an existing `.env`, so it is safe to re-run.

> Verified from scratch in a bare Debian container with no Node, npm, git,
> curl, compiler or Python: both commands, then a passing 27-check smoke test.

Then open <http://localhost:8080>. You are asked for the site password first;
the landing page is behind it. The admin panel is at **`/admin`** and asks for
the second password.

### Which command does what

| Command | Reachable from | Contacts anything external? |
|---|---|---|
| `npm start` / `npm run lan` | this machine **and your whole network** | **No.** Nothing outside your machine. |
| `npm run share` | the public internet | Yes — opens a Cloudflare tunnel. |

`lan` and `start` are the same command; `lan` exists so the name answers the
question by itself. Use `share` **only** when you need the site reachable from
outside your network. Verified: `npm start` spawns no tunnel client and holds
no outbound connections at all.

### Reaching it from other devices on your network

Nothing extra to run — the server already binds `0.0.0.0`, so it is reachable
from any device on the same Wi-Fi or LAN. On startup it prints the addresses:

```
  Waitlist is running.
    on this machine  http://localhost:8080
    on your network  http://10.12.211.201:8080
    admin panel      http://localhost:8080/admin
```

Open the `on your network` address on a phone or another computer. Everything
works over plain HTTP on a LAN: the session cookie omits `Secure` when the
connection is not HTTPS (a `Secure` cookie would be dropped by the browser and
you would never get past the gate), and the same-origin check compares against
whatever address you used, so no configuration is needed.

To bind one interface only, set `HOST`:

```bash
HOST=127.0.0.1 npm start     # this machine only, not reachable from the LAN
PORT=8090 npm start          # a different port
```

Use a tunnel (`npm run share`) only when you need the site reachable from
*outside* your network. For a phone on the same Wi-Fi, the LAN address is
simpler, faster and involves no third party.

If you would rather not install anything at all:

```bash
docker compose up --build
```

### Moving it to another machine

Copy or clone the project, then run the same two commands there.

`.env` is deliberately **not** copied — it is gitignored, and it holds this
machine's secrets. `npm run setup` generates new ones on the new machine.
Give it the same two passwords if you want both machines to behave
identically; the signing secrets are meant to differ per machine, and the
waitlist data lives in `data/` (or in Postgres), not in `.env`.

To move the data as well, copy `data/waitlist.sqlite`, or export it from the
admin panel and keep the file.

---

## What is where

| Path | What it is |
|---|---|
| `backend/src/` | The API server. Nothing here is app-specific. |
| `backend/test/` | End-to-end tests, run against a real server. |
| `frontend/gate/` | The site password page — the only unauthenticated screen. |
| `frontend/admin/` | The admin panel (statistics, list, activity log, exports). |
| `frontend/apps/<slug>/` | One landing page per app, served at `/a/<slug>/`. |
| `misc/` | Where design uploads land before import. Gitignored. |
| `scripts/` | Smoke test, load test, secret generation. |
| `data/`, `logs/` | Runtime state. Both gitignored. |

---

## The apps

| App | Page | Collects | Limit |
|---|---|---|---|
| **Pages** | `/a/pages/` | name, email | 50 places; the form closes when full |
| **C·Dots** | `/a/cdots/` | email only | 100 places; the page counts down |

They share one backend, one database and one admin panel, but nothing else:
different designs, different fields, and one counts up to its limit while the
other counts down from it. What an app asks for and how many places it offers
are rows in the `apps` table, editable from the admin panel, not code.

## Adding a third app

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

   Then `GET {API}/count` for the counter and `POST {API}/waitlist` to sign
   up. If the app has a capacity, the count response carries `capacity` and
   `remaining`, and a signup past the limit comes back as
   `{ ok: false, error: 'full' }`.

Assets go alongside the page — `frontend/apps/<slug>/assets/…` is served at
`/a/<slug>/assets/…`. Fonts, CSS, SVG and HTML are compressed and cached
automatically.

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
  status or add a note inline. An app that does not collect a field shows an
  em dash rather than a blank cell.
- **Apps** — what each app asks for, its capacity, and its landing page. The
  capacity is editable: raising it reopens a closed beta, and the landing
  page picks the change up on its next load.
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
