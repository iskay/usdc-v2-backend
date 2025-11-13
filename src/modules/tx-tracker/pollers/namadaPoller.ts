import type { TendermintRpcClient } from '../../../common/rpc/tendermintClient.js';
import type { AppLogger } from '../../../common/utils/logger.js';
import {
  type PollParams,
  type PollResult,
  type PollUpdateCallback,
  sleep,
  createPollTimeout,
  indexAttributes,
  retryWithBackoff,
  isTransientError,
  isPermanentError,
} from './base.js';

export interface NamadaPollParams extends PollParams {
  startHeight: number;
  forwardingAddress?: string;
  namadaReceiver?: string;
  expectedAmountUusdc?: string;
  denom?: string;
}

export interface NamadaPollResult extends PollResult {
  ackFound?: boolean;
  foundAt?: number;
  namadaTxHash?: string;
}


export function createNamadaPoller(
  rpcClient: TendermintRpcClient,
  logger: AppLogger
): {
  pollForDeposit: (
    params: NamadaPollParams,
    onUpdate?: PollUpdateCallback
  ) => Promise<NamadaPollResult>;
} {
  return {
    async pollForDeposit(params, onUpdate) {
      const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
      const intervalMs = params.intervalMs ?? 5000;
      const blockRequestDelayMs = params.blockRequestDelayMs ?? 100;
      const { controller, cleanup, wasTimeout } = createPollTimeout(
        timeoutMs,
        logger,
        params.flowId
      );
      const abortSignal = params.abortSignal || controller.signal;
      // Check both signals: external abortSignal and internal controller.signal (for timeout)
      const isAborted = () => abortSignal.aborted || controller.signal.aborted;

      const deadline = Date.now() + timeoutMs;
      let nextHeight = params.startHeight;
      const denom = params.denom || 'uusdc';
      const expectedAmount = params.expectedAmountUusdc;

      let ackFound = false;
      let foundAt: number | undefined;
      let namadaTxHash: string | undefined;

      logger.info(
        {
          flowId: params.flowId,
          startHeight: params.startHeight,
          forwardingAddress: params.forwardingAddress,
          namadaReceiver: params.namadaReceiver,
          denom,
          expectedAmount,
        },
        'Starting Namada deposit poll'
      );

      try {
        while (Date.now() < deadline && !ackFound) {
          if (isAborted()) break;

          const latest = await rpcClient.getLatestBlockHeight();
          logger.debug(
            { flowId: params.flowId, latest, nextHeight },
            'Namada deposit poll progress'
          );

          while (nextHeight <= latest && !ackFound) {
            if (isAborted()) break;

            onUpdate?.({ height: nextHeight, ackFound });

            try {
              // Retry with exponential backoff for transient errors
              const blockResults = await retryWithBackoff(
                () => rpcClient.getBlockResults(nextHeight),
                3, // max retries
                500, // initial delay 500ms
                5000 // max delay 5s
              );
              
              if (!blockResults) {
                logger.debug(
                  { flowId: params.flowId, height: nextHeight },
                  'Namada deposit poll: no block results for height'
                );
                nextHeight++;
                // Add delay before next block request
                await sleep(blockRequestDelayMs);
                continue;
              }
              // Access end_block_events directly from blockResults (RPC client unwraps the result)
              const endEvents = (blockResults as unknown as { end_block_events?: Array<{ type: string; attributes?: Array<{ key: string; value: string; index?: boolean }> }> }).end_block_events || [];

              // First pass: Extract inner-tx-hash from message event (it's in a separate event, not in write_acknowledgement)
              let innerTxHash: string | undefined;
              for (const ev of endEvents) {
                if (ev?.type === 'message') {
                  const attrs = indexAttributes(ev.attributes);
                  const inner = attrs['inner-tx-hash'];
                  if (inner) {
                    innerTxHash = inner;
                    break;
                  }
                }
              }

              // Second pass: Find and process write_acknowledgement event
              for (const ev of endEvents) {
                if (ev?.type !== 'write_acknowledgement') continue;

                const attrs = indexAttributes(ev.attributes);
                const ack = attrs['packet_ack'];
                const pdata = attrs['packet_data'];
                const ok = ack === '{"result":"AQ=="}';

                if (!ok) continue;

                try {
                  // Handle both direct JSON and JSON string in 'value' field
                  let parsed: Record<string, unknown>;
                  if (typeof pdata === 'string') {
                    parsed = JSON.parse(pdata) as Record<string, unknown>;
                  } else if (pdata && typeof pdata === 'object' && 'value' in pdata) {
                    parsed = JSON.parse((pdata as { value: string }).value) as Record<string, unknown>;
                  } else {
                    parsed = (pdata as Record<string, unknown>) || {};
                  }

                  const recv = parsed?.receiver;
                  const send = parsed?.sender;
                  const d = parsed?.denom;
                  const amount = parsed?.amount;

                  const receiverMatches =
                    params.namadaReceiver && recv === params.namadaReceiver;
                  const senderMatches =
                    params.forwardingAddress && send === params.forwardingAddress;
                  const denomMatches = d === denom;

                  // Handle amount comparison - expectedAmount might include "uusdc" suffix
                  let amountMatches = true;
                  if (expectedAmount) {
                    const expectedNumeric = expectedAmount.replace('uusdc', '');
                    const actualNumeric =
                      amount?.toString().replace('uusdc', '') || '';
                    amountMatches = expectedNumeric === actualNumeric;
                  }

                  if (receiverMatches && senderMatches && denomMatches && amountMatches) {
                    ackFound = true;
                    foundAt = nextHeight;
                    // Use inner-tx-hash from message event (extracted in first pass)
                    namadaTxHash = innerTxHash;
                    logger.info(
                      {
                        flowId: params.flowId,
                        height: nextHeight,
                        txHash: namadaTxHash,
                        innerTxHashFromMessage: innerTxHash,
                      },
                      'Namada write_acknowledgement matched'
                    );
                    onUpdate?.({ height: nextHeight, ackFound, namadaTxHash });
                    break;
                  }
                } catch (error) {
                  logger.debug(
                    { err: error, flowId: params.flowId },
                    'Namada poll packet_data parse failed'
                  );
                }
              }
            } catch (error) {
              // Check if error is permanent (404 = block doesn't exist)
              if (isPermanentError(error)) {
                logger.debug(
                  { err: error, flowId: params.flowId, height: nextHeight },
                  'Namada deposit poll: permanent error for height, skipping'
                );
                nextHeight++;
                await sleep(blockRequestDelayMs);
                continue;
              }
              
              // Transient errors should have been retried by retryWithBackoff
              // If we still get here, log warning and skip block after max retries
              logger.warn(
                { err: error, flowId: params.flowId, height: nextHeight },
                'Namada deposit poll fetch failed for height after retries, skipping block'
              );
              nextHeight++;
              await sleep(blockRequestDelayMs);
              continue;
            }

            nextHeight++;
            // Add delay before next block request to avoid rate limiting
            await sleep(blockRequestDelayMs);
          }

          if (ackFound) break;
          await sleep(intervalMs);
        }

        logger.info(
          { flowId: params.flowId, ackFound, foundAt, namadaTxHash },
          'Namada deposit poll completed'
        );

        return {
          success: ackFound,
          found: ackFound,
          ackFound,
          foundAt,
          namadaTxHash,
        };
      } catch (error) {
        logger.error({ err: error, flowId: params.flowId }, 'Namada deposit poll error');
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

