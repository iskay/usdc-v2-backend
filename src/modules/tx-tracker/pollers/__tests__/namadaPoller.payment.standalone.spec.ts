/**
 * Standalone test for Namada payment IBC send polling
 * 
 * This test validates the direct block lookup approach:
 * 1. Fetches block_results at the provided block height
 * 2. Searches end_block_events for send_packet event
 * 3. Matches by inner-tx-hash (comparing with provided tx hash)
 * 4. Extracts packet_sequence from the matching event
 * 
 * Usage:
 *   npm test -- namadaPoller.payment.standalone.spec.ts
 * 
 * Or with specific parameters:
 *   TX_HASH=C9C7EF18AD9CAD0A322E335F567C85D637332608DDCB43227002EA808C71C6AE \
 *   BLOCK_HEIGHT=3511667 \
 *   RPC_URL=https://rpc.testnet.siuuu.click \
 *   npm test -- namadaPoller.payment.standalone.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { createNamadaPoller } from '../namadaPoller.js';
import { createTendermintRpcClient } from '../../../../common/rpc/tendermintClient.js';
import type { AppLogger } from '../../../../common/utils/logger.js';
import { vi } from 'vitest';

// Mock logger for cleaner test output
const mockLogger: AppLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

interface TestParams {
  txHash: string;
  blockHeight: number;
  namadaRpcUrl: string;
}

interface TestResult {
  success: boolean;
  packetSequence?: number;
  namadaTxHash?: string;
  foundAt?: number;
  error?: string;
}

async function testNamadaPaymentPolling(params: TestParams): Promise<TestResult> {
  console.log(`\n[Test] Searching for send_packet event`);
  console.log(`[Test] Transaction Hash: ${params.txHash}`);
  console.log(`[Test] Block Height: ${params.blockHeight}`);
  console.log(`[Test] RPC URL: ${params.namadaRpcUrl}`);

  // 1. Create RPC client and poller
  const rpcClient = createTendermintRpcClient(params.namadaRpcUrl);
  const namadaPoller = createNamadaPoller(rpcClient, mockLogger);

  // 2. Run polling with short timeout for test
  const result = await namadaPoller.pollForPayment({
    flowId: `test-flow-${params.txHash.slice(0, 16)}`,
    chain: 'namada-testnet',
    startHeight: params.blockHeight,
    namadaBlockHeight: params.blockHeight,
    namadaIbcTxHash: params.txHash,
    timeoutMs: 10000, // 10 seconds timeout for the whole poll
    intervalMs: 1000, // 1 second interval (not used in direct lookup)
    blockRequestDelayMs: 100,
  });

  return {
    success: result.success && result.packetSequence !== undefined,
    packetSequence: result.packetSequence,
    namadaTxHash: result.namadaTxHash,
    foundAt: result.foundAt,
    error: result.error,
  };
}

describe('Namada Payment Polling Standalone Test', () => {
  const txHash = process.env.TX_HASH || 'C9C7EF18AD9CAD0A322E335F567C85D637332608DDCB43227002EA808C71C6AE';
  const blockHeight = Number.parseInt(process.env.BLOCK_HEIGHT || '3511667', 10);
  const rpcUrl = process.env.RPC_URL || 'https://rpc.testnet.siuuu.click';

  it(`should find send_packet and extract packet_sequence for tx hash ${txHash.slice(0, 16)}...`, async () => {
    const result = await testNamadaPaymentPolling({
      txHash,
      blockHeight,
      namadaRpcUrl: rpcUrl,
    });

    expect(result.success).toBe(true);
    expect(result.packetSequence).toBeDefined();
    expect(result.packetSequence).toBeGreaterThan(0);
    expect(result.namadaTxHash).toBeDefined();
    expect(result.namadaTxHash).toBeTruthy();
    expect(result.foundAt).toBe(blockHeight);

    console.log('\n✅ Test passed!');
    console.log(`   Block Height: ${result.foundAt}`);
    console.log(`   Packet Sequence: ${result.packetSequence}`);
    console.log(`   Transaction Hash: ${result.namadaTxHash}`);
  }, 30000); // 30 second timeout
});

