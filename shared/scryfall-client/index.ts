/**
 * Scryfall Cache API Client
 * Auto-generated TypeScript types and utilities
 */

export type { paths, components } from './schema';

// Helper type extracts
export type Card = components['schemas']['Card'];
export type ApiResponse<T> = components['schemas']['ApiResponse_for_Card']; // Generic version
export type PaginatedResponse<T> = components['schemas']['PaginatedResponse_for_Card'];
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

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
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
  async searchCards(params: SearchParams) {
    const query = new URLSearchParams(params as any).toString();
    return this.request<ApiResponse<PaginatedResponse<Card>>>(`/cards/search?${query}`);
  }

  async getCardByName(params: NamedParams) {
    const query = new URLSearchParams(params as any).toString();
    return this.request<ApiResponse<Card>>(`/cards/named?${query}`);
  }

  async getCard(id: string) {
    return this.request<ApiResponse<Card>>(`/cards/${id}`);
  }

  // Utility endpoints
  async getStats() {
    return this.request<ApiResponse<CacheStats>>('/stats');
  }

  async health() {
    return this.request<any>('/health');
  }
}
