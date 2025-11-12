import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContainer } from '../../config/container.js';
import { getChainEntry } from '../../config/chainRegistry.js';
import type { ChainProgress, TrackedTransaction } from './types.js';

const trackBodySchema = z.object({
  txHash: z.string().min(1, 'txHash is required'),
  chain: z.string().min(1, 'chain is required'),
  chainType: z.string().min(1, 'chainType is required'),
  flowType: z.enum(['deposit', 'payment']).optional(),
  status: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  addressId: z.string().min(1).optional(),
  lastCheckedAt: z.string().datetime().optional(),
  nextCheckAfter: z.string().datetime().optional(),
  errorState: z.record(z.string(), z.any()).optional()
});

const trackFlowSchema = z.object({
  flowType: z.enum(['deposit', 'payment'], { required_error: 'flowType is required' }),
  initialChain: z.string().min(1, 'initialChain is required'),
  destinationChain: z.string().min(1, 'destinationChain is required'),
  chainType: z.string().min(1, 'chainType is required'),
  chainProgress: z.record(z.string(), z.any()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  status: z.string().optional(),
  errorState: z.record(z.string(), z.any()).optional(),
  txHash: z.string().min(1, 'txHash is required')
});

const txHashParamsSchema = z.object({
  hash: z.string().min(1)
});

const flowIdParamsSchema = z.object({
  id: z.string().min(1)
});

const chainHashParamsSchema = z.object({
  chain: z.string().min(1),
  hash: z.string().min(1)
});

const stageUpdateBodySchema = z.object({
  chain: z.enum(['evm', 'noble', 'namada']),
  stage: z.string().min(1),
  status: z.enum(['pending', 'confirmed', 'failed']).optional(),
  message: z.string().optional(),
  txHash: z.string().optional(),
  occurredAt: z.string().datetime().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  kind: z.enum(['gasless', 'default']).optional(),
  source: z.enum(['client', 'poller']).optional()
});

export async function registerTxTrackerController(
  app: FastifyInstance,
  container: AppContainer
): Promise<void> {
  const registry = container.resolve('chainRegistry');
  const service = container.resolve('txTrackerService');
  const queueManager = container.resolve('queueManager');

  app.post('/track', async (request, reply) => {
    const payload = trackBodySchema.parse(request.body);
    validateChain(registry, payload.chain);

    const result = await service.track({
      txHash: payload.txHash,
      chain: payload.chain,
      chainType: payload.chainType,
      flowType: payload.flowType ?? null,
      status: payload.status,
      metadata: payload.metadata,
      addressId: payload.addressId,
      lastCheckedAt: payload.lastCheckedAt ? new Date(payload.lastCheckedAt) : undefined,
      nextCheckAfter: payload.nextCheckAfter ? new Date(payload.nextCheckAfter) : undefined,
      errorState: payload.errorState
    });

    return reply.code(201).send({ data: serializeTrackedTransaction(result) });
  });

  app.post('/track/flow', async (request, reply) => {
    const logger = container.resolve('logger');
    
    // Log request body for debugging
    logger.debug({ body: request.body }, 'Received flow tracking request');
    
    try {
    const payload = trackFlowSchema.parse(request.body);
    validateChain(registry, payload.initialChain);
      validateChain(registry, payload.destinationChain);

    const chainProgress = payload.chainProgress
      ? (payload.chainProgress as ChainProgress)
      : undefined;

    const result = await service.trackFlow({
      flowType: payload.flowType,
      initialChain: payload.initialChain,
        destinationChain: payload.destinationChain,
      chainType: payload.chainType,
      chainProgress,
      metadata: payload.metadata,
      status: payload.status,
      errorState: payload.errorState,
        txHash: payload.txHash
    });

    return reply.code(201).send({ data: serializeTrackedTransaction(result) });
    } catch (error) {
      // Log detailed Zod validation errors
      if (error instanceof z.ZodError) {
        logger.error(
          {
            errors: error.errors,
            body: request.body,
          },
          'Zod validation failed for flow tracking request'
        );
        return reply.code(400).send({
          error: 'Validation failed',
          message: 'Invalid request body',
          details: error.errors.map((e) => ({
            path: e.path.join('.'),
            message: e.message,
          })),
        });
      }
      throw error;
    }
  });

  app.get('/flow/:id', async (request, reply) => {
    const params = flowIdParamsSchema.parse(request.params);
    const result = await service.getById(params.id);
    if (!result) {
      return reply.code(404).send({ message: 'Flow not found' });
    }

    return { data: serializeTrackedTransaction(result) };
  });

  app.get('/flow/:id/status', async (request, reply) => {
    const params = flowIdParamsSchema.parse(request.params);
    const result = await service.getById(params.id);
    if (!result) {
      return reply.code(404).send({ message: 'Flow not found' });
    }

    return {
      data: {
        id: result.id,
        status: result.status,
        chainProgress: result.chainProgress
      }
    };
  });

  app.get('/flow/:id/logs', async (request, reply) => {
    const params = flowIdParamsSchema.parse(request.params);
    const flow = await service.getById(params.id);
    if (!flow) {
      return reply.code(404).send({ message: 'Flow not found' });
    }

    const logs = await service.getStatusLogs(params.id);
    return {
      data: logs.map((log) => ({
        id: log.id,
        status: log.status,
        chain: log.chain,
        source: log.source,
        detail: log.detail,
        createdAt: log.createdAt.toISOString()
      }))
    };
  });

  app.get('/flow/:id/job', async (request, reply) => {
    const params = flowIdParamsSchema.parse(request.params);
    const flow = await service.getById(params.id);
    if (!flow) {
      return reply.code(404).send({ message: 'Flow not found' });
    }

    // Find jobs related to this flow
    const jobs = await queueManager.txPollingQueue.getJobs(['active', 'waiting', 'completed', 'failed']);
    const flowJobs = jobs.filter((job) => {
      const jobData = job.data as { flowId?: string };
      return jobData.flowId === params.id;
    });

    // Sort by creation time (newest first)
    flowJobs.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    // Get job states asynchronously
    const jobData = await Promise.all(
      flowJobs.map(async (job) => ({
        id: job.id,
        name: job.name,
        state: await job.getState(),
        progress: job.progress,
        data: job.data,
        timestamp: job.timestamp,
        processedOn: job.processedOn,
        finishedOn: job.finishedOn,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        opts: {
          attempts: job.opts.attempts,
          backoff: job.opts.backoff
        }
      }))
    );

    return {
      data: {
        flowId: params.id,
        jobs: jobData,
        activeJob: jobData.find((j) => j.state === 'active'),
        latestJob: jobData[0] || null
      }
    };
  });

  app.post('/flow/:id/stage', async (request, reply) => {
    const params = flowIdParamsSchema.parse(request.params);
    const body = stageUpdateBodySchema.parse(request.body);

    await service.appendClientStage({
      flowId: params.id,
      chain: body.chain,
      stage: body.stage,
      status: body.status,
      message: body.message,
      txHash: body.txHash,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
      metadata: body.metadata,
      kind: body.kind,
      source: body.source
    });

    return reply.code(204).send();
  });

  app.get('/flow/by-hash/:chain/:hash', async (request, reply) => {
    const params = chainHashParamsSchema.parse(request.params);
    validateChain(registry, params.chain);

    const results = await service.listUnfinishedFlows();
    const match = results.find((flow) => {
      const progress = flow.chainProgress ?? {};
      return Object.values(progress).some((entry) =>
        entry?.txHash === params.hash || entry?.stages?.some((stage) => stage.txHash === params.hash)
      );
    });

    if (!match) {
      return reply.code(404).send({ message: 'Flow not found for the given hash' });
    }

    return {
      data: {
        id: match.id,
        flowType: match.flowType,
        status: match.status,
        chainProgress: match.chainProgress
      }
    };
  });

  app.get('/tx/:hash', async (request, reply) => {
    const params = txHashParamsSchema.parse(request.params);

    const result = await service.getByHash(params.hash);
    if (!result) {
      return reply.code(404).send({ message: 'Transaction not found' });
    }

    return { data: serializeTrackedTransaction(result) };
  });
}

function validateChain(registry: AppContainer['cradle']['chainRegistry'], chainId: string) {
  getChainEntry(registry, chainId);
}

function serializeTrackedTransaction(transaction: TrackedTransaction) {
  return {
    id: transaction.id,
    txHash: transaction.txHash,
    chain: transaction.chain,
    chainType: transaction.chainType,
    flowType: transaction.flowType,
    initialChain: transaction.initialChain,
    destinationChain: transaction.destinationChain,
    status: transaction.status,
    metadata: transaction.metadata,
    chainProgress: transaction.chainProgress,
    lastCheckedAt: transaction.lastCheckedAt?.toISOString() ?? null,
    nextCheckAfter: transaction.nextCheckAfter?.toISOString() ?? null,
    errorState: transaction.errorState,
    addressId: transaction.addressId,
    createdAt: transaction.createdAt.toISOString(),
    updatedAt: transaction.updatedAt.toISOString()
  };
}

