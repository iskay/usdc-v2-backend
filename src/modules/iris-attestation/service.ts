/**
 * Iris Attestation Service
 * Handles MessageSent event extraction and Iris API polling
 */

import type { AxiosInstance } from 'axios';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createHttpClient } from '../../common/http/httpClient.js';
import type { EvmRpcClient, EvmTransactionReceipt, EvmLog } from '../../common/rpc/evmClient.js';
import type { ChainRegistry } from '../../config/chainRegistry.js';
import type { AppLogger } from '../../common/utils/logger.js';
import { sleep } from '../tx-tracker/pollers/base.js';
import { parseMessage, parseBurnMessage } from './messageParser.js';
import type {
  AttestationResponse,
  MessageSentData,
  IrisPollingParams,
  IrisPollingResult,
  MessageSentExtractionResult,
} from './types.js';

// MessageSent event signature: keccak256("MessageSent(bytes)")
// This is the first topic in the event log
const MESSAGE_SENT_EVENT_TOPIC = '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036';

// DepositForBurn event signature: keccak256("DepositForBurn(uint64,address,uint256,address,bytes32,uint32,bytes32,bytes32)")
const DEPOSIT_FOR_BURN_EVENT_TOPIC = '0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0';

/**
 * Keccak256 hash function
 * Returns hex string without 0x prefix
 */
function keccak256(data: Uint8Array): string {
  const hash = keccak_256(data);
  return bytesToHex(hash);
}

export interface IrisAttestationServiceDependencies {
  chainRegistry: ChainRegistry;
  logger: AppLogger;
  attestationBaseURL?: string; // Default: https://iris-api.circle.com/attestations/
}

export interface IrisAttestationService {
  extractMessageSent(
    txHash: string,
    chainId: string,
    rpcClient: EvmRpcClient
  ): Promise<MessageSentExtractionResult>;
  
  pollAttestation(
    params: IrisPollingParams,
    irisLookupID: string,
    rpcClient?: EvmRpcClient
  ): Promise<IrisPollingResult>;
}

