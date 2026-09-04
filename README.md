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
| **Database** | PostgreSQL 17 | `localhost:5432` | Primary database (`vaultflow`/`vaultflow`) |
| **Cache & Queue** | Redis 7.4 | `localhost:6379` | In-memory cache & state store |
| **Worker** | Node.js / tsx | Background Container | Automated execution worker |

---

## 1. Quick Start with Docker (Recommended)

Run the full stack (Frontend, Backend API, Worker, PostgreSQL, and Redis) in containers.

### Initial Setup
```bash
# 1. Ensure you have your environment file configured
cp .env.example .env
```

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

# View logs for a specific service (api, web, worker, postgres, redis)
docker compose logs -f api
docker compose logs -f web

# Restart a service
docker compose restart api
docker compose restart web

# Stop all services
docker compose down

# Stop and wipe volume data (resets DB & Redis state)
docker compose down -v
```

---

## 2. Local Development (Running Services Directly on Host)

If you prefer developing outside of Docker containers:

### Step 1: Start Supporting Infrastructure
Run PostgreSQL and Redis via Docker:
```bash
docker compose up -d postgres redis
```

### Step 2: Install Dependencies
```bash
npm install
```

### Step 3: Run the Backend & Frontend

Open separate terminal windows:

- **Run Backend API** (Port `4000`):
  ```bash
  npm run dev:api
  ```

- **Run Frontend Web Console** (Port `4560`):
  ```bash
  npm run dev:web
  ```

- **Build Frontend Production Bundle**:
  ```bash
  npm run build -w @vaultflow/web
  ```

- **Run Background Worker**:
  ```bash
  npm run dev:worker
  ```

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
  The frontend runs on port `4560` and queries the API on port `4000`. The API uses `SameSite=Lax` and plain HTTP cookies for localhost development.
- **Transfers on Testnet:**
  Testnet IBC channels may expire if relayers are idle. Make sure your target addresses and channel configurations in `.env` match the target network (Testnet vs Mainnet).

