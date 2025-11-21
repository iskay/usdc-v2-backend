/**
 * Types for Iris attestation polling and MessageSent event extraction
 */

export interface AttestationResponse {
  attestation: string; // Hex-encoded attestation (when complete)
  status: 'pending_confirmations' | 'complete';
}

export interface MessageSentData {
  irisLookupID: string; // Keccak256 hash of MessageSent bytes (hex string without 0x)
  nonce: number; // Message nonce (uint64)
  sourceDomain: number; // Source chain domain ID (uint32)
  destinationDomain: number; // Destination chain domain ID (uint32)
  messageBytes: Uint8Array; // Raw MessageSent event bytes
  messageBody: Uint8Array; // Message body bytes
  destinationCaller: Uint8Array; // Destination caller address (32 bytes)
}

export interface IrisPollingParams {
  txHash: string;
  chainId: string;
  flowId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  requestTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface IrisPollingResult {
  success: boolean;
  attestation?: string; // Hex-encoded attestation (when complete)
  irisLookupID?: string;
  nonce?: number;
  status?: 'pending_confirmations' | 'complete';
  error?: string;
}

export interface MessageSentExtractionResult {
  success: boolean;
  data?: MessageSentData;
  error?: string;
}

