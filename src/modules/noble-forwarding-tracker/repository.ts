import { Prisma, PrismaClient } from '@prisma/client';

import type {
  NobleForwardingRegistration,
  TrackRegistrationInput
} from './types.js';

export interface NobleForwardingRepository {
  upsert(input: TrackRegistrationInput): Promise<NobleForwardingRegistration>;
  findById(id: string): Promise<NobleForwardingRegistration | null>;
  findByNobleAddress(address: string): Promise<NobleForwardingRegistration | null>;
  findPending(): Promise<NobleForwardingRegistration[]>;
  updateStatus(
    id: string,
    status: 'pending' | 'registered' | 'failed' | 'stale',
    data?: {
      balanceUusdc?: bigint;
      lastCheckedAt?: Date;
      registeredAt?: Date;
      registrationTxHash?: string;
      errorMessage?: string | null;
    }
  ): Promise<NobleForwardingRegistration>;
  markStale(olderThan: Date): Promise<number>; // Returns count of marked records
  delete(id: string): Promise<void>;
}

type NobleForwardingRegistrationModel = Prisma.NobleForwardingRegistrationGetPayload<
  Record<string, unknown>
>;

export function createNobleForwardingRepository(
  prisma: PrismaClient
): NobleForwardingRepository {
  return {
    async upsert(input) {
      const entity = await prisma.nobleForwardingRegistration.upsert({
        where: { nobleAddress: input.nobleAddress },
        update: {
          recipient: input.recipient,
          channel: input.channel ?? 'channel-136',
          fallback: input.fallback ?? '',
          status: 'pending' // Reset to pending if updating existing record
        },
        create: {
          nobleAddress: input.nobleAddress,
          recipient: input.recipient,
          channel: input.channel ?? 'channel-136',
          fallback: input.fallback ?? '',
          status: 'pending'
        }
      });

      return mapRegistration(entity);
    },

    async findById(id) {
      const entity = await prisma.nobleForwardingRegistration.findUnique({
        where: { id }
      });
      return entity ? mapRegistration(entity) : null;
    },

    async findByNobleAddress(address) {
      const entity = await prisma.nobleForwardingRegistration.findUnique({
        where: { nobleAddress: address }
      });
      return entity ? mapRegistration(entity) : null;
    },

    async findPending() {
      const items = await prisma.nobleForwardingRegistration.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' }
      });
      return items.map(mapRegistration);
    },

    async updateStatus(id, status, data = {}) {
      const updateData: Prisma.NobleForwardingRegistrationUpdateInput = {
        status,
        ...(data.balanceUusdc !== undefined && { balanceUusdc: data.balanceUusdc }),
        ...(data.lastCheckedAt !== undefined && { lastCheckedAt: data.lastCheckedAt }),
        ...(data.registeredAt !== undefined && { registeredAt: data.registeredAt }),
        ...(data.registrationTxHash !== undefined && {
          registrationTxHash: data.registrationTxHash
        }),
        ...(data.errorMessage !== undefined && { errorMessage: data.errorMessage })
      };

      const entity = await prisma.nobleForwardingRegistration.update({
        where: { id },
        data: updateData
      });

      return mapRegistration(entity);
    },

    async markStale(olderThan) {
      const result = await prisma.nobleForwardingRegistration.updateMany({
        where: {
          status: 'pending',
          createdAt: {
            lt: olderThan
          }
        },
        data: {
          status: 'stale'
        }
      });

      return result.count;
    },

    async delete(id) {
      await prisma.nobleForwardingRegistration.delete({
        where: { id }
      });
    }
  };
}

function mapRegistration(
  entity: NobleForwardingRegistrationModel
): NobleForwardingRegistration {
  return {
    id: entity.id,
    nobleAddress: entity.nobleAddress,
    recipient: entity.recipient,
    channel: entity.channel,
    fallback: entity.fallback,
    status: entity.status,
    balanceUusdc: entity.balanceUusdc,
    lastCheckedAt: entity.lastCheckedAt,
    registeredAt: entity.registeredAt,
    registrationTxHash: entity.registrationTxHash,
    errorMessage: entity.errorMessage,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt
  };
}

