import { readFile } from 'fs/promises';
import path from 'path';

import type { AppConfig } from './env.js';

export type ChainType = 'evm' | 'tendermint';

export interface ChainRegistryEntry {
  id: string; // e.g., "sepolia-testnet"
  chainType: ChainType;
  chainId?: number;
  chainName?: string;
  network: 'mainnet' | 'testnet';
  displayName: string;
  rpcUrls: string[];
  explorer?: {
    baseUrl: string;
    addressPath?: string;
    txPath?: string;
  };
  contracts?: {
    usdc?: string;
    tokenMessenger?: string;
    messageTransmitter?: string;
  };
  gasless?: {
    enabled: boolean;
    zeroExChainId?: number;
    zeroExBaseUrl?: string;
  };
}

export type ChainRegistry = Record<string, ChainRegistryEntry>;

const FALLBACK_REGISTRY: ChainRegistry = {
  'sepolia-testnet': {
    id: 'sepolia-testnet',
    chainType: 'evm',
    chainId: 11155111,
    network: 'testnet',
    displayName: 'Ethereum Sepolia',
    rpcUrls: ['https://rpc.sepolia.org'],
    explorer: { baseUrl: 'https://sepolia.etherscan.io' },
    contracts: {
      usdc: '',
      tokenMessenger: ''
    },
    gasless: {
      enabled: false,
      zeroExChainId: 11155111
    }
  },
  'base-sepolia-testnet': {
    id: 'base-sepolia-testnet',
    chainType: 'evm',
    chainId: 84532,
    network: 'testnet',
    displayName: 'Base Sepolia',
    rpcUrls: ['https://sepolia.base.org'],
    explorer: { baseUrl: 'https://sepolia.basescan.org' },
    contracts: {
      usdc: '',
      tokenMessenger: ''
    },
    gasless: {
      enabled: false,
      zeroExChainId: 84532
    }
  },
  'noble-testnet': {
    id: 'noble-testnet',
    chainType: 'tendermint',
    chainName: 'noble',
    network: 'testnet',
    displayName: 'Noble Testnet',
    rpcUrls: ['https://noble-testnet-rpc.polkachu.com'],
    explorer: { baseUrl: 'https://testnet.mintscan.io/noble' }
  },
  'namada-testnet': {
    id: 'namada-testnet',
    chainType: 'tendermint',
    chainName: 'namada',
    network: 'testnet',
    displayName: 'Namada Public Testnet',
    rpcUrls: ['https://rpc.namada.world'],
    explorer: { baseUrl: 'https://namada.world' }
  }
};

let cachedRegistry: ChainRegistry | undefined;

export async function loadChainRegistry(_config: AppConfig): Promise<ChainRegistry> {
  if (cachedRegistry) {
    return cachedRegistry;
  }

  const overridePath = process.env.CHAIN_REGISTRY_PATH;
  if (!overridePath) {
    cachedRegistry = FALLBACK_REGISTRY;
    return cachedRegistry;
  }

  const resolved = path.isAbsolute(overridePath)
    ? overridePath
    : path.join(process.cwd(), overridePath);

  try {
    const fileContents = await readFile(resolved, 'utf8');
    const parsed = JSON.parse(fileContents) as ChainRegistryEntry[];
    const registry: ChainRegistry = {};
    for (const entry of parsed) {
      registry[entry.id] = entry;
    }
    cachedRegistry = Object.keys(registry).length > 0 ? registry : FALLBACK_REGISTRY;
  } catch (err) {
    const logger = console;
    logger.warn('Failed to load chain registry override, falling back to defaults', err);
    cachedRegistry = FALLBACK_REGISTRY;
  }

  return cachedRegistry;
}

export function getChainEntry(registry: ChainRegistry, chainId: string): ChainRegistryEntry {
  const entry = registry[chainId];
  if (!entry) {
    throw new Error(`Unknown chain identifier: ${chainId}`);
  }
  return entry;
}

export function listChains(registry: ChainRegistry): ChainRegistryEntry[] {
  return Object.values(registry);
}

