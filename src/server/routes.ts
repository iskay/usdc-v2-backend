import type { FastifyInstance } from 'fastify';

import type { AppContainer } from '../config/container.js';
import { registerAddressTrackerController } from '../modules/address-tracker/controller.js';
import { registerTxTrackerController } from '../modules/tx-tracker/controller.js';
import { registerNobleForwardingController } from '../modules/noble-forwarding-tracker/controller.js';

export async function registerRoutes(app: FastifyInstance, container: AppContainer): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime()
  }));

  // Register API routes under /api prefix
  await app.register(async (apiApp) => {
    await registerTxTrackerController(apiApp, container);
    await registerAddressTrackerController(apiApp, container);
  }, { prefix: '/api' });

  // Register Noble forwarding routes under /api/noble-forwarding prefix
  await app.register(async (nobleApp) => {
    await registerNobleForwardingController(nobleApp, container);
  }, { prefix: '/api/noble-forwarding' });
}

