import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));

  console.log("Navigating to http://localhost:5174/");
  await page.goto('http://localhost:5174/');
  
  await page.waitForTimeout(1000);

  console.log("Uploading a dummy image...");
  // Find the file input. Usually it's type="file"
  // Create a dummy image
  const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

  const fileChooserPromise = page.waitForEvent('filechooser');
  // Click the upload section (which usually has "Drop card images here" text)
  await page.getByText(/click to upload/i).click();
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles({
    name: 'dummy.png',
    mimeType: 'image/png',
    buffer: buffer
  });

  await page.waitForTimeout(1000);

  console.log("Clicking Export to PDF...");
  const exportBtn = page.getByRole('button', { name: 'Export to PDF' }).first();
  await exportBtn.click();

  await page.waitForTimeout(3000);

  console.log("Done");
  await browser.close();
})();
