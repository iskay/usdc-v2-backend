import Fastify from 'fastify';

import { DEFAULT_SHUTDOWN_TIMEOUT_MS } from './config/constants.js';
import { createAppContainer } from './config/container.js';
import { loadConfig } from './config/env.js';
import { registerMiddleware } from './server/middleware.js';
import { registerRoutes } from './server/routes.js';
import { createWebSocketManager } from './server/websocket.js';
import { disconnectPrisma } from './common/db/prismaClient.js';
import { registerJobs } from './jobs/index.js';
import { resumeUnfinishedFlows } from './jobs/resume.js';

export async function buildApp() {
  const config = loadConfig();
  const container = await createAppContainer(config);
  const logger = container.resolve('logger');

  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.nodeEnv === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:standard'
            }
          }
        : undefined
    }
  });

  await registerMiddleware(app, config);
  await registerRoutes(app, container);

  // Initialize WebSocket server
  const wsManager = createWebSocketManager(app, logger);

  // Register job workers
  const jobRegistry = await registerJobs(container);
  await jobRegistry.start();

  // Resume unfinished flows on startup (non-blocking)
  const txTrackerService = container.resolve('txTrackerService');
  const queueManager = container.resolve('queueManager');
  resumeUnfinishedFlows(queueManager, txTrackerService, logger).catch((error) => {
    logger.warn({ err: error }, 'Resume unfinished flows failed, continuing startup');
  });

  const close = async () => {
    await app.close();
    await wsManager.close();
    await jobRegistry.stop();
    await disconnectPrisma();
    await container.dispose();
  };

  return { app, config, container, jobRegistry, wsManager, close };
}

async function start() {
  const { app, config, container, jobRegistry, wsManager } = await buildApp();

  const shutdownSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of shutdownSignals) {
    process.once(signal, async () => {
      app.log.info({ signal }, 'Received signal, shutting down');
      setTimeout(() => {
        app.log.error('Forced shutdown due to timeout');
        process.exit(1);
      }, DEFAULT_SHUTDOWN_TIMEOUT_MS).unref();

      try {
        await app.close();
        await wsManager.close();
        await jobRegistry.stop();
        await disconnectPrisma();
        await container.dispose();
        process.exit(0);
      } catch (error) {
        app.log.error({ err: error }, 'Error during shutdown');
        process.exit(1);
      }
    });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ port: config.port, host: config.host }, 'API server started');
  } catch (error) {
    app.log.error({ err: error }, 'Failed to start server');
    await wsManager.close().catch(() => {});
    await jobRegistry.stop().catch(() => {});
    await container.dispose();
    await disconnectPrisma();
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

