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
  packetSequence?: number; // IBC packet sequence from Noble polling (for deposit flow)
  forwardingAddress?: string;
  namadaReceiver?: string;
  expectedAmountUusdc?: string;
  denom?: string;
  // Payment flow specific params
  namadaIbcTxHash?: string;
  namadaBlockHeight?: number; // Block height where payment transaction was submitted
  memoJson?: string;
  receiver?: string;
  amount?: string;
}

export interface NamadaPollResult extends PollResult {
  ackFound?: boolean;
  foundAt?: number;
  namadaTxHash?: string;
  packetSequence?: number; // IBC packet sequence (for payment flow)
}

/**
 * Direct lookup approach for payment flow: fetch block_results at specific height
 * and extract packet_sequence from send_packet event matching by inner-tx-hash
 */
async function pollForPaymentIbcSend(
  params: NamadaPollParams,
  onUpdate?: PollUpdateCallback,
  rpcClient?: TendermintRpcClient,
  logger?: AppLogger
): Promise<NamadaPollResult> {
  if (!rpcClient || !logger) {
    throw new Error('rpcClient and logger required for pollForPaymentIbcSend');
  }

  const { namadaBlockHeight, namadaIbcTxHash } = params;

  if (namadaBlockHeight === undefined || !namadaIbcTxHash) {
    return {
      success: false,
      found: false,
      error: 'namadaBlockHeight and namadaIbcTxHash are required',
    };
  }

  logger.info(
    {
      flowId: params.flowId,
      blockHeight: namadaBlockHeight,
      txHash: namadaIbcTxHash,
    },
    'Starting Namada payment IBC send lookup'
  );

  try {
    // Fetch block_results at the provided height
    const blockResults = await retryWithBackoff(
      () => rpcClient.getBlockResults(namadaBlockHeight),
      3, // max retries
      500, // initial delay 500ms
      5000 // max delay 5s
    );

    if (!blockResults) {
      logger.error(
        { flowId: params.flowId, blockHeight: namadaBlockHeight },
        'Block results not found at height'
      );
      return {
        success: false,
        found: false,
        error: `Block results not found at height ${namadaBlockHeight}`,
      };
    }

    // Access end_block_events (or finalize_block_events depending on RPC structure)
    const endEvents = (blockResults as unknown as { 
      end_block_events?: Array<{ 
        type: string; 
        attributes?: Array<{ key: string; value: string; index?: boolean }> 
      }> 
    }).end_block_events || [];

    logger.debug(
      { flowId: params.flowId, blockHeight: namadaBlockHeight, eventCount: endEvents.length },
      'Searching end_block_events for send_packet event'
    );

    // Search for send_packet event matching inner-tx-hash
    const txHashLower = namadaIbcTxHash.toLowerCase();
    let packetSequence: number | undefined;

    for (const event of endEvents) {
      if (event?.type !== 'send_packet') continue;

      const attrs = indexAttributes(event.attributes || []);
      const innerTxHash = attrs['inner-tx-hash'];

      if (!innerTxHash) continue;

      // Case-insensitive comparison
      if (innerTxHash.toLowerCase() === txHashLower) {
        logger.debug(
          {
            flowId: params.flowId,
            blockHeight: namadaBlockHeight,
            innerTxHash,
            txHash: namadaIbcTxHash,
          },
          'Found send_packet event with matching inner-tx-hash'
        );

        // Extract packet_sequence
        const packetSeqStr = attrs['packet_sequence'];
        if (packetSeqStr) {
          packetSequence = Number.parseInt(packetSeqStr, 10);
          if (!packetSequence || packetSequence <= 0) {
            logger.error(
              {
                flowId: params.flowId,
                blockHeight: namadaBlockHeight,
                packetSeqStr,
              },
              'Invalid packet_sequence value'
            );
            return {
              success: false,
              found: false,
              error: `Invalid packet_sequence: ${packetSeqStr}`,
            };
          }

          logger.info(
            {
              flowId: params.flowId,
              blockHeight: namadaBlockHeight,
              txHash: namadaIbcTxHash,
              packetSequence,
            },
            'Namada payment IBC send event found and packet_sequence extracted'
          );

          // Notify update
          onUpdate?.({ height: namadaBlockHeight, packetSequence });

          return {
            success: true,
            found: true,
            packetSequence,
            namadaTxHash: namadaIbcTxHash,
            foundAt: namadaBlockHeight,
          };
        } else {
          logger.error(
            {
              flowId: params.flowId,
              blockHeight: namadaBlockHeight,
              txHash: namadaIbcTxHash,
            },
            'packet_sequence attribute not found in send_packet event'
          );
          return {
            success: false,
            found: false,
            error: 'packet_sequence attribute not found in send_packet event',
          };
        }
      }
    }

    logger.warn(
      {
        flowId: params.flowId,
        blockHeight: namadaBlockHeight,
        txHash: namadaIbcTxHash,
        eventCount: endEvents.length,
      },
      'No send_packet event found with matching inner-tx-hash'
    );

    return {
      success: false,
      found: false,
      error: `No send_packet event found with matching inner-tx-hash ${namadaIbcTxHash} at height ${namadaBlockHeight}`,
    };
  } catch (error) {
    logger.error(
      { err: error, flowId: params.flowId, blockHeight: namadaBlockHeight },
      'Namada payment IBC send lookup error'
    );
    return {
      success: false,
      found: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

      // Warn if packetSequence is not provided (backward compatibility)
      if (!params.packetSequence) {
        logger.warn(
          { flowId: params.flowId },
          'Namada deposit poll: packetSequence not provided, falling back to packet_data matching'
        );
      }

      logger.info(
        {
          flowId: params.flowId,
          startHeight: params.startHeight,
          packetSequence: params.packetSequence,
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

              // If packetSequence is provided, use new matching logic
              if (params.packetSequence !== undefined) {
                // Search for write_acknowledgement event matching packet_sequence
                for (const ev of endEvents) {
                  if (ev?.type !== 'write_acknowledgement') continue;

                  const attrs = indexAttributes(ev.attributes);
                  const packetSeqStr = attrs['packet_sequence'];
                  const packetAck = attrs['packet_ack'];
                  const innerTxHashAttr = attrs['inner-tx-hash'];

                  // Match by packet_sequence
                  if (!packetSeqStr) continue;
                  const packetSeq = Number.parseInt(packetSeqStr, 10);
                  if (packetSeq !== params.packetSequence) continue;

                  logger.debug(
                    {
                      flowId: params.flowId,
                      height: nextHeight,
                      packetSequence: packetSeq,
                      packetAck,
                      hasInnerTxHash: !!innerTxHashAttr,
                    },
                    'Found write_acknowledgement with matching packet_sequence'
                  );

                  // Verify packet_ack is success code
                  if (packetAck !== '{"result":"AQ=="}') {
                    logger.error(
                      {
                        flowId: params.flowId,
                        height: nextHeight,
                        packetSequence: packetSeq,
                        packetAck,
                      },
                      'Packet acknowledgement indicates failure'
                    );
                    // Return error immediately
                    return {
                      success: false,
                      found: false,
                      error: `Packet acknowledgement indicates failure: ${packetAck}`,
                      ackFound: false,
                    };
                  }

                  // Extract inner-tx-hash from write_acknowledgement event
                  if (innerTxHashAttr) {
                    namadaTxHash = innerTxHashAttr;
                  } else {
                    logger.warn(
                      {
                        flowId: params.flowId,
                        height: nextHeight,
                        packetSequence: packetSeq,
                      },
                      'inner-tx-hash not found in write_acknowledgement event'
                    );
                  }

                  ackFound = true;
                  foundAt = nextHeight;
                  logger.info(
                    {
                      flowId: params.flowId,
                      height: nextHeight,
                      packetSequence: packetSeq,
                      txHash: namadaTxHash,
                    },
                    'Namada write_acknowledgement matched by packet_sequence'
                  );
                  onUpdate?.({ height: nextHeight, ackFound, namadaTxHash });
                  break;
                }
              } else {
                // Fallback to old packet_data matching logic (backward compatibility)
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
                        'Namada write_acknowledgement matched (fallback: packet_data)'
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
      // Require block height and tx hash for payment flow polling
      if (params.namadaBlockHeight === undefined || !params.namadaIbcTxHash) {
        logger.warn(
          { flowId: params.flowId, hasBlockHeight: params.namadaBlockHeight !== undefined, hasTxHash: !!params.namadaIbcTxHash },
          'Namada payment polling requires blockHeight and txHash'
        );
        return {
          success: false,
          found: false,
          error: 'Namada payment polling requires namadaBlockHeight and namadaIbcTxHash',
        };
      }

      // Use new direct lookup approach
      return pollForPaymentIbcSend(params, onUpdate, rpcClient, logger);
    },
  };
}

