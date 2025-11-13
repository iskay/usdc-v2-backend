import type { AppLogger } from '../../../common/utils/logger.js';

export interface PollParams {
  flowId: string;
  chain: string;
  timeoutMs?: number;
  intervalMs?: number;
  blockRequestDelayMs?: number; // Delay between consecutive block_results requests (milliseconds)
  abortSignal?: AbortSignal;
}

export interface PollResult {
  success: boolean;
  found: boolean;
  txHash?: string;
  blockNumber?: number | bigint;
  height?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface PollingService {
  poll(params: PollParams): Promise<PollResult>;
}

export interface PollUpdate {
  height?: number;
  blockNumber?: number | bigint;
  scannedFrom?: number | bigint;
  scannedTo?: number | bigint;
  [key: string]: unknown;
}

export type PollUpdateCallback = (update: PollUpdate) => void;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function indexAttributes(
  attrs?: Array<{ key: string; value: string; index?: boolean }>
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attr of attrs || []) {
    if (!attr?.key) continue;
    map[attr.key] = attr.value;
  }
  return map;
}

export function parseMaybeJsonOrBase64Json(value?: string): unknown {
  if (!value) return undefined;
  // Try direct JSON first
  try {
    return JSON.parse(value);
  } catch {
    // Try base64-decoded JSON
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    } catch {
      return undefined;
    }
  }
}

export function stripQuotes(s?: string): string | undefined {
  if (typeof s !== 'string') return s;
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

export function createPollTimeout(
  timeoutMs: number,
  logger: AppLogger,
  flowId: string,
  externalAbortSignal?: AbortSignal
): { controller: AbortController; cleanup: () => void; wasTimeout: () => boolean } {
  const controller = new AbortController();
  let timeoutOccurred = false;
  
  const timeout = setTimeout(() => {
    timeoutOccurred = true;
    logger.warn({ flowId, timeoutMs }, 'Polling timeout reached');
    controller.abort();
    // Also abort external signal if provided (so trackerManager can detect timeout)
    if (externalAbortSignal && !externalAbortSignal.aborted) {
      // Create a new AbortController to abort the external signal
      // Note: AbortSignal is read-only, so we can't abort it directly
      // Instead, the poller should check wasTimeout() and abort the external signal
    }
  }, timeoutMs);

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeout);
    },
    wasTimeout: () => timeoutOccurred,
  };
}

/**
 * Retry a function with exponential backoff
 * @param fn Function to retry
 * @param maxRetries Maximum number of retry attempts
 * @param initialDelayMs Initial delay before first retry (milliseconds)
 * @param maxDelayMs Maximum delay between retries (milliseconds)
 * @returns Result of the function call
 * @throws Error if all retries are exhausted
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelayMs: number = 500,
  maxDelayMs: number = 5000
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = Math.min(initialDelayMs * Math.pow(2, attempt), maxDelayMs);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Check if an error is a transient error that should be retried
 * @param error Error to check
 * @returns true if error is transient (429, 500, network errors)
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;
  
  // Check for axios error structure
  const axiosError = error as { response?: { status?: number }; code?: string };
  
  // Network errors (ECONNREFUSED, ETIMEDOUT, etc.)
  if (axiosError.code && axiosError.code !== 'ECONNABORTED') {
    return true;
  }
  
  // HTTP status codes
  const status = axiosError.response?.status;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  
  return false;
}

/**
 * Check if an error is a permanent error (should not retry)
 * @param error Error to check
 * @returns true if error is permanent (404, 400, 403)
 */
export function isPermanentError(error: unknown): boolean {
  if (!error) return false;
  
  const axiosError = error as { response?: { status?: number } };
  const status = axiosError.response?.status;
  
  // 404 = block doesn't exist (permanent)
  // 400 = bad request (permanent)
  // 403 = forbidden (permanent)
  if (status === 404 || status === 400 || status === 403) {
    return true;
  }
  
  return false;
}

