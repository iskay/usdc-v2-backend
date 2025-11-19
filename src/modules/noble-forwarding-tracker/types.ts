import type { NobleForwardingStatus } from '@prisma/client';

export interface TrackRegistrationInput {
  nobleAddress: string;
  recipient: string;
  channel?: string;
  fallback?: string;
}

export interface NobleForwardingRegistration {
  id: string;
  nobleAddress: string;
  recipient: string;
  channel: string;
  fallback: string | null;
  status: NobleForwardingStatus;
  balanceUusdc: bigint | null;
  lastCheckedAt: Date | null;
  registeredAt: Date | null;
  registrationTxHash: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RegistrationStatus = NobleForwardingStatus;

export interface NobleForwardingAddressResponse {
  exists: boolean;
  address?: string;
}

export interface NobleBalanceResponse {
  balances: Array<{
    denom: string;
    amount: string;
  }>;
}

export interface NobleBroadcastResponse {
  tx_response: {
    code: number;
    txhash: string;
    raw_log: string;
  };
}

export interface RegistrationResult {
  success: boolean;
  txHash?: string;
  error?: string;
}

