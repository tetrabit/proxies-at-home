import { expect, test } from '@playwright/test';

test('downloads a local valid US Letter calibration PDF without a private API request', async ({ page }) => {
  const privateCalibrationRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/printer-calibration')) {
      privateCalibrationRequests.push(request.url());
    }
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Printer Calibration (Translation)' }).click();

  const downloadButton = page.getByRole('button', { name: 'Download Calibration Sheet (US Letter)' });
  await expect(downloadButton).toBeEnabled();

  const downloadPromise = page.waitForEvent('download');
  await downloadButton.click();
  const download = await downloadPromise;
  const filePath = await download.path();

  expect(download.suggestedFilename()).toBe('printer_calibration_sheet.pdf');
  expect(filePath).not.toBeNull();
  const bytes = await (await import('node:fs/promises')).readFile(filePath!);
  expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  expect(privateCalibrationRequests).toEqual([]);
});
