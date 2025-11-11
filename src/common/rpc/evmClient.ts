import { type AxiosInstance } from 'axios';

import { createHttpClient, type HttpClientOptions } from '../http/httpClient.js';

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: JsonRpcError;
}

export interface EvmTransaction {
  hash: string;
  from: string;
  to?: string;
  blockHash?: string;
  blockNumber?: string;
  input?: string;
  value?: string;
  [key: string]: unknown;
}

export interface EvmTransactionReceipt {
  transactionHash: string;
  status?: string;
  blockHash?: string;
  blockNumber?: string;
  logs?: EvmLog[];
  [key: string]: unknown;
}

export interface EvmLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
  removed: boolean;
  [key: string]: unknown;
}

export interface EvmLogFilter {
  fromBlock?: string;
  toBlock?: string;
  address?: string | string[];
  topics?: (string | string[] | null)[];
}

export interface EvmRpcClient {
  type: 'evm';
  getTransaction(txHash: string): Promise<EvmTransaction | null>;
  getTransactionReceipt(txHash: string): Promise<EvmTransactionReceipt | null>;
  getBlockNumber(): Promise<number>;
  getLogs(filter: EvmLogFilter): Promise<EvmLog[]>;
}

export type EvmRpcClientOptions = HttpClientOptions;

export function createEvmRpcClient(
  endpoint: string,
  options?: EvmRpcClientOptions
): EvmRpcClient {
  const http = createHttpClient({
    baseURL: endpoint,
    timeoutMs: options?.timeoutMs ?? 30_000
  });

  return buildClient(http);
}

export function buildClient(http: AxiosInstance): EvmRpcClient {
  async function callRpc<T>(method: string, params: unknown[] = []): Promise<T | null> {
    const payload = {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params
    };

    const { data } = await http.post<JsonRpcResponse<T>>('', payload);
    if (data.error) {
      const error = new Error(
        `EVM RPC error (${data.error.code}): ${data.error.message}`
      );
      (error as Error & { cause?: unknown }).cause = data.error.data;
      throw error;
    }

    return data.result ?? null;
  }

  return {
    type: 'evm',
    async getTransaction(txHash) {
      return callRpc<EvmTransaction>('eth_getTransactionByHash', [txHash]);
    },
    async getTransactionReceipt(txHash) {
      return callRpc<EvmTransactionReceipt>('eth_getTransactionReceipt', [txHash]);
    },
    async getBlockNumber() {
      const blockHex = await callRpc<string>('eth_blockNumber');
      if (!blockHex) {
        throw new Error('eth_blockNumber returned null');
      }
      return Number.parseInt(blockHex, 16);
    },
    async getLogs(filter) {
      return (await callRpc<EvmLog[]>('eth_getLogs', [filter])) ?? [];
    }
  };
}

