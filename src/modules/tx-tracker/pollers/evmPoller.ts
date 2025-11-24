import type { EvmRpcClient, EvmLog } from '../../../common/rpc/evmClient.js';
import type { AppLogger } from '../../../common/utils/logger.js';
import {
  type PollParams,
  type PollResult,
  type PollUpdateCallback,
  sleep,
  createPollTimeout,
} from './base.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const DEFAULT_EVM_MAX_BLOCK_RANGE = 2000n;

// MessageReceived event signature: keccak256("MessageReceived(address,uint32,uint64,bytes32,bytes)")
const MESSAGE_RECEIVED_TOPIC = '0x58200b4c34ae05ee816d710053fff3fb75af4395915d3d2a771b24aa10e3cc5d';

export interface EvmPollParams extends PollParams {
  usdcAddress: string;
  recipient: string;
  amountBaseUnits: string;
  fromBlock?: bigint;
  // New fields for nonce-based polling
  cctpNonce?: number; // CCTP message nonce from Noble DepositForBurn
  sourceDomain?: number; // Source chain domain ID (Noble = 4)
  messageTransmitterAddress?: string; // MessageTransmitter contract address
  maxBlockRange?: number; // Maximum block span per getLogs call
}

interface ParsedMessageReceived {
  nonce: number;
  sourceDomain: number;
  sender: string;
  mintRecipient: string; // EVM address extracted from bytes32
  amount: bigint;
}

export interface EvmPollResult extends PollResult {
  blockNumber?: bigint;
}

function toPaddedTopicAddress(addr: string): string {
  const clean = addr.toLowerCase().replace(/^0x/, '');
  return `0x${clean.padStart(64, '0')}`;
}

function toHexQuantity(n: bigint): string {
  return `0x${n.toString(16)}`;
}

/**
 * Convert nonce to padded hex topic for event filtering
 * Nonce is uint64, padded to 32 bytes (64 hex characters)
 */
function toPaddedNonceTopic(nonce: number): string {
  return `0x${BigInt(nonce).toString(16).padStart(64, '0')}`;
}

/**
 * Extract EVM address from bytes32
 * EVM address is in the last 20 bytes of the bytes32 value
 */
function extractEvmAddressFromBytes32(bytes32: string): string {
  // Remove 0x prefix if present
  const clean = bytes32.replace(/^0x/, '');
  // Extract last 20 bytes (40 hex characters)
  const addressHex = clean.slice(-40);
  return `0x${addressHex}`;
}

/**
 * Parse MessageReceived event data
 * Event structure: MessageReceived(address indexed caller, uint32 sourceDomain, uint64 indexed nonce, bytes32 sender, bytes messageBody)
 * Topics: [eventSignature, caller, nonce]
 * Data: ABI-encoded (uint32 sourceDomain, bytes32 sender, bytes messageBody)
 */
