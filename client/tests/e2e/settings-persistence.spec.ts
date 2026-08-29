import { test, expect, type Page } from '@playwright/test';

async function readActiveProjectColumns(page: Page): Promise<number | null> {
    return page.evaluate(async () => {
        const openRequest = indexedDB.open('ProxxiedDB');
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            openRequest.onsuccess = () => resolve(openRequest.result);
            openRequest.onerror = () => reject(openRequest.error);
        });
        if (
            !database.objectStoreNames.contains('projects') ||
            !database.objectStoreNames.contains('userPreferences')
        ) {
            database.close();
            return null;
        }
        const transaction = database.transaction(['projects', 'userPreferences'], 'readonly');
        const read = <T>(store: string, key: IDBValidKey) =>
            new Promise<T | undefined>((resolve, reject) => {
                const request = transaction.objectStore(store).get(key);
                request.onsuccess = () => resolve(request.result as T | undefined);
                request.onerror = () => reject(request.error);
            });
        const preferences = await read<{ lastProjectId?: string }>('userPreferences', 'default');
        if (!preferences?.lastProjectId) {
            database.close();
            return null;
        }
        const project = await read<{ settings?: { columns?: number } }>(
            'projects',
            preferences.lastProjectId
        );
        database.close();
        return project?.settings?.columns ?? null;
    });
}

test.describe('Settings Persistence', () => {
    test('should persist column count after reload', async ({ page }) => {
        await page.route('**/api/backup', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ backups: [] }),
            });
        });
        await page.goto('/');

        const columnsInput = page.getByLabel('Columns', { exact: true });
        await expect(columnsInput).toBeVisible();
        await expect
            .poll(() => readActiveProjectColumns(page), { timeout: 30000 })
            .not.toBeNull();

        await columnsInput.fill('4');
        await columnsInput.blur();
        await expect(columnsInput).toHaveValue('4');
        await expect
            .poll(() => readActiveProjectColumns(page), { timeout: 30000 })
            .toBe(4);

        await page.reload();
        await expect
            .poll(() => readActiveProjectColumns(page), { timeout: 30000 })
            .toBe(4);
        await expect(columnsInput).toHaveValue('4');
    });
});
