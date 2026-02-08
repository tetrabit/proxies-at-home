#!/usr/bin/env node

/**
 * Script to generate TypeScript client from OpenAPI spec
 * Fetches the spec from the running Scryfall Cache microservice
 * and generates a typed TypeScript client.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MICROSERVICE_URL = process.env.SCRYFALL_CACHE_URL || 'http://localhost:8080';
const SPEC_URL = `${MICROSERVICE_URL}/api-docs/openapi.json`;
const OUTPUT_DIR = path.join(__dirname, '../shared/scryfall-api-client');
const TEMP_SPEC = path.join(__dirname, '../shared/openapi-spec.json');

console.log('🚀 Generating TypeScript client for Scryfall Cache API...\n');

// Step 1: Fetch OpenAPI spec
console.log(`📥 Fetching OpenAPI spec from ${SPEC_URL}...`);
try {
  const response = execSync(`curl -s ${SPEC_URL}`, { encoding: 'utf-8' });
  fs.writeFileSync(TEMP_SPEC, response);
  console.log('✅ OpenAPI spec downloaded\n');
} catch (error) {
  console.error('❌ Failed to fetch OpenAPI spec. Is the microservice running?');
  console.error('   Start it with: cd /path/to/scryfall-cache-microservice && cargo run');
  process.exit(1);
}

// Step 2: Generate TypeScript client
console.log('🔧 Generating TypeScript client...');
try {
  execSync(
    `npx openapi-generator-cli generate \
      -i ${TEMP_SPEC} \
      -g typescript-axios \
      -o ${OUTPUT_DIR} \
      --additional-properties=supportsES6=true,withSeparateModelsAndApi=true`,
    { stdio: 'inherit' }
  );
  console.log('✅ TypeScript client generated\n');
} catch (error) {
  console.error('❌ Failed to generate client');
  process.exit(1);
}

// Step 3: Clean up
fs.unlinkSync(TEMP_SPEC);
console.log('🎉 Done! Client available at:', OUTPUT_DIR);
console.log('\nUsage example:');
console.log('  import { CardsApi, Configuration } from "@/shared/scryfall-api-client";');
console.log('  const api = new CardsApi(new Configuration({ basePath: "http://localhost:8080" }));');
console.log('  const cards = await api.searchCards({ q: "lightning bolt" });');
