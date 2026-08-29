# Build context must be the repo root: docker build -f apps/api/Dockerfile .
#
# packages/shared (and friends) ship as raw TypeScript with no compiled build
# output, so the API runs through tsx at runtime (same as `npm run dev:api`)
# instead of a plain `node dist/...` — the workspace isn't buildable to plain
# JS yet.
FROM node:22-alpine AS deps
WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/blockchain-core/package.json packages/blockchain-core/package.json
COPY packages/blockchain-cosmos/package.json packages/blockchain-cosmos/package.json

RUN npm ci

FROM deps AS runtime
ENV NODE_ENV=production
WORKDIR /repo

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/database packages/database
COPY packages/blockchain-core packages/blockchain-core
COPY packages/blockchain-cosmos packages/blockchain-cosmos
COPY apps/api apps/api

RUN mkdir -p /repo/.data
VOLUME ["/repo/.data"]

EXPOSE 4000
CMD ["npx", "tsx", "apps/api/src/server.ts"]
