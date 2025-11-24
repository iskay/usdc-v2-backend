/**
 * Standalone test for EVM mint polling with CCTP nonce
 * 
 * This test validates the new efficient polling approach for payment flows:
 * 1. Uses getLogs to find MessageReceived event filtered by nonce
 * 2. Verifies event parsing extracts mintRecipient and amount correctly
 * 3. Verifies recipient extraction from bytes32 (last 20 bytes)
 * 
 * Usage:
 *   npm test -- evmPoller.standalone.spec.ts
 * 
 * Or with specific nonce:
 *   CCTP_NONCE=704111 RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY npm test -- evmPoller.standalone.spec.ts
 * 
 * Or with specific nonce and expected recipient:
 *   CCTP_NONCE=704111 RPC_URL=https://base-sepolia.g.alchemy.com/v2/YOUR_KEY EXPECTED_RECIPIENT=0x1234... npm test -- evmPoller.standalone.spec.ts
 */

import { describe, it, expect } from 'vitest';
import { createEvmRpcClient } from '../../../../common/rpc/evmClient.js';

// Import helper functions (we'll need to make them exported or duplicate the logic)
// For now, we'll duplicate the key parsing logic for testing
const MESSAGE_RECEIVED_TOPIC = '0x58200b4c34ae05ee816d710053fff3fb75af4395915d3d2a771b24aa10e3cc5d';

function toPaddedNonceTopic(nonce: number): string {
  return `0x${BigInt(nonce).toString(16).padStart(64, '0')}`;
}

function extractEvmAddressFromBytes32(bytes32: string): string {
  const clean = bytes32.replace(/^0x/, '');
  const addressHex = clean.slice(-40);
  return `0x${addressHex}`;
}

interface TestParams {
  cctpNonce: number;
  evmRpcUrl: string;
  messageTransmitterAddress: string;
  expectedRecipient?: string; // Optional: for recipient verification
  expectedAmount?: string; // Optional: for amount verification
  sourceDomain?: number; // Optional: for source domain verification (Noble = 4)
}

interface TestResult {
  success: boolean;
  blockNumber?: number;
  txHash?: string;
  mintRecipient?: string;
  amount?: string;
  sourceDomain?: number;
  error?: string;
}

