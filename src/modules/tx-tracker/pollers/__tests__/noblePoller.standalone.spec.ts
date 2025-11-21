/**
 * Standalone test for Noble deposit polling with CCTP nonce
 * 
 * This test validates the new efficient polling approach:
 * 1. Uses tx_search to find CCTP mint event by nonce
 * 2. Extracts block height from the transaction
 * 3. Fetches block_results at that height
 * 4. Finds send_packet event in finalize_block_events
 * 5. Matches packet_data and extracts packet_sequence
 * 
 * Usage:
 *   npm test -- noblePoller.standalone.spec.ts
 * 
 * Or with specific nonce:
 *   NONCE=704111 RPC_URL=https://noble-testnet-rpc.polkachu.com npm test -- noblePoller.standalone.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { createTendermintRpcClient } from '../../../../common/rpc/tendermintClient.js';
import { indexAttributes, stripQuotes } from '../base.js';

interface TestParams {
  nonce: number;
  nobleRpcUrl: string;
  expectedAmount?: string; // Optional: for packet_data validation (e.g., "100000")
  expectedReceiver?: string; // Optional: for packet_data validation
  expectedSender?: string; // Optional: for packet_data validation
}

interface TestResult {
  success: boolean;
  blockHeight?: number;
  packetSequence?: number;
  txHash?: string;
  error?: string;
}

async function testNoblePolling(params: TestParams): Promise<TestResult> {
  // 1. Create RPC client
  const rpcClient = createTendermintRpcClient(params.nobleRpcUrl);

  // 2. Run Step 1: tx_search for CCTP mint
  // Query format: circle.cctp.v1.MessageReceived.nonce='\"<NONCE>\"'
  // The entire query will be wrapped in double quotes by searchTransactions
  const query = `circle.cctp.v1.MessageReceived.nonce='\\"${params.nonce}\\"'`;
  console.log(`\n[Test] Searching for CCTP mint`);
  console.log(`[Test] Nonce: ${params.nonce}`);
  console.log(`[Test] Raw query string: ${query}`);
  console.log(`[Test] RPC URL: ${params.nobleRpcUrl}`);
  
  console.log(`[Test] Calling searchTransactions...`);
  const txs = await rpcClient.searchTransactions(query, 1, 1);
  console.log(`[Test] searchTransactions returned ${txs.length} transaction(s)`);
  
  if (txs.length === 0) {
    console.error(`[Test] ❌ No transactions found for the given nonce`);
    return {
      success: false,
      error: 'No transactions found for the given nonce',
    };
  }

  const tx = txs[0];
  console.log(`[Test] Transaction found:`, {
    hash: tx.hash,
    height: tx.height,
    hasTxResult: !!(tx as any).tx_result,
    hasResult: !!(tx as any).result,
  });
  
  // Verify the transaction has the MessageReceived event with matching nonce
  const txResult = (tx as any).tx_result || (tx as any).result;
  console.log(`[Test] Transaction result:`, {
    hasTxResult: !!txResult,
    eventCount: txResult?.events?.length || 0,
  });
  
  const events = txResult?.events || [];
  console.log(`[Test] Events found: ${events.length}`);
  events.forEach((ev: any, idx: number) => {
    console.log(`[Test]   Event ${idx}: type=${ev.type}, attributes=${ev.attributes?.length || 0}`);
  });
  
  let nonceMatched = false;
  let messageReceivedEvent: any = null;
  
  for (const event of events) {
    if (event.type === 'circle.cctp.v1.MessageReceived') {
      console.log(`[Test] Found MessageReceived event, checking nonce...`);
      const attrs = indexAttributes(event.attributes || []);
      console.log(`[Test]   Indexed attributes:`, Object.keys(attrs));
      const eventNonce = stripQuotes(attrs['nonce']);
      console.log(`[Test]   Event nonce: "${eventNonce}", Expected: "${params.nonce}"`);
      if (eventNonce === String(params.nonce)) {
        nonceMatched = true;
        messageReceivedEvent = event;
        console.log(`[Test] ✓ Nonce matched!`);
        break;
      } else {
        console.log(`[Test]   Nonce mismatch: "${eventNonce}" !== "${params.nonce}"`);
      }
    }
  }

  if (!nonceMatched || !messageReceivedEvent) {
    console.error(`[Test] ❌ MessageReceived event not found or nonce mismatch`);
    console.error(`[Test]   nonceMatched: ${nonceMatched}`);
    console.error(`[Test]   messageReceivedEvent: ${!!messageReceivedEvent}`);
    return {
      success: false,
      error: 'MessageReceived event not found or nonce mismatch',
    };
  }

  // Extract block height
  const blockHeight = Number.parseInt(tx.height, 10);
  console.log(`[Test] Parsed block height: ${blockHeight} (from "${tx.height}")`);
  if (!blockHeight || blockHeight <= 0) {
    console.error(`[Test] ❌ Invalid block height: ${tx.height}`);
    return {
      success: false,
      error: `Invalid block height: ${tx.height}`,
    };
  }

  console.log(`[Test] ✓ CCTP mint found at block height: ${blockHeight}, txHash: ${tx.hash}`);

  // 3. Run Step 2: block_results lookup
  console.log(`[Test] Fetching block_results for height ${blockHeight}...`);
  const blockResults = await rpcClient.getBlockResults(blockHeight);
  console.log(`[Test] Block results:`, {
    hasBlockResults: !!blockResults,
    height: blockResults?.height,
    finalizeBlockEventsCount: blockResults?.finalize_block_events?.length || 0,
  });
  
  if (!blockResults) {
    console.error(`[Test] ❌ Block results not found for height ${blockHeight}`);
    return {
      success: false,
      error: `Block results not found for height ${blockHeight}`,
    };
  }

  if (!blockResults.finalize_block_events || blockResults.finalize_block_events.length === 0) {
    console.error(`[Test] ❌ No finalize_block_events found at height ${blockHeight}`);
    return {
      success: false,
      error: `No finalize_block_events found at height ${blockHeight}`,
    };
  }

  console.log(`[Test] ✓ Block results fetched, found ${blockResults.finalize_block_events.length} finalize_block_events`);

  // 4. Find send_packet event
  const finalizeEvents = blockResults.finalize_block_events;
  console.log(`[Test] Searching for send_packet event in ${finalizeEvents.length} finalize_block_events...`);
  finalizeEvents.forEach((ev: any, idx: number) => {
    console.log(`[Test]   Event ${idx}: type=${ev.type}`);
  });
  
  let sendPacketEvent: any = null;
  
  for (const event of finalizeEvents) {
    if (event.type === 'send_packet') {
      sendPacketEvent = event;
      console.log(`[Test] Found send_packet event at index ${finalizeEvents.indexOf(event)}`);
      break;
    }
  }

  if (!sendPacketEvent) {
    console.error(`[Test] ❌ send_packet event not found in finalize_block_events`);
    return {
      success: false,
      error: 'send_packet event not found in finalize_block_events',
    };
  }

  console.log(`[Test] ✓ send_packet event found`);

  // 5. Extract packet_data
  console.log(`[Test] Extracting packet_data from send_packet event...`);
  console.log(`[Test]   Event attributes:`, sendPacketEvent.attributes?.map((a: any) => a.key));
  const packetDataAttr = sendPacketEvent.attributes?.find(
    (a: any) => a.key === 'packet_data'
  );
  console.log(`[Test]   packet_data attribute:`, {
    found: !!packetDataAttr,
    value: packetDataAttr?.value?.substring(0, 100) + (packetDataAttr?.value?.length > 100 ? '...' : ''),
  });

  if (!packetDataAttr || !packetDataAttr.value) {
    console.error(`[Test] ❌ packet_data attribute not found in send_packet event`);
    return {
      success: false,
      error: 'packet_data attribute not found in send_packet event',
    };
  }

  let packetData: any;
  try {
    packetData = JSON.parse(packetDataAttr.value);
    console.log(`[Test] ✓ packet_data parsed successfully:`, packetData);
  } catch (error) {
    console.error(`[Test] ❌ Failed to parse packet_data JSON:`, error);
    return {
      success: false,
      error: `Failed to parse packet_data JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 6. Validate packet_data (if expected values provided)
  if (params.expectedAmount || params.expectedReceiver || params.expectedSender) {
    if (params.expectedAmount && packetData.amount !== params.expectedAmount) {
      return {
        success: false,
        error: `Amount mismatch: expected ${params.expectedAmount}, got ${packetData.amount}`,
      };
    }

    if (params.expectedReceiver && packetData.receiver !== params.expectedReceiver) {
      return {
        success: false,
        error: `Receiver mismatch: expected ${params.expectedReceiver}, got ${packetData.receiver}`,
      };
    }

    if (params.expectedSender && packetData.sender !== params.expectedSender) {
      return {
        success: false,
        error: `Sender mismatch: expected ${params.expectedSender}, got ${packetData.sender}`,
      };
    }

    console.log(`✓ packet_data validation passed`);
  }

  // 7. Extract packet_sequence
  console.log(`[Test] Extracting packet_sequence from send_packet event...`);
  const packetSequenceAttr = sendPacketEvent.attributes?.find(
    (a: any) => a.key === 'packet_sequence'
  );
  console.log(`[Test]   packet_sequence attribute:`, {
    found: !!packetSequenceAttr,
    value: packetSequenceAttr?.value,
  });

  if (!packetSequenceAttr || !packetSequenceAttr.value) {
    console.error(`[Test] ❌ packet_sequence attribute not found in send_packet event`);
    return {
      success: false,
      error: 'packet_sequence attribute not found in send_packet event',
    };
  }

  const packetSequence = Number.parseInt(packetSequenceAttr.value, 10);
  console.log(`[Test]   Parsed packet_sequence: ${packetSequence} (from "${packetSequenceAttr.value}")`);
  if (!packetSequence || packetSequence <= 0) {
    console.error(`[Test] ❌ Invalid packet_sequence: ${packetSequenceAttr.value}`);
    return {
      success: false,
      error: `Invalid packet_sequence: ${packetSequenceAttr.value}`,
    };
  }

  console.log(`[Test] ✓ packet_sequence extracted: ${packetSequence}`);
  console.log(`[Test] ✅ Test completed successfully!`);

  return {
    success: true,
    blockHeight,
    packetSequence,
    txHash: tx.hash,
  };
}

describe('Noble Polling Standalone Test', () => {
  const nonce = Number.parseInt(process.env.NONCE || '704111', 10);
  const rpcUrl = process.env.RPC_URL || 'https://noble-testnet-rpc.polkachu.com';

  it(`should find CCTP mint and extract packet_sequence for nonce ${nonce}`, async () => {
    const result = await testNoblePolling({
      nonce,
      nobleRpcUrl: rpcUrl,
      // Optional: uncomment to validate packet_data
      // expectedAmount: '100000',
      // expectedReceiver: 'tnam1qprxs9n5afscskramwajyrdjw5a64lwweudc0l78',
      // expectedSender: 'noble1cugfxuln9k2zsvey7yuaeckr7avfzffd7d44jp',
    });

    expect(result.success).toBe(true);
    expect(result.blockHeight).toBeDefined();
    expect(result.blockHeight).toBeGreaterThan(0);
    expect(result.packetSequence).toBeDefined();
    expect(result.packetSequence).toBeGreaterThan(0);
    expect(result.txHash).toBeDefined();

    console.log('\n✅ Test passed!');
    console.log(`   Block Height: ${result.blockHeight}`);
    console.log(`   Packet Sequence: ${result.packetSequence}`);
    console.log(`   Transaction Hash: ${result.txHash}`);
  }, 30000); // 30 second timeout
});

