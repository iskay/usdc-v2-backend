export interface RegisterAddressInput {
  address: string;
  chain: string;
  labels?: string[];
  metadata?: Record<string, unknown>;
}

export interface TrackedAddress {
  id: string;
  address: string;
  chain: string;
  labels: string[];
  metadata: Record<string, unknown> | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

