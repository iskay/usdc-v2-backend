import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/env.js';

export async function registerMiddleware(app: FastifyInstance, config: AppConfig): Promise<void> {
  // Allow all origins if CORS_ORIGINS is empty or contains only "*"
  const allowAllOrigins =
    config.corsOrigins.length === 0 ||
    (config.corsOrigins.length === 1 && config.corsOrigins[0] === '*');

  await app.register(cors, {
    origin: allowAllOrigins ? true : config.corsOrigins
  });
}

