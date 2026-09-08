# Deployment

The service is one container with one writable directory. It runs anywhere
that can run Node 20+ or a Docker image, and it stores data either in a SQLite
file or in Postgres, chosen by whether `DATABASE_URL` is set.

That choice is the one that decides which hosts are viable:

| Host gives you | Use | Why |
|---|---|---|
| A persistent disk | **SQLite** (leave `DATABASE_URL` empty) | Simplest. No second service, no network hop. |
| An ephemeral filesystem | **Postgres** (set `DATABASE_URL`) | A SQLite file is wiped on every redeploy. |

---

## Hosting options, checked September 2026

Free tiers change often and several well-known ones have quietly disappeared.
What follows was verified against the providers' own pricing and documentation
pages; where something could not be confirmed, it says so.

### Recommended: Render + Neon — free, no credit card, ~10 minutes

The only combination here that needs **no card anywhere**, and the fastest to
stand up. A blueprint is committed as [`render.yaml`](render.yaml).

1. Push this repository to GitHub.
2. Create a free Postgres database at **[neon.com](https://neon.com/pricing)**.
   Neon's pricing page states the free plan is permanent, not a trial, and
   needs no credit card: 0.5 GB storage, 100 compute-hours per project per
   month, 5 GB egress.
3. In Render: **New → Blueprint**, pick the repo. It will prompt for
   `SITE_GATE_PASSWORD`, `ADMIN_PASSWORD` and `DATABASE_URL` (the Neon
   string). `SESSION_SECRET` and `IP_HASH_SECRET` are generated for you.
4. Smoke-test it:

   ```bash
   npm run smoke -- --base https://your-app.onrender.com \
     --gate-password '...' --admin-password '...'
   ```

**What you are accepting.** Render spins a free web service down after 15
minutes without traffic, and the next request takes roughly a minute to wake
it. Neon suspends its compute after 5 minutes idle — that resume is fast, but
it is not zero. Free Render services also share a 750 instance-hours-per-month
grant, and a 31-day month is 744 hours, so one continuously-pinged service
fits, but only just, and it uses the whole quota.

**Do not** use Render's own free Postgres: it expires 30 days after creation.
**Do not** use SQLite on Render: there is no free persistent disk.

To avoid the cold start, point a free uptime monitor at `/healthz` every 14
minutes. That endpoint is deliberately outside the site gate and does no
database work, so it is cheap to poll.

### For always-on: Oracle Cloud Always Free

The most capable free option and the only one on this list that never sleeps.
Oracle's documentation describes Always Free resources as free "for the life
of the account". Current allocation is **2 ARM OCPUs and 12 GB RAM** (halved
from 4/24 in June 2026), 200 GB block storage and 10 TB/month egress.

With a real disk you can use SQLite and skip the second service entirely:

```bash
git clone <your-repo> && cd waitlist-website
cp .env.example .env      # fill in passwords; run: npm run generate-secrets
docker compose up -d --build
```

Then put Caddy in front for automatic HTTPS:

```
your-domain.com {
    reverse_proxy localhost:8080
}
```

and set `TRUST_PROXY_HOPS=1`.

**What you are accepting.** Oracle authorises **$1** on a card to verify
identity at signup (it states the card is not charged unless you choose to
upgrade). ARM capacity is genuinely hard to get — "Out of host capacity" is
routine, regions with three availability domains do better, and people script
retry loops. Always Free compute can also be **reclaimed** if, across a 7-day
window, CPU, network and memory all sit below 20%; a waitlist plus the uptime
ping will normally stay above that, but it is a real policy. You also own the
OS, Docker, TLS and patching.

If ARM capacity never appears, the 2× AMD `E2.1.Micro` shapes (1 GB RAM each)
are far easier to provision and are enough for this service.

### Middle ground: Northflank Sandbox

Northflank's pricing page advertises a $0 tier with **always-on compute, no
sleeping**, two free services and one free database, building straight from a
Dockerfile. That makes it the only *managed* option here that avoids cold
starts.

