#!/usr/bin/env node

/**
 * Lightweight script to generate TypeScript types from OpenAPI spec
 * using openapi-typescript (simpler and faster than openapi-generator)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MICROSERVICE_URL = process.env.SCRYFALL_CACHE_URL || 'http://localhost:8080';
const SPEC_URL = `${MICROSERVICE_URL}/api-docs/openapi.json`;
const OUTPUT_DIR = path.join(__dirname, '../shared/scryfall-api-client');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'schema.d.ts');

console.log('🚀 Generating TypeScript types for Scryfall Cache API...\n');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Generate types
console.log(`📥 Generating types from ${SPEC_URL}...`);
try {
  execSync(
    `npx openapi-typescript ${SPEC_URL} -o ${OUTPUT_FILE}`,
    { stdio: 'inherit' }
  );
  console.log(`✅ Types generated at: ${OUTPUT_FILE}\n`);
} catch (error) {
  console.error('❌ Failed to generate types. Is the microservice running?');
  console.error('   Start it with: cd ../scryfall-cache-microservice && cargo run');
  process.exit(1);
}

// Create index file with helper utilities
const indexContent = `/**
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
  constructor(private config: ApiClientConfig) {}

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const url = \`\${this.config.baseUrl}\${path}\`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      throw new Error(\`API request failed: \${response.statusText}\`);
    }

    return response.json();
  }

  // Card endpoints
  async searchCards(params: SearchParams) {
    const query = new URLSearchParams(params as any).toString();
    return this.request<ApiResponse<PaginatedResponse<Card>>>(\`/cards/search?\${query}\`);
  }

  async getCardByName(params: NamedParams) {
    const query = new URLSearchParams(params as any).toString();
    return this.request<ApiResponse<Card>>(\`/cards/named?\${query}\`);
  }

  async getCard(id: string) {
    return this.request<ApiResponse<Card>>(\`/cards/\${id}\`);
  }

  // Utility endpoints
  async getStats() {
    return this.request<ApiResponse<CacheStats>>('/stats');
  }

  async health() {
    return this.request<any>('/health');
  }
}
`;

fs.writeFileSync(path.join(OUTPUT_DIR, 'index.ts'), indexContent);
console.log('✅ Client utilities created\n');

// Create README
const readmeContent = `# Scryfall Cache API Client

Auto-generated TypeScript client for the Scryfall Cache Microservice.

## Installation

This is a shared module used internally in the project.

## Usage

\`\`\`typescript
import { ScryfallCacheClient, Card } from '@/shared/scryfall-api-client';

const client = new ScryfallCacheClient({
  baseUrl: 'http://localhost:8080',
});

// Search for cards
const response = await client.searchCards({ q: 'lightning bolt' });
console.log(response.data.data); // Array of cards

// Get card by name
const card = await client.getCardByName({ fuzzy: 'lightning bolt' });
console.log(card.data);

// Get cache stats
const stats = await client.getStats();
console.log(stats.data);
\`\`\`

## Regenerating

Run \`npm run generate:api-client\` to regenerate the client from the latest OpenAPI spec.

The microservice must be running at \`http://localhost:8080\` (or set \`SCRYFALL_CACHE_URL\` env var).
`;

fs.writeFileSync(path.join(OUTPUT_DIR, 'README.md'), readmeContent);

console.log('🎉 Done! Client available at:', OUTPUT_DIR);
console.log('\nNext steps:');
console.log('  1. Import and use in your code:');
console.log('     import { ScryfallCacheClient } from "@/shared/scryfall-api-client";');
console.log('  2. See README.md for usage examples');
