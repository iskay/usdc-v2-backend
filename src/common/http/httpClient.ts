import axios, { type AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';

export interface HttpClientOptions {
  baseURL?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export type HttpClient = AxiosInstance;

export type HttpClientFactory = (options?: HttpClientOptions) => HttpClient;

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const instance = axios.create({
    baseURL: options.baseURL,
    timeout: options.timeoutMs ?? 30_000,
    headers: {
      'Content-Type': 'application/json'
    }
  });

  axiosRetry(instance, {
    retries: options.retries ?? 3,
    retryDelay: axiosRetry.exponentialDelay,
    shouldResetTimeout: true,
    retryCondition: (error) => {
      if (axiosRetry.isNetworkOrIdempotentRequestError(error)) {
        return true;
      }
      const status = error.response?.status ?? 0;
      return status >= 500 || status === 429;
    }
  });

  return instance;
}

