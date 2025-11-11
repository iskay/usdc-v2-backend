import { Queue, QueueOptions, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config/env.js';
import type { AppLogger } from '../common/utils/logger.js';

export interface QueueManager {
  txPollingQueue: Queue;
  evmPollingQueue: Queue;
  noblePollingQueue: Queue;
  namadaPollingQueue: Queue;
  workers: Worker[];
  connection: Redis;
  close(): Promise<void>;
}

const QUEUE_NAMES = {
  TX_POLLING: 'tx-polling',
  EVM_POLLING: 'evm-polling',
  NOBLE_POLLING: 'noble-polling',
  NAMADA_POLLING: 'namada-polling',
} as const;

export function createQueueManager(
  config: AppConfig,
  logger: AppLogger
): QueueManager {
  if (!config.redisUrl) {
    throw new Error('REDIS_URL is required for BullMQ queues');
  }

  const connection = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const queueOptions: QueueOptions = {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: {
        age: 24 * 3600, // Keep completed jobs for 24 hours
        count: 1000,
      },
      removeOnFail: {
        age: 7 * 24 * 3600, // Keep failed jobs for 7 days
      },
    },
  };

  const txPollingQueue = new Queue(QUEUE_NAMES.TX_POLLING, queueOptions);
  const evmPollingQueue = new Queue(QUEUE_NAMES.EVM_POLLING, queueOptions);
  const noblePollingQueue = new Queue(QUEUE_NAMES.NOBLE_POLLING, queueOptions);
  const namadaPollingQueue = new Queue(QUEUE_NAMES.NAMADA_POLLING, queueOptions);

  const workers: Worker[] = [];

  connection.on('error', (error: Error) => {
    logger.error({ err: error }, 'Redis connection error');
  });

  connection.on('connect', () => {
    logger.info('Redis connected');
  });

  return {
    txPollingQueue,
    evmPollingQueue,
    noblePollingQueue,
    namadaPollingQueue,
    workers,
    connection,
    async close() {
      logger.info('Closing queues and workers...');
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all([
        txPollingQueue.close(),
        evmPollingQueue.close(),
        noblePollingQueue.close(),
        namadaPollingQueue.close(),
      ]);
      await connection.quit();
      logger.info('Queues and workers closed');
    },
  };
}

export { QUEUE_NAMES };

