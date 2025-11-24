# EVM Mint Polling Optimization - Implementation Plan

## Overview

This document outlines the implementation plan for optimizing EVM mint confirmation polling by using CCTP nonce-based event queries instead of iterative block scanning. This mirrors the efficient approach already implemented for Noble chain polling.

## Current State Analysis

### Current Implementation
- **File**: `src/modules/tx-tracker/pollers/evmPoller.ts`
- **Method**: Iterative block-by-block scanning
- **Approach**: 
  - Scans `Transfer` events from `address(0)` to recipient
  - Checks each block range for matching amount
  - Polls every 5 seconds until found or timeout
- **Inefficiencies**:
  - Scans many unnecessary blocks
  - Processes many irrelevant Transfer events
  - High RPC call volume
  - Slow confirmation times (minutes)

### Available Data

#### For Payment Flows (Namada → Noble → EVM)
- **CCTP Nonce**: Extracted from Noble `DepositForBurn` event during Noble polling
  - Location: `noblePoller.ts` line 490 (`pollForPaymentWithPacketSequence`)
  - Returned in: `NoblePollResult.cctpNonce` (line 546)
  - **Currently NOT passed to EVM poller**
- **Source Domain**: Noble domain ID (typically 4)
- **MessageTransmitter Address**: Available in chain config (`chainRegistry.ts`)

#### For Deposit Flows (EVM → Noble)
- **CCTP Nonce**: Extracted from EVM `MessageSent` event
  - Location: `trackerManager.ts` line 423 (`irisNonce`)
  - Already used for Noble polling (line 581)
  - **Not applicable for EVM mint polling** (this is the source chain)

## Target State

### New Implementation
- **Method**: Direct event query using indexed nonce parameter
- **Approach**:
  - Query `MessageReceived` events on MessageTransmitter contract
  - Filter by indexed nonce (topics[2])
  - Parse event to extract transaction hash and verify recipient/amount
  - Fallback to current approach if nonce unavailable (backward compatibility)

### Benefits
- **Efficiency**: Direct event query (no block scanning)
- **Speed**: Confirmation in seconds instead of minutes
- **Reliability**: Nonce is unique identifier (more reliable than amount matching)
- **Consistency**: Mirrors efficient Noble polling pattern
- **Resource Usage**: Minimal RPC calls

## Implementation Steps

### Step 1: Update `EvmPollParams` Interface

**File**: `src/modules/tx-tracker/pollers/evmPoller.ts`

**Changes**:
- Add optional `cctpNonce?: number` field
- Add optional `sourceDomain?: number` field
- Add optional `messageTransmitterAddress?: string` field

**Rationale**: These fields enable nonce-based querying while maintaining backward compatibility.

```typescript
export interface EvmPollParams extends PollParams {
  usdcAddress: string;
  recipient: string;
  amountBaseUnits: string;
  fromBlock?: bigint;
  // New fields for nonce-based polling
  cctpNonce?: number; // CCTP message nonce
  sourceDomain?: number; // Source chain domain ID (e.g., Noble = 4)
  messageTransmitterAddress?: string; // MessageTransmitter contract address
}
```

### Step 2: Implement Nonce-Based Event Query Function

**File**: `src/modules/tx-tracker/pollers/evmPoller.ts`

**New Function**: `queryMessageReceivedByNonce`

**Purpose**: Query MessageReceived events filtered by nonce

**Implementation Details**:
- Event signature: `MessageReceived(address indexed caller, uint32 sourceDomain, uint64 indexed nonce, bytes32 sender, bytes messageBody)`
- Event topic hash: `0x58200b4c34ae05ee816d710053fff3fb75af4395915d3d2a771b24aa10e3cc5d`
- Nonce is in `topics[2]` (indexed parameter)
- Nonce must be padded to 32 bytes (64 hex characters)

**Function Signature**:
```typescript
async function queryMessageReceivedByNonce(
  rpcClient: EvmRpcClient,
  params: {
    messageTransmitterAddress: string;
    nonce: number;
    sourceDomain?: number; // Optional: can filter by source domain too
    fromBlock?: bigint;
    toBlock?: bigint;
  },
  logger: AppLogger
): Promise<EvmLog[]>
```

