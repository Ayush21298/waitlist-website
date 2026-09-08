/**
 * Runs the full test suite against a disposable Postgres container, so the
 * adapter that production actually uses is exercised, not just SQLite.
 *
 * Requires Docker. Leaves nothing behind.
 */
import { execFileSync, spawnSync } from 'node:child_process';

const NAME = 'waitlist-test-postgres';
const PORT = process.env.TEST_PG_PORT ?? '55432';
const URL = `postgres://postgres:testpw@127.0.0.1:${PORT}/waitlist?sslmode=disable`;

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function cleanup() {
  try {
    docker(['rm', '-f', NAME]);
  } catch {
    // Nothing to remove.
  }
}

cleanup();
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

console.log('Starting a disposable Postgres container...');
docker([
  'run', '-d', '--name', NAME,
  '-e', 'POSTGRES_PASSWORD=testpw',
  '-e', 'POSTGRES_DB=waitlist',
  '-p', `${PORT}:5432`,
  'postgres:16-alpine',
]);

process.stdout.write('Waiting for it to accept connections');
let ready = false;
for (let i = 0; i < 60; i += 1) {
  try {
    docker(['exec', NAME, 'pg_isready', '-U', 'postgres']);
    ready = true;
    break;
  } catch {
    process.stdout.write('.');
    // A short synchronous pause; this script is a convenience wrapper.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}
console.log('');
if (!ready) {
  console.error('Postgres did not become ready in time.');
  process.exit(1);
}

const result = spawnSync('npm', ['--prefix', 'backend', 'test'], {
  stdio: 'inherit',
  env: { ...process.env, TEST_DATABASE_URL: URL },
});

process.exit(result.status ?? 1);
