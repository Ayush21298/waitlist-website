/**
 * Process entry point: boot, background maintenance, graceful shutdown.
 *
 * The shape of this file is what keeps the service stable unattended. It
 * starts nothing until the database is migrated and the passwords are hashed,
 * it sweeps its own tables on a schedule, and it drains in-flight requests
 * before exiting so a redeploy never cuts a signup in half.
 */
import os from 'node:os';

import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { createStore } from './db/index.js';
import { AuthService } from './middleware/auth.js';
import { config, configWarnings } from './config.js';
import { SEED_APPS } from './seed.js';

const startedAt = Date.now();
const logger = createLogger(config);

/** Table sweeps: cheap, and they keep unbounded tables from becoming a problem. */
const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;

async function main() {
  for (const warning of configWarnings) logger.warn('configuration warning', { warning });

  logger.info('starting waitlist backend', {
    nodeEnv: config.nodeEnv,
    node: process.version,
    port: config.server.port,
    siteGateEnabled: config.auth.siteGateEnabled,
    trustProxyHops: config.server.trustProxyHops,
  });

  const { adapter, store } = await createStore(config, logger);
  await store.ensureApps(SEED_APPS);

  const auth = new AuthService({ config, store, logger });
  await auth.init();

  const app = createApp({ config, store, auth, logger, startedAt });

  const server = app.listen(config.server.port, config.server.host, () => {
    const addresses = listenAddresses(config.server.host, config.server.port);
    logger.info('listening', {
      host: config.server.host,
      port: config.server.port,
      urls: addresses,
      dialect: store.dialect,
    });

    // Printed plainly as well as logged. The single most common question is
    // "what address do I open on my phone", and making someone grep their own
    // interface list to answer it is a poor use of their time.
    if (config.logging.toConsole) {
      process.stdout.write(`\n  Waitlist is running.\n`);
      for (const { label, url } of addresses) {
        process.stdout.write(`    ${label.padEnd(16)} ${url}\n`);
      }
      process.stdout.write(`    admin panel      ${addresses[0].url}/admin\n\n`);
    }
  });

  // Node's defaults are shorter than a typical load balancer's idle timeout,
  // which shows up as sporadic 502s when the balancer reuses a connection the
  // server has just closed. Keep-alive must outlast the balancer's window.
  server.keepAliveTimeout = config.server.keepAliveTimeoutMs;
  server.headersTimeout = config.server.headersTimeoutMs;
  server.requestTimeout = config.server.requestTimeoutMs;

  server.on('error', (err) => {
    logger.fatal('server error', { err });
    process.exit(1);
  });

  const maintenanceTimer = setInterval(() => {
    runMaintenance(store, logger).catch((err) => logger.error('maintenance failed', { err }));
  }, MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
  // Once at boot, so a long-idle deployment tidies up on its next start.
  runMaintenance(store, logger).catch((err) => logger.error('initial maintenance failed', { err }));

  installShutdownHandlers({ server, adapter, app, logger });
}

/**
 * Every address this server can actually be reached on.
 *
 * Binding to 0.0.0.0 means other devices on the network can reach it, but
 * nothing tells you which address to give them. Virtual interfaces are left
 * out: a docker bridge address is never the one you want to type into a phone.
 */
function listenAddresses(host, port) {
  const addresses = [{ label: 'on this machine', url: `http://localhost:${port}` }];

  // A specific bind address is the only one that will answer.
  if (host !== '0.0.0.0' && host !== '::') {
    return [{ label: 'on this machine', url: `http://${host}:${port}` }];
  }

  const skip = /^(docker|br-|veth|virbr|lo|tun|tap|zt)/;
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      addresses.push({ label: 'on your network', url: `http://${entry.address}:${port}` });
    }
  }
  return addresses;
}

async function runMaintenance(store, logger) {
  const sessions = await store.pruneSessions();
  const attempts = await store.pruneAuthAttempts();
  const events = await store.pruneEvents(config.logging.eventRetentionDays);
  await store.maintenance();
  logger.info('maintenance complete', { prunedSessions: sessions, prunedAttempts: attempts, prunedEvents: events });
}

function installShutdownHandlers({ server, adapter, app, logger }) {
  let shuttingDown = false;

  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });

    // Stop accepting new connections, then wait for in-flight requests.
    const closed = new Promise((resolve) => server.close(resolve));
    const timeout = new Promise((resolve) => {
      const timer = setTimeout(() => {
        logger.warn('shutdown grace period elapsed; closing anyway');
        resolve('timeout');
      }, config.server.shutdownGraceMs);
      timer.unref();
    });
    await Promise.race([closed, timeout]);

    app.stopBackgroundWork?.();
    try {
      await adapter.close();
    } catch (err) {
      logger.error('error closing database', { err });
    }
    await logger.close();
    process.exit(exitCode);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crashed process that keeps its port is worse than one that exits and is
  // restarted by the platform. Log the cause first, then go down cleanly.
  process.on('uncaughtException', (err) => {
    logger.fatal('uncaught exception', { err });
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal('unhandled rejection', { err: reason instanceof Error ? reason : new Error(String(reason)) });
    shutdown('unhandledRejection', 1);
  });
}

main().catch((err) => {
  logger.fatal('failed to start', { err });
  process.exit(1);
});
