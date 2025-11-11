import { getChainEntry, type ChainRegistry, type ChainRegistryEntry } from '../../config/chainRegistry.js';
import { createEvmRpcClient, type EvmRpcClient } from './evmClient.js';
import { createTendermintRpcClient, type TendermintRpcClient } from './tendermintClient.js';

export type RpcClient = EvmRpcClient | TendermintRpcClient;

export interface RpcClientFactory {
  (chainId: string): RpcClient;
}

export function createRpcClientFactory(
  registry: ChainRegistry
): RpcClientFactory {
  return (chainId: string) => {
    const entry = getChainEntry(registry, chainId);
    const endpoint = resolveEndpoint(entry);

    if (entry.chainType === 'evm') {
      return createEvmRpcClient(endpoint);
    }

    return createTendermintRpcClient(endpoint);
  };
}

function resolveEndpoint(entry: ChainRegistryEntry): string {
  const endpoint = entry.rpcUrls?.[0];
  if (!endpoint) {
    throw new Error(`No RPC URL configured for chain ${entry.id}`);
  }
  return endpoint;
}

