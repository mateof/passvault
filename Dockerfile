# syntax=docker/dockerfile:1

# Build and run the PassVault server.
#
# Multi-stage, so what ships is the compiled output and production dependencies rather than
# a toolchain. The build stage needs the whole workspace: the server imports four local
# packages, and npm workspaces resolve them by symlink, so copying only `apps/server` gives
# a tree that cannot install.
#
# The image was over 700 MB, and almost none of that was the application. The prune stage below
# says where it went; the short version is that a Node dependency tree ships its own build
# leftovers, three database drivers nobody asked for, and a browser front end's runtime beside
# the bundle that front end was already compiled into.

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

# Which database drivers to keep. `sqlite` is the default because it is what a single-box
# deployment uses and what this image is for; `all` keeps every engine the server supports, for
# somebody pointing it at Postgres or SQL Server.
ARG DATABASE_DRIVERS=sqlite

# Everything the runtime does not need, removed before it can be copied into the next stage.
#
#   * better-sqlite3 keeps its C sources, the SQLite amalgamation and the object files it
#     compiled from them — tens of megabytes of build leftovers around one `.node` binary.
#   * pdfjs ships a browser viewer, a non-legacy build the rasteriser never loads, TypeScript
#     types and source maps. Rendering a page needs `legacy/build` and the standard fonts.
#   * The three network database drivers pull in a client library each, and the SQL Server one
#     brings the Azure identity libraries with it. None is loaded unless DATABASE_URL names
#     that engine — they are imported dynamically for exactly this reason.
#   * React and the rest of the browser runtime were compiled into the bundle in the stage
#     above. Shipping them again ships the ingredients beside the cake. `intl-messageformat`
#     is *not* in that list and must not be: the server's own catalogue formats its messages
#     with it, so removing it would leave every translated error unrenderable.
#   * Source maps everywhere. They exist to map a stack trace back to source that is not in
#     this image anyway.
RUN set -eux; \
    rm -rf node_modules/better-sqlite3/build/Release/obj \
           node_modules/better-sqlite3/build/Release/obj.target \
           node_modules/better-sqlite3/build/deps \
           node_modules/better-sqlite3/deps \
           node_modules/better-sqlite3/src; \
    find node_modules/better-sqlite3/build -name '*.o' -delete; \
    rm -rf node_modules/pdfjs-dist/web \
           node_modules/pdfjs-dist/types \
           node_modules/pdfjs-dist/image_decoders \
           node_modules/pdfjs-dist/build \
           node_modules/pdfjs-dist/legacy/web \
           node_modules/pdfjs-dist/legacy/image_decoders; \
    rm -rf node_modules/react node_modules/react-dom node_modules/react-router \
           node_modules/react-router-dom node_modules/scheduler; \
    if [ "$DATABASE_DRIVERS" = "sqlite" ]; then \
      rm -rf node_modules/pg node_modules/pg-cloudflare node_modules/pg-connection-string \
             node_modules/pg-int8 node_modules/pg-pool node_modules/pg-protocol \
             node_modules/pg-types node_modules/pgpass node_modules/postgres-array \
             node_modules/postgres-bytea node_modules/postgres-date node_modules/postgres-interval \
             node_modules/mysql2 node_modules/tedious node_modules/tarn node_modules/@azure \
             node_modules/@js-joda; \
    fi; \
    find node_modules -name '*.map' -delete; \
    find node_modules -name '*.md' -delete


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
# The compiled output and the manifests that resolve it, rather than the whole workspace. The
# TypeScript sources were only ever there because copying a directory is easier than listing
# what is in it, and a running server never reads them.
COPY --from=build /app/packages/crypto/dist packages/crypto/dist
COPY --from=build /app/packages/crypto/package.json packages/crypto/package.json
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/package.json packages/db/package.json
COPY --from=build /app/packages/i18n/dist packages/i18n/dist
COPY --from=build /app/packages/i18n/package.json packages/i18n/package.json
COPY --from=build /app/packages/ingest/dist packages/ingest/dist
COPY --from=build /app/packages/ingest/package.json packages/ingest/package.json
COPY --from=build /app/packages/tkpak/dist packages/tkpak/dist
COPY --from=build /app/packages/tkpak/package.json packages/tkpak/package.json
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/package.json apps/server/package.json
COPY --from=build /app/apps/web/dist apps/web/dist
# The asset links file, which is what lets the Android app use a passkey for this domain.
COPY --from=build /app/apps/server/well-known apps/server/well-known

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