function parseMessageReceivedEvent(log: EvmLog): ParsedMessageReceived | null {
  try {
    if (log.topics.length < 3) {
      return null;
    }

    // Extract nonce from topics[2] (indexed uint64, padded to 32 bytes)
    const nonceTopic = log.topics[2];
    const nonce = Number(BigInt(nonceTopic));

    // Parse data field: ABI-encoded (uint32 sourceDomain, bytes32 sender, bytes messageBody)
    // Data structure:
    // - Offset 0-31: sourceDomain (uint32, padded to 32 bytes)
    // - Offset 32-63: sender (bytes32)
    // - Offset 64-95: messageBody offset (uint256, should be 0x80 = 128)
    // - Offset 96-127: messageBody length (uint256)
    // - Offset 128+: messageBody bytes (contains BurnMessage)
    const dataHex = log.data.replace(/^0x/, '');
    const dataBytes = Buffer.from(dataHex, 'hex');

    if (dataBytes.length < 128) {
      return null;
    }

    // Extract sourceDomain (uint32 at offset 0, padded to 32 bytes)
    const sourceDomainBytes = dataBytes.slice(28, 32); // Last 4 bytes of first 32-byte slot
    const sourceDomain = dataBytes.readUInt32BE(28);

    // Extract sender (bytes32 at offset 32-63)
    const senderBytes = dataBytes.slice(32, 64);
    const sender = '0x' + senderBytes.toString('hex');

    // Extract messageBody offset (uint256 at offset 64-95)
    const messageBodyOffset = Number(BigInt('0x' + dataBytes.slice(64, 96).toString('hex')));
    if (messageBodyOffset <= 0 || messageBodyOffset > dataBytes.length - 32) {
      return null;
    }

    // Extract messageBody length (uint256 at offset = messageBodyOffset)
    const lengthStart = messageBodyOffset;
    const lengthEnd = messageBodyOffset + 32;
    if (lengthEnd > dataBytes.length) {
      return null;
    }
    const messageBodyLength = Number(BigInt('0x' + dataBytes.slice(lengthStart, lengthEnd).toString('hex')));
    
    const bodyStart = lengthEnd;
    const bodyEnd = bodyStart + messageBodyLength;
    if (bodyEnd > dataBytes.length) {
      return null;
    }

    // Extract messageBody bytes using the dynamic offset
    const messageBodyBytes = dataBytes.slice(bodyStart, bodyEnd);

    // Parse BurnMessage from messageBody
    // BurnMessage structure:
    // - Offset 0-3: version (uint32)
    // - Offset 4-35: burnToken (address, 32 bytes padded)
    // - Offset 36-67: mintRecipient (bytes32)
    // - Offset 68-99: amount (uint256)
    // - Offset 100-131: messageSender (address, 32 bytes padded)
    if (messageBodyBytes.length < 132) {
      return null;
    }

    // Extract mintRecipient (bytes32 at offset 36-67)
    const mintRecipientBytes32 = '0x' + messageBodyBytes.slice(36, 68).toString('hex');
    const mintRecipient = extractEvmAddressFromBytes32(mintRecipientBytes32);

    // Extract amount (uint256 at offset 68-99, big-endian)
    const amountBytes = messageBodyBytes.slice(68, 100);
    const amount = BigInt('0x' + amountBytes.toString('hex'));

    return {
      nonce,
      sourceDomain,
      sender,
      mintRecipient,
      amount,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Query MessageReceived events filtered by nonce
 * Uses indexed nonce parameter (topics[2]) for efficient filtering
 */
async function queryMessageReceivedByNonce(
  rpcClient: EvmRpcClient,
  params: {
    messageTransmitterAddress: string;
    nonce: number;
    fromBlock?: bigint;
    toBlock?: bigint;
  },
  logger: AppLogger
): Promise<EvmLog[]> {
  const nonceTopic = toPaddedNonceTopic(params.nonce);
  
  // Topics: [eventSignature, null (caller - any), nonce]
  const topics = [
    MESSAGE_RECEIVED_TOPIC,
    null, // caller - any address
    nonceTopic, // nonce (indexed)
  ];

  const filter = {
    address: params.messageTransmitterAddress.toLowerCase(),
    topics,
    fromBlock: params.fromBlock ? toHexQuantity(params.fromBlock) : undefined,
    toBlock: params.toBlock ? toHexQuantity(params.toBlock) : undefined,
  };

  logger.debug(
    {
      messageTransmitterAddress: params.messageTransmitterAddress,
      nonce: params.nonce,
      nonceTopic,
      fromBlock: params.fromBlock?.toString(),
      toBlock: params.toBlock?.toString(),
    },
    'Querying MessageReceived events by nonce'
  );

  try {
    const logs = await rpcClient.getLogs(filter);
    logger.debug(
      {
        nonce: params.nonce,
        logCount: logs.length,
      },
      'MessageReceived events found by nonce'
    );
    return logs;
  } catch (error) {
    logger.warn(
      { err: error, nonce: params.nonce },
      'Failed to query MessageReceived events by nonce'
    );
    throw error;
  }
}

/**
 * Efficient polling approach for EVM mint using nonce-based event query
 * Finds MessageReceived event filtered by CCTP nonce and extracts mint details
 */
async function pollUsdcMintByNonce(
    params: EvmPollParams,
  onUpdate?: PollUpdateCallback,
  rpcClient?: EvmRpcClient,
  logger?: AppLogger
): Promise<EvmPollResult> {
  if (!rpcClient || !logger) {
    throw new Error('rpcClient and logger required for pollUsdcMintByNonce');
  }

  const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
  const intervalMs = params.intervalMs ?? 5000;
  const { controller, cleanup } = createPollTimeout(
    timeoutMs,
    logger,
    params.flowId
  );
  const abortSignal = params.abortSignal || controller.signal;
  const isAborted = () => abortSignal.aborted || controller.signal.aborted;

  logger.info(
    {
      flowId: params.flowId,
      cctpNonce: params.cctpNonce,
      messageTransmitterAddress: params.messageTransmitterAddress,
    },
    'Starting EVM mint polling with CCTP nonce (new approach)'
  );

  try {
    const maxBlockRange =
      params.maxBlockRange && params.maxBlockRange > 0
        ? BigInt(params.maxBlockRange)
        : DEFAULT_EVM_MAX_BLOCK_RANGE;

    let fromBlock = params.fromBlock;
    if (!fromBlock) {
      const latestBlock = await rpcClient.getBlockNumber();
      fromBlock = latestBlock > 0 ? BigInt(latestBlock) - 1n : 0n;
      logger.debug(
        { flowId: params.flowId, fromBlock: fromBlock.toString(), latestBlock },
        'Starting EVM nonce-based poll from latest block minus one'
      );
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline && !isAborted()) {
      const latestNumber = await rpcClient.getBlockNumber();
      const latest = BigInt(latestNumber);

      onUpdate?.({
        latest: Number(latest),
        scannedFrom: Number(fromBlock),
        scannedTo: Number(latest),
      });

      if (latest < fromBlock) {
        await sleep(intervalMs);
        continue;
      }

      // Query MessageReceived events by nonce in chunks to avoid RPC limits
      let chunkStart = fromBlock;
      while (chunkStart <= latest) {
        if (isAborted()) break;
        const chunkEndCandidate = chunkStart + maxBlockRange - 1n;
        const chunkEnd = chunkEndCandidate < latest ? chunkEndCandidate : latest;

        const logs = await queryMessageReceivedByNonce(
          rpcClient,
          {
            messageTransmitterAddress: params.messageTransmitterAddress!,
            nonce: params.cctpNonce!,
            fromBlock: chunkStart,
            toBlock: chunkEnd,
          },
          logger
        );

        // Parse and verify each event
        for (const log of logs) {
          const parsed = parseMessageReceivedEvent(log);
          if (!parsed) {
            logger.debug(
              { flowId: params.flowId, txHash: log.transactionHash },
              'Failed to parse MessageReceived event, skipping'
            );
            continue;
          }

          // Verify recipient matches
          const recipientLower = params.recipient.toLowerCase();
          const mintRecipientLower = parsed.mintRecipient.toLowerCase();
          
          if (mintRecipientLower !== recipientLower) {
            logger.debug(
              {
                flowId: params.flowId,
                expectedRecipient: recipientLower,
                actualRecipient: mintRecipientLower,
                nonce: parsed.nonce,
              },
              'MessageReceived event recipient mismatch, skipping'
            );
            continue;
          }

          // Verify amount matches (optional safety check)
          const expectedAmount = BigInt(params.amountBaseUnits);
          if (parsed.amount !== expectedAmount) {
            logger.debug(
              {
                flowId: params.flowId,
                expectedAmount: expectedAmount.toString(),
                actualAmount: parsed.amount.toString(),
                nonce: parsed.nonce,
              },
              'MessageReceived event amount mismatch, skipping'
            );
            continue;
          }

          // Verify source domain if provided
          if (params.sourceDomain !== undefined && parsed.sourceDomain !== params.sourceDomain) {
            logger.debug(
              {
                flowId: params.flowId,
                expectedSourceDomain: params.sourceDomain,
                actualSourceDomain: parsed.sourceDomain,
                nonce: parsed.nonce,
              },
              'MessageReceived event source domain mismatch, skipping'
            );
            continue;
          }

          // Match found!
          const blockNumber = BigInt(log.blockNumber);
          logger.info(
            {
              flowId: params.flowId,
              txHash: log.transactionHash,
              blockNumber: blockNumber.toString(),
              nonce: parsed.nonce,
              recipient: parsed.mintRecipient,
              amount: parsed.amount.toString(),
            },
            'EVM USDC mint detected via MessageReceived event'
          );

          return {
            success: true,
            found: true,
            txHash: log.transactionHash,
            blockNumber,
          };
        }

        chunkStart = chunkEnd + 1n;
      }

      // Update fromBlock for next iteration
      fromBlock = latest + 1n;
      await sleep(intervalMs);
    }

    return {
      success: false,
      found: false,
      error: 'Polling aborted or timeout',
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        success: false,
        found: false,
        error: 'Polling aborted',
      };
    }

    logger.error(
      { err: error, flowId: params.flowId },
      'EVM nonce-based poll error'
    );
  return {
      success: false,
      found: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    cleanup();
  }
}

/**
 * Fallback polling approach using Transfer event scanning
 * Used when CCTP nonce is not available (backward compatibility)
 */
async function pollUsdcMintByTransfer(
  params: EvmPollParams,
  onUpdate?: PollUpdateCallback,
  rpcClient?: EvmRpcClient,
  logger?: AppLogger
): Promise<EvmPollResult> {
  if (!rpcClient || !logger) {
    throw new Error('rpcClient and logger required for pollUsdcMintByTransfer');
  }

      const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000; // 30 minutes default
      const intervalMs = params.intervalMs ?? 5000; // 5 seconds default
      const { controller, cleanup, wasTimeout } = createPollTimeout(
        timeoutMs,
        logger,
        params.flowId
      );

      // Use provided abort signal or create new one
      const abortSignal = params.abortSignal || controller.signal;
      // Check both signals: external abortSignal and internal controller.signal (for timeout)
      const isAborted = () => abortSignal.aborted || controller.signal.aborted;

      try {
        const zeroAddress = '0x0000000000000000000000000000000000000000';
    const maxBlockRange =
      params.maxBlockRange && params.maxBlockRange > 0
        ? BigInt(params.maxBlockRange)
        : DEFAULT_EVM_MAX_BLOCK_RANGE;
        let fromBlock = params.fromBlock;

        if (!fromBlock) {
          const latestBlock = await rpcClient.getBlockNumber();
          // Convert number to bigint to match toHexQuantity signature
          // Start from one block before latest to avoid fromBlock == toBlock on first call
      fromBlock = latestBlock > 0 ? BigInt(latestBlock) - 1n : 0n;
          logger.debug(
            { flowId: params.flowId, fromBlock: fromBlock.toString(), latestBlock },
            'Starting EVM poll from latest block minus one'
          );
        }

        while (!isAborted()) {
          const latestNumber = await rpcClient.getBlockNumber();
          // Convert number to bigint for consistency
          const latest = BigInt(latestNumber);
          onUpdate?.({
            latest: Number(latest),
            scannedFrom: Number(fromBlock),
            scannedTo: Number(latest),
          });

          if (latest < fromBlock) {
            await sleep(intervalMs);
            continue;
          }

        // Query for Transfer events from zero address to recipient in chunks
        let chunkStart = fromBlock;
        while (chunkStart <= latest) {
          if (isAborted()) break;
          const chunkEndCandidate = chunkStart + maxBlockRange - 1n;
          const chunkEnd = chunkEndCandidate < latest ? chunkEndCandidate : latest;

          const getLogsParams = {
            fromBlock: toHexQuantity(chunkStart),
            toBlock: toHexQuantity(chunkEnd),
            address: params.usdcAddress,
            topics: [
              TRANSFER_TOPIC,
              toPaddedTopicAddress(zeroAddress),
              toPaddedTopicAddress(params.recipient),
            ],
          };
          logger.debug(
            {
              flowId: params.flowId,
              getLogsParams,
              fromBlock: chunkStart.toString(),
              toBlock: chunkEnd.toString(),
              recipient: params.recipient,
              usdcAddress: params.usdcAddress,
            },
            'EVM getLogs call parameters'
          );
          const logs = await rpcClient.getLogs(getLogsParams);

          for (const log of logs) {
            // data is uint256 value (32 bytes)
            const value = BigInt(log.data);
            if (value === BigInt(params.amountBaseUnits)) {
              const blockNumber = BigInt(log.blockNumber);
              logger.info(
                {
                  flowId: params.flowId,
                  txHash: log.transactionHash,
                  blockNumber: blockNumber.toString(),
                },
                'EVM USDC mint detected'
              );
              return {
                success: true,
                found: true,
                txHash: log.transactionHash,
                blockNumber,
              };
            }
          }

          chunkStart = chunkEnd + 1n;
          }

          fromBlock = latest + 1n;
          await sleep(intervalMs);
        }

        return {
          success: false,
          found: false,
          error: 'Polling aborted or timeout',
        };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return {
            success: false,
            found: false,
            error: 'Polling aborted',
          };
        }

        logger.error(
          { err: error, flowId: params.flowId },
          'EVM poll error'
        );
        return {
          success: false,
          found: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        cleanup();
      }
}

export function createEvmPoller(
  rpcClient: EvmRpcClient,
  logger: AppLogger
): {
  pollUsdcMint: (
    params: EvmPollParams,
    onUpdate?: PollUpdateCallback
  ) => Promise<EvmPollResult>;
} {
  // Bind rpcClient and logger to helper functions
  const pollUsdcMintByNonceBound = (params: EvmPollParams, onUpdate?: PollUpdateCallback) =>
    pollUsdcMintByNonce(params, onUpdate, rpcClient, logger);
  const pollUsdcMintByTransferBound = (params: EvmPollParams, onUpdate?: PollUpdateCallback) =>
    pollUsdcMintByTransfer(params, onUpdate, rpcClient, logger);

  return {
    async pollUsdcMint(params, onUpdate) {
      // Check if nonce-based polling is available
      const useNonceBased = Boolean(
        params.cctpNonce !== undefined &&
        params.messageTransmitterAddress
      );

      if (useNonceBased) {
        logger.info(
          {
            flowId: params.flowId,
            cctpNonce: params.cctpNonce,
            messageTransmitterAddress: params.messageTransmitterAddress,
          },
          'Using nonce-based EVM mint polling'
        );
        return pollUsdcMintByNonceBound(params, onUpdate);
      } else {
        logger.info(
          {
            flowId: params.flowId,
            reason: params.cctpNonce === undefined ? 'cctpNonce not provided' : 'messageTransmitterAddress not provided',
          },
          'Using Transfer-based EVM mint polling (fallback)'
        );
        return pollUsdcMintByTransferBound(params, onUpdate);
      }
    },
  };
}

