import type { AppLogger } from '../../common/utils/logger.js';
import type { NobleLcdClient } from './nobleClient.js';
import type { NobleForwardingRepository } from './repository.js';
import { buildRegistrationTransaction } from './registration.js';
import type {
  NobleForwardingRegistration,
  RegistrationResult,
  TrackRegistrationInput
} from './types.js';

export interface NobleForwardingService {
  track(input: TrackRegistrationInput): Promise<{
    tracked: boolean;
    reason?: string;
    registration?: NobleForwardingRegistration;
  }>;
  checkRegistration(id: string): Promise<RegistrationResult>;
  processPendingRegistrations(config: {
    minUusdc: number;
    gasLimit: number;
    feeUusdc: string;
    staleMs: number;
  }): Promise<{ processed: number; registered: number; failed: number; stale: number }>;
}

export interface NobleForwardingServiceDependencies {
  repository: NobleForwardingRepository;
  nobleClient: NobleLcdClient;
  logger: AppLogger;
  config: {
    channelId: string;
    fallback: string;
  };
}

export function createNobleForwardingService({
  repository,
  nobleClient,
  logger,
  config
}: NobleForwardingServiceDependencies): NobleForwardingService {
  return {
    async track(input) {
      const channel = input.channel ?? config.channelId;
      const fallback = input.fallback ?? config.fallback;

      // Check if forwarding address already exists
      try {
        const existsCheck = await nobleClient.checkForwardingAddressExists(
          channel,
          input.recipient,
          fallback
        );

        if (existsCheck.exists) {
          logger.debug(
            { nobleAddress: input.nobleAddress, recipient: input.recipient },
            'Forwarding address already registered, skipping tracking'
          );
          return { tracked: false, reason: 'already_registered' };
        }
      } catch (error) {
        // If existence check fails, log but continue (might be transient error)
        logger.warn(
          { err: error, recipient: input.recipient },
          'Failed to check forwarding address existence, proceeding with tracking'
        );
      }

      // Upsert registration record
      const registration = await repository.upsert({
        ...input,
        channel,
        fallback
      });

      logger.info(
        { id: registration.id, nobleAddress: registration.nobleAddress },
        'Tracked Noble forwarding address'
      );

      return { tracked: true, registration };
    },

    async checkRegistration(id) {
      const registration = await repository.findById(id);

      if (!registration) {
        return { success: false, error: 'Registration not found' };
      }

      if (registration.status !== 'pending') {
        return {
          success: false,
          error: `Registration is not pending (status: ${registration.status})`
        };
      }

      const channel = registration.channel;
      const fallback = registration.fallback ?? '';

      try {
        // Check if already registered
        const existsCheck = await nobleClient.checkForwardingAddressExists(
          channel,
          registration.recipient,
          fallback
        );

        if (existsCheck.exists) {
          await repository.updateStatus(registration.id, 'registered', {
            registeredAt: new Date()
          });
          logger.info(
            { id: registration.id, nobleAddress: registration.nobleAddress },
            'Registration already exists, marked as registered'
          );
          return { success: true };
        }

        // Check balance
        const balanceResponse = await nobleClient.getBalance(registration.nobleAddress);
        const uusdcBalance = balanceResponse.balances.find((b) => b.denom === 'uusdc');
        const balance = uusdcBalance ? BigInt(uusdcBalance.amount) : BigInt(0);

        await repository.updateStatus(registration.id, 'pending', {
          balanceUusdc: balance,
          lastCheckedAt: new Date()
        });

        // Note: Registration logic will be handled by processPendingRegistrations
        // This method just checks status

        return { success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await repository.updateStatus(registration.id, 'failed', {
          errorMessage
        });
        logger.error(
          { err: error, id: registration.id },
          'Failed to check registration'
        );
        return { success: false, error: errorMessage };
      }
    },

    async processPendingRegistrations(processConfig) {
      const pending = await repository.findPending();
      let registered = 0;
      let failed = 0;
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - processConfig.staleMs);

      // Mark stale registrations
      const staleCount = await repository.markStale(staleThreshold);
      logger.debug({ staleCount }, 'Marked stale registrations');

      for (const registration of pending) {
        try {
          // Skip if stale (will be handled by markStale)
          if (registration.createdAt < staleThreshold) {
            continue;
          }

          const channel = registration.channel;
          const fallback = registration.fallback ?? '';

          // Check if already registered
          const existsCheck = await nobleClient.checkForwardingAddressExists(
            channel,
            registration.recipient,
            fallback
          );

          if (existsCheck.exists) {
            await repository.updateStatus(registration.id, 'registered', {
              registeredAt: new Date()
            });
            registered++;
            logger.info(
              { id: registration.id, nobleAddress: registration.nobleAddress },
              'Registration already exists, marked as registered'
            );
            continue;
          }

          // Check balance
          const balanceResponse = await nobleClient.getBalance(registration.nobleAddress);
          const uusdcBalance = balanceResponse.balances.find((b) => b.denom === 'uusdc');
          const balance = uusdcBalance ? BigInt(uusdcBalance.amount) : BigInt(0);

          await repository.updateStatus(registration.id, 'pending', {
            balanceUusdc: balance,
            lastCheckedAt: new Date()
          });

          // Register if balance is sufficient
          if (balance >= BigInt(processConfig.minUusdc)) {
            try {
              const txResult = buildRegistrationTransaction(
                {
                  nobleAddress: registration.nobleAddress,
                  recipient: registration.recipient,
                  channel,
                  fallback,
                  gasLimit: processConfig.gasLimit,
                  feeAmount: processConfig.feeUusdc
                },
                logger
              );

              const broadcastResult = await nobleClient.broadcastTransaction(txResult.txBytes);
              const code = broadcastResult.tx_response.code;
              const rawLog = (broadcastResult.tx_response.raw_log || '').toLowerCase();
              const ok = code === 0 || rawLog.includes('already registered');

              if (ok) {
                await repository.updateStatus(registration.id, 'registered', {
                  registeredAt: new Date(),
                  registrationTxHash: broadcastResult.tx_response.txhash
                });
                registered++;
                logger.info(
                  {
                    id: registration.id,
                    nobleAddress: registration.nobleAddress,
                    txHash: broadcastResult.tx_response.txhash
                  },
                  'Successfully registered Noble forwarding address'
                );
              } else {
                const errorMessage = `Broadcast failed: ${rawLog || code}`;
                await repository.updateStatus(registration.id, 'failed', {
                  errorMessage
                });
                failed++;
                logger.error(
                  { id: registration.id, code, rawLog },
                  'Failed to broadcast registration transaction'
                );
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              await repository.updateStatus(registration.id, 'failed', {
                errorMessage
              });
              failed++;
              logger.error(
                { err: error, id: registration.id },
                'Failed to register forwarding address'
              );
            }
          } else {
            logger.debug(
              {
                id: registration.id,
                balance: balance.toString(),
                minRequired: processConfig.minUusdc.toString()
              },
              'Insufficient balance for registration'
            );
          }
        } catch (error) {
          // Error checking this registration, but continue with others
          logger.error(
            { err: error, id: registration.id },
            'Error processing registration'
          );
          failed++;
        }
      }

      return {
        processed: pending.length,
        registered,
        failed,
        stale: staleCount
      };
    }
  };
}

