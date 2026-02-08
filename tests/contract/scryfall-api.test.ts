/**
 * Contract Tests for Scryfall Cache Microservice
 * 
 * These tests verify that the OpenAPI spec matches the actual API implementation.
 * Run with: npm run test:contract
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = process.env.SCRYFALL_CACHE_URL || 'http://localhost:8080';

async function fetchJSON(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const text = await response.text();
  return {
    status: response.status,
    data: text ? JSON.parse(text) : null,
    headers: Object.fromEntries(response.headers.entries()),
  };
}

describe('Scryfall Cache API Contract Tests', () => {
  before(async () => {
    // Verify service is running
    try {
      const health = await fetchJSON(`${BASE_URL}/health`);
      assert.equal(health.status, 200, 'Service must be running');
    } catch (error) {
      throw new Error(`Service not available at ${BASE_URL}: ${error}`);
    }
  });

  describe('Health Endpoint', () => {
    it('GET /health returns 200 with status object', async () => {
      const result = await fetchJSON(`${BASE_URL}/health`);
      
      assert.equal(result.status, 200);
      assert.equal(typeof result.data, 'object');
      assert.equal(result.data.status, 'healthy');
      assert.equal(typeof result.data.service, 'string');
      assert.equal(typeof result.data.version, 'string');
    });
  });

  describe('OpenAPI Documentation', () => {
    it('GET /api-docs/openapi.json returns valid OpenAPI 3.0 spec', async () => {
      const result = await fetchJSON(`${BASE_URL}/api-docs/openapi.json`);
      
      assert.equal(result.status, 200);
      assert.equal(result.data.openapi, '3.0.3');
      assert.equal(typeof result.data.info, 'object');
      assert.equal(result.data.info.title, 'Scryfall Cache Microservice');
      assert.equal(typeof result.data.paths, 'object');
      assert.equal(typeof result.data.components, 'object');
    });

    it('OpenAPI spec includes all expected paths', async () => {
      const result = await fetchJSON(`${BASE_URL}/api-docs/openapi.json`);
      const paths = Object.keys(result.data.paths);
      
      assert.ok(paths.includes('/health'));
      assert.ok(paths.includes('/cards/search'));
      assert.ok(paths.includes('/cards/named'));
      assert.ok(paths.includes('/cards/{id}'));
      assert.ok(paths.includes('/stats'));
      assert.ok(paths.includes('/admin/reload'));
    });

    it('OpenAPI spec includes all expected schemas', async () => {
      const result = await fetchJSON(`${BASE_URL}/api-docs/openapi.json`);
      const schemas = Object.keys(result.data.components.schemas);
      
      assert.ok(schemas.includes('Card'));
      assert.ok(schemas.includes('CardResponse'));
      assert.ok(schemas.includes('CardListResponse'));
      assert.ok(schemas.includes('PaginatedCardData'));
      assert.ok(schemas.includes('CacheStats'));
      assert.ok(schemas.includes('StatsResponse'));
      assert.ok(schemas.includes('ReloadResponse'));
      assert.ok(schemas.includes('SearchParams'));
      assert.ok(schemas.includes('NamedParams'));
    });
  });

  describe('Stats Endpoint', () => {
    it('GET /stats returns 200 with StatsResponse structure', async () => {
      const result = await fetchJSON(`${BASE_URL}/stats`);
      
      assert.equal(result.status, 200);
      assert.equal(typeof result.data, 'object');
      assert.equal(typeof result.data.success, 'boolean');
      
      if (result.data.success) {
        assert.equal(typeof result.data.data, 'object');
        assert.equal(typeof result.data.data.total_cards, 'number');
        assert.equal(typeof result.data.data.total_cache_entries, 'number');
      } else {
        assert.equal(typeof result.data.error, 'string');
      }
    });
  });

  describe('Card Search Endpoint', () => {
    it('GET /cards/search with query returns CardListResponse', async () => {
      const result = await fetchJSON(`${BASE_URL}/cards/search?q=lightning+bolt`);
      
      assert.equal(result.status, 200);
      assert.equal(typeof result.data, 'object');
      assert.equal(result.data.success, true);
      assert.equal(typeof result.data.data, 'object');
      assert.ok(Array.isArray(result.data.data.data));
      assert.equal(typeof result.data.data.total, 'number');
      assert.equal(typeof result.data.data.page, 'number');
      assert.equal(typeof result.data.data.page_size, 'number');
      assert.equal(typeof result.data.data.total_pages, 'number');
      assert.equal(typeof result.data.data.has_more, 'boolean');
    });

    it('GET /cards/search respects pagination parameters', async () => {
      const result = await fetchJSON(`${BASE_URL}/cards/search?q=lightning+bolt&page=1&page_size=5`);
      
      assert.equal(result.status, 200);
      assert.equal(result.data.data.page, 1);
      assert.equal(result.data.data.page_size, 5);
      assert.ok(result.data.data.data.length <= 5);
    });
  });

  describe('Named Card Lookup', () => {
    it('GET /cards/named with fuzzy parameter returns CardResponse', async () => {
      const result = await fetchJSON(`${BASE_URL}/cards/named?fuzzy=light+bolt`);
      
      assert.equal(result.status, 200);
      assert.equal(typeof result.data, 'object');
      assert.equal(typeof result.data.success, 'boolean');
      
      if (result.data.success) {
        assert.equal(typeof result.data.data, 'object');
        assert.equal(typeof result.data.data.id, 'string');
        assert.equal(typeof result.data.data.name, 'string');
      }
    });

    it('GET /cards/named without fuzzy or exact returns 400', async () => {
      const result = await fetchJSON(`${BASE_URL}/cards/named`);
      
      assert.equal(result.status, 400);
      assert.equal(result.data.success, false);
      assert.equal(typeof result.data.error, 'string');
    });
  });

  describe('Response Structure Consistency', () => {
    it('All API responses include success field', async () => {
      const endpoints = [
        '/stats',
        '/cards/search?q=lightning',
        '/cards/named?fuzzy=bolt',
      ];

      for (const endpoint of endpoints) {
        const result = await fetchJSON(`${BASE_URL}${endpoint}`);
        assert.equal(typeof result.data.success, 'boolean', `${endpoint} missing success field`);
      }
    });

    it('Success responses include data field', async () => {
      const result = await fetchJSON(`${BASE_URL}/stats`);
      
      if (result.data.success) {
        assert.notEqual(result.data.data, null);
        assert.notEqual(result.data.data, undefined);
      }
    });

    it('Error responses include error field', async () => {
      const result = await fetchJSON(`${BASE_URL}/cards/named`);
      
      if (!result.data.success) {
        assert.equal(typeof result.data.error, 'string');
      }
    });
  });
});
