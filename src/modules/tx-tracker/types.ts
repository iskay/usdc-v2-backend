export type FlowType = 'deposit' | 'payment';

export type StatusSource = 'client' | 'poller';

export interface ChainStage {
  stage: string;
  status?: 'pending' | 'confirmed' | 'failed';
  message?: string;
  txHash?: string;
  occurredAt?: Date | string;
  source: StatusSource;
  metadata?: Record<string, unknown>;
}

export interface ChainProgressEntry {
  status?: string;
  txHash?: string;
  startBlock?: number | null;
  lastCheckedAt?: Date | null;
  nextCheckAfter?: Date | null;
  stages?: ChainStage[];
  gaslessStages?: ChainStage[];
  metadata?: Record<string, unknown>;
}

export interface ChainProgress {
  evm?: ChainProgressEntry;
  noble?: ChainProgressEntry;
  namada?: ChainProgressEntry;
}

export interface TrackTransactionInput {
  txHash: string;
  chain: string;
  chainType: string;
  status?: string;
  metadata?: Record<string, unknown>;
  addressId?: string | null;
  lastCheckedAt?: Date | null;
  nextCheckAfter?: Date | null;
  errorState?: Record<string, unknown> | null;
  flowType?: FlowType | null;
  initialChain?: string | null;
  chainProgress?: ChainProgress | null;
}

export interface MultiChainTrackInput {
  flowType: FlowType;
  initialChain: string;
  chain: string;
  chainType: string;
  chainProgress?: ChainProgress;
  metadata?: Record<string, unknown>;
  status?: string;
  errorState?: Record<string, unknown> | null;
  txHash?: string | null;
}

export interface TrackedTransaction {
  id: string;
  txHash: string;
  chain: string;
  chainType: string;
  flowType: FlowType | null;
  initialChain: string | null;
  status: string;
  chainProgress: ChainProgress | null;
  metadata: Record<string, unknown> | null;
  lastCheckedAt: Date | null;
  nextCheckAfter: Date | null;
  errorState: Record<string, unknown> | null;
  addressId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TxStatusUpdate {
  flowId: string;
  chain: 'evm' | 'noble' | 'namada';
  stage: string;
  status: 'pending' | 'confirmed' | 'failed';
  message?: string;
  txHash?: string;
  occurredAt: Date;
  source: StatusSource;
  metadata?: Record<string, unknown>;
}

