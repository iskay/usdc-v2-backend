import { Worker, WorkerOptions } from 'bullmq';
import type { AppContainer } from '../config/container.js';
import type { QueueManager } from './queue.js';
import { QUEUE_NAMES } from './queue.js';
import { createTxPollingProcessor } from './txStatusPoller.js';

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
    createTxPollingProcessor(trackerManager, txTrackerRepository, logger),
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
