# Vault Automator — Phase 1 Architecture

Status: architecture approved for review; no application code has been generated.

## 1. Current repository analysis

The project directory is new and empty. There is no package manager, framework,
Git history, environment configuration, contract metadata, ABI/schema, or chain
client to preserve.

The target blockchain cannot yet be classified as EVM, Cosmos SDK, CosmWasm, or
another protocol. Names such as `0x...`, ERC20, and Cosmos in the brief are
examples, not evidence. Chain-specific dependencies and transaction encoding must
therefore remain unselected until the network and vault interfaces are verified.

## 2. Proposed architecture

```text
Browser
  Next.js UI + browser wallet/manual interactive signer
       |
       | HTTPS + HTTP-only session + CSRF protection
       | SSE for live events
       v
Fastify API
  auth / RBAC / validation / audit / public chain config
       |
       +-------------------- PostgreSQL (system of record)
       |
       +-------------------- Redis + BullMQ (durable scheduling)
                                      |
                                      v
                                Worker processes
                                      |
                          TransactionCoordinator
                                      |
              ChainClient / TokenClient / SignerProvider / VaultAdapter
                                      |
                                      v
                              Configured blockchain RPC
```

The web app, API, and workers are separate deployable processes in a pnpm/Turbo
monorepo. PostgreSQL is authoritative for users, configuration, execution state,
transactions, and audit history. Redis/BullMQ owns delayed work and retries but is
not the source of truth. The API publishes server events from committed state.

## 3. Proposed folder structure

```text
vault-automator/
  apps/
    web/                  # Next.js, TypeScript, Tailwind, shadcn/ui
    api/                  # Fastify API, sessions, RBAC, SSE
    worker/               # BullMQ scheduler, execution, reconciliation
  packages/
    database/             # Prisma schema, migrations, repositories
    auth/                 # sessions, Argon2id, permissions, CSRF
    blockchain-core/      # chain-neutral interfaces and state machines
    blockchain-evm/       # added only if the verified chain is EVM
    blockchain-cosmos/    # added only if the verified chain requires it
    scheduler/            # queue contracts, locks, idempotency
    shared/               # Zod schemas, DTOs, enums, exact amount helpers
    ui/                   # reusable application components
    config/               # validated server/public configuration
  infrastructure/
    docker-compose.yml    # PostgreSQL and Redis for development
  docs/
    architecture.md
    blockchain-onboarding.md
    security.md
  .env.example
  pnpm-workspace.yaml
  turbo.json
  README.md
```

## 4. Database schema

All money-like token fields are base-10 strings representing non-negative
integer base units. Application code converts them to `bigint`; floating point
is never used.

- `User`: id, email (unique), passwordHash, role, active, createdAt, updatedAt.
- `Session`: id/hash, userId, expiresAt, lastSeenAt, revokedAt, createdAt.
- `Wallet`: id, chainKey, address, mode, label, active, createdAt, updatedAt. No
  private key, mnemonic, seed, or secret columns.
- `Vault`: id, key (unique), configuredName, address, chainKey, enabled,
  interfaceStatus, createdAt, updatedAt.
- `AutomationConfig`: id, vaultId, walletId, updatedByUserId, status,
  minAmountBaseUnits, maxAmountBaseUnits, intervalSeconds, generation,
  totalExecutedBaseUnits, lastExecutionAt, nextExecutionAt, timestamps.
- `AutomationExecution`: id, automationConfigId, scheduledFor, idempotencyKey
  (unique), attempt, state, selectedAmountBaseUnits, startedAt, finishedAt,
  errorCode, safeErrorMessage.
- `BlockchainTransaction`: id, executionId, vaultId, walletId, chainId,
  walletAddress, vaultAddress, tokenAddress, requested/executed amount base units,
  hash, status, blockNumber, gasUsed, feeBaseUnits, nonceOrSequence, timestamps,
  errorCode, safeErrorMessage.
- `AuditLog`: id, actorUserId, action, targetType, targetId, metadataJson,
  requestId, ipHash, createdAt. Metadata is allow-listed and secret-free.
- `OutboxEvent`: id, aggregateType, aggregateId, eventType, payloadJson,
  createdAt, publishedAt; used for reliable SSE/queue publication.

Important constraints/indexes: one active execution per automation/slot, unique
transaction hash when present, indexed transaction history by `(walletId,
vaultId, createdAt desc)`, and optimistic version/generation checks on automation
updates.

## 5. Authentication design

