import type { HttpClient } from '../../common/http/httpClient.js';
import type { AppLogger } from '../../common/utils/logger.js';
import type {
  NobleBalanceResponse,
  NobleBroadcastResponse,
  NobleForwardingAddressResponse
} from './types.js';

export interface NobleLcdClient {
  checkForwardingAddressExists(
    channel: string,
    recipient: string,
    fallback?: string
  ): Promise<NobleForwardingAddressResponse>;
  getBalance(address: string): Promise<NobleBalanceResponse>;
  broadcastTransaction(txBytes: string): Promise<NobleBroadcastResponse>;
}

export interface NobleLcdClientDependencies {
  httpClient: HttpClient;
  logger: AppLogger;
  baseUrl: string;
}

export function createNobleLcdClient({
  httpClient,
  logger,
  baseUrl
}: NobleLcdClientDependencies): NobleLcdClient {
  return {
    async checkForwardingAddressExists(channel, recipient, fallback = '') {
      const url = fallback
        ? `/noble/forwarding/v1/address/${channel}/${recipient}/${fallback}`
        : `/noble/forwarding/v1/address/${channel}/${recipient}/`; // trailing slash is essential

      logger.debug({ channel, recipient, fallback, url }, 'Checking Noble forwarding address existence');

      try {
        const response = await httpClient.get<NobleForwardingAddressResponse>(url);
        return response.data;
      } catch (error) {
        const axiosError = error as { response?: { status?: number }; message?: string };
        if (axiosError.response?.status === 404) {
          // 404 means forwarding address doesn't exist
          logger.debug({ channel, recipient }, 'Forwarding address does not exist (404)');
          return { exists: false };
        }
        logger.error(
          { err: error, channel, recipient, fallback },
          'Failed to check Noble forwarding address existence'
        );
        throw error;
      }
    },

    async getBalance(address: string) {
      const url = `/cosmos/bank/v1beta1/balances/${address}`;
      logger.debug({ address, url }, 'Fetching Noble balance');

      try {
        const response = await httpClient.get<NobleBalanceResponse>(url);
        return response.data;
      } catch (error) {
        logger.error({ err: error, address }, 'Failed to fetch Noble balance');
        throw error;
      }
    },

    async broadcastTransaction(txBytes: string) {
      const url = `/cosmos/tx/v1beta1/txs`;
      logger.debug({ url }, 'Broadcasting Noble transaction');

      try {
        const response = await httpClient.post<NobleBroadcastResponse>(url, {
          tx_bytes: txBytes,
          mode: 'BROADCAST_MODE_SYNC'
        });
        return response.data;
      } catch (error) {
        logger.error({ err: error }, 'Failed to broadcast Noble transaction');
        throw error;
      }
    }
  };
}

