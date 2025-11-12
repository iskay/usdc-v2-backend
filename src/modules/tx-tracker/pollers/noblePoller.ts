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
  stripQuotes,
} from './base.js';

export interface NoblePollParams extends PollParams {
  startHeight: number;
  forwardingAddress?: string;
  expectedAmountUusdc?: string;
  namadaReceiver?: string;
  memoJson?: string;
  receiver?: string;
  amount?: string;
  destinationCallerB64?: string;
  mintRecipientB64?: string;
  destinationDomain?: number;
  channelId?: string;
}

export interface NoblePollResult extends PollResult {
  receivedFound?: boolean;
  forwardFound?: boolean;
  ackFound?: boolean;
  cctpFound?: boolean;
  receivedAt?: number;
  forwardAt?: number;
  ackAt?: number;
  cctpAt?: number;
}


export function createNoblePoller(
  rpcClient: TendermintRpcClient,
  logger: AppLogger
): {
  pollForDeposit: (
    params: NoblePollParams,
    onUpdate?: PollUpdateCallback
  ) => Promise<NoblePollResult>;
  pollForOrbiter: (
    params: NoblePollParams,
    onUpdate?: PollUpdateCallback
  ) => Promise<NoblePollResult>;
} {
  return {
    async pollForDeposit(params, onUpdate) {
      const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
      const intervalMs = params.intervalMs ?? 5000;
      const { controller, cleanup } = createPollTimeout(
        timeoutMs,
        logger,
        params.flowId
      );
      const abortSignal = params.abortSignal || controller.signal;

      const deadline = Date.now() + timeoutMs;
      let nextHeight = params.startHeight;
      let receivedFound = false;
      let forwardFound = false;
      let receivedAt: number | undefined;
      let forwardAt: number | undefined;

      try {
        while (Date.now() < deadline && (!receivedFound || !forwardFound)) {
          if (abortSignal.aborted) break;

          const latest = await rpcClient.getLatestBlockHeight();
          logger.debug(
            { flowId: params.flowId, latest, nextHeight },
            'Noble deposit poll progress'
          );

          // If nextHeight is ahead of latest, wait for chain to catch up
          if (nextHeight > latest) {
            logger.debug(
              { flowId: params.flowId, nextHeight, latest },
              'Noble deposit poll: waiting for chain to catch up'
            );
            await sleep(intervalMs);
            continue;
          }

          while (nextHeight <= latest && (!receivedFound || !forwardFound)) {
            if (abortSignal.aborted) break;

            onUpdate?.({ height: nextHeight, receivedFound, forwardFound });

            try {
              const blockResults = await rpcClient.getBlockResults(nextHeight);
              if (!blockResults) {
                logger.debug(
                  { flowId: params.flowId, height: nextHeight },
                  'Noble deposit poll: no block results for height'
                );
                nextHeight++;
                continue;
              }

              // 1) coin_received in txs_results
              const txs = blockResults.txs_results || [];
              logger.debug(
                {
                  flowId: params.flowId,
                  height: nextHeight,
                  txCount: txs.length,
                },
                'Noble deposit poll: scanning transactions'
              );

              for (let txIdx = 0; txIdx < txs.length; txIdx++) {
                const tx = txs[txIdx];
                const events = tx?.events || [];
                logger.debug(
                  {
                    flowId: params.flowId,
                    height: nextHeight,
                    txIndex: txIdx,
                    eventCount: events.length,
                  },
                  'Noble deposit poll: scanning transaction events'
                );

                for (let evIdx = 0; evIdx < events.length; evIdx++) {
                  const ev = events[evIdx];
                  logger.debug(
                    {
                      flowId: params.flowId,
                      height: nextHeight,
                      txIndex: txIdx,
                      eventIndex: evIdx,
                      eventType: ev?.type,
                      attributeCount: ev?.attributes?.length ?? 0,
                    },
                    'Noble deposit poll: examining event'
                  );

                  if (!receivedFound && ev?.type === 'coin_received') {
                    const rawAttrs = ev.attributes || [];
                    const attrs = indexAttributes(rawAttrs);
                    const receiver = attrs['receiver'];
                    const amount = attrs['amount'];

                    logger.debug(
                      {
                        flowId: params.flowId,
                        height: nextHeight,
                        txIndex: txIdx,
                        eventIndex: evIdx,
                        rawAttributes: rawAttrs,
                        indexedAttributes: attrs,
                        extractedReceiver: receiver,
                        extractedAmount: amount,
                        expectedReceiver: params.forwardingAddress,
                        expectedAmount: params.expectedAmountUusdc,
                        receiverMatch: receiver === params.forwardingAddress,
                        amountMatch: amount === params.expectedAmountUusdc,
                      },
                      'Noble deposit poll: coin_received match attempt'
                    );

                    if (
                      params.forwardingAddress &&
                      receiver === params.forwardingAddress &&
                      params.expectedAmountUusdc &&
                      amount === params.expectedAmountUusdc
                    ) {
                      receivedFound = true;
                      receivedAt = nextHeight;
                      logger.info(
                        { flowId: params.flowId, height: nextHeight },
                        'Noble coin_received matched'
                      );
                      onUpdate?.({ height: nextHeight, receivedFound, forwardFound });
                    } else {
                      logger.debug(
                        {
                          flowId: params.flowId,
                          height: nextHeight,
                          reason: !params.forwardingAddress
                            ? 'missing_forwarding_address'
                            : receiver !== params.forwardingAddress
                              ? 'receiver_mismatch'
                              : !params.expectedAmountUusdc
                                ? 'missing_expected_amount'
                                : amount !== params.expectedAmountUusdc
                                  ? 'amount_mismatch'
                                  : 'unknown',
                        },
                        'Noble deposit poll: coin_received did not match'
                      );
                    }
                  }
                }
              }

              // 2) ibc_transfer in finalize_block_events
              const endEvents = blockResults.finalize_block_events || [];
              logger.debug(
                {
                  flowId: params.flowId,
                  height: nextHeight,
                  endEventCount: endEvents.length,
                },
                'Noble deposit poll: scanning finalize_block_events'
              );

              for (let evIdx = 0; evIdx < endEvents.length; evIdx++) {
                const ev = endEvents[evIdx];
                logger.debug(
                  {
                    flowId: params.flowId,
                    height: nextHeight,
                    eventIndex: evIdx,
                    eventType: ev?.type,
                    attributeCount: ev?.attributes?.length ?? 0,
                  },
                  'Noble deposit poll: examining finalize_block event'
                );

                if (!forwardFound && ev?.type === 'ibc_transfer') {
                  const rawAttrs = ev.attributes || [];
                  const attrs = indexAttributes(rawAttrs);
                  const sender = attrs['sender'];
                  const receiver = attrs['receiver'];
                  const denom = attrs['denom'];
                  const amount = attrs['amount'];

                  logger.debug(
                    {
                      flowId: params.flowId,
                      height: nextHeight,
                      eventIndex: evIdx,
                      rawAttributes: rawAttrs,
                      indexedAttributes: attrs,
                      extractedSender: sender,
                      extractedReceiver: receiver,
                      extractedDenom: denom,
                      extractedAmount: amount,
                      expectedSender: params.forwardingAddress,
                      expectedReceiver: params.namadaReceiver,
                      expectedDenom: 'uusdc',
                      senderMatch: sender === params.forwardingAddress,
                      receiverMatch: receiver === params.namadaReceiver,
                      denomMatch: denom === 'uusdc',
                    },
                    'Noble deposit poll: ibc_transfer match attempt'
                  );

                  if (
                    params.forwardingAddress &&
                    params.namadaReceiver &&
                    sender === params.forwardingAddress &&
                    receiver === params.namadaReceiver &&
                    denom === 'uusdc'
                  ) {
                    forwardFound = true;
                    forwardAt = nextHeight;
                    logger.info(
                      { flowId: params.flowId, height: nextHeight },
                      'Noble ibc_transfer matched'
                    );
                    onUpdate?.({ height: nextHeight, receivedFound, forwardFound });
                  } else {
                    logger.debug(
                      {
                        flowId: params.flowId,
                        height: nextHeight,
                        reason: !params.forwardingAddress
                          ? 'missing_forwarding_address'
                          : !params.namadaReceiver
                            ? 'missing_namada_receiver'
                            : sender !== params.forwardingAddress
                              ? 'sender_mismatch'
                              : receiver !== params.namadaReceiver
                                ? 'receiver_mismatch'
                                : denom !== 'uusdc'
                                  ? 'denom_mismatch'
                                  : 'unknown',
                      },
                      'Noble deposit poll: ibc_transfer did not match'
                    );
                  }
                }
              }
            } catch (error) {
              logger.warn(
                { err: error, flowId: params.flowId, height: nextHeight },
                'Noble deposit poll fetch failed for height'
              );
            }

            nextHeight++;
          }

          if (receivedFound && forwardFound) break;
          await sleep(intervalMs);
        }

        return {
          success: receivedFound && forwardFound,
          found: receivedFound && forwardFound,
          receivedFound,
          forwardFound,
          receivedAt,
          forwardAt,
        };
      } catch (error) {
        logger.error({ err: error, flowId: params.flowId }, 'Noble deposit poll error');
        return {
          success: false,
          found: false,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        cleanup();
      }
    },

    async pollForOrbiter(params, onUpdate) {
      const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
      const intervalMs = params.intervalMs ?? 5000;
      const { controller, cleanup } = createPollTimeout(
        timeoutMs,
        logger,
        params.flowId
      );
      const abortSignal = params.abortSignal || controller.signal;

      const deadline = Date.now() + timeoutMs;
      let nextHeight = params.startHeight;
      let ackFound = false;
      let cctpFound = false;
      let ackAt: number | undefined;
      let cctpAt: number | undefined;

      try {
        while (Date.now() < deadline && (!ackFound || !cctpFound)) {
          if (abortSignal.aborted) break;

          const latest = await rpcClient.getLatestBlockHeight();
          logger.debug(
            { flowId: params.flowId, latest, nextHeight },
            'Noble orbiter poll progress'
          );

          while (nextHeight <= latest && (!ackFound || !cctpFound)) {
            if (abortSignal.aborted) break;

            onUpdate?.({ height: nextHeight, ackFound, cctpFound });

            try {
              const blockResults = await rpcClient.getBlockResults(nextHeight);
              if (!blockResults) {
                logger.debug(
                  { flowId: params.flowId, height: nextHeight },
                  'Noble orbiter poll: no block results for height'
                );
                nextHeight++;
                continue;
              }
              const txs = blockResults.txs_results || [];

              for (const tx of txs) {
                const events = tx?.events || [];
                for (const ev of events) {
                  // IBC ack
                  if (!ackFound && ev?.type === 'write_acknowledgement') {
                    const attrs = indexAttributes(ev.attributes);
                    const packetDataRaw = attrs['packet_data'];
                    const packetAck = attrs['packet_ack'];
                    let memoMatches = false;
                    let amountMatches = false;
                    let receiverMatches = false;

                    if (packetDataRaw) {
                      const parsed = parseMaybeJsonOrBase64Json(packetDataRaw) as Record<string, unknown>;
                      // Handle double-encoded JSON string
                      const parsed2 =
                        typeof parsed === 'string'
                          ? (() => {
                              try {
                                return JSON.parse(parsed);
                              } catch {
                                return parsed;
                              }
                            })()
                          : parsed;
                      const amount = parsed?.amount;
                      const receiver = parsed?.receiver;
                      const memo = (parsed2 as Record<string, unknown>)?.memo ?? parsed?.memo;

                      if (params.memoJson) memoMatches = memo === params.memoJson;
                      if (params.amount) amountMatches = amount === params.amount;
                      if (params.receiver) receiverMatches = receiver === params.receiver;
                      // Optional: verify denom contains channel id (denom checked but not used for matching)
                    }

                    const ackOk = packetAck === '{"result":"AQ=="}';
                    if (memoMatches && amountMatches && receiverMatches && ackOk) {
                      ackFound = true;
                      ackAt = nextHeight;
                      logger.info(
                        { flowId: params.flowId, height: nextHeight },
                        'Noble IBC acknowledgement matched'
                      );
                      onUpdate?.({ height: nextHeight, ackFound, cctpFound });
                    }
                  }

                  // CCTP DepositForBurn
                  if (!cctpFound && ev?.type === 'circle.cctp.v1.DepositForBurn') {
                    const attrs = indexAttributes(ev.attributes);
                    const amount = stripQuotes(attrs['amount']);
                    const destCaller = stripQuotes(attrs['destination_caller']);
                    const mintRecipient = stripQuotes(attrs['mint_recipient']);
                    const destDomain = attrs['destination_domain'];

                    if (
                      params.amount &&
                      params.destinationCallerB64 &&
                      params.mintRecipientB64 &&
                      params.destinationDomain &&
                      amount === params.amount &&
                      destCaller === params.destinationCallerB64 &&
                      mintRecipient === params.mintRecipientB64 &&
                      Number(destDomain) === params.destinationDomain
                    ) {
                      cctpFound = true;
                      cctpAt = nextHeight;
                      logger.info(
                        { flowId: params.flowId, height: nextHeight },
                        'Noble CCTP DepositForBurn matched'
                      );
                      onUpdate?.({ height: nextHeight, ackFound, cctpFound });
                    }
                  }
                }
              }
            } catch (error) {
              logger.warn(
                { err: error, flowId: params.flowId, height: nextHeight },
                'Noble orbiter poll fetch failed for height'
              );
            }

            nextHeight++;
          }

          if (ackFound && cctpFound) break;
          await sleep(intervalMs);
        }

        return {
          success: ackFound && cctpFound,
          found: ackFound && cctpFound,
          ackFound,
          cctpFound,
          ackAt,
          cctpAt,
        };
      } catch (error) {
        logger.error({ err: error, flowId: params.flowId }, 'Noble orbiter poll error');
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

