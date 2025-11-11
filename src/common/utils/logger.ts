import pino from 'pino';

import type { AppConfig } from '../../config/env.js';
import { APP_NAME } from '../../config/constants.js';

export type AppLogger = pino.Logger;

export function createLogger(config: AppConfig): AppLogger {
  return pino({
    name: APP_NAME,
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
  });
}

