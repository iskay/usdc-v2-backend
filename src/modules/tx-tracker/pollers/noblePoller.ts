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
  retryWithBackoff,
  isTransientError,
  isPermanentError,
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
  cctpNonce?: number; // CCTP message nonce extracted from MessageSent event (for deposit flow)
  packetSequence?: number; // IBC packet sequence number (for payment flow, from Namada polling)
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
  packetSequence?: number; // IBC packet sequence number (required for Namada polling)
  cctpNonce?: number; // CCTP nonce extracted from DepositForBurn event (for EVM polling)
  retryExhausted?: boolean; // Flag indicating RPC retry exhaustion
}


/**
 * Check if an error indicates RPC retry exhaustion (ETIMEDOUT after retries)
 */
function isRetryExhaustionError(error: unknown): boolean {
  if (!error) return false;
  
  const axiosError = error as { code?: string; message?: string; config?: { 'axios-retry'?: { retryCount?: number } } };
  
  // Check for ETIMEDOUT error code (network timeout)
  if (axiosError.code === 'ETIMEDOUT') {
    // If axios-retry config shows retries were attempted, this is retry exhaustion
    const retryConfig = axiosError.config?.['axios-retry'];
    if (retryConfig && retryConfig.retryCount !== undefined && retryConfig.retryCount > 0) {
      return true;
    }
    // ETIMEDOUT without retry config might still be retry exhaustion (axios-retry may not expose it)
    // Check error message for timeout indicators
    const errorMessage = axiosError.message || '';
    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      return true;
    }
  }
  
  return false;
}

/**
 * New efficient polling approach using tx_search by nonce
 */
