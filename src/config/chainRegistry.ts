import { readFile } from 'fs/promises';
import path from 'path';

import type { AppConfig } from './env.js';

export type ChainType = 'evm' | 'tendermint';

export interface ChainRegistryEntry {
  id: string; // e.g., "sepolia" (matches frontend evm-chains.json keys)
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
  // EVM chains - matching frontend evm-chains.json keys
  'sepolia': {
    id: 'sepolia',
    chainType: 'evm',
    chainId: 11155111,
    network: 'testnet',
    displayName: 'Ethereum Sepolia',
    rpcUrls: ['https://sepolia.gateway.tenderly.co'],
    explorer: { 
      baseUrl: 'https://sepolia.etherscan.io',
      txPath: 'tx',
      addressPath: 'address'
    },
    contracts: {
      usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5'
    },
    gasless: {
      enabled: true,
      zeroExChainId: 11155111,
      zeroExBaseUrl: 'https://api.0x.org'
    }
  },
  'base-sepolia': {
    id: 'base-sepolia',
    chainType: 'evm',
    chainId: 84532,
    network: 'testnet',
    displayName: 'Base Sepolia',
    rpcUrls: ['https://sepolia.base.org'],
    explorer: { 
      baseUrl: 'https://sepolia.basescan.org',
      txPath: 'tx',
      addressPath: 'address'
    },
    contracts: {
      usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5'
    },
    gasless: {
      enabled: false,
      zeroExChainId: 84532
    }
  },
  'avalanche-fuji': {
    id: 'avalanche-fuji',
    chainType: 'evm',
    chainId: 43113,
    network: 'testnet',
    displayName: 'Avalanche Fuji',
    rpcUrls: ['https://api.avax-test.network/ext/bc/C/rpc'],
    explorer: { 
      baseUrl: 'https://subnets-test.avax.network',
      txPath: 'c-chain/tx',
      addressPath: 'c-chain/address'
    },
    contracts: {
      usdc: '0x5425890298aed601595a70AB815c96711a31Bc65',
      tokenMessenger: '0xeb08f243E5d3FCFF26A9E38Ae5520A669f4019d0'
    },
    gasless: {
      enabled: false
    }
  },
  'polygon-amoy': {
    id: 'polygon-amoy',
    chainType: 'evm',
    chainId: 80002,
    network: 'testnet',
    displayName: 'Polygon Amoy',
    rpcUrls: ['https://rpc-amoy.polygon.technology'],
    explorer: { 
      baseUrl: 'https://amoy.polygonscan.com',
      txPath: 'tx',
      addressPath: 'address'
    },
    contracts: {
      usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
      tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5'
    },
    gasless: {
      enabled: false
    }
  },
  // Tendermint chains
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
    rpcUrls: ['https://rpc.testnet.siuuu.click'],
    explorer: { baseUrl: 'https://testnet.namada.world' }
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

