# Build context must be the repo root: docker build -f apps/worker/Dockerfile .
#
# See apps/api/Dockerfile for why this runs through tsx instead of a
# compiled `node dist/...` entrypoint.
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
COPY apps/worker apps/worker

CMD ["npx", "tsx", "apps/worker/src/index.ts"]
