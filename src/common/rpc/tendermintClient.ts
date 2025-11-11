import { URLSearchParams } from 'node:url';

import type { AxiosInstance } from 'axios';

import { createHttpClient, type HttpClientOptions } from '../http/httpClient.js';

export interface TendermintTx {
  hash: string;
  height: string;
  tx: string;
  result?: {
    log?: string;
    events?: TendermintEvent[];
    code?: number;
  };
  [key: string]: unknown;
}

export interface TendermintEventAttribute {
  key: string;
  value: string;
  index?: boolean;
}

export interface TendermintEvent {
  type: string;
  attributes: TendermintEventAttribute[];
}

export interface TendermintBlockResults {
  height: string;
  txs_results?: Array<{
    code: number;
    log: string;
    events: TendermintEvent[];
  }>;
  finalize_block_events?: TendermintEvent[];
}

export interface TendermintStatus {
  node_info: {
    network: string;
  };
  sync_info: {
    latest_block_hash: string;
    latest_app_hash: string;
    latest_block_height: string;
    latest_block_time: string;
  };
}

export interface TendermintRpcClient {
  type: 'tendermint';
  getTransaction(txHash: string): Promise<TendermintTx | null>;
  searchTransactions(query: string, page?: number, perPage?: number): Promise<TendermintTx[]>;
  getBlockResults(height: number): Promise<TendermintBlockResults | null>;
  getLatestBlockHeight(): Promise<number>;
}

export type TendermintRpcClientOptions = HttpClientOptions;

export function createTendermintRpcClient(
  endpoint: string,
  options?: TendermintRpcClientOptions
): TendermintRpcClient {
  const http = createHttpClient({
    baseURL: endpoint,
    timeoutMs: options?.timeoutMs ?? 30_000
  });

  return buildClient(http);
}

export function buildClient(http: AxiosInstance): TendermintRpcClient {
  return {
    type: 'tendermint',

    async getTransaction(txHash) {
      try {
        const { data } = await http.get<{ tx?: TendermintTx }>('tx', {
          params: {
            hash: txHash.startsWith('0x') ? txHash : `0x${txHash}`,
            prove: 'false'
          }
        });
        return data.tx ?? null;
      } catch (error: unknown) {
        const err = error as { response?: { status?: number } };
        if (err?.response?.status === 404) {
          return null;
        }
        throw error;
      }
    },

    async searchTransactions(query, page = 1, perPage = 30) {
      const params = new URLSearchParams({
        query,
        page: page.toString(),
        per_page: perPage.toString(),
        order_by: 'asc'
      });
      const { data } = await http.get<{ txs?: TendermintTx[] }>(`tx_search?${params.toString()}`);
      return data.txs ?? [];
    },

    async getBlockResults(height) {
      try {
        const { data } = await http.get<{ result?: TendermintBlockResults }>('block_results', {
          params: { height: height.toString() }
        });
        return data.result ?? null;
      } catch (error: unknown) {
        const err = error as { response?: { status?: number } };
        if (err?.response?.status === 404) {
          return null;
        }
        throw error;
      }
    },

    async getLatestBlockHeight() {
      const { data } = await http.get<{ result: { sync_info: TendermintStatus['sync_info'] } }>('status');
      return Number.parseInt(data.result.sync_info.latest_block_height, 10);
    }
  };
}

