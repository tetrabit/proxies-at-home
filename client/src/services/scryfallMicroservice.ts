/**
 * Scryfall Microservice Integration
 * 
 * This module provides a bridge between the Electron IPC layer and the Scryfall microservice client.
 * It automatically discovers the microservice URL from Electron and provides a ready-to-use client.
 */

import { ScryfallCacheClient } from '../../../shared/scryfall-client/index';

let clientInstance: ScryfallCacheClient | null = null;

/**
 * Get or create the Scryfall client instance
 * Automatically discovers microservice URL from Electron
 */
export async function getScryfallClient(): Promise<ScryfallCacheClient> {
    if (clientInstance) {
        return clientInstance;
    }

    // Get microservice URL from Electron IPC
    const microserviceUrl = await window.electronAPI.getMicroserviceUrl();
    
    clientInstance = new ScryfallCacheClient({
        baseUrl: microserviceUrl,
        timeout: 30000,
    });

    return clientInstance;
}

/**
 * Example: Search for cards by name
 */
export async function searchCardsByName(query: string, page = 1) {
    const client = await getScryfallClient();
    
    try {
        const response = await client.searchCards({
            q: query,
            page: page.toString(),
        });
        
        return response;
    } catch (error) {
        console.error('Failed to search cards:', error);
        throw error;
    }
}

/**
 * Example: Get card by exact name
 */
export async function getCardByName(name: string, set?: string) {
    const client = await getScryfallClient();
    
    try {
        const response = await client.getCardByName({
            exact: name,
            ...(set && { set }),
        });
        
        return response;
    } catch (error) {
        console.error('Failed to get card by name:', error);
        throw error;
    }
}

/**
 * Example: Get card by ID
 */
export async function getCardById(id: string) {
    const client = await getScryfallClient();
    
    try {
        const response = await client.getCard(id);
        return response;
    } catch (error) {
        console.error('Failed to get card by ID:', error);
        throw error;
    }
}

/**
 * Example: Get cache statistics
 */
export async function getCacheStats() {
    const client = await getScryfallClient();
    
    try {
        const response = await client.getStats();
        return response;
    } catch (error) {
        console.error('Failed to get cache stats:', error);
        throw error;
    }
}

/**
 * Example: Check microservice health
 */
export async function checkMicroserviceHealth() {
    const client = await getScryfallClient();
    
    try {
        const response = await client.health();
        return response;
    } catch (error) {
        console.error('Microservice health check failed:', error);
        return { status: 'unhealthy', error: String(error) };
    }
}
