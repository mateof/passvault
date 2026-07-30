# syntax=docker/dockerfile:1

# Build and run the PassVault server.
#
# Multi-stage, so what ships is the compiled output and production dependencies rather than
# a toolchain. The build stage needs the whole workspace: the server imports four local
# packages, and npm workspaces resolve them by symlink, so copying only `apps/server` gives
# a tree that cannot install.

FROM node:22-bookworm-slim AS build

WORKDIR /app

# better-sqlite3 builds native code. Present in the build stage only — the
# runtime stage receives the compiled artefacts and needs no compiler.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Manifests first, so a change to source code does not invalidate the dependency layer.
COPY package.json package-lock.json ./
COPY packages/crypto/package.json packages/crypto/
COPY packages/db/package.json packages/db/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ingest/package.json packages/ingest/
COPY packages/tkpak/package.json packages/tkpak/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/

RUN npm ci

COPY tsconfig*.json ./
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web

# The root script, not a per-workspace one: `tsc --build` walks the project references, so the
# server and the packages it imports are built in dependency order by one command. The server
# workspace has no build script of its own, and the first draft called one that does not exist —
# it only ever worked because of an `|| npm run build` fallback that hid the mistake.
RUN npm run build

# The web interface is served by the same process, so it has to be in the image. Without this the
# API answers and the root is a 404, which is what a first deployment actually did.
RUN npm run build --workspace @passvault/web

# Drop development dependencies rather than reinstalling, so the native modules built above
# are the ones that ship — a fresh `npm ci --omit=dev` would rebuild them.
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

# Unprivileged. The image writes to /data and nothing else, and the one thing worth having
# on a host that holds other people's ticket barcodes is that a compromise of this process
# is not a compromise of the host.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages packages
COPY --from=build /app/apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist

# Created before dropping privileges, and owned by the user that will write to it. A volume
# mounted over it inherits this ownership, which is what stops the usual first-run failure
# where the container cannot write to its own data directory.
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 8080

# The server migrates on boot, so there is no separate migration step to forget. Idempotent,
# so a rolling restart runs it repeatedly without harm.
CMD ["node", "apps/server/dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
