# Build context is the WORKSPACE ROOT, not this directory:
#   docker build -f packages/server/Dockerfile -t driftwatch-server .
#
# Uses `pnpm deploy` to produce a self-contained copy of @driftwatch/server
# with its workspace dependency (@driftwatch/sdk) resolved to real files
# instead of a symlink, so the runtime stage doesn't need the whole monorepo.
# The console (packages/console) is also built here and its static `dist`
# is copied alongside the deployed server so server.ts's existsSync check
# (`<server dist>/../../console/dist`) finds it and serves it at /console/.
#
# If you edited packages/server/src/config/model-client.ts to use a provider
# package other than the built-in gateway default, run
# `pnpm --filter @driftwatch/server add @ai-sdk/<provider>` first so it's in
# the lockfile before building.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /workspace

FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/console/package.json packages/console/package.json
RUN pnpm install --frozen-lockfile
COPY packages/sdk packages/sdk
COPY packages/server packages/server
COPY packages/console packages/console
RUN pnpm --filter @driftwatch/sdk build
RUN pnpm --filter @driftwatch/server build
RUN pnpm --filter @driftwatch/console build
RUN pnpm --filter @driftwatch/server deploy --prod /deploy/server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app/packages/server
COPY --from=build /deploy/server ./
COPY --from=build /workspace/packages/console/dist /app/packages/console/dist
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "--import", "./dist/telemetry-bootstrap.js", "./dist/server.js"]