async function pollForDepositWithNonce(
  params: NoblePollParams,
  onUpdate?: PollUpdateCallback,
  rpcClient?: TendermintRpcClient,
  logger?: AppLogger
): Promise<NoblePollResult> {
  if (!rpcClient || !logger) {
    throw new Error('rpcClient and logger required for pollForDepositWithNonce');
  }

  const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
  const txSearchTimeoutMs = 2 * 60 * 1000; // 2 minutes for tx_search
  const txSearchIntervalMs = 3000; // 3 seconds
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
      forwardingAddress: params.forwardingAddress,
      expectedAmountUusdc: params.expectedAmountUusdc,
      namadaReceiver: params.namadaReceiver,
    },
    'Starting Noble deposit polling with CCTP nonce (new approach)'
  );

  try {
    // Step 1: Search for CCTP mint event by nonce using tx_search
    // Query format: circle.cctp.v1.MessageReceived.nonce='\"<NONCE>\"'
    // The entire query will be wrapped in double quotes by searchTransactions
    const query = `circle.cctp.v1.MessageReceived.nonce='\\"${params.cctpNonce}\\"'`;
    logger.debug({ flowId: params.flowId, query, cctpNonce: params.cctpNonce }, 'Searching for CCTP mint event');

    const txSearchDeadline = Date.now() + txSearchTimeoutMs;
    let cctpTx: Awaited<ReturnType<typeof rpcClient.searchTransactions>>[0] | null = null;
    let cctpBlockHeight: number | null = null;

    while (Date.now() < txSearchDeadline) {
      if (isAborted()) {
        return {
          success: false,
          found: false,
          error: 'Polling aborted',
        };
      }

      try {
        const txs = await rpcClient.searchTransactions(query, 1, 1);
        
        if (txs.length > 0) {
          const tx = txs[0];
          
          // Verify the transaction has the MessageReceived event with matching nonce
          // Handle both tx_result (from API) and result (from interface) field names
          const txResult = (tx as any).tx_result || (tx as any).result;
          const events = txResult?.events || [];
          
          let nonceMatched = false;
          for (const event of events) {
            if (event.type === 'circle.cctp.v1.MessageReceived') {
              const attrs = indexAttributes(event.attributes || []);
              const eventNonce = stripQuotes(attrs['nonce']);
              if (eventNonce === String(params.cctpNonce)) {
                nonceMatched = true;
                break;
              }
            }
          }

          if (nonceMatched) {
            cctpTx = tx as any;
            cctpBlockHeight = Number.parseInt(tx.height, 10);
            logger.info(
              {
                flowId: params.flowId,
                cctpNonce: params.cctpNonce,
                blockHeight: cctpBlockHeight,
                txHash: tx.hash,
              },
              'CCTP mint event found via tx_search'
            );
            // Notify that CCTP mint was found
            logger.debug(
              { flowId: params.flowId, receivedFound: true, forwardFound: false },
              'Calling onUpdate callback for CCTP mint'
            );
            await onUpdate?.({ height: cctpBlockHeight, receivedFound: true, forwardFound: false });
            logger.debug(
              { flowId: params.flowId },
              'onUpdate callback completed for CCTP mint'
            );
            break;
          }
        }
      } catch (error) {
        logger.warn(
          { flowId: params.flowId, err: error, query },
          'tx_search request failed, retrying'
        );
      }

      await sleep(txSearchIntervalMs);
    }

    if (!cctpTx || !cctpBlockHeight) {
      return {
        success: false,
        found: false,
        error: `CCTP mint event not found for nonce ${params.cctpNonce} within ${txSearchTimeoutMs}ms`,
      };
    }

    // Step 2: Get block_results at the found height and extract IBC packet sequence
    logger.debug(
      { flowId: params.flowId, blockHeight: cctpBlockHeight },
      'Fetching block_results to find IBC send_packet event'
    );

    const blockResults = await rpcClient.getBlockResults(cctpBlockHeight);
    if (!blockResults) {
      return {
        success: false,
        found: false,
        error: `Block results not found for height ${cctpBlockHeight}`,
      };
    }

    // Construct expected packet_data JSON
    if (!params.expectedAmountUusdc || !params.namadaReceiver || !params.forwardingAddress) {
      logger.warn(
        { flowId: params.flowId },
        'Missing required params for packet_data matching, returning CCTP mint success only'
      );
      // Notify that CCTP mint was found (but IBC forward cannot be verified)
      logger.debug(
        { flowId: params.flowId, receivedFound: true, forwardFound: false },
        'Calling onUpdate callback for CCTP mint (early return)'
      );
      await onUpdate?.({ height: cctpBlockHeight, receivedFound: true, forwardFound: false });
      logger.debug(
        { flowId: params.flowId },
        'onUpdate callback completed for CCTP mint (early return)'
      );
      return {
        success: true,
        found: true,
        receivedFound: true,
        forwardFound: false,
        cctpAt: cctpBlockHeight,
        receivedAt: cctpBlockHeight,
      };
    }

    const amountValue = params.expectedAmountUusdc.replace('uusdc', '');
    const expectedPacketData = JSON.stringify({
      amount: amountValue,
      denom: 'uusdc',
      receiver: params.namadaReceiver,
      sender: params.forwardingAddress,
    });

    logger.debug(
      { flowId: params.flowId, expectedPacketData },
      'Searching for send_packet event with matching packet_data'
    );

    // Search finalize_block_events for send_packet
    const finalizeEvents = blockResults.finalize_block_events || [];
    let packetSequence: number | undefined;
    let forwardFound = false;

    for (const event of finalizeEvents) {
      if (event.type === 'send_packet') {
        const packetDataAttr = event.attributes?.find(
          attr => attr.key === 'packet_data'
        );

        if (packetDataAttr?.value === expectedPacketData) {
          // Found matching packet
          const packetSequenceAttr = event.attributes?.find(
            attr => attr.key === 'packet_sequence'
          );

          if (packetSequenceAttr?.value) {
            packetSequence = Number.parseInt(packetSequenceAttr.value, 10);
            forwardFound = true;
            logger.info(
              {
                flowId: params.flowId,
                blockHeight: cctpBlockHeight,
                packetSequence,
                packetData: expectedPacketData,
              },
              'IBC send_packet event found with matching packet_data'
            );
            // Notify that IBC forward was found
            logger.debug(
              { flowId: params.flowId, forwardFound: true, receivedFound: true },
              'Calling onUpdate callback for IBC forward'
            );
            await onUpdate?.({ height: cctpBlockHeight, receivedFound: true, forwardFound: true });
            logger.debug(
              { flowId: params.flowId },
              'onUpdate callback completed for IBC forward'
            );
            break;
          }
        }
      }
    }

    if (!forwardFound) {
      logger.warn(
        {
          flowId: params.flowId,
          blockHeight: cctpBlockHeight,
          expectedPacketData,
        },
        'CCTP mint found but matching send_packet event not found in finalize_block_events'
      );
    }

    return {
      success: true,
      found: true,
      receivedFound: true,
      forwardFound,
      cctpAt: cctpBlockHeight,
      receivedAt: cctpBlockHeight,
      forwardAt: forwardFound ? cctpBlockHeight : undefined,
      packetSequence,
    };
  } catch (error) {
    logger.error(
      { flowId: params.flowId, err: error, cctpNonce: params.cctpNonce },
      'Noble deposit poll with nonce error'
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
 * Efficient polling approach for payment flow using tx_search by packet_sequence.
 * Finds write_acknowledgement event (Noble IBC received) and extracts CCTP nonce from DepositForBurn event.
 */
async function pollForPaymentWithPacketSequence(
  params: NoblePollParams,
  onUpdate?: PollUpdateCallback,
  rpcClient?: TendermintRpcClient,
  logger?: AppLogger
): Promise<NoblePollResult> {
  if (!rpcClient || !logger) {
    throw new Error('rpcClient and logger required for pollForPaymentWithPacketSequence');
  }

  const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
  const txSearchTimeoutMs = 2 * 60 * 1000; // 2 minutes for tx_search
  const txSearchIntervalMs = 3000; // 3 seconds
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
      packetSequence: params.packetSequence,
    },
    'Starting Noble payment polling with packet_sequence (new approach)'
  );

  try {
    // Step 1: Search for write_acknowledgement event by packet_sequence using tx_search
    // Query format: write_acknowledgement.packet_sequence='<SEQUENCE>'
    // The entire query will be wrapped in double quotes by searchTransactions
    const query = `write_acknowledgement.packet_sequence='${params.packetSequence}'`;
    logger.debug({ flowId: params.flowId, query, packetSequence: params.packetSequence }, 'Searching for write_acknowledgement event');

    const txSearchDeadline = Date.now() + txSearchTimeoutMs;
    let ackTx: Awaited<ReturnType<typeof rpcClient.searchTransactions>>[0] | null = null;
    let ackBlockHeight: number | null = null;

    while (Date.now() < txSearchDeadline) {
      if (isAborted()) {
        return {
          success: false,
          found: false,
          error: 'Polling aborted',
        };
      }

      try {
        const txs = await rpcClient.searchTransactions(query, 1, 1);
        
        if (txs.length > 0) {
          const tx = txs[0];
          
          // Verify the transaction has the write_acknowledgement event with matching packet_sequence
          const txResult = (tx as any).tx_result || (tx as any).result;
          const events = txResult?.events || [];
          
          let packetSeqMatched = false;
          let packetAck: string | undefined;
          
          for (const event of events) {
            if (event.type === 'write_acknowledgement') {
              const attrs = indexAttributes(event.attributes || []);
              const eventPacketSeq = attrs['packet_sequence'];
              packetAck = attrs['packet_ack'];
              
              if (eventPacketSeq === String(params.packetSequence)) {
                packetSeqMatched = true;
                break;
              }
            }
          }

          if (packetSeqMatched) {
            // Verify packet_ack is success code
            if (packetAck !== '{"result":"AQ=="}') {
              logger.error(
                {
                  flowId: params.flowId,
                  packetSequence: params.packetSequence,
                  packetAck,
                },
                'Packet acknowledgement indicates failure'
              );
              return {
                success: false,
                found: false,
                error: `Packet acknowledgement indicates failure: ${packetAck}`,
                ackFound: false,
              };
            }

            ackTx = tx as any;
            ackBlockHeight = Number.parseInt(tx.height, 10);
            logger.info(
              {
                flowId: params.flowId,
                packetSequence: params.packetSequence,
                blockHeight: ackBlockHeight,
                txHash: tx.hash,
              },
              'write_acknowledgement event found via tx_search'
            );
            
            // Emit NOBLE_RECEIVED stage (IBC ack received)
            logger.debug(
              { flowId: params.flowId, ackFound: true, cctpFound: false },
              'Calling onUpdate callback for IBC acknowledgement'
            );
            await onUpdate?.({ height: ackBlockHeight, ackFound: true, cctpFound: false });
            logger.debug(
              { flowId: params.flowId },
              'onUpdate callback completed for IBC acknowledgement'
            );
            break;
          }
        }
      } catch (error) {
        logger.warn(
          { flowId: params.flowId, err: error, query },
          'tx_search request failed, retrying'
        );
      }

      await sleep(txSearchIntervalMs);
    }

    if (!ackTx || !ackBlockHeight) {
      return {
        success: false,
        found: false,
        error: `write_acknowledgement event not found for packet_sequence ${params.packetSequence} within ${txSearchTimeoutMs}ms`,
        ackFound: false,
      };
    }

    // Step 2: Search for DepositForBurn event in the same transaction
    logger.debug(
      { flowId: params.flowId, blockHeight: ackBlockHeight },
      'Searching for DepositForBurn event in transaction'
    );

    const txResult = (ackTx as any).tx_result || (ackTx as any).result;
    const events = txResult?.events || [];
    
    let cctpNonce: number | undefined;
    let cctpFound = false;

    for (const event of events) {
      if (event.type === 'circle.cctp.v1.DepositForBurn') {
        const attrs = indexAttributes(event.attributes || []);
        const nonceStr = stripQuotes(attrs['nonce']);
        
        if (nonceStr) {
          cctpNonce = Number.parseInt(nonceStr, 10);
          if (!cctpNonce || cctpNonce <= 0) {
            logger.warn(
              {
                flowId: params.flowId,
                blockHeight: ackBlockHeight,
                nonceStr,
              },
              'Invalid CCTP nonce value'
            );
            continue;
          }

          cctpFound = true;
          logger.info(
            {
              flowId: params.flowId,
              blockHeight: ackBlockHeight,
              cctpNonce,
            },
            'CCTP DepositForBurn event found, nonce extracted'
          );
          
          // Emit NOBLE_CCTP_BURNED stage (CCTP burn for mint)
          logger.debug(
            { flowId: params.flowId, ackFound: true, cctpFound: true },
            'Calling onUpdate callback for CCTP burn'
          );
          await onUpdate?.({ height: ackBlockHeight, ackFound: true, cctpFound: true });
          logger.debug(
            { flowId: params.flowId },
            'onUpdate callback completed for CCTP burn'
          );
          break;
        }
      }
    }

    if (!cctpFound) {
      logger.warn(
        {
          flowId: params.flowId,
          blockHeight: ackBlockHeight,
          packetSequence: params.packetSequence,
        },
        'write_acknowledgement found but DepositForBurn event not found in same transaction'
      );
    }

    return {
      success: true,
      found: true,
      ackFound: true,
      cctpFound,
      ackAt: ackBlockHeight,
      cctpAt: cctpFound ? ackBlockHeight : undefined,
      cctpNonce, // Return nonce for EVM polling
    };
  } catch (error) {
    logger.error(
      { flowId: params.flowId, err: error, packetSequence: params.packetSequence },
      'Noble payment poll with packet_sequence error'
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
 * Old iterative polling approach (fallback when cctpNonce is not provided)
 */
async function pollForDepositIterative(
  params: NoblePollParams,
  onUpdate?: PollUpdateCallback,
  rpcClient?: TendermintRpcClient,
  logger?: AppLogger
): Promise<NoblePollResult> {
  if (!rpcClient || !logger) {
    throw new Error('rpcClient and logger required for pollForDepositIterative');
  }

  const timeoutMs = params.timeoutMs ?? 30 * 60 * 1000;
  const intervalMs = params.intervalMs ?? 5000;
  const blockRequestDelayMs = params.blockRequestDelayMs ?? 100;
  const { controller, cleanup, wasTimeout } = createPollTimeout(
    timeoutMs,
    logger,
    params.flowId
  );
  const abortSignal = params.abortSignal || controller.signal;
  const isAborted = () => abortSignal.aborted || controller.signal.aborted;

  logger.info(
    { flowId: params.flowId },
    'Starting Noble deposit polling (iterative approach - fallback)'
  );

  const deadline = Date.now() + timeoutMs;
  let nextHeight = params.startHeight;
  let receivedFound = false;
  let forwardFound = false;
  let receivedAt: number | undefined;
  let forwardAt: number | undefined;
  let retryExhausted = false;

  try {
    while (Date.now() < deadline && (!receivedFound || !forwardFound)) {
          if (isAborted()) break;

          // Wrap getLatestBlockHeight with retry logic for consistent error handling
          let latest: number;
          try {
            latest = await retryWithBackoff(
              () => rpcClient.getLatestBlockHeight(),
              3, // max retries
              500, // initial delay 500ms
              5000 // max delay 5s
            );
          } catch (error) {
            // Check if this is retry exhaustion
            if (isRetryExhaustionError(error)) {
              logger.warn(
                { err: error, flowId: params.flowId },
                'Noble deposit poll: RPC retry exhaustion detected'
              );
              retryExhausted = true;
              // Re-throw to be caught by outer catch block
              throw error;
            }
            // Re-throw other errors
            throw error;
          }
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
            if (isAborted()) break;

            onUpdate?.({ height: nextHeight, receivedFound, forwardFound });

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
                  'Noble deposit poll: no block results for height'
                );
                nextHeight++;
                // Add delay before next block request
                await sleep(blockRequestDelayMs);
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
              // Check if error is permanent (404 = block doesn't exist)
              if (isPermanentError(error)) {
                logger.debug(
                  { err: error, flowId: params.flowId, height: nextHeight },
                  'Noble deposit poll: permanent error for height, skipping'
                );
                nextHeight++;
                await sleep(blockRequestDelayMs);
                continue;
              }
              
              // Transient errors should have been retried by retryWithBackoff
              // If we still get here, log warning and skip block after max retries
              logger.warn(
                { err: error, flowId: params.flowId, height: nextHeight },
                'Noble deposit poll fetch failed for height after retries, skipping block'
              );
              nextHeight++;
              await sleep(blockRequestDelayMs);
              continue;
            }

            nextHeight++;
            // Add delay before next block request to avoid rate limiting
            await sleep(blockRequestDelayMs);
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
          retryExhausted: false,
        };
      } catch (error) {
        // Check if this is retry exhaustion
        const isRetryExhaustion = isRetryExhaustionError(error);
        if (isRetryExhaustion) {
          logger.warn(
            { err: error, flowId: params.flowId },
            'Noble deposit poll: RPC retry exhaustion (treating as timeout)'
          );
        } else {
          logger.error({ err: error, flowId: params.flowId }, 'Noble deposit poll error');
        }
        return {
          success: false,
          found: false,
          error: error instanceof Error ? error.message : String(error),
          retryExhausted: isRetryExhaustion,
        };
      } finally {
        cleanup();
      }
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
  // Bind rpcClient and logger to helper functions
  const pollForDepositWithNonceBound = (params: NoblePollParams, onUpdate?: PollUpdateCallback) =>
    pollForDepositWithNonce(params, onUpdate, rpcClient, logger);
  const pollForDepositIterativeBound = (params: NoblePollParams, onUpdate?: PollUpdateCallback) =>
    pollForDepositIterative(params, onUpdate, rpcClient, logger);
  const pollForPaymentWithPacketSequenceBound = (params: NoblePollParams, onUpdate?: PollUpdateCallback) =>
    pollForPaymentWithPacketSequence(params, onUpdate, rpcClient, logger);
  const pollForOrbiterIterativeBound = (params: NoblePollParams, onUpdate?: PollUpdateCallback) =>
    pollForOrbiterIterative(params, onUpdate, rpcClient, logger);

  return {
    async pollForDeposit(params, onUpdate) {
      // If cctpNonce is provided, use new efficient approach
      if (params.cctpNonce !== undefined) {
        return pollForDepositWithNonceBound(params, onUpdate);
      }
      
      // Otherwise, fall back to old iterative approach
      return pollForDepositIterativeBound(params, onUpdate);
    },

    async pollForOrbiter(params, onUpdate) {
      // If packetSequence is provided, use new efficient approach
      if (params.packetSequence !== undefined) {
        return pollForPaymentWithPacketSequenceBound(params, onUpdate);
      }
      
      // Otherwise, fall back to old iterative approach
      return pollForOrbiterIterativeBound(params, onUpdate);
    },
  };
}

/**
 * Old iterative polling approach for payment flow (fallback when packetSequence is not provided)
 */
async function pollForOrbiterIterative(
  params: NoblePollParams,
  onUpdate?: PollUpdateCallback,
  rpcClient?: TendermintRpcClient,
  logger?: AppLogger
): Promise<NoblePollResult> {
  if (!rpcClient || !logger) {
    throw new Error('rpcClient and logger required for pollForOrbiterIterative');
  }

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
      let ackFound = false;
      let cctpFound = false;
      let ackAt: number | undefined;
      let cctpAt: number | undefined;
      let retryExhausted = false;

      try {
        while (Date.now() < deadline && (!ackFound || !cctpFound)) {
          if (isAborted()) break;

          // Wrap getLatestBlockHeight with retry logic for consistent error handling
          let latest: number;
          try {
            latest = await retryWithBackoff(
              () => rpcClient.getLatestBlockHeight(),
              3, // max retries
              500, // initial delay 500ms
              5000 // max delay 5s
            );
          } catch (error) {
            // Check if this is retry exhaustion
            if (isRetryExhaustionError(error)) {
              logger.warn(
                { err: error, flowId: params.flowId },
                'Noble orbiter poll: RPC retry exhaustion detected'
              );
              retryExhausted = true;
              // Re-throw to be caught by outer catch block
              throw error;
            }
            // Re-throw other errors
            throw error;
          }
          logger.debug(
            { flowId: params.flowId, latest, nextHeight },
            'Noble orbiter poll progress'
          );

          // If nextHeight is ahead of latest, fail early (especially useful in tests)
          if (nextHeight > latest) {
            logger.warn(
              { flowId: params.flowId, nextHeight, latest },
              'Noble orbiter poll: nextHeight exceeds latest block height, stopping'
            );
            return {
              success: false,
              found: false,
              error: `Polling exceeded latest block height: nextHeight=${nextHeight}, latest=${latest}`,
              retryExhausted: false,
            };
          }

          while (nextHeight <= latest && (!ackFound || !cctpFound)) {
            if (isAborted()) break;

            onUpdate?.({ height: nextHeight, ackFound, cctpFound });

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
                  'Noble orbiter poll: no block results for height'
                );
                nextHeight++;
                // Add delay before next block request
                await sleep(blockRequestDelayMs);
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
                    const destCaller = stripQuotes(attrs['destination_caller']) || '';
                    const mintRecipient = stripQuotes(attrs['mint_recipient']);
                    const destDomain = attrs['destination_domain'];

                    // Handle null/undefined destinationCallerB64 (when destination_caller is null in memo)
                    const expectedDestCaller = params.destinationCallerB64 ?? '';

                    if (
                      params.amount &&
                      params.mintRecipientB64 &&
                      params.destinationDomain !== undefined &&
                      amount === params.amount &&
                      destCaller === expectedDestCaller &&
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
              // Check if error is permanent (404 = block doesn't exist)
              if (isPermanentError(error)) {
                logger.debug(
                  { err: error, flowId: params.flowId, height: nextHeight },
                  'Noble orbiter poll: permanent error for height, skipping'
                );
                nextHeight++;
                await sleep(blockRequestDelayMs);
                continue;
              }
              
              // Transient errors should have been retried by retryWithBackoff
              // If we still get here, log warning and skip block after max retries
              logger.warn(
                { err: error, flowId: params.flowId, height: nextHeight },
                'Noble orbiter poll fetch failed for height after retries, skipping block'
              );
              nextHeight++;
              await sleep(blockRequestDelayMs);
              continue;
            }

            nextHeight++;
            // Add delay before next block request to avoid rate limiting
            await sleep(blockRequestDelayMs);
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
          retryExhausted: false,
        };
      } catch (error) {
        // Check if this is retry exhaustion
        const isRetryExhaustion = isRetryExhaustionError(error);
        if (isRetryExhaustion) {
          logger.warn(
            { err: error, flowId: params.flowId },
            'Noble orbiter poll: RPC retry exhaustion (treating as timeout)'
          );
        } else {
          logger.error({ err: error, flowId: params.flowId }, 'Noble orbiter poll error');
        }
        return {
          success: false,
          found: false,
          error: error instanceof Error ? error.message : String(error),
          retryExhausted: isRetryExhaustion,
        };
      } finally {
        cleanup();
      }
}

