import { Prisma, PrismaClient } from '@prisma/client';

import type { RegisterAddressInput, TrackedAddress } from './types.js';

export interface AddressTrackerRepository {
  upsert(input: RegisterAddressInput): Promise<TrackedAddress>;
  list(): Promise<TrackedAddress[]>;
  markSynced(id: string, date: Date): Promise<void>;
  findByAddress(address: string): Promise<TrackedAddress | null>;
}

type TrackedAddressModel = Prisma.TrackedAddressGetPayload<Record<string, unknown>>;

export function createAddressTrackerRepository(prisma: PrismaClient): AddressTrackerRepository {
  return {
    async upsert(input) {
      const entity = await prisma.trackedAddress.upsert({
        where: { address: input.address },
        update: buildUpdateData(input),
        create: buildCreateData(input)
      });

      return mapTrackedAddress(entity);
    },

    async list() {
      const items = await prisma.trackedAddress.findMany({
        orderBy: { createdAt: 'asc' }
      });
      return items.map(mapTrackedAddress);
    },

    async markSynced(id, date) {
      await prisma.trackedAddress.update({
        where: { id },
        data: { lastSyncedAt: date }
      });
    },

    async findByAddress(address) {
      const entity = await prisma.trackedAddress.findUnique({ where: { address } });
      return entity ? mapTrackedAddress(entity) : null;
    }
  };
}

function buildCreateData(input: RegisterAddressInput): Prisma.TrackedAddressCreateInput {
  return {
    address: input.address,
    chain: input.chain,
    labels: input.labels ?? [],
    metadata: toJsonInputValue(input.metadata)
  };
}

function buildUpdateData(input: RegisterAddressInput): Prisma.TrackedAddressUpdateInput {
  const data: Prisma.TrackedAddressUpdateInput = {};

  if (input.chain) {
    data.chain = input.chain;
  }

  if (input.labels !== undefined) {
    data.labels = input.labels;
  }

  if (input.metadata !== undefined) {
    data.metadata = jsonUpdateValue(input.metadata);
  }

  return data;
}

function mapTrackedAddress(entity: TrackedAddressModel): TrackedAddress {
  return {
    id: entity.id,
    address: entity.address,
    chain: entity.chain,
    labels: entity.labels,
    metadata: (entity.metadata as Record<string, unknown> | null) ?? null,
    lastSyncedAt: entity.lastSyncedAt,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt
  };
}

function toJsonInputValue(
  value: Record<string, unknown> | null | undefined
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
  value: Record<string, unknown> | null
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value
    ? (value as unknown as Prisma.InputJsonValue)
    : Prisma.JsonNull;
}

