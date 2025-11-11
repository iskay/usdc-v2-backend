# Frontend Data Contract and Sync Strategy

This document defines the recommended data model and synchronization strategy for the frontend to integrate with the USDC v2 Backend transaction tracking system.

## Table of Contents

- [Overview](#overview)
- [Data Model](#data-model)
- [Client-Side vs Backend Data](#client-side-vs-backend-data)
- [Flow Lifecycle](#flow-lifecycle)
- [API Integration](#api-integration)
- [Status Synchronization](#status-synchronization)
- [Shielded Transaction Privacy](#shielded-transaction-privacy)
- [Implementation Examples](#implementation-examples)

## Overview

The backend serves as the **single source of truth** for live transaction status across all chains. The frontend should:

1. **Persist minimal initiation metadata** locally (for offline access and shielded privacy)
2. **Sync with backend** for real-time status updates
3. **Map backend `flowId`** to per-chain transaction hashes
4. **Handle client-side stages** (gasless swaps, wallet interactions) that the backend cannot observe

## Data Model

### Minimal Frontend Data Model

```typescript
interface FlowInitiationMetadata {
  // Frontend-generated identifier (used before backend flowId is available)
  localId: string;
  
  // Backend flowId (set after initial backend call)
  flowId?: string;
  
  // Flow type
  flowType: 'deposit' | 'payment';
  
  // Initiating chain information
  initialChain: string;
  initialChainType: 'evm' | 'tendermint';
  
  // Transaction details
  amount: string; // Token amount in base units
  token: 'USDC'; // Token identifier
  
  // Shielded transaction metadata (client-side only due to privacy)
  shieldedMetadata?: {
    // Namada-specific shielded transaction data
    // This cannot be tracked on-chain due to privacy properties
    shieldedAddress?: string;
    transparentAddress?: string;
    viewingKey?: string; // For viewing shielded balances
    // ... other shielded-specific metadata
  };
  
  // Timestamp
  initiatedAt: number;
  
  // UI state
  status: 'initiating' | 'tracking' | 'completed' | 'failed';
}

interface FlowStatus {
  // Backend flowId (canonical identifier)
  flowId: string;
  
  // Overall status
  status: 'pending' | 'completed' | 'failed';
  
  // Per-chain progress (from backend)
  chainProgress: {
    evm?: ChainProgressEntry;
    noble?: ChainProgressEntry;
    namada?: ChainProgressEntry;
  };
  
  // Last updated timestamp
  lastUpdated: number;
}

interface ChainProgressEntry {
  status?: string;
  txHash?: string;
  stages?: ChainStage[];
  gaslessStages?: ChainStage[];
  metadata?: Record<string, unknown>;
}

interface ChainStage {
  stage: string;
  status?: 'pending' | 'confirmed' | 'failed';
  message?: string;
  txHash?: string;
  occurredAt?: string;
  source: 'client' | 'poller';
  metadata?: Record<string, unknown>;
}
```

### Storage Strategy

**LocalStorage Keys:**
- `usdc-v2-flows` - Array of `FlowInitiationMetadata` objects
- `usdc-v2-flow-status-cache` - Map of `flowId` → `FlowStatus` (for offline access)

**In-Memory State:**
- Active flow tracking (for real-time updates)
- WebSocket connections (if using WebSocket for status updates)

## Client-Side vs Backend Data

### Client-Side Only (Never Sent to Backend)

Due to Namada's shielded transaction privacy properties, certain metadata must remain client-side:

1. **Shielded Address Information**
   - Shielded payment addresses
   - Viewing keys
   - Shielded account relationships

2. **Pre-Transaction Metadata**
   - Wallet connection state
   - Transaction building steps
   - User preferences

3. **Gasless Transaction Details**
   - 0x API quote details
   - Swap transaction hashes (before relay)
   - Gasless transaction metadata

### Backend-Managed (Source of Truth)

The backend tracks and provides:

1. **Multi-Chain Flow Status**
   - Overall flow status (`pending`, `completed`, `failed`)
   - Per-chain progress and stages
   - Transaction hashes for each chain
   - Poller-detected status updates

2. **Chain-Specific Transaction Data**
   - EVM transaction hashes and receipts
   - Noble IBC transfer events
   - Namada IBC acknowledgement events

3. **Timing Information**
   - Last checked timestamps
   - Next check scheduled times
   - Stage occurrence timestamps

## Flow Lifecycle

### 1. Flow Initiation (Client-Side)

```typescript
// User initiates a deposit or payment
const localId = generateUUID();
const initiationMetadata: FlowInitiationMetadata = {
  localId,
  flowType: 'deposit',
  initialChain: 'sepolia-testnet',
  initialChainType: 'evm',
  amount: '1000000', // 1 USDC in base units
  token: 'USDC',
  shieldedMetadata: {
    // Namada shielded address (for deposits)
    shieldedAddress: 'namada1...',
  },
  initiatedAt: Date.now(),
  status: 'initiating',
};

// Save to localStorage
saveFlowInitiation(localId, initiationMetadata);
```

### 2. Initial Backend Registration

After the first transaction is submitted (e.g., EVM burn or Namada IBC send):

```typescript
// Submit flow to backend
const response = await fetch('/api/track/flow', {
  method: 'POST',
  body: JSON.stringify({
    flowType: 'deposit',
    initialChain: 'sepolia-testnet',
    chain: 'sepolia-testnet',
    chainType: 'evm',
    txHash: evmTxHash, // First transaction hash
    metadata: {
      // Include any non-sensitive metadata
      amount: '1000000',
      token: 'USDC',
    },
  }),
});

const { data } = await response.json();
const flowId = data.id; // Backend-generated flowId

// Update local metadata with flowId
updateFlowInitiation(localId, { flowId, status: 'tracking' });
```

### 3. Client-Side Stage Updates

For stages that occur client-side (gasless swaps, wallet interactions):

```typescript
// Report client-side stage to backend
await fetch(`/api/flow/${flowId}/stage`, {
  method: 'POST',
  body: JSON.stringify({
    chain: 'evm',
    stage: 'gasless_quote_pending',
    status: 'pending',
    source: 'client',
    occurredAt: new Date().toISOString(),
    kind: 'gasless',
  }),
});

// Continue with more stages
await fetch(`/api/flow/${flowId}/stage`, {
  method: 'POST',
  body: JSON.stringify({
    chain: 'evm',
    stage: 'gasless_swap_completed',
    status: 'confirmed',
    txHash: swapTxHash,
    source: 'client',
    occurredAt: new Date().toISOString(),
    kind: 'gasless',
  }),
});
```

### 4. Status Polling

Poll backend for status updates:

```typescript
// Poll flow status
const response = await fetch(`/api/flow/${flowId}/status`);
const { data } = await response.json();

// Update local cache
updateFlowStatus(flowId, {
  flowId: data.id,
  status: data.status,
  chainProgress: data.chainProgress,
  lastUpdated: Date.now(),
});
```

## API Integration

### Endpoints Reference

#### Start Flow Tracking

```typescript
POST /api/track/flow
Content-Type: application/json

{
  "flowType": "deposit" | "payment",
  "initialChain": "sepolia-testnet",
  "chain": "sepolia-testnet",
  "chainType": "evm",
  "txHash": "0x...", // Optional: first transaction hash
  "metadata": {
    "amount": "1000000",
    "token": "USDC"
  }
}

Response: {
  "data": {
    "id": "flow-uuid", // flowId
    "txHash": "0x...",
    "status": "pending",
    "chainProgress": { ... }
  }
}
```

#### Get Flow Status

```typescript
GET /api/flow/:id/status

Response: {
  "data": {
    "id": "flow-uuid",
    "status": "pending" | "completed" | "failed",
    "chainProgress": {
      "evm": { ... },
      "noble": { ... },
      "namada": { ... }
    }
  }
}
```

#### Append Client Stage

```typescript
POST /api/flow/:id/stage
Content-Type: application/json

{
  "chain": "evm" | "noble" | "namada",
  "stage": "gasless_quote_pending",
  "status": "pending" | "confirmed" | "failed",
  "message": "Optional message",
  "txHash": "0x...", // Optional
  "occurredAt": "2024-01-01T00:00:00Z",
  "metadata": { ... }, // Optional
  "kind": "gasless" | "default",
  "source": "client" | "poller"
}

Response: 204 No Content
```

#### Lookup Flow by Hash

```typescript
GET /api/flow/by-hash/:chain/:hash

Response: {
  "data": {
    "id": "flow-uuid",
    "flowType": "deposit",
    "status": "pending",
    "chainProgress": { ... }
  }
}
```

## Status Synchronization

### Polling Strategy

**Recommended:** Poll every 5-10 seconds for active flows, with exponential backoff for completed/failed flows.

```typescript
class FlowStatusPoller {
  private intervals = new Map<string, NodeJS.Timeout>();
  
  startPolling(flowId: string) {
    if (this.intervals.has(flowId)) return;
    
    let pollCount = 0;
    const poll = async () => {
      try {
        const status = await fetchFlowStatus(flowId);
        this.onStatusUpdate(flowId, status);
        
        // Stop polling if flow is complete
        if (status.status === 'completed' || status.status === 'failed') {
          this.stopPolling(flowId);
          return;
        }
        
        pollCount++;
        // Exponential backoff after 10 polls
        const delay = pollCount > 10 ? 30000 : 5000;
        this.intervals.set(flowId, setTimeout(poll, delay));
      } catch (error) {
        console.error('Polling error:', error);
        // Retry with backoff
        this.intervals.set(flowId, setTimeout(poll, 10000));
      }
    };
    
    poll();
  }
  
  stopPolling(flowId: string) {
    const interval = this.intervals.get(flowId);
    if (interval) {
      clearTimeout(interval);
      this.intervals.delete(flowId);
    }
  }
}
```

### WebSocket Integration (Optional)

If the backend supports WebSocket, use it for real-time updates:

```typescript
const ws = new WebSocket('ws://backend:3000/ws');

ws.on('message', (data) => {
  const update: TxStatusUpdate = JSON.parse(data);
  if (update.flowId === currentFlowId) {
    handleStatusUpdate(update);
  }
});

// Subscribe to flow updates
ws.send(JSON.stringify({
  type: 'subscribe',
  flowId: currentFlowId,
}));
```

## Shielded Transaction Privacy

### Why Some Data Stays Client-Side

Namada's shielded transactions provide privacy by:
- Hiding transaction amounts and recipients on-chain
- Using zero-knowledge proofs
- Not exposing shielded address relationships

**Implications:**
- The backend **cannot** track shielded transaction details on-chain
- The frontend must track shielded metadata locally
- Shielded transaction hashes may not be resolvable via backend lookup

### Recommended Approach

1. **Store shielded metadata locally** in `FlowInitiationMetadata.shieldedMetadata`
2. **Report observable events** to backend (IBC acknowledgements, transparent transactions)
3. **Use backend for cross-chain status** (EVM → Noble → Namada flow)
4. **Combine client and backend data** for complete UI state

### Example: Deposit Flow with Shielded Transaction

```typescript
// 1. User initiates deposit
const initiation: FlowInitiationMetadata = {
  localId: 'local-123',
  flowType: 'deposit',
  initialChain: 'sepolia-testnet',
  amount: '1000000',
  shieldedMetadata: {
    shieldedAddress: 'namada1shielded...',
    transparentAddress: 'namada1transparent...',
  },
};

// 2. EVM burn happens (observable by backend)
const flowId = await startFlowTracking({
  flowType: 'deposit',
  initialChain: 'sepolia-testnet',
  txHash: evmBurnHash,
});

// 3. Backend tracks: EVM → Noble → Namada (IBC acknowledgement)
// 4. Frontend tracks: Shielded transaction details (client-side only)

// 5. Combine for UI
const uiState = {
  ...backendStatus, // EVM, Noble, Namada IBC status
  shieldedDetails: initiation.shieldedMetadata, // Client-side only
};
```

## Implementation Examples

### Complete Flow Tracking Hook

```typescript
import { useState, useEffect, useCallback } from 'react';

interface UseFlowTrackingOptions {
  flowId: string;
  onStatusUpdate?: (status: FlowStatus) => void;
}

export function useFlowTracking({ flowId, onStatusUpdate }: UseFlowTrackingOptions) {
  const [status, setStatus] = useState<FlowStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  
  const fetchStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/flow/${flowId}/status`);
      if (!response.ok) throw new Error('Failed to fetch status');
      
      const { data } = await response.json();
      const newStatus: FlowStatus = {
        flowId: data.id,
        status: data.status,
        chainProgress: data.chainProgress,
        lastUpdated: Date.now(),
      };
      
      setStatus(newStatus);
      onStatusUpdate?.(newStatus);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [flowId, onStatusUpdate]);
  
  useEffect(() => {
    if (!flowId) return;
    
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    
    return () => clearInterval(interval);
  }, [flowId, fetchStatus]);
  
  const reportClientStage = useCallback(async (
    chain: 'evm' | 'noble' | 'namada',
    stage: string,
    details: Partial<ChainStage>
  ) => {
    await fetch(`/api/flow/${flowId}/stage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain,
        stage,
        source: 'client',
        ...details,
      }),
    });
    
    // Refresh status after reporting
    fetchStatus();
  }, [flowId, fetchStatus]);
  
  return {
    status,
    loading,
    error,
    refresh: fetchStatus,
    reportClientStage,
  };
}
```

### Flow Initiation Service

```typescript
class FlowInitiationService {
  private storageKey = 'usdc-v2-flows';
  
  async initiateFlow(
    flowType: 'deposit' | 'payment',
    initialChain: string,
    amount: string,
    shieldedMetadata?: FlowInitiationMetadata['shieldedMetadata']
  ): Promise<{ localId: string; flowId?: string }> {
    const localId = generateUUID();
    const initiation: FlowInitiationMetadata = {
      localId,
      flowType,
      initialChain,
      initialChainType: getChainType(initialChain),
      amount,
      token: 'USDC',
      shieldedMetadata,
      initiatedAt: Date.now(),
      status: 'initiating',
    };
    
    // Save locally
    this.saveInitiation(localId, initiation);
    
    return { localId };
  }
  
  async registerWithBackend(
    localId: string,
    firstTxHash: string,
    metadata?: Record<string, unknown>
  ): Promise<string> {
    const initiation = this.getInitiation(localId);
    if (!initiation) throw new Error('Initiation not found');
    
    const response = await fetch('/api/track/flow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        flowType: initiation.flowType,
        initialChain: initiation.initialChain,
        chain: initiation.initialChain,
        chainType: initiation.initialChainType,
        txHash: firstTxHash,
        metadata: {
          amount: initiation.amount,
          token: initiation.token,
          ...metadata,
        },
      }),
    });
    
    const { data } = await response.json();
    const flowId = data.id;
    
    // Update with flowId
    this.updateInitiation(localId, {
      flowId,
      status: 'tracking',
    });
    
    return flowId;
  }
  
  private saveInitiation(localId: string, initiation: FlowInitiationMetadata) {
    const flows = this.getAllInitiations();
    flows[localId] = initiation;
    localStorage.setItem(this.storageKey, JSON.stringify(flows));
  }
  
  private getInitiation(localId: string): FlowInitiationMetadata | null {
    const flows = this.getAllInitiations();
    return flows[localId] || null;
  }
  
  private updateInitiation(localId: string, updates: Partial<FlowInitiationMetadata>) {
    const initiation = this.getInitiation(localId);
    if (!initiation) return;
    
    this.saveInitiation(localId, { ...initiation, ...updates });
  }
  
  private getAllInitiations(): Record<string, FlowInitiationMetadata> {
    const stored = localStorage.getItem(this.storageKey);
    return stored ? JSON.parse(stored) : {};
  }
}
```

### Mapping Backend Status to UI Stages

```typescript
function mapBackendStatusToUIStages(
  chainProgress: ChainProgress,
  flowType: 'deposit' | 'payment'
): UIStage[] {
  const stages: UIStage[] = [];
  const chainOrder = flowType === 'deposit'
    ? ['evm', 'noble', 'namada'] as const
    : ['namada', 'noble', 'evm'] as const;
  
  for (const chain of chainOrder) {
    const progress = chainProgress[chain];
    if (!progress) continue;
    
    // Add regular stages
    if (progress.stages) {
      for (const stage of progress.stages) {
        stages.push({
          chain,
          stage: stage.stage,
          status: stage.status || 'pending',
          txHash: stage.txHash,
          occurredAt: stage.occurredAt,
          source: stage.source,
        });
      }
    }
    
    // Add gasless stages (if any)
    if (progress.gaslessStages) {
      for (const stage of progress.gaslessStages) {
        stages.push({
          chain,
          stage: stage.stage,
          status: stage.status || 'pending',
          txHash: stage.txHash,
          occurredAt: stage.occurredAt,
          source: stage.source,
          kind: 'gasless',
        });
      }
    }
  }
  
  return stages;
}
```

## Best Practices

1. **Always use backend `flowId` as canonical identifier** after initial registration
2. **Store minimal metadata locally** - only what's needed for offline access and privacy
3. **Poll actively for pending flows**, back off for completed/failed flows
4. **Report client-side stages promptly** to keep backend in sync
5. **Handle network errors gracefully** - cache status locally, retry with backoff
6. **Combine client and backend data** for complete UI state
7. **Respect shielded transaction privacy** - never send sensitive shielded metadata to backend

## Migration from Current Frontend

If migrating from the current frontend implementation:

1. **Map existing `TrackedTransaction` to `FlowInitiationMetadata`**
2. **Register existing flows with backend** using `/api/track/flow`
3. **Update UI components** to use new `FlowStatus` structure
4. **Implement status polling** to replace stubbed `pollTxStatus`
5. **Add client stage reporting** for gasless transactions

## Summary

- **Backend is source of truth** for multi-chain transaction status
- **Frontend stores minimal initiation metadata** locally (for privacy and offline access)
- **Map `flowId` to per-chain hashes** using `chainProgress` structure
- **Report client-side stages** (gasless, wallet interactions) to backend
- **Respect shielded transaction privacy** - keep sensitive metadata client-side only
- **Poll actively** for pending flows, use exponential backoff for completed flows

