import type { TendermintRpcClient } from '../../../common/rpc/tendermintClient.js';
import type { AppLogger } from '../../../common/utils/logger.js';
import {
  type PollParams,
  type PollResult,
  type PollUpdateCallback,
  sleep,
  createPollTimeout,
  indexAttributes,
  parseMaybeJsonOrBase64Json,
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
  // Payment flow specific params
  namadaIbcTxHash?: string;
  memoJson?: string;
  receiver?: string;
  amount?: string;
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
  pollForPayment: (
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

    async pollForPayment(params, onUpdate) {
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
      const expectedAmount = params.amount;
      const expectedMemo = params.memoJson;
      const expectedReceiver = params.receiver;
      const expectedTxHash = params.namadaIbcTxHash;

      let txFound = false;
      let foundAt: number | undefined;
      let confirmedTxHash: string | undefined;

      logger.info(
        {
          flowId: params.flowId,
          startHeight: params.startHeight,
          namadaIbcTxHash: expectedTxHash,
          receiver: expectedReceiver,
          amount: expectedAmount,
          memoJson: expectedMemo,
          denom,
        },
        'Starting Namada payment poll'
      );

      try {
        while (Date.now() < deadline && !txFound) {
          if (isAborted()) break;

          const latest = await rpcClient.getLatestBlockHeight();
          logger.debug(
            { flowId: params.flowId, latest, nextHeight },
            'Namada payment poll progress'
          );

          // If nextHeight is ahead of latest, fail early (especially useful in tests)
          if (nextHeight > latest) {
            logger.warn(
              { flowId: params.flowId, nextHeight, latest },
              'Namada payment poll: nextHeight exceeds latest block height, stopping'
            );
            break;
          }

          while (nextHeight <= latest && !txFound) {
            if (isAborted()) break;

            onUpdate?.({ height: nextHeight });

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
                  'Namada payment poll: no block results for height'
                );
                nextHeight++;
                // Add delay before next block request
                await sleep(blockRequestDelayMs);
                continue;
              }

              // Scan txs_results[].events[] for send_packet or ibc_transfer events
              const txsResults = blockResults.txs_results || [];
              for (const txResult of txsResults) {
                // Check transaction result code (0 = success)
                if (txResult.code !== 0) {
                  continue; // Skip failed transactions
                }

                const events = txResult.events || [];
                for (const ev of events) {
                  // Check for send_packet event
                  if (ev?.type === 'send_packet') {
                    const attrs = indexAttributes(ev.attributes);
                    const packetDataRaw = attrs['packet_data'];

                    if (!packetDataRaw) continue;

                    try {
                      // Parse packet_data (may be JSON string or base64-encoded JSON)
                      const parsed = parseMaybeJsonOrBase64Json(packetDataRaw) as Record<string, unknown> | undefined;
                      if (!parsed) continue;

                      const memo = parsed.memo as string | undefined;
                      const receiver = parsed.receiver as string | undefined;
                      const amount = parsed.amount as string | undefined;
                      const denomFromPacket = parsed.denom as string | undefined;

                      // Match memo, receiver, amount, and denom
                      const memoMatches = expectedMemo ? memo === expectedMemo : true;
                      const receiverMatches = expectedReceiver ? receiver === expectedReceiver : true;
                      const denomMatches = denomFromPacket === denom;

                      // Handle amount comparison - expectedAmount might include "uusdc" suffix
                      let amountMatches = true;
                      if (expectedAmount) {
                        const expectedNumeric = expectedAmount.replace('uusdc', '');
                        const actualNumeric = amount?.toString().replace('uusdc', '') || '';
                        amountMatches = expectedNumeric === actualNumeric;
                      }

                      if (memoMatches && receiverMatches && denomMatches && amountMatches) {
                        // Try to extract transaction hash from events
                        // Look for transaction hash in message event or other events
                        let txHash: string | undefined;
                        for (const otherEv of events) {
                          if (otherEv?.type === 'message') {
                            const msgAttrs = indexAttributes(otherEv.attributes);
                            const innerHash = msgAttrs['inner-tx-hash'] || msgAttrs['tx_hash'];
                            if (innerHash) {
                              txHash = innerHash;
                              break;
                            }
                          }
                        }

                        // If we have an expected tx hash, verify it matches (if we found one)
                        if (expectedTxHash && txHash && txHash !== expectedTxHash) {
                          continue; // Skip if hash doesn't match
                        }

                        txFound = true;
                        foundAt = nextHeight;
                        confirmedTxHash = txHash || expectedTxHash;
                        logger.info(
                          {
                            flowId: params.flowId,
                            height: nextHeight,
                            txHash: confirmedTxHash,
                            memo,
                            receiver,
                            amount,
                          },
                          'Namada send_packet matched'
                        );
                        onUpdate?.({ height: nextHeight, txHash: confirmedTxHash });
                        break;
                      }
                    } catch (error) {
                      logger.debug(
                        { err: error, flowId: params.flowId },
                        'Namada payment poll packet_data parse failed'
                      );
                    }
                  }

                  // Check for ibc_transfer event (alternative to send_packet)
                  if (ev?.type === 'ibc_transfer') {
                    const attrs = indexAttributes(ev.attributes);
                    const receiver = attrs['receiver'];
                    const amount = attrs['amount'];
                    const denomFromEvent = attrs['denom'];

                    // Match receiver, amount, and denom
                    const receiverMatches = expectedReceiver ? receiver === expectedReceiver : true;
                    const denomMatches = denomFromEvent === denom;

                    // Handle amount comparison
                    let amountMatches = true;
                    if (expectedAmount) {
                      const expectedNumeric = expectedAmount.replace('uusdc', '');
                      const actualNumeric = amount?.toString().replace('uusdc', '') || '';
                      amountMatches = expectedNumeric === actualNumeric;
                    }

                    // For ibc_transfer, we can't match memo directly, so we rely on receiver/amount/denom
                    // If we have a transaction hash, we should also match it
                    if (receiverMatches && denomMatches && amountMatches) {
                      // Try to extract transaction hash
                      let txHash: string | undefined;
                      for (const otherEv of events) {
                        if (otherEv?.type === 'message') {
                          const msgAttrs = indexAttributes(otherEv.attributes);
                          const innerHash = msgAttrs['inner-tx-hash'] || msgAttrs['tx_hash'];
                          if (innerHash) {
                            txHash = innerHash;
                            break;
                          }
                        }
                      }

                      // If we have an expected tx hash, verify it matches (if we found one)
                      if (expectedTxHash && txHash && txHash !== expectedTxHash) {
                        continue; // Skip if hash doesn't match
                      }

                      txFound = true;
                      foundAt = nextHeight;
                      confirmedTxHash = txHash || expectedTxHash;
                      logger.info(
                        {
                          flowId: params.flowId,
                          height: nextHeight,
                          txHash: confirmedTxHash,
                          receiver,
                          amount,
                        },
                        'Namada ibc_transfer matched'
                      );
                      onUpdate?.({ height: nextHeight, txHash: confirmedTxHash });
                      break;
                    }
                  }
                }

                if (txFound) break;
              }
            } catch (error) {
              // Check if error is permanent (404 = block doesn't exist)
              if (isPermanentError(error)) {
                logger.debug(
                  { err: error, flowId: params.flowId, height: nextHeight },
                  'Namada payment poll: permanent error for height, skipping'
                );
                nextHeight++;
                await sleep(blockRequestDelayMs);
                continue;
              }

              // Transient errors should have been retried by retryWithBackoff
              // If we still get here, log warning and skip block after max retries
              logger.warn(
                { err: error, flowId: params.flowId, height: nextHeight },
                'Namada payment poll fetch failed for height after retries, skipping block'
              );
              nextHeight++;
              await sleep(blockRequestDelayMs);
              continue;
            }

            nextHeight++;
            // Add delay before next block request to avoid rate limiting
            await sleep(blockRequestDelayMs);
          }

          if (txFound) break;
          await sleep(intervalMs);
        }

        logger.info(
          { flowId: params.flowId, txFound, foundAt, txHash: confirmedTxHash },
          'Namada payment poll completed'
        );

        return {
          success: txFound,
          found: txFound,
          namadaTxHash: confirmedTxHash,
          foundAt,
        };
      } catch (error) {
        logger.error({ err: error, flowId: params.flowId }, 'Namada payment poll error');
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

