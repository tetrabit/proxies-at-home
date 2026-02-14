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
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`API request failed: ${response.statusText}`);
    }

    return response.json();
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
