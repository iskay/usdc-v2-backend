import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env.js';

export async function registerMiddleware(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true
  });
}

