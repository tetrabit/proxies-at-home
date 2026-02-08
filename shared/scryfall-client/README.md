# Scryfall Cache API Client

Auto-generated TypeScript client for the Scryfall Cache Microservice.

## Installation

This is a shared module used internally in the project.

## Usage

```typescript
import { ScryfallCacheClient, Card } from 'scryfall-cache-client';

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
```

## Regenerating

Run `npm run generate:api-client` to regenerate the client from the latest OpenAPI spec.

The microservice must be running at `http://localhost:8080` (or set `SCRYFALL_CACHE_URL` env var).
