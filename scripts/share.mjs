/**
 * Publishes the local server on a temporary public HTTPS URL, so the site can
 * be tested from a phone or handed to someone else for a few minutes.
 *
 * Uses a Cloudflare quick tunnel, which needs no account, no credit card and
 * no signup — unlike ngrok, which has required an auth token since v3. The
 * `cloudflared` binary is downloaded on first use.
 *
 * Two settings have to be right or the site is subtly broken behind a tunnel,
 * and this script is mostly here to get them right:
 *
 *   TRUST_PROXY_HOPS=1   The tunnel is a proxy. Without this every visitor
 *                        looks like one client, so one person's mistyped
 *                        password locks out everybody.
 *
 *   CORS_ALLOWED_ORIGINS Cloudflare rewrites the Host header to the local
 *                        address, so the server compares an Origin of
 *                        https://<name>.trycloudflare.com against a host of
 *                        127.0.0.1 and refuses every write as cross-origin.
 *                        The public URL is added explicitly.
 *
 * The site password still applies: the tunnel is public, the site is not.
 *
 * Usage:
 *   npm run share
 *   npm run share -- --port 8080
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const PORT = Number(args.get('port') ?? process.env.PORT ?? 8080);

const BIN_DIR = path.join(os.homedir(), '.local', 'bin');
const CLOUDFLARED = path.join(BIN_DIR, 'cloudflared');

const children = [];
let shuttingDown = false;

function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
}
process.on('SIGINT', () => { stopAll(); process.exit(0); });
process.on('SIGTERM', () => { stopAll(); process.exit(0); });
process.on('exit', stopAll);

/** Downloads cloudflared once, into ~/.local/bin. */
async function ensureCloudflared() {
  if (fs.existsSync(CLOUDFLARED)) return;

  const arch = { x64: 'amd64', arm64: 'arm64', arm: 'arm' }[process.arch] ?? 'amd64';
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${platform}-${arch}`;

  console.log(`Downloading cloudflared (${platform}-${arch})...`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(
      `Could not download cloudflared (HTTP ${response.status}). ` +
        'Install it manually from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
    );
  }
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.writeFileSync(CLOUDFLARED, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
  console.log(`Installed to ${CLOUDFLARED}\n`);
}

const TUNNEL_LOG = path.join(os.tmpdir(), 'waitlist-cloudflared.log');

/** Public address of the tunnel hostname, once known. */
let publicAddress = null;

/** Starts the tunnel and resolves once Cloudflare hands back a public URL. */
function startTunnel() {
  // cloudflared's own output is kept on disk. Without it, a tunnel that
  // registers but never becomes routable is undiagnosable from here.
  const tunnelLog = fs.createWriteStream(TUNNEL_LOG, { flags: 'w' });

  return new Promise((resolve, reject) => {
    const child = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error('cloudflared did not produce a URL within 60 seconds.'));
      }
    }, 60_000);

    // cloudflared prints its progress, including the URL, on stderr.
    const onData = (buffer) => {
      tunnelLog.write(buffer);
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buffer.toString());
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited with code ${code}`));
      } else if (!shuttingDown) {
        console.error('\nThe tunnel closed. Stopping.');
        stopAll();
        process.exit(1);
      }
    });
  });
}

/** Starts the application server with the tunnel-aware settings. */
function startServer(publicUrl) {
  const child = spawn(process.execPath, [path.join(ROOT, 'backend', 'src', 'server.js')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      PORT: String(PORT),
      // The tunnel is exactly one proxy hop.
      TRUST_PROXY_HOPS: '1',
      // Cloudflare rewrites Host, so the public origin must be named.
      CORS_ALLOWED_ORIGINS: publicUrl,
    },
  });
  children.push(child);

  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`\nThe server exited with code ${code}. Stopping the tunnel.`);
      stopAll();
      process.exit(code ?? 1);
    }
  });
  return child;
}

function lastLines(file, count) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-count);
  } catch {
    return [];
  }
}

/**
 * Confirms the name exists in public DNS, independently of this machine.
 *
 * Some networks (corporate resolvers, Pi-hole, a stale negative cache) fail
 * to resolve a freshly-created trycloudflare subdomain while the rest of the
 * internet resolves it fine. Without this check the script would report a
 * working tunnel as broken, and the obvious next step -- re-running it --
 * would not help.
 */
/** The system's current upstream resolver, for the diagnostic message. */
async function currentResolver() {
  try {
    const servers = dns.getServers();
    return servers[0] ?? null;
  } catch {
    return null;
  }
}

