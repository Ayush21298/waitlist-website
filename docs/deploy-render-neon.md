# Deploying to Render + Neon

About 15 minutes. No credit card at any point.

You end up with a permanent HTTPS URL that works from anywhere, whether or not
your own machine is on, and with the signup data somewhere Render's restarts
and redeploys cannot touch.

**Why this pairing.** Render runs the app but gives free services no
persistent disk, and its free Postgres is a 30-day trial that is deleted
afterwards with no recovery. Neon's free Postgres is permanent, needs no card,
and states plainly that none of its free limits delete your data. So: Render
for the process, Neon for the data. The process can be recycled at will
because the data is not on it.

---

## Before you start

Push everything, since Render deploys from GitHub:

```bash
git push origin main
```

Have ready:

- The two passwords — the site gate one and the admin one. They must differ;
  the server refuses to start otherwise.
- A GitHub account with this repository (`Ayush21298/waitlist-website`).

You do **not** need to prepare secrets: Render generates `SESSION_SECRET` and
`IP_HASH_SECRET` itself.

---

## Step 1 — Create the database (Neon)

1. Go to **[neon.com](https://neon.com)** and sign up. GitHub sign-in is
   fastest. No card is requested.
2. Create a project. Name it anything; **pick a region close to your users**
   — for Korea, an Asia-Pacific region such as Singapore. Choose an **AWS**
   region rather than Azure.
3. When the project is created, Neon shows a **connection string**. Copy it.
   If you have navigated away, it is behind the **Connect** button on the
   project dashboard.

It looks like:

```
postgresql://neondb_owner:SOMEPASSWORD@ep-cool-name-12345678.ap-southeast-1.aws.neon.tech/neondb?sslmode=require
```

**Take the direct connection string, not the pooled one.** If Neon offers a
choice, the pooled host has `-pooler` in it. This app keeps a small bounded
connection pool of its own from one long-lived process, which is exactly what
a direct connection is for, and it avoids the prepared-statement quirks that
connection poolers introduce.

Keep `?sslmode=require` on the end. The app expects TLS to anything that is
not localhost.

> Neon suspends a free database after 5 minutes idle and wakes it in a few
> hundred milliseconds. That is normal and costs you nothing. This app closes
> its idle connections after 30 seconds precisely so the database *can*
> suspend — holding them open would keep it awake and burn the monthly compute
> allowance.

---

## Step 2 — Deploy the app (Render)

1. Go to **[render.com](https://render.com)** and sign up with GitHub. No card
   is requested for the free tier.
2. **New → Blueprint**.
3. Pick the `waitlist-website` repository. Render reads `render.yaml` from the
   repo and proposes one free web service called `r2p-waitlist`.
4. It will prompt for the three values the blueprint deliberately does not
   contain:

   | Prompt | What to enter |
   |---|---|
   | `SITE_GATE_PASSWORD` | your site password |
   | `ADMIN_PASSWORD` | your admin password (must differ) |
   | `DATABASE_URL` | the Neon string from step 1 |

5. Apply. The first build takes roughly 5–10 minutes — it compiles
   `better-sqlite3` and copies the fonts, so it is slower than later deploys.

Everything else is already set by `render.yaml`: production mode, one proxy
hop so client IPs are read correctly, logging to stdout where Render captures
it, and generated signing secrets.

### What you should see in the logs

On first boot the app creates its own schema and both apps. Render's **Logs**
tab should show, as JSON lines:

```
database selected   dialect=postgres
migration applied   version=1  initial_schema
migration applied   version=2  per_app_name_and_capacity
migration applied   version=3  pages_capacity_and_no_phone
migration applied   version=4  pages_capacity_100
migration applied   version=5  korean_app_descriptions
app provisioned     slug=pages
app provisioned     slug=cdots
listening           port=8080  dialect=postgres
```

If you see `dialect=sqlite`, `DATABASE_URL` did not reach the service — the
data would then be lost on the next deploy. Fix it before going further.

---

## Step 3 — Check it works

Render gives you a URL like `https://r2p-waitlist.onrender.com`.

From your machine:

```bash
npm run smoke -- --base https://r2p-waitlist.onrender.com \
  --gate-password 'your-site-password' \
  --admin-password 'your-admin-password'
```

27 checks: the gate refusing strangers and admitting the password, a signup
landing and de-duplicating, the admin password being separate, CSRF enforced,
exports downloading, and the security headers surviving Render's proxy. It
creates one clearly-labelled test entry and tells you how to remove it.

Then open the URL in a browser. You should get the password screen, then the
app index with both apps.

---

## Step 4 — Turn on nightly backups

Do this now rather than later. Neon's free plan gives a **six-hour** restore
window, which does not survive a mistake noticed the next morning — and your
own bad migration is a likelier cause of loss than anything Neon does.

1. Make sure the GitHub repository is **private**. The backups contain names
   and email addresses, and scheduled workflows on public repositories are
   disabled automatically after 60 days of inactivity.
2. Repository → **Settings → Secrets and variables → Actions → New repository
   secret**:
   - Name: `DATABASE_URL`
   - Value: the same Neon string
3. Repository → **Actions → Backup waitlist → Run workflow** to test it
   immediately rather than waiting for 03:17 UTC.
4. Download the artifact it produces and open the `.csv`. If it has your test
   signup in it, backups work.

Take one manually before anything risky:

```bash
DATABASE_URL='postgres://...' npm run backup
```

---

## Step 5 — Your own domain (optional)

Render's URL works permanently, so this is cosmetic. For
`r2p.ayushpatel.com`:

1. In Render: your service → **Settings → Custom Domains → Add**, enter
   `r2p.ayushpatel.com`. Render shows the DNS target to use.
2. In BigRock's DNS manager for `ayushpatel.com`, add:

   ```
   Type: CNAME    Host: r2p    Points to: <the target Render showed>
   ```

3. Wait for propagation, then Render issues a TLS certificate automatically.

Your GitHub Pages site at `ayushpatel.com` is untouched — a subdomain is
independent of it.

If you also want `ayushpatel.com/r2p` to work, add a small page at `/r2p` in
your GitHub Pages repository that forwards to the subdomain. The shared link
is then on your main domain even though the app runs elsewhere.

---

## Step 6 — The cold start (optional)

Render spins a free service down after 15 minutes without traffic; the next
visitor waits about a minute. For a waitlist you are sharing deliberately,
that is usually fine.

To avoid it, point a free uptime monitor (UptimeRobot, Better Stack) at
`https://your-app.onrender.com/healthz` every 10–14 minutes. That endpoint
sits outside the password gate on purpose and does no database work, so it is
cheap to poll and will not keep Neon awake.

Be aware of the arithmetic: free services share **750 instance-hours per
month** and a month is about 730 hours, so one continuously-pinged service
fits with very little room. A second always-on free service would not.

---

## Troubleshooting

**Service won't start, logs mention a missing variable.** The server refuses
to boot on bad configuration rather than starting up insecure. It names the
variable. The usual causes: a secret shorter than 32 characters, or the two
passwords being identical.

**`dialect=sqlite` in the logs.** `DATABASE_URL` is not set on the service.
Render → service → **Environment**. Until this is fixed, every deploy wipes
the data.

**Signups fail but the page loads.** Check `/readyz` — if it returns 503 the
app is up but cannot reach Neon. Usually the connection string is wrong or is
missing `?sslmode=require`.

**Everyone appears to share one IP in the activity log.** `TRUST_PROXY_HOPS`
is wrong. It should be `1` on Render, which `render.yaml` sets. Symptom: one
visitor's mistyped password locks out everybody.

**First visitor of the day waits a minute.** That is the spin-down. See step 6.

**Changing a password later.** Render → service → **Environment**, edit, save.
The service restarts. Existing sessions survive; change `SESSION_SECRET` too
if you want to force everyone to sign in again.