**What you are accepting.** A payment method must be on file for verification
even on the free plan, the free tier's CPU and memory allocation is not
published, and Northflank's own documentation says the sandbox "should not be
used for production applications".

### Ruled out, and why

| Host | Status |
|---|---|
| **Fly.io** | No free tier. A card is required on all organisations; only a 2-hour/7-day trial exists. |
| **Railway** | The $0 plan grants $1/month of credit. At their published rates an always-on container costs roughly $2.50/month, so it cannot stay up. |
| **Koyeb** | Free web service no longer appears on their pricing page following the February 2026 Mistral acquisition; a card with a $29 authorisation hold is required. Reports that the free tier is closed to new signups could not be confirmed either way. |
| **Cloudflare Workers + D1** | Genuinely free forever and never sleeps, but it is the Workers runtime, not Node — Express would have to be rewritten, and the 10 ms CPU and 50-queries-per-invocation limits are hostile to this design. Containers need the $5/month paid plan. |
| **Hugging Face Spaces** | Docker Spaces now require a paid plan. |
| **Vercel / Netlify** | Functions only: no persistent disk and no database, and Vercel's Hobby tier is personal, non-commercial use. |
| **AWS** | For accounts created after 15 July 2025 the free tier is credits that expire at 6 months. |
| **Glitch, Deta** | Both shut down (July 2025 and October 2024). |

Supabase is a workable alternative to Neon if you want its extra tooling —
500 MB, permanent — but a free project **pauses after one week of inactivity**
and must be resumed by hand. For a low-traffic waitlist that is a worse
failure mode than Neon's automatic scale-to-zero.

---

## Testing it from another device before you deploy

If you only want to check the site on your phone, or show it to someone for a
few minutes, you do not need to deploy at all:

```bash
npm run share
```

This opens a temporary public HTTPS URL through a Cloudflare quick tunnel and
starts the server configured correctly for being behind a proxy. It is a
demo tool, not a hosting option: the URL dies with the command, and the
tunnel is infrastructure you do not control.

### If the tunnel URL does not open

Almost always this is DNS filtering on your own network, not a broken tunnel.
Cloudflare quick tunnels are heavily abused for phishing, so many ISP, campus
and corporate resolvers return NXDOMAIN for `*.trycloudflare.com` while still
resolving `trycloudflare.com` itself. `npm run share` detects this case and
says so explicitly rather than reporting a working tunnel as dead.

Confirm it in one command — if the first fails and the second succeeds, it is
your resolver:

```bash
getent hosts <name>.trycloudflare.com          # your network's answer
dig +short @1.1.1.1 <name>.trycloudflare.com   # the public answer
```

Three fixes, least invasive first:

1. **Open the link on another network** — a phone on mobile data rather than
   Wi-Fi. Nothing to change, and it confirms the tunnel is fine.
2. **Turn on Secure DNS (DoH) in your browser**, which bypasses the network
   resolver for the browser only and needs no administrator rights.
   Chrome: *Settings → Privacy and security → Security → Use secure DNS*.
   Firefox: *Settings → Privacy & Security → DNS over HTTPS*.
3. **Route just that one domain to a public resolver**, leaving all other DNS
   — including internal hostnames — on your network's server. On a
   systemd-resolved system, create
   `/etc/systemd/resolved.conf.d/trycloudflare.conf`:

   ```ini
   [Resolve]
   DNS=1.1.1.1 1.0.0.1
   Domains=~trycloudflare.com
   ```

   then `sudo systemctl restart systemd-resolved && resolvectl flush-caches`.
   The `~` prefix makes it a *routing* domain, so only names ending in
   `trycloudflare.com` are affected. Remove the file to undo.

None of this affects a real deployment: a deployed site is on your own
hostname, not a tunnel domain.

---

## Before you go live

- [ ] `SITE_GATE_PASSWORD` and `ADMIN_PASSWORD` set, and different from each
      other. The server refuses to start otherwise.
