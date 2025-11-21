/**
 * Standalone test for Namada deposit polling with packet sequence
 * 
 * This test validates the new packet sequence-based polling approach:
 * 1. Uses block_results to find write_acknowledgement events
 * 2. Matches by packet_sequence number
 * 3. Verifies packet_ack contains success code "AQ=="
 * 4. Extracts inner-tx-hash from write_acknowledgement event
 * 
 * Usage:
 *   npm test -- namadaPoller.standalone.spec.ts
 * 
 * Or with specific parameters:
 *   PACKET_SEQUENCE=919 RPC_URL=https://rpc.testnet.siuuu.click START_HEIGHT=3492800 npm test -- namadaPoller.standalone.spec.ts
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
  packetSequence: number;
  namadaRpcUrl: string;
  startHeight: number;
}

interface TestResult {
  success: boolean;
  foundAt?: number;
  namadaTxHash?: string;
  error?: string;
}

async function testNamadaPolling(params: TestParams): Promise<TestResult> {
  console.log(`\n[Test] Searching for write_acknowledgement`);
  console.log(`[Test] Packet Sequence: ${params.packetSequence}`);
  console.log(`[Test] Start Height: ${params.startHeight}`);
  console.log(`[Test] RPC URL: ${params.namadaRpcUrl}`);

  // 1. Create RPC client and poller
  const rpcClient = createTendermintRpcClient(params.namadaRpcUrl);
  const namadaPoller = createNamadaPoller(rpcClient, mockLogger);

  // 2. Run polling with short timeout for test
  const result = await namadaPoller.pollForDeposit({
    flowId: `test-flow-${params.packetSequence}`,
    chain: 'namada-testnet',
    startHeight: params.startHeight,
    packetSequence: params.packetSequence,
    timeoutMs: 30000, // 30 seconds timeout for the whole poll
    intervalMs: 1000, // 1 second interval
    blockRequestDelayMs: 100,
  });

  return {
    success: result.success && result.ackFound === true,
    foundAt: result.foundAt,
    namadaTxHash: result.namadaTxHash,
    error: result.error,
  };
}

describe('Namada Polling Standalone Test', () => {
  const packetSequence = Number.parseInt(process.env.PACKET_SEQUENCE || '919', 10);
  const rpcUrl = process.env.RPC_URL || 'https://rpc.testnet.siuuu.click';
  const startHeight = Number.parseInt(process.env.START_HEIGHT || '3492800', 10);

  it(`should find write_acknowledgement and extract inner-tx-hash for packet sequence ${packetSequence}`, async () => {
    const result = await testNamadaPolling({
      packetSequence,
      namadaRpcUrl: rpcUrl,
      startHeight,
    });

    expect(result.success).toBe(true);
    expect(result.foundAt).toBeDefined();
    expect(result.foundAt).toBeGreaterThan(0);
    expect(result.namadaTxHash).toBeDefined();
    expect(result.namadaTxHash).toBeTruthy();
    expect(result.namadaTxHash?.length).toBeGreaterThan(0);

    console.log('\n✅ Test passed!');
    console.log(`   Found At Block Height: ${result.foundAt}`);
    console.log(`   Namada TX Hash: ${result.namadaTxHash}`);
  }, 60000); // 60 second timeout (allows time for polling)
});

