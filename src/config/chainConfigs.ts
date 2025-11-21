import type { AppConfig } from './env.js';
import type { ChainRegistry } from './chainRegistry.js';

export interface IrisPollingConfig {
  enabled: boolean; // Enable iris polling for this chain
  pollIntervalMs: number; // Interval between iris API polls (milliseconds)
  timeoutMs: number; // Maximum time to wait for attestation (milliseconds)
  requestTimeoutMs?: number; // HTTP request timeout (milliseconds)
}

export interface ChainPollingConfig {
  maxDurationMin: number; // Maximum duration to poll before timing out (minutes)
  blockWindowBackscan: number; // Number of blocks to scan backwards on startup
  pollIntervalMs: number; // Interval between poll attempts (milliseconds)
  blockRequestDelayMs?: number; // Delay between consecutive block_results requests (milliseconds)
  iris?: IrisPollingConfig; // Iris attestation polling configuration
}

export type ChainPollingConfigs = Record<string, ChainPollingConfig>;

const DEFAULT_IRIS_CONFIG: IrisPollingConfig = {
  enabled: true, // Enable for EVM chains by default
  pollIntervalMs: 30000, // Poll every 30 seconds
  timeoutMs: 20 * 60 * 1000, // 20 minutes max wait
  requestTimeoutMs: 5000, // 5 second HTTP timeout
};

const DEFAULT_POLLING_CONFIG: ChainPollingConfig = {
  maxDurationMin: 30,
  blockWindowBackscan: 50,
  pollIntervalMs: 5000,
  blockRequestDelayMs: 100, // Default 100ms delay between block requests
};

const FALLBACK_CHAIN_CONFIGS: ChainPollingConfigs = {
  // EVM chains - matching frontend evm-chains.json keys
  'sepolia': {
    maxDurationMin: 10,
    blockWindowBackscan: 50,
    pollIntervalMs: 5000,
    iris: {
      enabled: true,
      pollIntervalMs: 30000, // Faster polling for testnet
      timeoutMs: 30 * 60 * 1000, // 30 minutes for testnet
    },
  },
  'base-sepolia': {
    maxDurationMin: 10,
    blockWindowBackscan: 50,
    pollIntervalMs: 5000,
    iris: {
      enabled: true,
      pollIntervalMs: 5000, // Fast chain, can poll more frequently
      timeoutMs: 10 * 60 * 1000, // 10 minutes
    },
  },
  'avalanche-fuji': {
    maxDurationMin: 10,
    blockWindowBackscan: 50,
    pollIntervalMs: 5000,
    iris: {
      enabled: true,
      pollIntervalMs: 5000,
      timeoutMs: 10 * 60 * 1000,
    },
  },
  'polygon-amoy': {
    maxDurationMin: 10,
    blockWindowBackscan: 50,
    pollIntervalMs: 5000,
    iris: {
      enabled: true,
      pollIntervalMs: 5000,
      timeoutMs: 10 * 60 * 1000,
    },
  },
  // Tendermint chains (no iris polling - not EVM)
  'noble-testnet': {
    maxDurationMin: 10,
    blockWindowBackscan: 50,
    pollIntervalMs: 5000,
    // No iris config - not an EVM chain
  },
  'namada-testnet': {
    maxDurationMin: 5,
    blockWindowBackscan: 20,
    pollIntervalMs: 5000,
    // No iris config - not an EVM chain
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
      const chainEntry = registry[chainId];
      // Add default iris config for EVM chains
      const config: ChainPollingConfig = { ...DEFAULT_POLLING_CONFIG };
      if (chainEntry.chainType === 'evm') {
        config.iris = { ...DEFAULT_IRIS_CONFIG };
      }
      configs[chainId] = config;
    } else if (registry[chainId].chainType === 'evm' && !configs[chainId].iris) {
      // Ensure EVM chains have iris config if missing
      configs[chainId].iris = { ...DEFAULT_IRIS_CONFIG };
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