- [ ] `SESSION_SECRET` and `IP_HASH_SECRET` set, at least 32 characters,
      **unique to this environment**. Sharing them with staging means a
      session minted there is valid here.
- [ ] `NODE_ENV=production`.
- [ ] `TRUST_PROXY_HOPS` matches the real number of proxies — see below.
- [ ] `DATABASE_URL` set if the host's filesystem is ephemeral.
- [ ] HTTPS enforced. `Secure` cookies and HSTS depend on it.
- [ ] Health check pointed at `/readyz`.
- [ ] `npm run smoke` passes against the live URL.
- [ ] A backup schedule exists (below).

### Getting `TRUST_PROXY_HOPS` right

This is the setting most worth double-checking, because getting it wrong is
silent. The server reads the client IP from `X-Forwarded-For`, and that IP is
the identity every rate limit and lockout is keyed on.

| Setup | Value |
|---|---|
| Local, direct | `0` |
| One platform load balancer (Render, Northflank, Fly) | `1` |
| Cloudflare or another CDN in front of that | `2` |
| Your own nginx/Caddy on a VM | `1` |

Set it **too high** and a client can prepend a forged address and get a fresh
rate-limit budget on every request. Set it too low and everyone appears to
share the proxy's address, so one visitor's mistyped password locks out
everybody.

To verify: sign in, then look at an entry's *Client* column in the admin
panel's Activity tab. If every visitor shows the same pseudonym, the value is
too low.

---

## Backups

The waitlist is the asset. Everything else in this repository can be rebuilt.

**Postgres.** Neon and Supabase both keep point-in-time history on their free
plans, but do not rely on that alone:

```bash
pg_dump "$DATABASE_URL" --no-owner --format=custom --file="waitlist-$(date +%F).dump"
```

**SQLite.** Use the online backup command, not `cp` — copying a live database
file mid-write yields a corrupt snapshot:

```bash
sqlite3 data/waitlist.sqlite ".backup 'backup-$(date +%F).sqlite'"
```

**The low-tech backup that always works.** Open the admin panel and export
everything as XLSX or CSV. It takes ten seconds, the file is readable without
any of this software, and it is the one backup you can be sure you know how
to restore. Do it before any risky change.

---

## Operating it

**Watching logs.** Everything is one JSON object per line, on stdout and (when
`LOG_TO_FILE` is on) in `logs/waitlist.log`, rotated at 8 MB.

```bash
tail -f logs/waitlist.log | jq -c 'select(.level != "info") | {ts, level, msg, path, status}'
tail -f logs/waitlist.log | jq -c 'select(.durationMs > 500)'          # slow requests
grep '"requestId":"abc123"' logs/waitlist.log | jq .                    # one request end to end
```

**What is worth alerting on.** In the admin panel's Activity tab, or by
filtering the log:

| Event | Meaning |
|---|---|
| `gate.locked_out`, `admin.locked_out` | Someone is guessing passwords. |
| `admin.csrf_rejected` | A stale admin tab, or an attempted forgery. |
| `signup.honeypot` | Bot traffic found the form. |
| `ratelimit.blocked` | A client is hammering the API. |
| `server.error` | A real fault. Investigate with its `requestId`. |

**Rotating a password.** Change the environment variable and restart.
Existing sessions survive; to force everyone out, change `SESSION_SECRET` too.

**Scaling out.** The database-backed lockout and signup limits work across
replicas. The in-memory burst limiter does not — with N replicas the effective
burst allowance is N times the configured value. For this workload one
instance is comfortably enough: 60 simulated devices sustained ~1,030
requests/second on a single process with zero errors.

---

## Upgrading

Migrations run automatically at boot and are idempotent, so a deploy is just a
restart. On Postgres an advisory lock prevents two overlapping instances from
racing the same migration, which free platforms do routinely during a rollout.

```bash
git pull
npm --prefix backend ci
npm test              # 48 tests
npm start
```

Take a backup first. Rolling *back* a schema change is not automated — there
is one migration today, so this has not needed to be solved yet.