There is no public registration. A one-time server-side bootstrap command creates
the first admin and hashes its password with Argon2id. Login is rate-limited and
creates an opaque session whose hashed identifier is stored in PostgreSQL. The
browser receives only a Secure, HttpOnly, SameSite cookie. State-changing routes
require CSRF protection and an Origin check. Every API route performs server-side
authentication and role/permission authorization. Disabling a user revokes all
of that user's sessions. Password resets invalidate existing sessions and are
audited.

## 6. Wallet signing design

Planned operator choices:

1. **Browser wallet (recommended interactive mode):** connect through the
   chain-appropriate provider once the chain is known. The UI obtains only the
   public address, network, balances, and signing capability. It never accesses
   the extension's private key. Deposits require an operator signature and show
   `AWAITING_SIGNATURE`.
2. **Manual private key (explicitly less-safe interactive mode):** an advanced,
   warning-gated browser form may accept a private key. It remains only in a
   narrowly scoped in-memory signer, is never persisted, logged, placed in URLs,
   analytics, crash reports, storage, or sent to the API. The address is derived
   from the key; any separately entered address is treated as a display/check
   value and must match. Refresh, logout, or lock destroys the reference as far
   as JavaScript permits.
3. **Backend-managed signer (deferred/recommended for unattended automation):**
   server secret injection or KMS; the browser sees only availability and public
   address.

Important limitation: browser-wallet and manual-browser-key modes cannot provide
true unattended automation after the browser closes. They support scheduled
preparation followed by operator signing. Continuous backend workers require the
backend-managed signer/KMS mode. The product must label this distinction clearly.

## 7. Backend signer design

`SignerProvider` exposes `initialize`, `getPublicAddress`, `sign`, and `destroy`.
Concrete providers are process-secret (development) and KMS/secret-manager
(production). Secret material is never stored in PostgreSQL, Redis, queues,
telemetry, errors, or API responses. Logging uses a deny-list plus structured
allow-listed fields. Configuration reports only `enabled`, `ready`, `mode`, and
public address. Key lifecycle is limited to the worker process and references are
released on disable/shutdown. This mode can remain disabled in the first UI
release while preserving the abstraction.

## 8. Scheduler design

Each vault has an independent recurring schedule identified by automation ID and
configuration generation. Allowed initial intervals are 30, 60, 300, 900, 1800,
and 3600 seconds, stored as seconds.

State transitions are persisted before jobs are created or removed. Each slot has
a deterministic idempotency key such as `automationId:generation:scheduledFor`.
The worker claims the execution with a database uniqueness constraint and a
short Redis lock. Duplicate/retried jobs load the existing execution instead of
depositing again. Pause/stop increments the generation and cancels future jobs.
Workers re-read status and generation before simulation and again immediately
before broadcast. `STOP ALL` first commits a global execution barrier, then
cancels future jobs. Already-broadcast transactions go to reconciliation.

Secure random amounts are chosen in base units with rejection sampling over
`[min,max]`, using Node's cryptographic RNG. If spendable token balance is below
minimum, only that automation becomes `INSUFFICIENT_BALANCE`. Low native gas
balance becomes `INSUFFICIENT_GAS` without repeated blind retries.

## 9. Transaction coordinator design

All signing/broadcast requests for one `(chain, wallet)` pass through a single
`TransactionCoordinator`. Vault schedules remain concurrent, while operations
that consume a nonce/account sequence are serialized. The coordinator obtains or
reserves the next nonce/sequence, records the reservation transactionally, signs,
broadcasts, and records the hash/uncertain outcome before releasing the lane.

An RPC timeout after submission becomes `BROADCAST_UNKNOWN`, not `FAILED`.
Reconciliation searches by known hash and, where supported, sender plus
nonce/sequence. Lifecycle: `SCHEDULED -> PREPARING -> SIMULATING ->
AWAITING_SIGNATURE -> SIGNED -> BROADCAST/BROADCAST_UNKNOWN -> CONFIRMING ->
SUCCESS | REVERTED | DROPPED | FAILED`.

## 10. Selected-vault transaction history

The selected vault ID and selected wallet ID are explicit query keys. The panel
requests only that pair by default, with status filter and cursor pagination.
Changing tabs cancels/ignores stale requests and displays a skeleton without
layout shift. SSE events carry vaultId/walletId and update only matching cached
queries. Hashes open the configured explorer after strict URL construction.
Filters are All, Success, Pending, and Failed; refresh and infinite loading are
supported.

## 11. Frontend layout plan

- Auth: login only; no registration.
- Application shell: collapsible desktop sidebar, mobile drawer, top bar with
  network, wallet state, token/native balances, and profile menu.
