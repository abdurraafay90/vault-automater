# Build context must be the repo root: docker build -f apps/web/Dockerfile .
#
# apps/web runs on `vinext` (beta) + Wrangler/Cloudflare tooling instead of
# the plain Next.js CLI. `vinext build` + `vinext start` are meant to produce
# and serve a Node-runnable bundle without needing a live Cloudflare account
# for local/dev use, but this stack is new and beta — verify the exposed
# port and boot behavior against your `vinext`/`wrangler` versions before
# relying on this in anything but local/dev.
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
COPY apps/web apps/web

WORKDIR /repo/apps/web
EXPOSE 4560
CMD ["npm", "run", "start"]
