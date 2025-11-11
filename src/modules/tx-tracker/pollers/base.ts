import type { AppLogger } from '../../../common/utils/logger.js';

export interface PollParams {
  flowId: string;
  chain: string;
  timeoutMs?: number;
  intervalMs?: number;
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
  flowId: string
): { controller: AbortController; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    logger.warn({ flowId, timeoutMs }, 'Polling timeout reached');
    controller.abort();
  }, timeoutMs);

  return {
    controller,
    cleanup: () => {
      clearTimeout(timeout);
    },
  };
}

