import { test, expect } from '@playwright/test';

test.describe('Settings Persistence', () => {
    test('should persist column count after reload', async ({ page }) => {
        await page.goto('/');

        // Wait for the page to fully load and initialize
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1500);

        // Locate the Columns input
        const columnsInput = page.getByLabel('Columns', { exact: true });

        // Ensure it's visible
        await expect(columnsInput).toBeVisible();

        // Change value to 4
        await columnsInput.fill('4');
        await columnsInput.blur(); // Trigger change

        // Verify it's set to 4
        await expect(columnsInput).toHaveValue('4');

        // Wait for settings to be saved (debounce is 1000ms + buffer)
        await page.waitForTimeout(2500);

        // Reload the page
        await page.reload();

        // Wait for page to load
        await page.waitForLoadState('load');
        await page.waitForTimeout(1500);

        // Verify it's still 4
        await expect(columnsInput).toHaveValue('4');
    });
});
