import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContainer } from '../../config/container.js';
import type { TrackedAddress } from './types.js';

const registerBodySchema = z.object({
  address: z.string().min(1, 'address is required'),
  chain: z.string().min(1, 'chain is required'),
  labels: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.any()).optional()
});

export async function registerAddressTrackerController(
  app: FastifyInstance,
  container: AppContainer
): Promise<void> {
  app.post('/register', async (request, reply) => {
    const payload = registerBodySchema.parse(request.body);
    const service = container.resolve('addressTrackerService');

    const result = await service.register(payload);
    return reply.code(201).send({ data: serializeTrackedAddress(result) });
  });

  app.get('/addresses', async () => {
    const service = container.resolve('addressTrackerService');
    const results = await service.list();
    return { data: results.map(serializeTrackedAddress) };
  });
}

function serializeTrackedAddress(address: TrackedAddress) {
  return {
    id: address.id,
    address: address.address,
    chain: address.chain,
    labels: address.labels,
    metadata: address.metadata,
    lastSyncedAt: address.lastSyncedAt?.toISOString() ?? null,
    createdAt: address.createdAt.toISOString(),
    updatedAt: address.updatedAt.toISOString()
  };
}

