# Security

This service holds other people's names, email addresses and phone numbers.
That is the thing worth protecting, and it shapes every decision below.

The honest framing first: **nothing is "hack proof."** What follows is
defence in depth — several independent layers, each of which has to fail
before data is exposed — plus an explicit list of what is *not* covered, so
the gaps are known rather than assumed away.

---

## The two perimeters

They are separate on purpose.

**The site gate** stands in front of everything a visitor can reach. Without
a gate session, no landing page and no API returns anything but the login
screen. A leaked link on its own opens nothing.

**The admin panel** sits behind its own, different password on top of that.
Reaching the waitlist data therefore requires both.

The server refuses to start if the two passwords are the same, because the
gate is by design the weaker perimeter — its password is shared with every
invited visitor.

Health probes (`/healthz`, `/readyz`) are deliberately outside the gate: a
platform health checker cannot log in, and a probe that requires a password
is a probe that reports a healthy service as down. Neither reveals anything —
no versions, no hostnames, no counts, no connection strings.

**Web app manifests and their icons are also outside it**, for a similar
reason. A browser fetches a manifest with credentials omitted, so behind a
redirecting gate it receives the login page instead of JSON and reports the
app as not installable — silently, with nothing on the page to explain it.
The exemption is a pattern, not a directory: only a file named
`manifest.webmanifest` or a PNG under an `icons/` directory matches, so it
cannot widen by accident, and a crafted path cannot escape it (tested).

What that discloses is an app name and a logo. What stays behind the gate is
every page, the signup form, the service worker, all other assets, the whole
API and the admin panel.

---

## Passwords and sessions

| Concern | How it is handled |
|---|---|
| Password storage | Neither password is stored. Each is turned into an **scrypt** hash (N=32768, r=8) at boot; the plaintext exists only in the environment. |
| Comparison | Constant time, always. Comparisons are made over fixed-size digests so length never leaks through timing. |
| Session tokens | 256 bits of entropy. Only a **SHA-256 digest** is persisted, so a database leak yields nothing replayable — and sessions stay individually revocable. |
| Logout | Revokes the session server-side, not just the cookie. A replayed cookie after logout is rejected (tested). |
| Admin idle timeout | 45 minutes. An unattended admin panel does not stay open. |
| Admin device binding | The admin session is bound to the client's user-agent hash, so a stolen cookie is useless from another client. The IP is deliberately *not* bound — mobile networks rotate it mid-session and would log legitimate admins out constantly. |

### Cookies

| | Site gate | Admin |
|---|---|---|
| `HttpOnly` | yes | yes |
| `SameSite` | `Lax` | `Strict` |
| `Secure` | in production / over HTTPS | in production / over HTTPS |
| Lifetime | 12 hours | 8 hours, 45 min idle |

The gate cookie is `Lax` rather than `Strict` for a practical reason: `Strict`
would drop the cookie when a visitor follows a link to the site from anywhere
else, re-prompting on every arrival. The admin panel is only ever reached by
typing its address or from within the site, so it takes the stricter setting.

---

## CSRF — defended three times

1. **SameSite cookies**, so a cross-site request does not carry a session at all.
2. **An Origin/Referer check** on every state-changing request. This one exists
   specifically to cover *login*, which a session-bound token cannot protect:
   without it, a cross-site POST can log a victim into an attacker's session.
3. **A session-bound token** required on every admin write, in the
   `X-CSRF-Token` header. It is bound to the session row rather than to a
   second cookie, so it is a value an attacker can neither read nor set.
   Another session's valid token is rejected (tested).

---

## Rate limiting and lockout

Two layers, because they defend against different things.

- **A per-process sliding window**, in memory, cheap enough to run on every
  request. It absorbs bursts and accidental request loops. A sliding window
  rather than a fixed one, because a fixed window lets a caller spend a full
  budget at the end of one window and again at the start of the next.
- **A database-backed lockout** for password attempts, with backoff that is
  exponential in the number of failures *since the last success*. It is in the
  database because an in-process counter hands an attacker a fresh budget
  every time the platform recycles the process — and free tiers recycle often.

Signups have a durable backstop of their own, counted from the entries table,
for the same reason.

Defaults: 8 password attempts per IP per 15 minutes; 10 signups per IP per
hour; 240 public API calls per IP per minute.

**Concurrent password hashing is capped** with a bounded queue. scrypt is
deliberately expensive and, in Node, runs on the same small thread pool that
serves file reads — so an unbounded login burst starves ordinary page serving.
This was measured, not theorised: 60 concurrent logins pushed landing-page p99
from under a millisecond to 1.5 seconds. Capping it returned p99 to 1.06 ms.
Slow login is a security feature; slow *everything else* is an outage.

---

## Input handling

Every value passes through one validation layer before it reaches the
database, and no value is ever interpolated into SQL.

- **Parameterised statements everywhere.** The only identifiers that vary —
  sort column and direction — are mapped through allow-lists. A
  `sort=position; DROP TABLE entries--` parameter falls back to the default
  ordering; there is verifiably no path from a query parameter to SQL text.
- **Invisible characters are stripped** — zero-width joiners, bidi overrides,
  C0/C1 controls. They are a common source of look-alike duplicate signups and
  of text that renders one way in the admin panel and another in a mail client.
- **Length caps on everything**, applied after normalisation so padding cannot
  smuggle an oversized value past a limit. Request bodies are capped at 16 KB.
- **Metadata is never interpreted.** Referrer, user agent and campaign strings
  are attacker-controlled: they are truncated, stored, and only ever displayed
  as text.

