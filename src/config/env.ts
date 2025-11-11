import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(0).max(65535).default(3000),
    HOST: z.string().min(1).default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGINS: z.string().optional(),
    DATABASE_URL: z.string().url().optional(),
    REDIS_URL: z.string().url().optional(),
    EVM_RPC_URLS: z.string().optional(),
    TENDERMINT_RPC_URLS: z.string().optional()
  })
  .transform((value) => ({
    nodeEnv: value.NODE_ENV,
    port: value.PORT,
    host: value.HOST,
    logLevel: value.LOG_LEVEL,
    databaseUrl: value.DATABASE_URL,
    redisUrl: value.REDIS_URL,
    corsOrigins: value.CORS_ORIGINS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
    evmRpcUrls: value.EVM_RPC_URLS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
    tendermintRpcUrls:
      value.TENDERMINT_RPC_URLS?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
  }));

export type AppConfig = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | undefined;

export function loadConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const parsed = envSchema.parse(process.env);
  cachedConfig = Object.freeze(parsed);
  return cachedConfig;
}

