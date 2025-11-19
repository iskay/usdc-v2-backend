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
    TENDERMINT_RPC_URLS: z.string().optional(),
    // Noble Forwarding Configuration
    NOBLE_LCD_BASE: z.string().url().optional(),
    NOBLE_CHANNEL_ID: z.string().default('channel-136'),
    NOBLE_FALLBACK: z.string().default(''),
    NOBLE_REG_MIN_UUSDC: z.coerce.number().int().min(0).default(20000),
    NOBLE_REG_GAS: z.coerce.number().int().min(0).default(125000),
    NOBLE_REG_FEE_UUSDC: z.coerce.number().int().min(0).default(12500),
    NOBLE_REG_CHECK_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
    NOBLE_REG_STALE_MS: z.coerce.number().int().min(0).default(24 * 60 * 60 * 1000)
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
      value.TENDERMINT_RPC_URLS?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
    // Noble Forwarding Configuration
    nobleLcdBase: value.NOBLE_LCD_BASE,
    nobleChannelId: value.NOBLE_CHANNEL_ID,
    nobleFallback: value.NOBLE_FALLBACK,
    nobleRegMinUusdc: value.NOBLE_REG_MIN_UUSDC,
    nobleRegGas: value.NOBLE_REG_GAS,
    nobleRegFeeUusdc: value.NOBLE_REG_FEE_UUSDC,
    nobleRegCheckIntervalMs: value.NOBLE_REG_CHECK_INTERVAL_MS,
    nobleRegStaleMs: value.NOBLE_REG_STALE_MS
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

