import { Worker, WorkerOptions } from 'bullmq';
import type { AppContainer } from '../config/container.js';
import type { QueueManager } from './queue.js';
import { QUEUE_NAMES } from './queue.js';
import { createTxPollingProcessor } from './txStatusPoller.js';
import { createNobleForwardingCheckerProcessor } from './nobleForwardingChecker.js';

export interface JobRegistry {
  queueManager: QueueManager;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createJobRegistry(
  container: AppContainer
): Promise<JobRegistry> {
  const queueManager = container.resolve('queueManager');
  const trackerManager = container.resolve('trackerManager');
  const txTrackerRepository = container.resolve('txTrackerRepository');
  const logger = container.resolve('logger');
  const chainRegistry = container.resolve('chainRegistry');
  const config = container.resolve('config');
  const nobleForwardingService = container.resolve('nobleForwardingService');

  const workerOptions: WorkerOptions = {
    connection: queueManager.connection,
    concurrency: 5, // Process up to 5 jobs concurrently
    limiter: {
      max: 10,
      duration: 1000, // Max 10 jobs per second
    },
  };

  // Create worker for main transaction polling queue
  const txPollingWorker = new Worker(
    QUEUE_NAMES.TX_POLLING,
    createTxPollingProcessor(trackerManager, txTrackerRepository, logger, chainRegistry),
    workerOptions
  );

  txPollingWorker.on('completed', (job) => {
    logger.debug({ jobId: job.id, flowId: job.data.flowId }, 'Polling job completed');
  });

  txPollingWorker.on('failed', (job, err) => {
    logger.error(
      { err, jobId: job?.id, flowId: job?.data?.flowId },
      'Polling job failed'
    );
  });

  queueManager.workers.push(txPollingWorker);

  // Create worker for Noble forwarding checker (only if Noble LCD is configured)
  if (config.nobleLcdBase) {
    const nobleForwardingWorker = new Worker(
      QUEUE_NAMES.NOBLE_FORWARDING_CHECKER,
      createNobleForwardingCheckerProcessor(nobleForwardingService, config, logger),
      {
        ...workerOptions,
        concurrency: 1 // Only one checker job at a time
      }
    );

    nobleForwardingWorker.on('completed', (job) => {
      logger.debug({ jobId: job.id }, 'Noble forwarding checker job completed');
    });

    nobleForwardingWorker.on('failed', (job, err) => {
      logger.error({ err, jobId: job?.id }, 'Noble forwarding checker job failed');
    });

    queueManager.workers.push(nobleForwardingWorker);

    // Register repeatable job for periodic checking
    await queueManager.nobleForwardingCheckerQueue.add(
      'check-pending-registrations',
      {},
      {
        repeat: {
          every: config.nobleRegCheckIntervalMs
        }
      }
    );

    logger.info(
      {
        intervalMs: config.nobleRegCheckIntervalMs,
        queue: QUEUE_NAMES.NOBLE_FORWARDING_CHECKER
      },
      'Registered Noble forwarding checker repeatable job'
    );
  } else {
    logger.warn('NOBLE_LCD_BASE not configured, skipping Noble forwarding checker job');
  }

  return {
    queueManager,
    async start() {
      logger.info('Starting job workers...');
      // Workers are automatically started when created
      logger.info('Job workers started');
    },
    async stop() {
      logger.info('Stopping job workers...');
      await queueManager.close();
      logger.info('Job workers stopped');
    },
  };
}

export async function registerJobs(container: AppContainer): Promise<JobRegistry> {
  return createJobRegistry(container);
}
