import type { AppConfig } from './env.js';
import type { ChainRegistry } from './chainRegistry.js';

export interface ChainPollingConfig {
  maxDurationMin: number; // Maximum duration to poll before timing out (minutes)
  blockWindowBackscan: number; // Number of blocks to scan backwards on startup
  pollIntervalMs: number; // Interval between poll attempts (milliseconds)
}

export type ChainPollingConfigs = Record<string, ChainPollingConfig>;

const DEFAULT_POLLING_CONFIG: ChainPollingConfig = {
  maxDurationMin: 30,
  blockWindowBackscan: 20,
  pollIntervalMs: 5000,
};

const FALLBACK_CHAIN_CONFIGS: ChainPollingConfigs = {
  // EVM chains - matching frontend evm-chains.json keys
  'sepolia': {
    maxDurationMin: 10,
    blockWindowBackscan: 5,
    pollIntervalMs: 5000,
  },
  'base-sepolia': {
    maxDurationMin: 10,
    blockWindowBackscan: 5,
    pollIntervalMs: 5000,
  },
  'avalanche-fuji': {
    maxDurationMin: 10,
    blockWindowBackscan: 5,
    pollIntervalMs: 5000,
  },
  'polygon-amoy': {
    maxDurationMin: 10,
    blockWindowBackscan: 5,
    pollIntervalMs: 5000,
  },
  // Tendermint chains
  'noble-testnet': {
    maxDurationMin: 20,
    blockWindowBackscan: 10,
    pollIntervalMs: 5000,
  },
  'namada-testnet': {
    maxDurationMin: 15,
    blockWindowBackscan: 5,
    pollIntervalMs: 5000,
  },
};

let cachedConfigs: ChainPollingConfigs | undefined;

export function loadChainPollingConfigs(
  _config: AppConfig,
  registry: ChainRegistry
): ChainPollingConfigs {
  if (cachedConfigs) {
    return cachedConfigs;
  }

  // Start with fallback configs
  const configs: ChainPollingConfigs = { ...FALLBACK_CHAIN_CONFIGS };

  // Override from environment variables if provided
  const envConfigs = process.env.CHAIN_POLLING_CONFIGS;
  if (envConfigs) {
    try {
      const parsed = JSON.parse(envConfigs) as Record<string, Partial<ChainPollingConfig>>;
      for (const [chainId, chainConfig] of Object.entries(parsed)) {
        // Validate chain exists in registry
        if (registry[chainId]) {
          configs[chainId] = {
            ...DEFAULT_POLLING_CONFIG,
            ...configs[chainId],
            ...chainConfig,
          };
        }
      }
    } catch (error) {
      console.warn('Failed to parse CHAIN_POLLING_CONFIGS from environment', error);
    }
  }

  // Ensure all chains in registry have a config
  for (const chainId of Object.keys(registry)) {
    if (!configs[chainId]) {
      configs[chainId] = { ...DEFAULT_POLLING_CONFIG };
    }
  }

  cachedConfigs = configs;
  return cachedConfigs;
}

export function getChainPollingConfig(
  configs: ChainPollingConfigs,
  chainId: string
): ChainPollingConfig {
  return configs[chainId] || DEFAULT_POLLING_CONFIG;
}

