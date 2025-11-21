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
      // Format query: wrap entire query string in double quotes
      // Example input query: circle.cctp.v1.MessageReceived.nonce='\"704111\"'
      // Example formatted: "circle.cctp.v1.MessageReceived.nonce='\"704111\"'"
      const formattedQuery = `"${query}"`;
      
      // Manually construct the URL-encoded query parameter
      // Format: "circle.cctp.v1.MessageReceived.nonce%3D%27\"704111\"%27"
      // - Outer quotes are literal (not encoded in the example, but we'll encode them for HTTP)
      // - = is encoded as %3D
      // - ' is encoded as %27
      // - \" stays as \" (backslash + quote, not encoded)
      // Strategy: encode everything, then replace encoded backslashes with literal backslashes
      let queryParam = encodeURIComponent(formattedQuery);
      // Replace %5C (encoded backslash) with literal backslash
      queryParam = queryParam.replace(/%5C/g, '\\');
      
      const url = `/tx_search?query=${queryParam}`;
      
      const baseURL = (http.defaults.baseURL as string) || '';
      // For logging: properly construct the full URL
      const baseURLWithSlash = baseURL.endsWith('/') ? baseURL.slice(0, -1) : baseURL;
      const fullUrl = `${baseURLWithSlash}${url}`;
      console.log(`[tx_search] Raw query string: ${query}`);
      console.log(`[tx_search] Formatted query (with quotes): ${formattedQuery}`);
      console.log(`[tx_search] URL-encoded query param: ${queryParam}`);
      console.log(`[tx_search] Base URL: ${baseURL}`);
      console.log(`[tx_search] Request path: ${url}`);
      console.log(`[tx_search] Full URL: ${fullUrl}`);
      try {
        const response = await http.get<{ txs?: TendermintTx[]; total_count?: string; result?: { txs?: TendermintTx[]; total_count?: string } }>(url);
        console.log(`[tx_search] Response status: ${response.status}`);
        console.log(`[tx_search] Response data keys:`, Object.keys(response.data || {}));
        console.log(`[tx_search] Full response data:`, JSON.stringify(response.data, null, 2));
        
        // Handle different response structures
        const txs = response.data?.txs || response.data?.result?.txs || [];
        console.log(`[tx_search] Extracted transactions: ${txs.length}`);
        if (txs.length > 0) {
          console.log(`[tx_search] First transaction:`, {
            hash: txs[0].hash,
            height: txs[0].height,
            hasTxResult: !!(txs[0] as any).tx_result,
            hasResult: !!(txs[0] as any).result,
          });
        }
        
        return txs;
      } catch (error: any) {
        console.error(`[tx_search] Request failed`);
        console.error(`[tx_search] Error status: ${error?.response?.status}`);
        console.error(`[tx_search] Error message: ${error?.message}`);
        console.error(`[tx_search] Error data:`, JSON.stringify(error?.response?.data, null, 2));
        console.error(`[tx_search] Request URL was: ${fullUrl}`);
        throw error;
      }
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

