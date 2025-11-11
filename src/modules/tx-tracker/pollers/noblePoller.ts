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

interface BlockResults {
  result?: {
    txs_results?: Array<{
      events?: Array<{
        type: string;
        attributes?: Array<{ key: string; value: string; index?: boolean }>;
      }>;
    }>;
    finalize_block_events?: Array<{
      type: string;
      attributes?: Array<{ key: string; value: string; index?: boolean }>;
    }>;
  };
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

          while (nextHeight <= latest && (!receivedFound || !forwardFound)) {
            if (abortSignal.aborted) break;

            onUpdate?.({ height: nextHeight, receivedFound, forwardFound });

            try {
              const blockResults = await rpcClient.getBlockResults(nextHeight);
              const json = blockResults as unknown as BlockResults;

              // 1) coin_received in txs_results
              const txs = json?.result?.txs_results || [];
              for (const tx of txs) {
                const events = tx?.events || [];
                for (const ev of events) {
                  if (!receivedFound && ev?.type === 'coin_received') {
                    const attrs = indexAttributes(ev.attributes);
                    const receiver = attrs['receiver'];
                    const amount = attrs['amount'];
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
                    }
                  }
                }
              }

              // 2) ibc_transfer in finalize_block_events
              const endEvents = json?.result?.finalize_block_events || [];
              for (const ev of endEvents) {
                if (!forwardFound && ev?.type === 'ibc_transfer') {
                  const attrs = indexAttributes(ev.attributes);
                  const sender = attrs['sender'];
                  const receiver = attrs['receiver'];
                  const denom = attrs['denom'];
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
              const json = blockResults as unknown as BlockResults;
              const txs = json?.result?.txs_results || [];

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