async function resolvePublicly(hostname) {
  const resolver = new dns.Resolver();
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  try {
    const addresses = await resolver.resolve4(hostname);
    return addresses[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Works out what is actually wrong, by asking DNS directly rather than
 * inferring it from the shape of a fetch error.
 *
 * The order matters: a name this machine cannot resolve is a different
 * problem from a name it can resolve but cannot reach, and the two need
 * completely different advice.
 *
 * @returns {'reachable'|'local-dns'|'no-dns'|'unreachable'}
 */
async function waitForPublicUrl(url) {
  const hostname = new URL(url).hostname;

  // A freshly-created quick tunnel is not immediately in DNS -- cloudflared
  // says so itself ("it may take some time to be reachable"). Measured here,
  // registration and propagation took well over a minute, so a short wait
  // reports a perfectly good tunnel as a failed one.
  //
  // Both resolvers are polled together, because they answer different
  // questions: the public one says whether the tunnel registered at all, the
  // system one says whether this machine is allowed to see it.
  const DNS_TIMEOUT_MS = 150_000;
  const deadline = Date.now() + DNS_TIMEOUT_MS;

  for (;;) {
    try {
      await dns.lookup(hostname);
      break; // This machine can resolve it; go on to check it serves.
    } catch {
      // Held from the first successful public lookup rather than resolved
      // again when the message is printed: that second lookup can fail
      // transiently, and reporting a null address makes the advice useless.
      if (!publicAddress) publicAddress = await resolvePublicly(hostname);
      if (Date.now() >= deadline) {
        // Registered for the rest of the world but not visible here means the
        // local resolver is filtering it, which is a different problem.
        return publicAddress ? 'local-dns' : 'no-dns';
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // The name resolves here, so any remaining failure is a real one.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${url}/healthz`, { redirect: 'manual' });
      if (response.ok) return 'reachable';
    } catch {
      // Not serving yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 'unreachable';
}

function box(lines) {
  const width = Math.max(...lines.map((l) => l.length));
  const bar = '─'.repeat(width + 2);
  console.log(`┌${bar}┐`);
  for (const line of lines) console.log(`│ ${line.padEnd(width)} │`);
  console.log(`└${bar}┘`);
}

try {
  await ensureCloudflared();

  console.log('Opening a Cloudflare quick tunnel...');
  const publicUrl = await startTunnel();

  console.log(`Starting the server on port ${PORT}...\n`);
  startServer(publicUrl);

  box([
    'Your site is live on the public internet',
    '',
    `  Landing page   ${publicUrl}/`,
    `  Admin panel    ${publicUrl}/admin`,
    '',
    'Anyone opening it still needs the site password, and the',
    'admin panel needs its own on top of that.',
    '',
    'This URL is temporary and disappears when you stop this',
    'command. Press Ctrl-C to stop.',
  ]);

  console.log('\nWaiting for Cloudflare to publish the name in DNS (this can take a');
  console.log('minute or two on a new tunnel), then checking it serves...');
  const status = await waitForPublicUrl(publicUrl);
  if (status === 'reachable') {
    console.log('Reachable. Open the link above on any device.\n');
  } else if (status === 'local-dns') {
    const hostname = new URL(publicUrl).hostname;
    const address = publicAddress ?? (await resolvePublicly(hostname)) ?? '<address>';
    const resolver = await currentResolver();

    console.log(
      '\n' +
        'THE TUNNEL IS WORKING. Your own network cannot look up its name.\n' +
        '\n' +
        `  The name resolves fine on public DNS      ${address}\n` +
        `  Your resolver${resolver ? ` (${resolver})` : ''} returns NXDOMAIN\n` +
        '\n' +
        'Cloudflare quick tunnels are heavily abused for phishing, so many\n' +
        'ISP, campus and corporate resolvers block *.trycloudflare.com while\n' +
        'still resolving trycloudflare.com itself. That is what is happening\n' +
        'here, and it affects only devices using that resolver.\n' +
        '\n' +
        'Three ways round it, easiest first:\n' +
        '\n' +
        '  1. Open the link on your phone using mobile data rather than\n' +
        '     Wi-Fi. A different resolver will almost certainly work, and\n' +
        '     this needs no changes to anything.\n' +
        '\n' +
        '  2. Turn on Secure DNS (DNS-over-HTTPS) in your browser, which\n' +
        '     bypasses the network resolver entirely and fixes every future\n' +
        '     tunnel too:\n' +
        '       Chrome   Settings -> Privacy and security -> Security ->\n' +
        '                Use secure DNS -> With: Cloudflare (1.1.1.1)\n' +
        '       Firefox  Settings -> Privacy & Security -> DNS over HTTPS ->\n' +
        '                Increased Protection\n' +
        '\n' +
        '  3. Point this one name at the address yourself, for this session:\n' +
        `       echo "${address}  ${hostname}" | sudo tee -a /etc/hosts\n` +
        '     Remove that line when you are done; the name changes every run.\n' +
        '\n' +
        'To confirm from this machine without changing anything:\n' +
        `  curl --resolve ${hostname}:443:${address} ${publicUrl}/healthz\n`,
    );
  } else if (status === 'no-dns') {
    console.log(
      '\nThe tunnel reported a URL but the name does not resolve anywhere,\n' +
        'including on public DNS. That is a Cloudflare-side registration\n' +
        'failure. Stop and re-run.\n' +
        `cloudflared's own log: ${TUNNEL_LOG}`,
    );
    for (const line of lastLines(TUNNEL_LOG, 8)) console.log(`  ${line}`);
    console.log('');
  } else {
    console.log(
      '\nThe name resolves but the URL never answered, so the tunnel is not\n' +
        'reaching your local server. Check that it is listening on the port\n' +
        'shown above.\n' +
        'transient Cloudflare quick-tunnel failure — stop and re-run.\n' +
        `cloudflared's own log: ${TUNNEL_LOG}`,
    );
    for (const line of lastLines(TUNNEL_LOG, 8)) console.log(`  ${line}`);
    console.log('');
  }

  // Hold the process open; the children keep it alive.
  await new Promise(() => {});
} catch (err) {
  console.error(`\n${err.message}`);
  stopAll();
  process.exit(1);
}
