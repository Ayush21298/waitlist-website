/**
 * Prints a fresh set of secrets for a new deployment.
 *
 * Each deployment should have its own: sharing SESSION_SECRET between
 * staging and production means a session minted in one is valid in the other.
 */
import crypto from 'node:crypto';

const secret = () => crypto.randomBytes(48).toString('base64url');

console.log(`
Paste these into your .env (development) or your host's secret store
(production). Generate a new set for every environment.

SESSION_SECRET=${secret()}
IP_HASH_SECRET=${secret()}

Then set the two access passwords, which are yours to choose:

SITE_GATE_PASSWORD=...   # guards the whole site
ADMIN_PASSWORD=...       # guards the admin panel; must differ from the above
`);
