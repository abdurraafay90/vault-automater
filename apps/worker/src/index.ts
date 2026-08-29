if (process.env.NODE_ENV !== 'production') {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const required = ['DATABASE_URL', 'REDIS_URL'] as const;
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error({ event: 'worker_configuration_invalid', missing });
  process.exitCode = 1;
} else {
  console.info({ event: 'worker_ready', blockchainStatus: 'VAULT_INTERFACE_NOT_CONFIGURED' });
}
