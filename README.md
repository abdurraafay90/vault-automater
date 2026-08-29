# Vaultflow

Production-oriented token automation across three independently scheduled vaults.

## Current status

The dashboard shell and foundation packages are in place. Blockchain operations
are deliberately disabled with `VAULT_INTERFACE_NOT_CONFIGURED`; no transaction
success is mocked. The target chain, token, vault addresses, and verified vault
interface are still required.

## Local development

1. Copy `.env.example` to `.env` and set development secrets locally.
2. Start PostgreSQL and Redis with `docker compose up -d`.
3. Install workspace dependencies with `npm install`.
4. Start the web app with `npm run dev:web` and API with `npm run dev:api`.

Never commit a private key. Browser manual-key mode is interactive and transient;
unattended automation requires a separately configured backend signer/KMS.