**Implementation**:
1. Convert nonce to padded hex topic: `0x${BigInt(nonce).toString(16).padStart(64, '0')}`
2. Construct topics array:
   - `topics[0]`: Event signature hash
   - `topics[1]`: `null` (caller - any)
   - `topics[2]`: Nonce topic (padded)
   - Optionally `topics[3]`: Source domain if filtering (requires additional parsing)
3. Call `rpcClient.getLogs()` with filter
4. Return matching logs

**Note**: Source domain filtering is more complex (it's not indexed), so we'll parse it from event data if needed.

### Step 3: Parse MessageReceived Event Data

**File**: `src/modules/tx-tracker/pollers/evmPoller.ts`

**New Function**: `parseMessageReceivedEvent`

**Purpose**: Extract relevant data from MessageReceived event log

**Event Structure**:
- `topics[0]`: Event signature
- `topics[1]`: Caller address (indexed)
- `topics[2]`: Nonce (indexed, uint64 padded to 32 bytes)
- `data`: ABI-encoded `(uint32 sourceDomain, bytes32 sender, bytes messageBody)`

**Implementation**:
1. Extract nonce from `topics[2]`
2. Decode `data` field to extract:
   - `sourceDomain` (uint32, first 32 bytes)
   - `sender` (bytes32, next 32 bytes)
   - `messageBody` (dynamic bytes, remaining)
3. Parse `messageBody` as `BurnMessage` to extract:
   - `mintRecipient` (bytes32, offset 36-68)
   - `amount` (uint256, offset 68-100)
4. Return parsed data

**Function Signature**:
```typescript
interface ParsedMessageReceived {
  nonce: number;
  sourceDomain: number;
  sender: string;
  mintRecipient: string; // bytes32, extract last 20 bytes for EVM address
  amount: bigint;
}

function parseMessageReceivedEvent(
  log: EvmLog
): ParsedMessageReceived | null
```

### Step 4: Update `pollUsdcMint` Function

**File**: `src/modules/tx-tracker/pollers/evmPoller.ts`

**Changes**:
1. Check if nonce-based polling is available (all required params present)
2. If yes, use nonce-based query
3. If no, fall back to current Transfer event scanning

**Logic Flow**:
```typescript
async pollUsdcMint(params, onUpdate) {
  // ... existing timeout/abort setup ...
  
  // Check if nonce-based polling is available
  const useNonceBased = Boolean(
    params.cctpNonce &&
    params.messageTransmitterAddress
  );
  
  if (useNonceBased) {
    return await pollUsdcMintByNonce(params, onUpdate, rpcClient, logger);
  } else {
    // Fallback to current implementation
    return await pollUsdcMintByTransfer(params, onUpdate, rpcClient, logger);
  }
}
```

**New Function**: `pollUsdcMintByNonce`

**Implementation**:
1. Determine start block (from params or latest - 1)
2. Poll loop:
   - Get latest block number
   - Query MessageReceived events by nonce
   - Parse each event to extract recipient and amount
   - Verify recipient matches (extract EVM address from bytes32)
   - Verify amount matches (optional, for extra safety)
   - If match found, return success with tx hash
   - Sleep and repeat
3. Handle timeout/abort

**Recipient Matching**:
- `mintRecipient` in event is bytes32
- EVM address is in last 20 bytes
- Extract: `mintRecipient.slice(-20)` and convert to hex

### Step 5: Extract and Pass CCTP Nonce from Noble Polling

**File**: `src/modules/tx-tracker/trackerManager.ts`

**Location**: `trackPaymentFlow` function, after Noble polling (around line 1200)

**Changes**:
1. Extract `cctpNonce` from `nobleResult.cctpNonce`
2. Extract `sourceDomain` (Noble domain = 4, or from chain config)
3. Get `messageTransmitterAddress` from chain registry
4. Pass these to EVM poller

**Code Location**: After line 1200 (after Noble polling completes)

**Implementation**:
```typescript
// After nobleResult is received
const cctpNonce = nobleResult.cctpNonce;
const sourceDomain = 4; // Noble domain ID (or get from config)

// Get MessageTransmitter address from chain registry
const evmChainEntry = chainRegistry[evmChain];
const messageTransmitterAddress = evmChainEntry?.contracts?.messageTransmitter;

// Pass to EVM poller
const evmResult = await evmPoller.pollUsdcMint({
  // ... existing params ...
  cctpNonce,
  sourceDomain,
  messageTransmitterAddress,
});
```

**Note**: Only pass nonce if it's available. If not, fall back to current approach.

### Step 6: Update Chain Registry Type (if needed)

**File**: `src/config/chainRegistry.ts`

**Check**: Ensure `messageTransmitter` is available in chain config

**Status**: Already available (verified in grep results)

### Step 7: Add Helper Functions

**File**: `src/modules/tx-tracker/pollers/evmPoller.ts`

**New Helper Functions**:

1. **`toPaddedNonceTopic(nonce: number): string`**
   - Convert nonce to padded hex topic
   - Format: `0x${BigInt(nonce).toString(16).padStart(64, '0')}`

2. **`extractEvmAddressFromBytes32(bytes32: string): string`**
   - Extract last 20 bytes from bytes32
   - Convert to hex address with 0x prefix

3. **`parseBurnMessageFromMessageBody(messageBody: string): { mintRecipient: string; amount: bigint }`**
   - Parse BurnMessage from messageBody bytes
   - Extract mintRecipient (bytes32 at offset 36-68)
   - Extract amount (uint256 at offset 68-100)

### Step 8: Testing

#### Unit Tests

**File**: `src/modules/tx-tracker/pollers/__tests__/evmPoller.spec.ts`

**Test Cases**:
1. **Nonce-based query success**
   - Mock RPC client to return MessageReceived event
   - Verify nonce topic construction
   - Verify event parsing
   - Verify recipient/amount matching

2. **Nonce-based query with multiple events**
   - Test filtering by recipient
   - Test amount verification

3. **Fallback to Transfer scanning**
   - Test when nonce not provided
   - Verify current behavior maintained

4. **Error handling**
   - RPC errors
   - Invalid event data
   - Nonce mismatch

5. **Edge cases**
   - Nonce = 0
   - Very large nonce
   - Invalid recipient format

#### Integration Tests

**File**: `src/modules/tx-tracker/pollers/__tests__/evmPoller.integration.spec.ts`

**Test Cases**:
1. **End-to-end payment flow**
   - Mock Noble polling to return nonce
   - Verify EVM poller receives nonce
   - Verify nonce-based query executes
   - Verify mint confirmation

2. **Backward compatibility**
   - Test without nonce (should use Transfer scanning)
   - Verify existing flows still work

#### Manual Testing

**Test Scenarios**:
1. **Payment flow with nonce**
   - Initiate payment flow
   - Verify Noble polling extracts nonce
   - Verify EVM polling uses nonce
   - Verify faster confirmation time

2. **Payment flow without nonce (fallback)**
   - Test with missing nonce
   - Verify fallback to Transfer scanning works

3. **Deposit flow (should not use nonce)**
   - Verify deposit flows unaffected
   - EVM is source chain, not destination

### Step 9: Documentation Updates

**Files to Update**:
1. **Code Comments**: Add JSDoc comments to new functions
2. **README**: Update if there's a polling strategy section
3. **CHANGELOG**: Document optimization

### Step 10: Performance Monitoring

**Metrics to Track**:
1. **Polling Duration**: Time from start to confirmation
2. **RPC Calls**: Number of `getLogs` calls
3. **Blocks Scanned**: Number of blocks queried
4. **Success Rate**: Percentage of successful confirmations

**Comparison**:
- Before: Average polling time, RPC calls, blocks scanned
- After: Average polling time, RPC calls, blocks scanned
- Expected improvement: 10-100x reduction in RPC calls and time

## Implementation Checklist

- [ ] Step 1: Update `EvmPollParams` interface
- [ ] Step 2: Implement `queryMessageReceivedByNonce` function
- [ ] Step 3: Implement `parseMessageReceivedEvent` function
- [ ] Step 4: Update `pollUsdcMint` with nonce-based logic
- [ ] Step 5: Extract and pass nonce from Noble polling
- [ ] Step 6: Verify chain registry has messageTransmitter
- [ ] Step 7: Add helper functions
- [ ] Step 8: Write unit tests
- [ ] Step 8b: Write integration tests
- [ ] Step 8c: Manual testing
- [ ] Step 9: Update documentation
- [ ] Step 10: Monitor performance metrics

## Technical Details

### MessageReceived Event Structure

**Solidity Event**:
```solidity
event MessageReceived(
    address indexed caller,
    uint32 sourceDomain,
    uint64 indexed nonce,
    bytes32 sender,
    bytes messageBody
);
```

**Event Topics**:
- `topics[0]`: `keccak256("MessageReceived(address,uint32,uint64,bytes32,bytes)")` = `0x58200b4c34ae05ee816d710053fff3fb75af4395915d3d2a771b24aa10e3cc5d`
- `topics[1]`: `caller` (address, 32 bytes padded)
- `topics[2]`: `nonce` (uint64, 32 bytes padded)
- `data`: ABI-encoded `(uint32 sourceDomain, bytes32 sender, bytes messageBody)`

**Data Field Decoding**:
- Offset 0-31: `sourceDomain` (uint32, but padded to 32 bytes)
- Offset 32-63: `sender` (bytes32)
- Offset 64-95: `messageBody` offset (uint256, should be 0x80 = 128)
- Offset 96-127: `messageBody` length (uint256)
- Offset 128+: `messageBody` bytes (contains BurnMessage)

### BurnMessage Structure (in messageBody)

**Structure** (from `messageParser.ts`):
- Offset 0-3: `version` (uint32)
- Offset 4-35: `burnToken` (address, 32 bytes padded)
- Offset 36-67: `mintRecipient` (bytes32)
- Offset 68-99: `amount` (uint256)
- Offset 100-131: `messageSender` (address, 32 bytes padded)

**Total Length**: 132 bytes minimum

### Nonce Topic Format

**Example**: Nonce = 704111
- Convert to hex: `0xABE2F`
- Pad to 64 characters: `0x00000000000000000000000000000000000000000000000000000000000abe2f`
- This becomes `topics[2]`

### Source Domain Values

- **Noble**: 4
- **Base**: 6
- **Ethereum**: 0
- **Avalanche**: 1
- **Polygon**: 5

## Error Handling

### Scenarios to Handle

1. **Nonce not found**
   - Continue polling (event may not be indexed yet)
   - Log warning after N attempts

2. **Invalid event data**
   - Log error with event details
   - Continue polling (may be different event)

3. **Recipient mismatch**
   - Log warning
   - Continue polling (may be different nonce usage)

4. **Amount mismatch**
   - Log warning
   - Continue polling (may be different transaction)

5. **RPC errors**
   - Retry with exponential backoff
   - Fall back to Transfer scanning if persistent

## Rollout Strategy

### Phase 1: Implementation
- Implement all code changes
- Write comprehensive tests
- Code review

### Phase 2: Testing
- Run unit tests
- Run integration tests
- Manual testing on testnet

### Phase 3: Gradual Rollout
- Deploy to testnet
- Monitor metrics
- Compare performance vs. old approach

### Phase 4: Production
- Deploy to production
- Monitor for issues
- Keep fallback as safety net

## Backward Compatibility

### Requirements
- **Must maintain**: Current Transfer-based scanning as fallback
- **Must support**: Flows without nonce (e.g., direct EVM mints)
- **Must not break**: Existing deposit flows

### Implementation
- Check for nonce availability before using nonce-based approach
- Fall back to Transfer scanning if nonce unavailable
- Log which approach is being used for debugging

## Success Criteria

1. **Performance**: 
   - Polling time reduced from minutes to seconds
   - RPC calls reduced by 90%+

2. **Reliability**:
   - Same or better success rate
   - No increase in false positives/negatives

3. **Compatibility**:
   - All existing flows continue to work
   - Fallback works when nonce unavailable

4. **Code Quality**:
   - All tests pass
   - Code review approved
   - Documentation updated

## References

### Related Files
- `src/modules/tx-tracker/pollers/evmPoller.ts` - Main implementation
- `src/modules/tx-tracker/pollers/noblePoller.ts` - Similar nonce-based approach (reference)
- `src/modules/tx-tracker/trackerManager.ts` - Flow orchestration
- `src/modules/iris-attestation/messageParser.ts` - Message parsing utilities
- `src/config/chainRegistry.ts` - Chain configuration

### External References
- [CCTP Documentation](https://developers.circle.com/stablecoin/docs/cctp-technical-reference)
- [Ethereum Event Logs](https://ethereum.org/en/developers/docs/blocks/block-architecture/)
- [ABI Encoding](https://docs.soliditylang.org/en/latest/abi-spec.html)

## Notes

- The nonce-based approach is similar to the Noble polling optimization already implemented
- This change only affects payment flows (EVM as destination), not deposit flows (EVM as source)
- The MessageTransmitter contract address is already in chain config, no additional setup needed
- Source domain can be hardcoded (Noble = 4) or extracted from chain config if available

