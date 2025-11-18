import type { EvmRpcClient } from '../../../common/rpc/evmClient.js';
import type { AppLogger } from '../../../common/utils/logger.js';
import {
  type PollParams,
  type PollResult,
  type PollUpdateCallback,
  sleep,
  createPollTimeout,
} from './base.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface EvmPollParams extends PollParams {
  usdcAddress: string;
  recipient: string;
  amountBaseUnits: string;
  fromBlock?: bigint;
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

export function createEvmPoller(
  rpcClient: EvmRpcClient,
  logger: AppLogger
): {
  pollUsdcMint: (
    params: EvmPollParams,
    onUpdate?: PollUpdateCallback
  ) => Promise<EvmPollResult>;
} {
  return {
    async pollUsdcMint(params, onUpdate) {
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
        let fromBlock = params.fromBlock;

        if (!fromBlock) {
          const latestBlock = await rpcClient.getBlockNumber();
          // Convert number to bigint to match toHexQuantity signature
          // Start from one block before latest to avoid fromBlock == toBlock on first call
          fromBlock = BigInt(latestBlock) - 1n;
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

          // Query for Transfer events from zero address to recipient
          const getLogsParams = {
            fromBlock: toHexQuantity(fromBlock),
            toBlock: toHexQuantity(latest),
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
              fromBlock: fromBlock.toString(),
              toBlock: latest.toString(),
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
    },
  };
}