export function createIrisAttestationService(
  deps: IrisAttestationServiceDependencies
): IrisAttestationService {
  const { chainRegistry, logger, attestationBaseURL = 'https://iris-api.circle.com/attestations/' } = deps;

  // Ensure base URL ends with /
  const baseURL = attestationBaseURL.endsWith('/') ? attestationBaseURL : `${attestationBaseURL}/`;
  
  // Create HTTP client for iris API
  const httpClient: AxiosInstance = createHttpClient({
    baseURL,
    timeoutMs: 5000, // Default 5s timeout
  });

  /**
   * Extract MessageSent event from transaction receipt
   */
  async function extractMessageSent(
    txHash: string,
    chainId: string,
    rpcClient: EvmRpcClient
  ): Promise<MessageSentExtractionResult> {
    try {
      const chainEntry = chainRegistry[chainId];
      if (!chainEntry) {
        return {
          success: false,
          error: `Chain not found in registry: ${chainId}`,
        };
      }

      const messageTransmitterAddress = chainEntry.contracts?.messageTransmitter;
      if (!messageTransmitterAddress) {
        return {
          success: false,
          error: `MessageTransmitter address not configured for chain: ${chainId}`,
        };
      }

      logger.debug({ txHash, chainId }, 'Extracting MessageSent event from transaction receipt');

      // Get transaction receipt
      const receipt = await rpcClient.getTransactionReceipt(txHash);
      if (!receipt) {
        return {
          success: false,
          error: `Transaction receipt not found for hash: ${txHash}`,
        };
      }

      if (!receipt.logs || receipt.logs.length === 0) {
        return {
          success: false,
          error: `No logs found in transaction receipt`,
        };
      }

      // Find MessageSent event log
      // MessageSent event has:
      // - topics[0] = event signature hash
      // - data = ABI-encoded bytes message
      const messageTransmitterAddressLower = messageTransmitterAddress.toLowerCase();
      let messageSentLog: EvmLog | undefined;

      for (const log of receipt.logs) {
        const logAddress = log.address?.toLowerCase();
        if (
          logAddress === messageTransmitterAddressLower &&
          log.topics?.[0] === MESSAGE_SENT_EVENT_TOPIC
        ) {
          messageSentLog = log;
          break;
        }
      }

      if (!messageSentLog) {
        // Try fallback: extract nonce from DepositForBurn event
        logger.debug({ txHash }, 'MessageSent event not found, trying DepositForBurn fallback');
        return extractNonceFromDepositForBurn(receipt, chainId);
      }

      // Decode MessageSent event data
      // The data field contains the ABI-encoded bytes message
      // For dynamic bytes, ABI encoding is: offset (32 bytes) + length (32 bytes) + data
      const dataHex = messageSentLog.data;
      if (!dataHex || dataHex === '0x') {
        return {
          success: false,
          error: 'MessageSent event data is empty',
        };
      }

      logger.debug(
        { txHash, chainId, dataHex, dataLength: dataHex.length },
        'Decoding MessageSent event data'
      );

      // Remove 0x prefix and convert to bytes
      const dataBytes = Buffer.from(dataHex.slice(2), 'hex');
      
      // ABI-encoded dynamic bytes: offset (32 bytes) + length (32 bytes) + data
      if (dataBytes.length < 64) {
        logger.error(
          { txHash, chainId, dataBytesLength: dataBytes.length, dataHex },
          'MessageSent data too short for ABI encoding'
        );
        return {
          success: false,
          error: `MessageSent data too short: ${dataBytes.length} bytes (need at least 64 for offset + length)`,
        };
      }

      // Read offset (first 32 bytes) - should be 0x20 (32) for single dynamic parameter
      const offsetBytes = dataBytes.slice(0, 32);
      const offset = Number(BigInt('0x' + offsetBytes.toString('hex')));
      
      // Read length (next 32 bytes) as uint256
      const lengthBytes = dataBytes.slice(32, 64);
      const length = Number(BigInt('0x' + lengthBytes.toString('hex')));
      
      logger.debug(
        { txHash, chainId, offset, length, totalDataBytes: dataBytes.length },
        'Parsed ABI offset and length'
      );

      // Extract message bytes (after offset + length = 64 bytes)
      const messageBytes = new Uint8Array(dataBytes.slice(64, 64 + length));

      if (messageBytes.length === 0) {
        logger.error(
          {
            txHash,
            chainId,
            offset,
            length,
            dataBytesLength: dataBytes.length,
            dataHex: dataHex.substring(0, 200), // First 200 chars for debugging
          },
          'Message bytes are empty after ABI decoding'
        );
        return {
          success: false,
          error: `Message bytes are empty (length=${length}, offset=${offset}, dataBytes.length=${dataBytes.length})`,
        };
      }

      logger.debug(
        { txHash, chainId, messageBytesLength: messageBytes.length },
        'Successfully extracted message bytes from ABI-encoded data'
      );

      // Parse Message struct
      let message;
      try {
        message = parseMessage(messageBytes);
      } catch (error) {
        return {
          success: false,
          error: `Failed to parse Message struct: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Verify it's a BurnMessage
      try {
        parseBurnMessage(message.messageBody);
      } catch (error) {
        return {
          success: false,
          error: `MessageBody is not a valid BurnMessage: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      // Compute IrisLookupID (Keccak256 hash of MessageSent bytes)
      // Using a simple keccak256 implementation
      const irisLookupID = keccak256(messageBytes);

      logger.info(
        {
          txHash,
          chainId,
          irisLookupID,
          nonce: message.nonce,
          sourceDomain: message.sourceDomain,
          destinationDomain: message.destinationDomain,
        },
        'Successfully extracted MessageSent event'
      );

      return {
        success: true,
        data: {
          irisLookupID,
          nonce: message.nonce,
          sourceDomain: message.sourceDomain,
          destinationDomain: message.destinationDomain,
          messageBytes,
          messageBody: message.messageBody,
          destinationCaller: message.destinationCaller,
        },
      };
    } catch (error) {
      logger.error(
        { err: error, txHash, chainId },
        'Failed to extract MessageSent event'
      );
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Fallback: Extract nonce from DepositForBurn event
   * This is less reliable but can be used if MessageSent extraction fails
   */
  async function extractNonceFromDepositForBurn(
    receipt: EvmTransactionReceipt,
    chainId: string
  ): Promise<MessageSentExtractionResult> {
    try {
      const chainEntry = chainRegistry[chainId];
      const tokenMessengerAddress = chainEntry?.contracts?.tokenMessenger;
      
      if (!tokenMessengerAddress || !receipt.logs) {
        return {
          success: false,
          error: 'TokenMessenger address not configured or no logs available',
        };
      }

      const tokenMessengerAddressLower = tokenMessengerAddress.toLowerCase();

      // Find DepositForBurn event
      for (const log of receipt.logs) {
        const logAddress = log.address?.toLowerCase();
        if (
          logAddress === tokenMessengerAddressLower &&
          log.topics?.[0] === DEPOSIT_FOR_BURN_EVENT_TOPIC
        ) {
          // DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)
          // topics[0] = event signature
          // topics[1] = nonce (indexed)
          // topics[2] = burnToken (indexed)
          // topics[3] = depositor (indexed)
          // data = amount (uint256) + mintRecipient (bytes32) + destinationDomain (uint32) + destinationTokenMessenger (bytes32) + destinationCaller (bytes32)

          if (log.topics.length >= 2) {
            // Nonce is in topics[1] as uint64 (padded to 32 bytes)
            const nonceHex = log.topics[1];
            const nonce = Number(BigInt(nonceHex));

            logger.info(
              { chainId, nonce },
              'Extracted nonce from DepositForBurn event (fallback)'
            );

            // Return partial result - we don't have full MessageSent data
            return {
              success: true,
              data: {
                irisLookupID: '', // Cannot compute without MessageSent bytes
                nonce,
                sourceDomain: 0, // Unknown
                destinationDomain: 0, // Unknown
                messageBytes: new Uint8Array(),
                messageBody: new Uint8Array(),
                destinationCaller: new Uint8Array(),
              },
            };
          }
        }
      }

      return {
        success: false,
        error: 'DepositForBurn event not found in receipt logs',
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to extract nonce from DepositForBurn: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Poll Iris API for attestation status
   */
  async function pollAttestation(
    params: IrisPollingParams,
    irisLookupID: string,
    _rpcClient?: EvmRpcClient
  ): Promise<IrisPollingResult> {
    const { flowId, timeoutMs, pollIntervalMs, requestTimeoutMs = 5000, abortSignal } = params;

    // Ensure irisLookupID has 0x prefix for API call
    const lookupID = irisLookupID.startsWith('0x') ? irisLookupID : `0x${irisLookupID}`;
    const url = lookupID;
    const fullUrl = `${baseURL}${url}`;

    const deadline = Date.now() + timeoutMs;
    let attemptCount = 0;

    logger.info(
      { flowId, irisLookupID: lookupID, url: fullUrl, timeoutMs, pollIntervalMs },
      'Starting iris attestation polling'
    );

    while (Date.now() < deadline) {
      if (abortSignal?.aborted) {
        return {
          success: false,
          error: 'Polling aborted',
        };
      }

      attemptCount++;
      
      try {
        logger.debug(
          { flowId, attemptCount, url: fullUrl },
          'Polling iris attestation API'
        );

        // Create request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

        const response = await httpClient.get<AttestationResponse>(url, {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const { status, attestation } = response.data;

        logger.debug(
          { flowId, attemptCount, status, hasAttestation: !!attestation },
          'Iris API response received'
        );

        if (status === 'complete' && attestation) {
          logger.info(
            { flowId, irisLookupID: lookupID, attemptCount },
            'Attestation complete'
          );

          return {
            success: true,
            attestation,
            irisLookupID: lookupID,
            status: 'complete',
          };
        }

        if (status === 'pending_confirmations') {
          // Continue polling
          logger.debug(
            { flowId, attemptCount, url: fullUrl },
            'Attestation pending confirmations, continuing to poll'
          );
        } else {
          logger.warn(
            { flowId, attemptCount, url: fullUrl, status },
            'Unexpected attestation status'
          );
        }
      } catch (error) {
        // Handle timeout/abort
        if (error instanceof Error && error.name === 'AbortError') {
          logger.debug({ flowId, attemptCount, url: fullUrl }, 'Iris API request timeout');
        } else if (error instanceof Error && 'response' in error) {
          const axiosError = error as { response?: { status?: number } };
          const status = axiosError.response?.status;

          // 404 means attestation not ready yet (still processing)
          if (status === 404) {
            logger.debug({ flowId, attemptCount, url: fullUrl }, 'Attestation not found (still processing)');
          } else {
            logger.warn(
              { flowId, attemptCount, url: fullUrl, status, err: error },
              'Iris API request failed'
            );
          }
        } else {
          logger.warn(
            { flowId, attemptCount, url: fullUrl, err: error },
            'Iris API request error'
          );
        }
      }

      // Wait before next poll (unless we're past deadline)
      if (Date.now() + pollIntervalMs < deadline) {
        await sleep(pollIntervalMs);
      } else {
        break;
      }
    }

    logger.warn(
      { flowId, irisLookupID: lookupID, attemptCount, timeoutMs },
      'Iris attestation polling timed out'
    );

    return {
      success: false,
      irisLookupID: lookupID,
      error: `Attestation polling timed out after ${timeoutMs}ms (${attemptCount} attempts)`,
    };
  }

  return {
    extractMessageSent,
    pollAttestation,
  };
}