- Dashboard: balance/deposited/active/transactions summary, global controls,
  three vault tabs, selected vault configuration/status, and its transaction
  history directly below.
- Transactions: global filterable table.
- Users: admin-only creation, role change, disable, reset credentials.
- Settings: safe public chain/vault configuration, wallet mode, signer readiness,
  and diagnostics without secrets.

TanStack Query owns server state, React Hook Form plus Zod handles forms, and SSE
feeds query-cache updates. Countdown values are calculated locally from
`nextExecutionAt`; they do not poll RPC. Motion is limited to tab/panel changes,
dialogs, toasts, and status transitions. Controls use optimistic pending states
but reconcile to server-authoritative results.

## 12. Environment variables

```dotenv
DATABASE_URL=
REDIS_URL=
SESSION_SECRET=
APP_ORIGIN=
LOG_LEVEL=info

CHAIN_TYPE=                 # evm | cosmos-sdk | cosmwasm | other
CHAIN_NAME=
CHAIN_ID=
RPC_URL=
BLOCK_EXPLORER_URL=
NATIVE_TOKEN_SYMBOL=

TOKEN_SYMBOL=USDT
TOKEN_ADDRESS=
TOKEN_DECIMALS=

VAULT_1_KEY=vault-1
VAULT_1_NAME=Stablecoin Yield
VAULT_1_ADDRESS=
VAULT_2_KEY=vault-2
VAULT_2_NAME=Opportunistic Credit
VAULT_2_ADDRESS=
VAULT_3_KEY=vault-3
VAULT_3_NAME=Core Income
VAULT_3_ADDRESS=

BACKEND_SIGNER_ENABLED=false
BACKEND_SIGNER_PROVIDER=     # process-env | kms | secret-manager
BACKEND_SIGNER_SECRET_REF=   # identifier only; not the secret value
```

A development-only secret variable may be documented separately and loaded into
the worker process, excluded from Git and never exposed through `NEXT_PUBLIC_*`.

## 13. Missing information for real vault calls

Implementation of real deposits is blocked until these are supplied or safely
discovered from an official verified source:

- exact network and whether it is EVM, Cosmos SDK, CosmWasm, or another stack;
- chain ID, RPC URL, and official block explorer;
- token address/denom, decimals, and native gas token;
- three vault addresses and desired display names;
- verified vault ABI/schema/interface and exact deposit/execute method;
- every required argument, funds/message shape, and recipient semantics;
- ERC20 approval/permit rules or Cosmos allowance/funds requirements;
- expected confirmation/finality policy and transaction fee policy;
- supported wallet providers/extensions;
- whether vault contracts are upgradeable and how interface versions are found.

Until then, the adapter reports `VAULT_INTERFACE_NOT_CONFIGURED`; it never fakes
success or guesses `deposit(amount)`.

## 14. Major security concerns

- Manual browser private-key entry is materially riskier than a wallet extension
  and incompatible with unattended execution unless the secret is transferred to
  the backend. The UI must state this plainly.
- Multiple concurrent vaults can reuse nonces/sequences without centralized
  coordination and idempotency.
- Stop operations race with prepared transactions; workers must check the global
  barrier and vault generation immediately before broadcast.
- RPC timeouts can conceal a successful broadcast; reconciliation is mandatory.
- Frontend addresses and configuration are untrusted; server configuration wins.
- Sessions require secure cookies, CSRF/origin defense, rotation/revocation,
  throttling, and server-side RBAC.
- Logs, queue payloads, audit metadata, error serialization, and telemetry need
  secret-safe schemas.
- Amounts require exact base-unit arithmetic and validated decimals.
- Token deposits must preserve a separately checked native gas reserve.

## 15. Implementation phases

1. Approval and blockchain discovery.
2. Monorepo foundation, strict TypeScript, configuration validation, Docker
   Compose, PostgreSQL, Redis, and shared contracts.
3. Authentication, admin bootstrap, RBAC, sessions, CSRF, and audit logging.
4. Polished frontend shell with clearly labeled not-configured/mock data.
5. Browser wallet and warning-gated interactive manual-key signer; backend signer
   interfaces remain secret-free.
6. Prisma persistence and three independent automation configurations.
7. BullMQ scheduling, global barrier, locks, idempotency, and stop safety.
8. SSE live events and transaction-history query/cache behavior.
9. Verified chain-specific clients, token balance, adapter, simulation, approval,
   broadcast, confirmation, and reconciliation.
10. Unit/integration/security/concurrency tests.
11. Responsive polish, accessibility, failure states, and documentation.

No Phase 2 implementation should begin until this architecture is approved.
