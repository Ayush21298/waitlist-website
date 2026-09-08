# =====================================================================
# Waitlist platform
#
# Multi-stage: the build stage compiles better-sqlite3's native addon and
# then only the resulting node_modules and the application source travel
# into the runtime image. Compilers are not shipped to production.
# =====================================================================

# ---------- build ----------
FROM node:22-bookworm-slim AS build

# better-sqlite3 has no prebuilt binary for every platform, so the
# toolchain must be present while installing -- and only then.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copied first so a dependency install is cached until the manifests change.
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY backend/src ./backend/src
COPY frontend ./frontend


# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    LOG_DIR=/data/logs \
    # Node's default pool is 4 threads, shared by file reads and scrypt.
    # Raising it leaves room for both under a login burst.
    UV_THREADPOOL_SIZE=8 \
    # Node does not see a container memory limit by default and will size
    # its heap for the host, then get OOM-killed on a small instance.
    NODE_OPTIONS=--max-old-space-size=384

# dumb-init reaps zombies and forwards SIGTERM, so the graceful shutdown
# in server.js actually runs on a redeploy.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build --chown=node:node /app/backend ./backend
COPY --from=build --chown=node:node /app/frontend ./frontend

# The writable volume. Owned by the unprivileged user the app runs as.
RUN mkdir -p /data/logs && chown -R node:node /data

# Never run as root: a container escape should not start from uid 0.
USER node

EXPOSE 8080
VOLUME ["/data"]

# The platform's own health check may differ; this one makes `docker run`
# and Compose report the container honestly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/src/server.js"]
