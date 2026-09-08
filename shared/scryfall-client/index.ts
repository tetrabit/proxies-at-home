/**
 * Scryfall Cache API Client
 * Auto-generated TypeScript types and utilities
 */

import type { paths, components } from './schema.js';

export type { paths, components };

// Helper type extracts
export type Card = components['schemas']['Card'];
export type CardResponse = components['schemas']['CardResponse'];
export type CardListResponse = components['schemas']['CardListResponse'];
export type PaginatedCardData = components['schemas']['PaginatedCardData'];
export type CacheStats = components['schemas']['CacheStats'];
export type SearchParams = components['schemas']['SearchParams'];
export type NamedParams = components['schemas']['NamedParams'];

// API client configuration
export interface ApiClientConfig {
  baseUrl: string;
  timeout?: number;
}

// Simple fetch-based API client
export class ScryfallCacheClient {
  private config: ApiClientConfig;

  constructor(config: ApiClientConfig) {
    this.config = config;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const callerSignal = options.signal;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const abort = (reason?: unknown) => {
      if (!controller.signal.aborted) {
        controller.abort(reason ?? new DOMException('The operation was aborted', 'AbortError'));
      }
    };
    const onCallerAbort = () => abort(callerSignal?.reason);

    if (callerSignal?.aborted) {
      onCallerAbort();
    } else {
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    }

    if (!controller.signal.aborted && this.config.timeout !== undefined) {
      timeoutId = setTimeout(() => {
        abort(new DOMException('The request timed out', 'TimeoutError'));
      }, this.config.timeout);
    }

    const waitForAbort = <Value>(operation: Promise<Value>): Promise<Value> => {
      if (controller.signal.aborted) {
        return Promise.reject(controller.signal.reason);
      }

      return new Promise<Value>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(controller.signal.reason);
        };
        const cleanup = () => controller.signal.removeEventListener('abort', onAbort);

        controller.signal.addEventListener('abort', onAbort, { once: true });
        operation.then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error: unknown) => {
            cleanup();
            reject(error);
          }
        );
      });
    };

    try {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }

      const response = await waitForAbort(
        fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            ...options.headers,
          },
        })
      );

      if (!response.ok) {
        throw new Error(`API request failed: ${response.statusText}`);
      }

      return await waitForAbort(response.json());
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }

  // Card endpoints
  async searchCards(params: SearchParams, options?: RequestInit) {
    const query = new URLSearchParams(params as any).toString();
    return this.request<CardListResponse>(`/cards/search?${query}`, options);
  }

  async getCardByName(params: NamedParams, options?: RequestInit) {
    const query = new URLSearchParams(params as any).toString();
    return this.request<CardResponse>(`/cards/named?${query}`, options);
  }

  async getCard(id: string, options?: RequestInit) {
    return this.request<CardResponse>(`/cards/${id}`, options);
  }

  async autocomplete(params: { q: string }, options?: RequestInit) {
    const query = new URLSearchParams(params as any).toString();
    return this.request<{ object: string; data: string[] }>(`/cards/autocomplete?${query}`, options);
  }

  // Utility endpoints
  async getStats(options?: RequestInit) {
    return this.request<components['schemas']['StatsResponse']>('/stats', options);
  }

  async health(options?: RequestInit) {
    return this.request<any>('/health', options);
  }
}
