import { PrismaClient } from '@prisma/client';

import type { AppConfig } from '../../config/env.js';

let prisma: PrismaClient | undefined;

export function getPrismaClient(config: AppConfig): PrismaClient {
  if (!prisma) {
    // Ensure DATABASE_URL is set in process.env for Prisma
    // Prisma reads from process.env.DATABASE_URL at initialization
    // This is critical for Docker environments where env vars may not be set correctly
    if (config.databaseUrl) {
      process.env.DATABASE_URL = config.databaseUrl;
    }

    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is required but not set. Please set it in your environment or .env file.'
      );
    }

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

