import { PrismaClient } from '@prisma/client';

import type { AppConfig } from '../../config/env.js';

let prisma: PrismaClient | undefined;

export function getPrismaClient(config: AppConfig): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient({
      log: config.nodeEnv === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error']
    });
  }

  return prisma;
}

export async function disconnectPrisma(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}