async function testEvmMintPolling(params: TestParams): Promise<TestResult> {
  // 1. Create RPC client
  const rpcClient = createEvmRpcClient(params.evmRpcUrl);

  console.log(`\n[Test] Testing EVM mint polling with CCTP nonce`);
  console.log(`[Test] Nonce: ${params.cctpNonce}`);
  console.log(`[Test] MessageTransmitter Address: ${params.messageTransmitterAddress}`);
  console.log(`[Test] RPC URL: ${params.evmRpcUrl}`);
  if (params.expectedRecipient) {
    console.log(`[Test] Expected Recipient: ${params.expectedRecipient}`);
  }
  if (params.expectedAmount) {
    console.log(`[Test] Expected Amount: ${params.expectedAmount}`);
  }
  if (params.sourceDomain) {
    console.log(`[Test] Expected Source Domain: ${params.sourceDomain}`);
  }

  // 2. Determine search strategy
  const windowSize = Math.max(1, Number.parseInt(process.env.WINDOW_SIZE || '2000', 10));
  const maxWindows = Math.max(1, Number.parseInt(process.env.WINDOWS_TO_SCAN || '10', 10));
  const searchTimeoutMs = Math.max(1000, Number.parseInt(process.env.SEARCH_TIMEOUT_MS || '60000', 10));
  const explicitStartBlock = process.env.START_BLOCK ? Math.max(0, Number.parseInt(process.env.START_BLOCK, 10)) : undefined;

  console.log(`[Test] Window size: ${windowSize} blocks`);
  console.log(`[Test] Max windows: ${maxWindows}`);
  console.log(`[Test] Search timeout: ${searchTimeoutMs} ms`);
  if (explicitStartBlock !== undefined) {
    console.log(`[Test] Explicit start block: ${explicitStartBlock}`);
  }

  console.log(`[Test] Getting latest block number...`);
  const latestBlock = await rpcClient.getBlockNumber();
  console.log(`[Test] Latest block: ${latestBlock}`);

  let currentStartBlock =
    explicitStartBlock !== undefined
      ? explicitStartBlock
      : latestBlock > windowSize
          ? latestBlock - windowSize
          : 0;
  let currentEndBlock =
    explicitStartBlock !== undefined
      ? explicitStartBlock + windowSize
      : latestBlock;

  // 3. Query MessageReceived events filtered by nonce in windows
  const nonceTopic = toPaddedNonceTopic(params.cctpNonce);
  console.log(`[Test] Nonce topic: ${nonceTopic}`);

  const topics = [
    MESSAGE_RECEIVED_TOPIC,
    null, // caller - any address
    nonceTopic, // nonce (indexed)
  ];

  const startTime = Date.now();
  let windowsScanned = 0;
  let matchedLog: ReturnType<typeof createEvmRpcClient> extends infer Client
    ? Client extends { getLogs: (...args: any) => Promise<infer Logs> }
      ? Logs extends Array<infer Log>
        ? Log
        : never
      : never
    : never | null = null;

  while (windowsScanned < maxWindows && Date.now() - startTime < searchTimeoutMs) {
    if (currentStartBlock < 0 || currentEndBlock < 0 || currentStartBlock > currentEndBlock) {
      break;
    }

    console.log(`[Test] Window ${windowsScanned + 1}: scanning ${currentStartBlock} -> ${currentEndBlock}`);

    const filter = {
      address: params.messageTransmitterAddress.toLowerCase(),
      topics,
      fromBlock: `0x${Math.max(0, currentStartBlock).toString(16)}`,
      toBlock: `0x${Math.max(0, currentEndBlock).toString(16)}`,
    };

    const logs = await rpcClient.getLogs(filter);
    console.log(`[Test] getLogs returned ${logs.length} log(s) for this window`);

    if (logs.length > 0) {
      matchedLog = logs[0];
      break;
    }

    windowsScanned++;
    if (currentStartBlock === 0) {
      break;
    }

    currentEndBlock = currentStartBlock > 0 ? currentStartBlock - 1 : -1;
    currentStartBlock = currentEndBlock > windowSize ? currentEndBlock - windowSize : 0;
  }

  if (!matchedLog) {
    console.error(`[Test] ❌ No MessageReceived events found for the given nonce`);
    return {
      success: false,
      error: 'No MessageReceived events found for the given nonce within the search window(s)',
    };
  }

  // 4. Parse the matching event
  const log = matchedLog as any;
  console.log(`[Test] Event found:`, {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    address: log.address,
    topicCount: log.topics.length,
  });

  // Verify nonce in topics[2]
  const nonceTopicInLog = log.topics[2];
  if (!nonceTopicInLog) {
    console.error(`[Test] ❌ Nonce topic not found in event`);
    return {
      success: false,
      error: 'Nonce topic not found in event',
    };
  }

  const extractedNonce = Number(BigInt(nonceTopicInLog));
  console.log(`[Test]   Extracted Nonce: ${extractedNonce} (expected: ${params.cctpNonce})`);

  if (extractedNonce !== params.cctpNonce) {
    console.error(`[Test] ❌ Nonce mismatch: expected ${params.cctpNonce}, got ${extractedNonce}`);
    return {
      success: false,
      error: `Nonce mismatch: expected ${params.cctpNonce}, got ${extractedNonce}`,
    };
  }

  console.log(`[Test] ✓ Nonce matches!`);

  // 6. Parse event data to extract mintRecipient and amount
  // Data structure: ABI-encoded (uint32 sourceDomain, bytes32 sender, bytes messageBody)
  const dataHex = log.data.replace(/^0x/, '');
  const dataBytes = Buffer.from(dataHex, 'hex');

  if (dataBytes.length < 128) {
    console.error(`[Test] ❌ Event data too short: ${dataBytes.length} bytes`);
    return {
      success: false,
      error: `Event data too short: ${dataBytes.length} bytes`,
    };
  }

  // Extract sourceDomain (uint32 at offset 28-31, last 4 bytes of first 32-byte slot)
  const sourceDomain = dataBytes.readUInt32BE(28);
  console.log(`[Test]   Source Domain: ${sourceDomain}`);

  // Extract messageBody offset (dynamic)
  const messageBodyOffset = Number(BigInt('0x' + dataBytes.slice(64, 96).toString('hex')));
  console.log(`[Test]   MessageBody Offset: ${messageBodyOffset}`);
  if (messageBodyOffset <= 0 || messageBodyOffset > dataBytes.length - 32) {
    console.error(`[Test] ❌ Invalid messageBody offset: ${messageBodyOffset}`);
    return {
      success: false,
      error: `Invalid messageBody offset: ${messageBodyOffset}`,
    };
  }

  // Extract messageBody length at the dynamic offset
  const lengthStart = messageBodyOffset;
  const lengthEnd = messageBodyOffset + 32;
  if (lengthEnd > dataBytes.length) {
    console.error(`[Test] ❌ Event data incomplete while reading length`);
    return {
      success: false,
      error: `Event data incomplete while reading length`,
    };
  }
  const messageBodyLength = Number(BigInt('0x' + dataBytes.slice(lengthStart, lengthEnd).toString('hex')));
  console.log(`[Test]   MessageBody Length: ${messageBodyLength} bytes`);

  const bodyStart = lengthEnd;
  const bodyEnd = bodyStart + messageBodyLength;
  if (bodyEnd > dataBytes.length) {
    console.error(`[Test] ❌ Event data incomplete: need ${bodyEnd} bytes, got ${dataBytes.length}`);
    return {
      success: false,
      error: `Event data incomplete: need ${bodyEnd} bytes, got ${dataBytes.length}`,
    };
  }

  // Extract messageBody bytes using dynamic offset
  const messageBodyBytes = dataBytes.slice(bodyStart, bodyEnd);

  if (messageBodyBytes.length < 132) {
    console.error(`[Test] ❌ MessageBody too short for BurnMessage: ${messageBodyBytes.length} bytes`);
    return {
      success: false,
      error: `MessageBody too short for BurnMessage: ${messageBodyBytes.length} bytes`,
    };
  }

  // Parse BurnMessage from messageBody
  // - Offset 36-67: mintRecipient (bytes32)
  // - Offset 68-99: amount (uint256)
  const mintRecipientBytes32 = '0x' + messageBodyBytes.slice(36, 68).toString('hex');
  const mintRecipient = extractEvmAddressFromBytes32(mintRecipientBytes32);
  console.log(`[Test]   Mint Recipient (bytes32): ${mintRecipientBytes32}`);
  console.log(`[Test]   Mint Recipient (EVM address): ${mintRecipient}`);

  const amountBytes = messageBodyBytes.slice(68, 100);
  const amount = BigInt('0x' + amountBytes.toString('hex'));
  console.log(`[Test]   Amount: ${amount.toString()}`);

  // Verify recipient if provided
  if (params.expectedRecipient) {
    const expectedLower = params.expectedRecipient.toLowerCase();
    const actualLower = mintRecipient.toLowerCase();
    if (actualLower !== expectedLower) {
      console.error(`[Test] ❌ Recipient mismatch: expected ${expectedLower}, got ${actualLower}`);
      return {
        success: false,
        error: `Recipient mismatch: expected ${expectedLower}, got ${actualLower}`,
      };
    }
    console.log(`[Test] ✓ Recipient matches!`);
  }

  // Verify amount if provided
  if (params.expectedAmount) {
    const expectedAmount = BigInt(params.expectedAmount);
    if (amount !== expectedAmount) {
      console.error(`[Test] ❌ Amount mismatch: expected ${expectedAmount.toString()}, got ${amount.toString()}`);
      return {
        success: false,
        error: `Amount mismatch: expected ${expectedAmount.toString()}, got ${amount.toString()}`,
      };
    }
    console.log(`[Test] ✓ Amount matches!`);
  }

  // Verify source domain if provided
  if (params.sourceDomain !== undefined) {
    if (sourceDomain !== params.sourceDomain) {
      console.error(`[Test] ❌ Source domain mismatch: expected ${params.sourceDomain}, got ${sourceDomain}`);
      return {
        success: false,
        error: `Source domain mismatch: expected ${params.sourceDomain}, got ${sourceDomain}`,
      };
    }
    console.log(`[Test] ✓ Source domain matches!`);
  }

  console.log(`[Test] ✅ Test completed successfully!`);
  console.log(`[Test]   Block Number: ${log.blockNumber}`);
  console.log(`[Test]   Transaction Hash: ${log.transactionHash}`);
  console.log(`[Test]   Mint Recipient: ${mintRecipient}`);
  console.log(`[Test]   Amount: ${amount.toString()}`);
  console.log(`[Test]   Source Domain: ${sourceDomain}`);

  return {
    success: true,
    blockNumber: Number.parseInt(log.blockNumber, 16),
    txHash: log.transactionHash,
    mintRecipient,
    amount: amount.toString(),
    sourceDomain,
  };
}

