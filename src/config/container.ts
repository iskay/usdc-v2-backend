import {
  createRpcClientFactory,
  type RpcClientFactory
} from '../common/rpc/index.js';
import { asFunction, asValue, createContainer, InjectionMode, type AwilixContainer } from 'awilix';

import type { AppConfig } from './env.js';
import { createLogger, type AppLogger } from '../common/utils/logger.js';
import { getPrismaClient } from '../common/db/prismaClient.js';
import {
  loadChainRegistry,
  type ChainRegistry
} from './chainRegistry.js';
import {
  createTxTrackerRepository,
  type TxTrackerRepository
} from '../modules/tx-tracker/repository.js';
import {
  createTxTrackerService,
  type TxTrackerService
} from '../modules/tx-tracker/service.js';
import {
  createTrackerManager,
  type TrackerManager
} from '../modules/tx-tracker/trackerManager.js';
import {
  createAddressTrackerRepository,
  type AddressTrackerRepository
} from '../modules/address-tracker/repository.js';
import {
  createAddressTrackerService,
  type AddressTrackerService
} from '../modules/address-tracker/service.js';
import {
  createNobleForwardingRepository,
  type NobleForwardingRepository
} from '../modules/noble-forwarding-tracker/repository.js';
import {
  createNobleForwardingService,
  type NobleForwardingService
} from '../modules/noble-forwarding-tracker/service.js';
import {
  createNobleLcdClient,
  type NobleLcdClient
} from '../modules/noble-forwarding-tracker/nobleClient.js';
import { createHttpClient, type HttpClient } from '../common/http/httpClient.js';
import { createQueueManager, type QueueManager } from '../jobs/queue.js';
import {
  loadChainPollingConfigs,
  type ChainPollingConfigs
} from './chainConfigs.js';

import type { PrismaClient } from '@prisma/client';

export interface AppDependencies {
  config: AppConfig;
  logger: AppLogger;
  prisma: PrismaClient;
  chainRegistry: ChainRegistry;
  chainPollingConfigs: ChainPollingConfigs;
  rpcClientFactory: RpcClientFactory;
  queueManager: QueueManager;
  txTrackerRepository: TxTrackerRepository;
  trackerManager: TrackerManager;
  txTrackerService: TxTrackerService;
  addressTrackerRepository: AddressTrackerRepository;
  addressTrackerService: AddressTrackerService;
  nobleForwardingRepository: NobleForwardingRepository;
  nobleForwardingService: NobleForwardingService;
  nobleLcdClient: NobleLcdClient;
}

export type AppContainer = AwilixContainer<AppDependencies>;

export async function createAppContainer(config: AppConfig): Promise<AppContainer> {
  const container = createContainer<AppDependencies>({
    injectionMode: InjectionMode.PROXY
  });

  const chainRegistry = await loadChainRegistry(config);
  const chainPollingConfigs = loadChainPollingConfigs(config, chainRegistry);

  const logger = createLogger(config);

  container.register({
    config: asValue(config),
    logger: asValue(logger),
    prisma: asFunction(() => getPrismaClient(config)).singleton(),
    chainRegistry: asValue(chainRegistry),
    chainPollingConfigs: asValue(chainPollingConfigs),
    rpcClientFactory: asFunction(({ chainRegistry: registry }) => createRpcClientFactory(registry)).singleton(),
    queueManager: asFunction(({ config: cfg, logger: log }) => createQueueManager(cfg, log)).singleton(),
    txTrackerRepository: asFunction(({ prisma }) => createTxTrackerRepository(prisma)).singleton(),
    trackerManager: asFunction(({ txTrackerRepository, txTrackerService, rpcClientFactory, chainRegistry: registry, chainPollingConfigs, logger, config: cfg }) =>
      createTrackerManager({
        repository: txTrackerRepository,
        service: txTrackerService,
        rpcFactory: rpcClientFactory,
        chainRegistry: registry,
        chainPollingConfigs,
        logger,
        config: {
          irisAttestationBaseURL: cfg.irisAttestationBaseURL
        }
      })
    ).singleton(),
    txTrackerService: asFunction(({ txTrackerRepository, queueManager, logger, rpcClientFactory, chainPollingConfigs: pollingConfigs }) =>
      createTxTrackerService({
        repository: txTrackerRepository,
        queueManager,
        logger,
        rpcFactory: rpcClientFactory,
        chainPollingConfigs: pollingConfigs
      })
    ).singleton(),
    addressTrackerRepository: asFunction(({ prisma }) => createAddressTrackerRepository(prisma)).singleton(),
    addressTrackerService: asFunction(({ addressTrackerRepository, logger }) =>
      createAddressTrackerService({ repository: addressTrackerRepository, logger })
    ).singleton(),
    nobleForwardingRepository: asFunction(({ prisma }) =>
      createNobleForwardingRepository(prisma)
    ).singleton(),
    nobleLcdClient: asFunction(({ config: cfg, logger: log }) => {
      if (!cfg.nobleLcdBase) {
        throw new Error('NOBLE_LCD_BASE environment variable is required for Noble forwarding');
      }
      const httpClient = createHttpClient({ baseURL: cfg.nobleLcdBase });
      return createNobleLcdClient({
        httpClient,
        logger: log,
        baseUrl: cfg.nobleLcdBase
      });
    }).singleton(),
    nobleForwardingService: asFunction(
      ({ nobleForwardingRepository, nobleLcdClient, config: cfg, logger: log }) =>
        createNobleForwardingService({
          repository: nobleForwardingRepository,
          nobleClient: nobleLcdClient,
          logger: log,
          config: {
            channelId: cfg.nobleChannelId,
            fallback: cfg.nobleFallback
          }
        })
    ).singleton()
  });

  return container;
}

