# GitHub Actions deployment setup

Before enabling the deployment job, create the GitHub `production` environment
and add these secrets to it: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, and
`SSH_KNOWN_HOSTS`. `SSH_KNOWN_HOSTS` must contain the exact, independently
verified `known_hosts` line for the production host. Do not add fake values.

The deployment account must be able to run Docker Compose for the
`vault-automater` project, read `/opt/vault-automater/.env`, and write
`/opt/vault-automater/.deploy` and `/var/backups/vault-automater`. It should
not be granted access to unrelated Docker projects or server users.

The workflow uses the automatic `GITHUB_TOKEN` for GHCR publishing. It does
not require a manually created token. The web image always receives the fixed
production build argument `https://vault.wickhub.cc`.

CI runs on pull requests targeting `main`. Make its `checks-and-images` job a
required status check in the repository's `main` branch ruleset before merging.
CD runs only on pushes to `main`, which includes a normal merged pull request.
The deployment job retains `environment: production`, so its approval rules
and environment secrets apply when configured.

The first deployment does not blindly replace the current manual deployment.
It checks the currently running API, web, and worker, verifies their health and
fresh worker heartbeat, tags their exact local image IDs as a baseline, and
aborts if that baseline is not healthy. Later failures roll back to that
baseline or the previous verified GHCR release. Release state is parsed as
strict key-value data; no `eval` or `source` is used.

Before replacement, the deployment creates a consistent SQLite backup with
`VACUUM INTO` under `/var/backups/vault-automater`. A rollback after a schema
migration may still be unsafe if the old image cannot read the newer database;
the script reports that condition and the backup path for reviewed recovery.