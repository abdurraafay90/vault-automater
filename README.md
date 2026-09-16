# Vaultflow

Production-oriented token automation across three independently scheduled vaults on ZIGChain.

---

## Service Endpoints & Ports

| Service | Technology | URL / Address | Description |
| :--- | :--- | :--- | :--- |
| **Frontend (Web)** | Next.js / Vinext / React 19 | [`http://localhost:4560`](http://localhost:4560) | Web console & operations dashboard |
| **Backend (API)** | Fastify / TypeScript / tsx | [`http://localhost:4000`](http://localhost:4000) | REST API & config endpoints |
| **API Health Check** | Fastify | [`http://localhost:4000/health`](http://localhost:4000/health) | API health probe |
| **Public Config** | Fastify | [`http://localhost:4000/api/config/public`](http://localhost:4000/api/config/public) | Public chain & vault configuration |
| **Worker** | Node.js / tsx | Background process | Executes scheduled automations and CSV batches (runs with the console closed) |

No database server to run: auth, custom vaults and automation jobs all live in SQLite at `.data/auth.sqlite`, shared by the API and the worker.

---

## 1. Quick Start with Docker (Recommended)

Run the full stack (Frontend, Backend API, Worker) in containers.

### Initial Setup
```bash
# 1. Ensure you have your environment file configured
cp .env.example .env
```
Fill in `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` and
`AUTOMATION_ENCRYPTION_KEY` (see `.env.example` for how to generate the last
one) before starting. For a real deployment, also see
[Deploying to production](#deploying-to-production) below.

### Start All Services
```bash
# Build and start all services in detached mode
docker compose up -d --build
```

### Manage Running Containers
```bash
# Check status of all containers
docker compose ps

# View live logs for all services
docker compose logs -f

# View logs for a specific service (api, web, or worker)
docker compose logs -f api
docker compose logs -f web

# Restart a service
docker compose restart api
docker compose restart web

# Stop all services
docker compose down

# Stop and wipe the SQLite volume (resets all data: users, vaults, automations)
docker compose down -v
```

---

## Deploying to production

Example: `vault.wickhub.cc`.

1. **DNS & TLS.** This app serves plain HTTP on port `4560` (web) — it does not
   terminate TLS itself. Point `vault.wickhub.cc` at the host and put a
   TLS-terminating reverse proxy in front of the `web` container: a Cloudflare
   Tunnel, Caddy, or nginx with Let's Encrypt all work. Only `web` needs to be
   reachable from the internet; `api` is bound to `127.0.0.1:4000` in
   [docker-compose.yml](docker-compose.yml) and is only ever reached over the
   internal Docker network via `web`'s `/api/*` proxy.
2. **`.env` on the server** — set at minimum:
   ```bash
   APP_ORIGIN=https://vault.wickhub.cc
   NEXT_PUBLIC_SITE_URL=https://vault.wickhub.cc
   TRUST_PROXY=1               # exactly one reverse proxy in front
   SESSION_SECRET=<generate>
   ADMIN_EMAIL=<real email>
   ADMIN_PASSWORD=<a real password — never ship the dev default>
   AUTOMATION_ENCRYPTION_KEY=<generate, see .env.example>
   ```
   `NEXT_PUBLIC_SITE_URL` is baked into the web bundle at **build** time, so
   changing it requires `docker compose up -d --build`, not just a restart.
   Leave `NEXT_PUBLIC_API_URL` empty — the browser always calls the
   same-origin `/api/*` proxy; pointing it at the internal `api` service name
   would break, since browsers cannot resolve Docker service names.
3. **Build and start:**
   ```bash
   docker compose up -d --build
   ```
4. Log in at `https://vault.wickhub.cc` with the admin credentials from
   `.env`, and confirm the header shows **WORKER ONLINE**.

---

## 2. Local Development (Running Services Directly on Host)

No PostgreSQL or Redis is needed locally: auth, custom vaults and automation
jobs all live in SQLite at `.data/auth.sqlite`.

### Step 1: Install Dependencies
```bash
npm install
```

### Step 2: Set the automation encryption key
Automations and CSV batches store wallet keys encrypted. Put a 32-byte key in
`.env` (never commit it):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# -> AUTOMATION_ENCRYPTION_KEY=<output>
```

### Step 3: Run everything
```bash
npm run dev
```
Starts the API (`4000`), the automation worker, and the web console (`4560`)
together with labelled logs. Ctrl+C stops all three; if one exits, the others
are stopped too.

If it says Vaultflow is already running (e.g. left open in another terminal),
either use that one or replace it:
```bash
npm run dev:stop   # stops only this project's processes, never other apps
npm run dev
```

To run the services separately instead:
```bash
npm run dev:api
npm run dev:worker
npm run dev:web
```

---

## How automation runs

Scheduled automations and CSV batches are executed by the **worker**, not the
browser. Starting either in the console hands the job to the API; the worker
sends on schedule, so **closing the tab or the browser does not stop it** and
background-tab timer throttling does not apply.

- The console header shows **WORKER ONLINE / OFFLINE**. With the worker off,
  jobs are kept but nothing sends until it starts.
- Wallet keys are stored AES-256-GCM encrypted and **wiped** when an automation
  is stopped (or replaced) or a batch completes or is cancelled. Pausing keeps
  the key so Resume works without re-entering it.
- A failed send **pauses** the automation with the reason shown in the panel.
- Only one send at a time runs per sending wallet per chain (no nonce races).
- Only one worker may run against the database; a second one refuses to start.
- If the worker is killed mid-send, that send is marked failed with "check the
  explorer before retrying" and is **never resent automatically**.
- Clear Session removes the key from the browser only; stop an automation to
  end it. Deleting a vault stops its automation and cancels its batch.
- Wallet CSVs contain private keys and are gitignored; only
  `data/csv/*.template.csv` placeholders are tracked.

---

## 3. Default Admin Access

Default login credentials configured in `.env`:
- **Email:** `abt@gmail.com`
- **Password:** `123`

---

## 4. Useful Workspace Commands

```bash
# Run type checks across all workspaces
npm run typecheck

# Run tests across workspaces
npm run test

# Rebuild all workspace packages
npm run build
```

---

## 5. Troubleshooting & Tips

- **Container Rebuild After Git Pull:**
  When pulling updated code from GitHub, rebuild the Docker containers with:
  ```bash
  docker compose up -d --build
  ```
- **Session & Cookies on Localhost:**
  The frontend runs on port `4560` and queries the API on port `4000`. With `APP_ORIGIN=http://localhost:4560`, the API uses `SameSite=Lax` and plain HTTP cookies for local development. In production (`APP_ORIGIN` is `https://...` and `NODE_ENV=production`), cookies automatically switch to `Secure`.
- **Mainnet only:**
  Ethereum, BNB Smart Chain and ZIGChain mainnets. RPC endpoints in `.env` are tried in order with automatic failover; ZIGChain's `RPC_URL` must be a Tendermint RPC and `API_URL` its LCD.
- **Nothing is sending:**
  Check the header shows WORKER ONLINE. If it says OFFLINE, start the worker (`npm run dev:worker`, or `npm run dev` for everything).
- **Changed `NEXT_PUBLIC_SITE_URL` but nothing changed:**
  It's inlined into the web bundle at build time. `docker compose up -d --build` (a plain restart isn't enough).
- **Never ship the default admin login:**
  `abt@gmail.com` / `123` below is for local development only. Set a real `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` before deploying anywhere reachable from the internet — the API overwrites the admin account from `.env` on every boot.

