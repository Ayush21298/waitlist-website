/**
 * First-run setup for a fresh machine.
 *
 * Checks the environment, installs dependencies, writes a .env with freshly
 * generated secrets, and proves the result actually boots. Everything is
 * idempotent: running it twice is safe, and an existing .env is never
 * overwritten.
 *
 * The point is that the failure modes are named. Setting this up by hand goes
 * wrong in four predictable ways -- wrong Node version, a native module that
 * cannot compile, a missing .env, a port already in use -- and each of those
 * produces an error message that does not obviously say which of the four it
 * is. This says.
 *
 * Usage:
 *   npm run setup
 *   npm run setup -- --site-password 'x' --admin-password 'y'   (unattended)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const MIN_NODE = 20;
let failed = false;

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const bad = (msg) => {
  failed = true;
  console.log(`  ✗ ${msg}`);
};

function heading(text) {
  console.log(`\n${text}`);
}

/* ------------------------------------------------------------------ *
 * 1. Environment
 * ------------------------------------------------------------------ */
heading('Checking this machine');

const major = Number(process.versions.node.split('.')[0]);
if (major >= MIN_NODE) {
  ok(`Node ${process.versions.node}`);
} else {
  bad(`Node ${process.versions.node} is too old; this needs Node ${MIN_NODE} or newer. Install it from https://nodejs.org`);
}

try {
  const npmVersion = execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
  ok(`npm ${npmVersion}`);
} catch {
  bad('npm was not found on PATH.');
}