describe('EVM Mint Polling Standalone Test', () => {
  const cctpNonce = Number.parseInt(process.env.CCTP_NONCE || '704111', 10);
  const rpcUrl = process.env.RPC_URL || 'https://base-sepolia.g.alchemy.com/v2/YOUR_KEY';
  const messageTransmitterAddress = process.env.MESSAGE_TRANSMITTER_ADDRESS || '0x26413e8157CD32011E726065a5462e97dD4d03D9'; // Base Sepolia
  const expectedRecipient = process.env.EXPECTED_RECIPIENT;
  const expectedAmount = process.env.EXPECTED_AMOUNT;
  const sourceDomain = process.env.SOURCE_DOMAIN ? Number.parseInt(process.env.SOURCE_DOMAIN, 10) : 4; // Noble = 4

  it(`should find MessageReceived event and extract details for nonce ${cctpNonce}`, async () => {
    const result = await testEvmMintPolling({
      cctpNonce,
      evmRpcUrl: rpcUrl,
      messageTransmitterAddress,
      expectedRecipient,
      expectedAmount,
      sourceDomain,
    });

    expect(result.success).toBe(true);
    expect(result.blockNumber).toBeDefined();
    expect(result.blockNumber).toBeGreaterThan(0);
    expect(result.txHash).toBeDefined();
    expect(result.txHash).toMatch(/^0x[a-fA-F0-9]{64}$/);

    console.log('\n✅ Test passed!');
    console.log(`   Block Number: ${result.blockNumber}`);
    console.log(`   Transaction Hash: ${result.txHash}`);
    if (result.mintRecipient) {
      console.log(`   Mint Recipient: ${result.mintRecipient}`);
    }
    if (result.amount) {
      console.log(`   Amount: ${result.amount}`);
    }
    if (result.sourceDomain) {
      console.log(`   Source Domain: ${result.sourceDomain}`);
    }
  }, 60000); // 60 second timeout
});

