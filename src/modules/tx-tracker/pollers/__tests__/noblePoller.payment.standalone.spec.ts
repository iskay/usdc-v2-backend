/**
 * Standalone test for Noble payment polling with packet_sequence
 * 
 * This test validates the new efficient polling approach for payment flows:
 * 1. Uses tx_search to find write_acknowledgement event by packet_sequence
 * 2. Verifies packet_ack is success code
 * 3. Finds circle.cctp.v1.DepositForBurn event in same transaction
 * 4. Extracts CCTP nonce from DepositForBurn event
 * 
 * Usage:
 *   npm test -- noblePoller.payment.standalone.spec.ts
 * 
 * Or with specific packet_sequence:
 *   PACKET_SEQUENCE=143 RPC_URL=https://noble-testnet-rpc.polkachu.com npm test -- noblePoller.payment.standalone.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { createTendermintRpcClient } from '../../../../common/rpc/tendermintClient.js';
import { indexAttributes, stripQuotes } from '../base.js';

interface TestParams {
  packetSequence: number;
  nobleRpcUrl: string;
}

interface TestResult {
  success: boolean;
  blockHeight?: number;
  cctpNonce?: number;
  txHash?: string;
  error?: string;
}

async function testNoblePaymentPolling(params: TestParams): Promise<TestResult> {
  // 1. Create RPC client
  const rpcClient = createTendermintRpcClient(params.nobleRpcUrl);

  // 2. Run Step 1: tx_search for write_acknowledgement event
  // Query format: write_acknowledgement.packet_sequence='<SEQUENCE>'
  // The entire query will be wrapped in double quotes by searchTransactions
  const query = `write_acknowledgement.packet_sequence='${params.packetSequence}'`;
  console.log(`\n[Test] Searching for write_acknowledgement event`);
  console.log(`[Test] Packet Sequence: ${params.packetSequence}`);
  console.log(`[Test] Raw query string: ${query}`);
  console.log(`[Test] RPC URL: ${params.nobleRpcUrl}`);
  
  console.log(`[Test] Calling searchTransactions...`);
  const txs = await rpcClient.searchTransactions(query, 1, 1);
  console.log(`[Test] searchTransactions returned ${txs.length} transaction(s)`);
  
  if (txs.length === 0) {
    console.error(`[Test] ❌ No transactions found for the given packet_sequence`);
    return {
      success: false,
      error: 'No transactions found for the given packet_sequence',
    };
  }

  const tx = txs[0];
  console.log(`[Test] Transaction found:`, {
    hash: tx.hash,
    height: tx.height,
    hasTxResult: !!(tx as any).tx_result,
    hasResult: !!(tx as any).result,
  });
  
  // Verify the transaction has the write_acknowledgement event with matching packet_sequence
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
  
  let packetSeqMatched = false;
  let packetAck: string | undefined;
  let writeAckEvent: any = null;
  
  for (const event of events) {
    if (event.type === 'write_acknowledgement') {
      console.log(`[Test] Found write_acknowledgement event, checking packet_sequence...`);
      const attrs = indexAttributes(event.attributes || []);
      console.log(`[Test]   Indexed attributes:`, Object.keys(attrs));
      const eventPacketSeq = attrs['packet_sequence'];
      packetAck = attrs['packet_ack'];
      console.log(`[Test]   Event packet_sequence: "${eventPacketSeq}", Expected: "${params.packetSequence}"`);
      console.log(`[Test]   Event packet_ack: "${packetAck}"`);
      if (eventPacketSeq === String(params.packetSequence)) {
        packetSeqMatched = true;
        writeAckEvent = event;
        console.log(`[Test] ✓ Packet sequence matched!`);
        break;
      } else {
        console.log(`[Test]   Packet sequence mismatch: "${eventPacketSeq}" !== "${params.packetSequence}"`);
      }
    }
  }

  if (!packetSeqMatched || !writeAckEvent) {
    console.error(`[Test] ❌ write_acknowledgement event not found or packet_sequence mismatch`);
    console.error(`[Test]   packetSeqMatched: ${packetSeqMatched}`);
    console.error(`[Test]   writeAckEvent: ${!!writeAckEvent}`);
    return {
      success: false,
      error: 'write_acknowledgement event not found or packet_sequence mismatch',
    };
  }

  // Verify packet_ack is success code
  if (packetAck !== '{"result":"AQ=="}') {
    console.error(`[Test] ❌ Packet acknowledgement indicates failure: ${packetAck}`);
    return {
      success: false,
      error: `Packet acknowledgement indicates failure: ${packetAck}`,
    };
  }

  console.log(`[Test] ✓ Packet acknowledgement is success code`);

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

  console.log(`[Test] ✓ write_acknowledgement found at block height: ${blockHeight}, txHash: ${tx.hash}`);

  // 3. Search for DepositForBurn event in the same transaction
  console.log(`[Test] Searching for DepositForBurn event in same transaction...`);
  
  let depositForBurnEvent: any = null;
  let cctpNonce: number | undefined;
  
  for (const event of events) {
    if (event.type === 'circle.cctp.v1.DepositForBurn') {
      console.log(`[Test] Found DepositForBurn event, extracting nonce...`);
      depositForBurnEvent = event;
      const attrs = indexAttributes(event.attributes || []);
      console.log(`[Test]   Indexed attributes:`, Object.keys(attrs));
      const nonceStr = stripQuotes(attrs['nonce']);
      console.log(`[Test]   Event nonce: "${nonceStr}"`);
      
      if (nonceStr) {
        cctpNonce = Number.parseInt(nonceStr, 10);
        console.log(`[Test]   Parsed nonce: ${cctpNonce} (from "${nonceStr}")`);
        if (!cctpNonce || cctpNonce <= 0) {
          console.error(`[Test] ❌ Invalid CCTP nonce: ${nonceStr}`);
          return {
            success: false,
            error: `Invalid CCTP nonce: ${nonceStr}`,
          };
        }
        console.log(`[Test] ✓ CCTP nonce extracted: ${cctpNonce}`);
        break;
      } else {
        console.error(`[Test] ❌ Nonce attribute not found in DepositForBurn event`);
        return {
          success: false,
          error: 'Nonce attribute not found in DepositForBurn event',
        };
      }
    }
  }

  if (!depositForBurnEvent || !cctpNonce) {
    console.error(`[Test] ❌ DepositForBurn event not found or nonce not extracted`);
    console.error(`[Test]   depositForBurnEvent: ${!!depositForBurnEvent}`);
    console.error(`[Test]   cctpNonce: ${cctpNonce}`);
    return {
      success: false,
      error: 'DepositForBurn event not found or nonce not extracted',
    };
  }

  console.log(`[Test] ✅ Test completed successfully!`);
  console.log(`[Test]   Block Height: ${blockHeight}`);
  console.log(`[Test]   CCTP Nonce: ${cctpNonce}`);
  console.log(`[Test]   Transaction Hash: ${tx.hash}`);

  return {
    success: true,
    blockHeight,
    cctpNonce,
    txHash: tx.hash,
  };
}

describe('Noble Payment Polling Standalone Test', () => {
  const packetSequence = Number.parseInt(process.env.PACKET_SEQUENCE || '143', 10);
  const rpcUrl = process.env.RPC_URL || 'https://noble-testnet-rpc.polkachu.com';

  it(`should find write_acknowledgement and extract CCTP nonce for packet sequence ${packetSequence}`, async () => {
    const result = await testNoblePaymentPolling({
      packetSequence,
      nobleRpcUrl: rpcUrl,
    });

    expect(result.success).toBe(true);
    expect(result.blockHeight).toBeDefined();
    expect(result.blockHeight).toBeGreaterThan(0);
    expect(result.cctpNonce).toBeDefined();
    expect(result.cctpNonce).toBeGreaterThan(0);
    expect(result.txHash).toBeDefined();

    console.log('\n✅ Test passed!');
    console.log(`   Block Height: ${result.blockHeight}`);
    console.log(`   CCTP Nonce: ${result.cctpNonce}`);
    console.log(`   Transaction Hash: ${result.txHash}`);
  }, 30000); // 30 second timeout
});