// better-sqlite3 ships prebuilt binaries for common platforms and falls back
// to compiling. When it has to compile, a missing toolchain is the single
// most common setup failure, and its error message is a wall of node-gyp
// output that never says "install a compiler".
if (process.platform === 'linux' || process.platform === 'darwin') {
  const haveCompiler = ['c++', 'g++', 'clang++'].some((bin) => {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (haveCompiler) ok('a C++ compiler is available (needed only if better-sqlite3 has no prebuilt binary)');
  else {
    warn(
      'no C++ compiler found. Usually fine -- better-sqlite3 ships prebuilt binaries.\n' +
        '    If the install below fails, on Debian/Ubuntu run:\n' +
        '      sudo apt-get install -y python3 make g++',
    );
  }
}

if (failed) {
  console.log('\nFix the items marked ✗ above, then run this again.');
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 2. Dependencies
 * ------------------------------------------------------------------ */
heading('Installing dependencies');

const lockfile = path.join(ROOT, 'backend', 'package-lock.json');
const installCommand = fs.existsSync(lockfile) ? 'ci' : 'install';
const install = spawnSync('npm', ['--prefix', path.join(ROOT, 'backend'), installCommand], {
  stdio: 'inherit',
});
if (install.status !== 0) {
  console.log(
    '\nThe dependency install failed. The usual cause is a missing build toolchain\n' +
      'for better-sqlite3. On Debian/Ubuntu:\n' +
      '  sudo apt-get install -y python3 make g++\n' +
      'then run this again.',
  );
  process.exit(1);
}
ok('backend dependencies installed');

/* ------------------------------------------------------------------ *
 * 3. Configuration
 * ------------------------------------------------------------------ */
heading('Configuration');

const envPath = path.join(ROOT, '.env');
const secret = () => crypto.randomBytes(48).toString('base64url');

if (fs.existsSync(envPath)) {
  ok('.env already exists; leaving it untouched');

  // Warn about the things that stop the server booting, without printing values.
  const existing = fs.readFileSync(envPath, 'utf8');
  const missing = ['SITE_GATE_PASSWORD', 'ADMIN_PASSWORD', 'SESSION_SECRET', 'IP_HASH_SECRET'].filter(
    (key) => !new RegExp(`^\\s*${key}\\s*=\\s*\\S`, 'm').test(existing),
  );
  if (missing.length) warn(`.env is missing a value for: ${missing.join(', ')}`);
} else {
  let sitePassword = args.get('site-password');
  let adminPassword = args.get('admin-password');

  if (!sitePassword || !adminPassword) {
    if (!process.stdin.isTTY) {
      console.log(
        '\nNo .env found and no terminal to prompt on. Re-run with:\n' +
          "  npm run setup -- --site-password 'something' --admin-password 'something-else'",
      );
      process.exit(1);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('\n  Two passwords are needed. They must be different from each other.');
    console.log('  The first guards the whole site; the second guards the admin panel.\n');
    sitePassword ||= (await rl.question('  Site access password : ')).trim();
    adminPassword ||= (await rl.question('  Admin panel password : ')).trim();
    rl.close();
  }

  if (sitePassword.length < 8 || adminPassword.length < 8) {
    bad('Both passwords must be at least 8 characters.');
    process.exit(1);
  }
  if (sitePassword === adminPassword) {
    bad('The two passwords must differ; the server refuses to start otherwise.');
    process.exit(1);
  }

  fs.writeFileSync(
    envPath,
    `# Generated by "npm run setup" on ${new Date().toISOString()}.
# This file holds secrets and is gitignored. Never commit it.

NODE_ENV=development
PORT=8080
HOST=0.0.0.0

# ---- access passwords ----
SITE_GATE_PASSWORD=${sitePassword}
ADMIN_PASSWORD=${adminPassword}

# ---- signing secrets (unique to this machine) ----
SESSION_SECRET=${secret()}
IP_HASH_SECRET=${secret()}

# ---- storage ----
# Empty means a local SQLite file under ./data.
# Set a Postgres URL when deploying somewhere with an ephemeral filesystem.
DATABASE_URL=

# Number of reverse proxies in front of this server. 0 when run directly.
TRUST_PROXY_HOPS=0
`,
    { mode: 0o600 },
  );
  ok('.env written with freshly generated secrets (permissions 600)');
}

/* ------------------------------------------------------------------ *
 * 4. Port
 * ------------------------------------------------------------------ */
heading('Checking the port');

const port = Number(process.env.PORT ?? 8080);
const portFree = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.once('listening', () => probe.close(() => resolve(true)));
  probe.listen(port, '0.0.0.0');
});
if (portFree) ok(`port ${port} is free`);
else warn(`port ${port} is already in use. Start on another with:  PORT=8090 npm start`);

/* ------------------------------------------------------------------ *
 * 5. Prove it boots
 * ------------------------------------------------------------------ */
heading('Verifying it starts');

const verifyPort = portFree ? port : 0;
const probePort = verifyPort || 8099;
const child = spawnSync(
  process.execPath,
  ['-e', `
    process.env.PORT = '${probePort}';
    process.env.LOG_TO_FILE = 'false';
    process.env.LOG_TO_CONSOLE = 'false';
    const { spawn } = require('child_process');
    const server = spawn(process.execPath, ['backend/src/server.js'], { env: process.env, stdio: 'ignore' });
    const done = (code, message) => { try { server.kill('SIGTERM'); } catch {} console.log(message); process.exit(code); };
    let tries = 0;
    const tick = () => {
      tries += 1;
      fetch('http://127.0.0.1:${probePort}/readyz')
        .then((r) => (r.ok ? done(0, 'ready') : Promise.reject(new Error('not ready'))))
        .catch(() => (tries > 30 ? done(1, 'timeout') : setTimeout(tick, 500)));
    };
    setTimeout(tick, 700);
  `],
  { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
);

if (child.stdout?.includes('ready')) {
  ok('the server boots, migrates its database and reports ready');
} else {
  bad('the server did not come up. Run "npm start" to see the error.');
}

/* ------------------------------------------------------------------ *
 * Done
 * ------------------------------------------------------------------ */
if (failed) {
  console.log('\nSetup finished with problems; see the ✗ items above.');
  process.exit(1);
}

console.log(`
Setup complete.

  npm start          run it            ->  http://localhost:${port}
  npm run share      publish a temporary public HTTPS URL
  npm test           run the test suite

The site password is asked for first; the landing page is behind it.
The admin panel is at /admin and asks for the second password.

Your passwords and secrets are in .env, which is gitignored. Copying this
project to another machine does NOT copy .env -- run this script there too,
and it will generate new secrets. Use the SAME passwords if you want the two
machines to feel identical; the secrets are per-machine by design.
`);
