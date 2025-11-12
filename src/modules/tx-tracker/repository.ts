import { randomUUID } from 'crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import type {
  ChainProgress,
  MultiChainTrackInput,
  StatusSource,
  TrackTransactionInput,
  TrackedTransaction
} from './types.js';

export interface AddStatusLogInput {
  transactionId: string;
  status: string;
  chain?: string;
  source?: StatusSource;
  detail?: Record<string, unknown>;
}

export interface UpdateChainProgressInput {
  chainProgress: ChainProgress;
  status?: string;
  metadata?: Record<string, unknown> | null;
  errorState?: Record<string, unknown> | null;
  nextCheckAfter?: Date | null;
}

export interface StatusLogEntry {
  id: string;
  transactionId: string;
  status: string;
  chain: string | null;
  source: string | null;
  detail: Record<string, unknown> | null;
  createdAt: Date;
}

export interface TxTrackerRepository {
  create(input: TrackTransactionInput): Promise<TrackedTransaction>;
  createMultiChainFlow(input: MultiChainTrackInput): Promise<TrackedTransaction>;
  findById(id: string): Promise<TrackedTransaction | null>;
  findByHash(txHash: string): Promise<TrackedTransaction | null>;
  findUnfinishedFlows(): Promise<TrackedTransaction[]>;
  update(id: string, changes: Partial<TrackedTransaction>): Promise<TrackedTransaction>;
  updateChainProgress(id: string, changes: UpdateChainProgressInput): Promise<TrackedTransaction>;
  addStatusLog(entry: AddStatusLogInput): Promise<void>;
  getStatusLogs(transactionId: string): Promise<StatusLogEntry[]>;
}

type TrackedTransactionModel = Prisma.TrackedTransactionGetPayload<Record<string, unknown>>;

const DEFAULT_STATUS = 'pending';
const FINISHED_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export function createTxTrackerRepository(prisma: PrismaClient): TxTrackerRepository {
  return {
    async create(input) {
      const entity = await prisma.trackedTransaction.create({
        data: buildCreateData(input)
      });

      return mapTrackedTransaction(entity);
    },

    async createMultiChainFlow(input) {
      const entity = await prisma.trackedTransaction.create({
        data: buildMultiChainCreateData(input)
      });

      return mapTrackedTransaction(entity);
    },

    async findById(id) {
      const entity = await prisma.trackedTransaction.findUnique({
        where: { id }
      });

      return entity ? mapTrackedTransaction(entity) : null;
    },

    async findByHash(txHash) {
      const entity = await prisma.trackedTransaction.findUnique({
        where: { txHash }
      });

      return entity ? mapTrackedTransaction(entity) : null;
    },

    async findUnfinishedFlows() {
      const entities = await prisma.trackedTransaction.findMany({
        where: {
          flowType: { not: null },
          NOT: {
            status: { in: Array.from(FINISHED_STATUSES) }
          }
        }
      });

      return entities.map(mapTrackedTransaction);
    },

    async update(id, changes) {
      const data = buildUpdateData(changes);
      const entity = await prisma.trackedTransaction.update({
        where: { id },
        data
      });

      return mapTrackedTransaction(entity);
    },

    async updateChainProgress(id, changes) {
      const data: Prisma.TrackedTransactionUpdateInput = {
        chainProgress: toJsonInputValue(changes.chainProgress),
        metadata: changes.metadata !== undefined ? toJsonInputValue(changes.metadata) : undefined,
        errorState: changes.errorState !== undefined ? toJsonInputValue(changes.errorState) : undefined
      };

      if (typeof changes.status === 'string') {
        data.status = changes.status;
      }

      if (changes.nextCheckAfter !== undefined) {
        data.nextCheckAfter = changes.nextCheckAfter;
      }

      const entity = await prisma.trackedTransaction.update({
        where: { id },
        data
      });

      return mapTrackedTransaction(entity);
    },

    async addStatusLog(entry) {
      await prisma.transactionStatusLog.create({
        data: {
          transactionId: entry.transactionId,
          status: entry.status,
          chain: entry.chain,
          source: entry.source ?? 'poller',
          detail: toJsonInputValue(entry.detail)
        }
      });
    },

    async getStatusLogs(transactionId) {
      const entities = await prisma.transactionStatusLog.findMany({
        where: { transactionId },
        orderBy: { createdAt: 'asc' }
      });

      return entities.map((entity) => ({
        id: entity.id,
        transactionId: entity.transactionId,
        status: entity.status,
        chain: entity.chain,
        source: entity.source,
        detail: (entity.detail as Record<string, unknown> | null) ?? null,
        createdAt: entity.createdAt
      }));
    }
  };
}

