import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppContainer } from '../../config/container.js';
import type { NobleForwardingRegistration } from './types.js';

const trackBodySchema = z.object({
  nobleAddress: z.string().min(1, 'nobleAddress is required'),
  recipient: z.string().min(1, 'recipient is required'),
  channel: z.string().optional(),
  fallback: z.string().optional()
});

export async function registerNobleForwardingController(
  app: FastifyInstance,
  container: AppContainer
): Promise<void> {
  app.post('/track', async (request, reply) => {
    const payload = trackBodySchema.parse(request.body);
    const service = container.resolve('nobleForwardingService');

    const result = await service.track(payload);

    if (!result.tracked) {
      return reply.code(200).send({
        tracked: false,
        reason: result.reason
      });
    }

    return reply.code(201).send({
      tracked: true,
      data: serializeRegistration(result.registration!)
    });
  });

  app.get('/tracked/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const repository = container.resolve('nobleForwardingRepository');

    const registration = await repository.findByNobleAddress(address);

    return reply.code(200).send({
      tracked: Boolean(registration),
      data: registration ? serializeRegistration(registration) : null
    });
  });

  app.get('/registrations', async (request, reply) => {
    const repository = container.resolve('nobleForwardingRepository');
    const { status } = request.query as { status?: string };

    let registrations: NobleForwardingRegistration[];
    if (status === 'pending') {
      registrations = await repository.findPending();
    } else {
      // For now, return all pending (can extend later)
      registrations = await repository.findPending();
    }

    return reply.code(200).send({
      data: registrations.map(serializeRegistration)
    });
  });
}

function serializeRegistration(registration: NobleForwardingRegistration) {
  return {
    id: registration.id,
    nobleAddress: registration.nobleAddress,
    recipient: registration.recipient,
    channel: registration.channel,
    fallback: registration.fallback,
    status: registration.status,
    balanceUusdc: registration.balanceUusdc?.toString() ?? null,
    lastCheckedAt: registration.lastCheckedAt?.toISOString() ?? null,
    registeredAt: registration.registeredAt?.toISOString() ?? null,
    registrationTxHash: registration.registrationTxHash,
    errorMessage: registration.errorMessage,
    createdAt: registration.createdAt.toISOString(),
    updatedAt: registration.updatedAt.toISOString()
  };
}