### Two injection paths that are easy to miss

**Spreadsheet formula injection.** A waitlist stores names typed by strangers.
Without a defence, a signup called `=HYPERLINK("http://evil","click")` becomes
a live formula the moment an administrator opens the CSV. Values beginning
`=`, `+`, `-` or `@` are prefixed with an apostrophe, which forces Excel,
LibreOffice and Sheets to treat them as literal text.

**DOM injection in the admin panel.** Admin table rows are built with
`createElement` and `textContent`, never by string concatenation — that is
exactly how a hostile name ends up executing in an administrator's browser.
The helper that builds elements throws if handed an `html` key, so the rule
cannot be broken by accident later.

---

## Response headers

Sent on every response:

```
Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
  font-src 'self' data: https://cdn.jsdelivr.net; img-src 'self' data:;
  connect-src 'self'; form-action 'self'; frame-ancestors 'none';
  base-uri 'none'; object-src 'none'; upgrade-insecure-requests
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: accelerometer=(), camera=(), geolocation=(), ...
Strict-Transport-Security: max-age=31536000; includeSubDomains   (over HTTPS)
```

`X-Powered-By` is removed: there is no reason to tell an attacker which stack
to target.

HSTS is sent whenever the request actually arrived over HTTPS, rather than
only when `NODE_ENV` says production — a tunnelled or staging deployment is
still a real HTTPS connection and should still be pinned. It is withheld over
plain HTTP, because a browser that records the pin for `localhost` makes local
development unreachable. This is the same rule the `Secure` cookie flag uses,
so the two cannot disagree. A forged `X-Forwarded-Proto` cannot trigger it
when no proxy is trusted; both directions are covered by tests.

**A known weakness:** `script-src` and `style-src` allow `'unsafe-inline'`,
because the landing page inlines its styles and its script. That is a real
reduction in XSS defence-in-depth. It is mitigated by the fact that no user
data is ever rendered as HTML anywhere in the application, but the honest
fix is to move to hashed or nonced inline blocks. See *Known gaps* below.

---

## Errors and disclosure

An internal failure produces a fully-detailed, correlated record on the
server, and an opaque message plus a request id to the client. Stack traces,
SQL text and file paths are precisely the reconnaissance an attacker wants
and help a legitimate user not at all — while the request id makes a support
report actionable.

Login failures return one message for every failure mode. Nothing reveals
whether a password was close, or how long the real one is.

---

## Privacy

- **IP addresses are never stored raw.** They are recorded as keyed HMAC
  pseudonyms, which still allows "these ten signups came from one address"
  without retaining the address. The key is separate from the session secret,
  so a leaked log cannot be correlated with session material.
- **Log redaction.** Keys such as `password`, `token`, `cookie` and
  `authorization` are replaced wherever they appear at any depth.
- **Query strings are not logged**, since they can carry personal data.
- **The activity trail is pruned** on a schedule (365 days by default).
- **`removed` status instead of deletion** keeps a record while dropping the
  entry from public counts. Deletion is available and is irreversible; it is
  recorded in the activity trail as a warning-level event.

---

## Path traversal and static files

Static paths are resolved and then checked to be inside their root *after*
normalisation, which is what stops `..%2f..%2f` and its encoded variants.
Dotfiles are never served. Both are covered by tests that attempt to fetch
`.env` and backend source through every mount.

---

## Known gaps

Stated plainly, because a security document that claims completeness is not
trustworthy.

1. **`'unsafe-inline'` in the CSP.** Required by the current single-file
   landing page. The fix is per-block hashes or a nonce.
2. **App names and icons are public**, by the deliberate trade above: a
   manifest and its icons are served without a session so the apps can be
   installed. Someone who guesses a URL learns that "Pages" and "C·Dots"
   exist, and sees their icons. They learn nothing else and can do nothing.
3. **The site gate is a shared password.** Everyone invited holds the same
   secret, and it cannot be revoked per person. It is a perimeter against
   casual discovery and link-sharing, not against a determined insider.
   Revoking it means changing it and telling everyone.
4. **In-memory rate limiting is per instance.** Running more than one replica
   multiplies the effective burst limit by the replica count. The lockout and
   the signup backstop are database-backed and unaffected.
5. **No email verification.** Anyone can enter anyone's address. For a beta
   waitlist that is usually acceptable; if it is not, add a confirmation link.
6. **No 2FA on the admin panel.** A single password is the only factor.
7. **Data at rest is not encrypted by the application.** It relies on the
   host's disk or database encryption.
8. **No automated dependency scanning in CI.** `npm audit` currently reports
   zero vulnerabilities across 118 packages, but that is a point-in-time
   check; run it on a schedule.

---

## Operational advice

- Give every environment its own `SESSION_SECRET`. Sharing one between staging
  and production means a session minted in one is valid in the other.
- Set `TRUST_PROXY_HOPS` to the real number of proxies. Too high and a client
  can forge `X-Forwarded-For`, which is the identity every rate limit and
  lockout is keyed on.
- Rotate the passwords by changing the environment variables and restarting.
  Existing sessions survive; change `SESSION_SECRET` too to force everyone out.
- Watch for `gate.locked_out`, `admin.login_failed` and `admin.csrf_rejected`
  in the activity log. A run of them is worth looking at.
- `npm run share` puts the site on the public internet. The site password
  still applies, but the URL is guessable-by-nobody rather than secret, and
  the tunnel is unauthenticated infrastructure you do not control. Use it for
  a demo, not as a way to run the service.

## Reporting a vulnerability

Email **patel.ayush08@gmail.com**. Please do not open a public issue.
