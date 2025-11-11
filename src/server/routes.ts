import type { FastifyInstance } from 'fastify';

import type { AppContainer } from '../config/container.js';
import { registerAddressTrackerController } from '../modules/address-tracker/controller.js';
import { registerTxTrackerController } from '../modules/tx-tracker/controller.js';

export async function registerRoutes(app: FastifyInstance, container: AppContainer): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime()
  }));

  await registerTxTrackerController(app, container);
  await registerAddressTrackerController(app, container);
}

