import type { AppLogger } from '../../common/utils/logger.js';
import type { AddressTrackerRepository } from './repository.js';
import type { RegisterAddressInput, TrackedAddress } from './types.js';

export interface AddressTrackerService {
  register(input: RegisterAddressInput): Promise<TrackedAddress>;
  list(): Promise<TrackedAddress[]>;
}

export interface AddressTrackerServiceDependencies {
  repository: AddressTrackerRepository;
  logger: AppLogger;
}

export function createAddressTrackerService({
  repository,
  logger
}: AddressTrackerServiceDependencies): AddressTrackerService {
  return {
    async register(input) {
      const normalized = normalizeInput(input);

      try {
        const address = await repository.upsert(normalized);
        logger.debug({ address: address.address, chain: address.chain }, 'Tracked address upserted');
        return address;
      } catch (error) {
        logger.error({ err: error, address: input.address }, 'Failed to register address');
        throw error;
      }
    },

    async list() {
      return repository.list();
    }
  };
}

function normalizeInput(input: RegisterAddressInput): RegisterAddressInput {
  const normalizedLabels = Array.from(
    new Set((input.labels ?? []).map((label) => label.trim()).filter((label) => label.length > 0))
  );

  return {
    ...input,
    labels: normalizedLabels
  };
}