function buildCreateData(input: TrackTransactionInput): Prisma.TrackedTransactionCreateInput {
  return {
    txHash: input.txHash,
    chain: input.chain,
    chainType: input.chainType,
    flowType: input.flowType ?? undefined,
    initialChain: input.initialChain ?? null,
    status: input.status ?? DEFAULT_STATUS,
    chainProgress: toJsonInputValue(input.chainProgress),
    metadata: toJsonInputValue(input.metadata),
    lastCheckedAt: input.lastCheckedAt ?? null,
    nextCheckAfter: input.nextCheckAfter ?? null,
    errorState: toJsonInputValue(input.errorState),
    address: input.addressId
      ? {
          connect: { id: input.addressId }
        }
      : undefined
  };
}

function buildMultiChainCreateData(input: MultiChainTrackInput): Prisma.TrackedTransactionCreateInput {
  return {
    txHash: input.txHash,
    chain: input.initialChain, // Keep chain field for backward compatibility (set to initialChain)
    chainType: input.chainType,
    flowType: input.flowType,
    initialChain: input.initialChain,
    destinationChain: input.destinationChain,
    status: input.status ?? DEFAULT_STATUS,
    chainProgress: toJsonInputValue(input.chainProgress),
    metadata: toJsonInputValue(input.metadata),
    errorState: toJsonInputValue(input.errorState)
  };
}

function buildUpdateData(changes: Partial<TrackedTransaction>): Prisma.TrackedTransactionUpdateInput {
  const data: Prisma.TrackedTransactionUpdateInput = {};

  if (typeof changes.status === 'string') {
    data.status = changes.status;
  }

  if (changes.metadata !== undefined) {
    data.metadata = jsonUpdateValue(changes.metadata);
  }

  if (changes.lastCheckedAt !== undefined) {
    data.lastCheckedAt = changes.lastCheckedAt;
  }

  if (changes.nextCheckAfter !== undefined) {
    data.nextCheckAfter = changes.nextCheckAfter;
  }

  if (changes.errorState !== undefined) {
    data.errorState = jsonUpdateValue(changes.errorState);
  }

  if (changes.addressId !== undefined) {
    data.address = changes.addressId
      ? { connect: { id: changes.addressId } }
      : { disconnect: true };
  }

  if (changes.chainProgress !== undefined) {
    data.chainProgress = toJsonInputValue(changes.chainProgress);
  }

  if (changes.flowType !== undefined) {
    data.flowType = changes.flowType ?? null;
  }

  if (changes.initialChain !== undefined) {
    data.initialChain = changes.initialChain ?? null;
  }

  return data;
}

function mapTrackedTransaction(entity: TrackedTransactionModel): TrackedTransaction {
  return {
    id: entity.id,
    txHash: entity.txHash,
    chain: entity.chain,
    chainType: entity.chainType,
    flowType: (entity.flowType as TrackedTransaction['flowType']) ?? null,
    initialChain: entity.initialChain ?? null,
    destinationChain: entity.destinationChain ?? null,
    status: entity.status,
    chainProgress: (entity.chainProgress as ChainProgress | null) ?? null,
    metadata: (entity.metadata as Record<string, unknown> | null) ?? null,
    lastCheckedAt: entity.lastCheckedAt,
    nextCheckAfter: entity.nextCheckAfter,
    errorState: (entity.errorState as Record<string, unknown> | null) ?? null,
    addressId: entity.addressId ?? null,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt
  };
}

function toJsonInputValue(
  value: unknown
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return Prisma.JsonNull;
  }

  return value as unknown as Prisma.InputJsonValue;
}

function jsonUpdateValue(
  value: unknown
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value
    ? (value as unknown as Prisma.InputJsonValue)
    : Prisma.JsonNull;
}

