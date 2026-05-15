import { expect, test } from "@playwright/test";

test.describe("MPC Calibration Modal Stress Test", () => {
  test.beforeEach(async ({ page }) => {
    // Intercept MPC search to return many candidates for each seed to stress the visual profiler
    await page.route("**/api/mpcfill/search", async (route) => {
      const postData = route.request().postDataJSON();
      const query = postData?.query || "unknown";
      const candidates = [
        {
          identifier: `id-${query}-1`,
          name: query,
          rawName: `${query} [SET1]`,
          smallThumbnailUrl: "/api/cards/images/proxy?url=mock-img-1",
          mediumThumbnailUrl: "/api/cards/images/proxy?url=mock-img-1",
          dpi: 600,
          tags: [],
          sourceName: "Hathwellcrisping",
        },
        {
          identifier: `id-${query}-2`,
          name: query,
          rawName: `${query} [SET2]`,
          smallThumbnailUrl: "/api/cards/images/proxy?url=mock-img-2",
          mediumThumbnailUrl: "/api/cards/images/proxy?url=mock-img-2",
          dpi: 800,
          tags: [],
          sourceName: "Chilli_Axe",
        },
        {
          identifier: `id-${query}-3`,
          name: query,
          rawName: `${query} [SET3]`,
          smallThumbnailUrl: "/api/cards/images/proxy?url=mock-img-3",
          mediumThumbnailUrl: "/api/cards/images/proxy?url=mock-img-3",
          dpi: 1200,
          tags: [],
          sourceName: "Hathwellcrisping",
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ cards: candidates }),
      });
    });

    // Intercept batch search used by some components
    await page.route("**/api/mpcfill/batch-search", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ results: {} }),
      });
    });

    // Intercept image proxy to return a tiny valid PNG
    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
      "base64"
    );
    await page.route("**/api/cards/images/proxy*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: tinyPng,
      });
    });

    // Intercept calibration API calls to prevent backend dependency
    await page.route("**/api/calibration/**", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, cases: [], datasets: [] }),
      });
    });

    await page.goto("/");
  });

  test("should open Calibration Modal and perform heavy bootstrap without crashing", async ({
    page,
  }) => {
    // 1. Ensure page is loaded
    await expect(page).toHaveTitle(/Proxxied/);

    // 2. Open Calibration Modal directly from the Upload Section
    const calibrationTrigger = page.getByTestId("open-mpc-calibration-harness");
    await expect(calibrationTrigger).toBeVisible({ timeout: 10000 });
    await calibrationTrigger.click();

    // 3. Monitor for modal appearance
    await expect(page.getByText("MPC Auto-Selection Calibration")).toBeVisible({
      timeout: 15000,
    });

    // 4. Verify bootstrap starts and finishes (transition to "Active Capture" or similar state)
    // The "Cases captured" text appears once the dataset is ensured and cases listed
    await expect(page.getByText(/cases captured/i)).toBeVisible({
      timeout: 60000,
    });

    // 5. Stress: Rapidly close and re-open to verify AbortSignal propagation
    // Try clicking the close button explicitly
    console.log("Attempting to close modal...");
    const closeButton = page.getByTestId("calibration-modal-close");
    await closeButton.click();

    await expect(
      page.getByText("MPC Auto-Selection Calibration")
    ).not.toBeVisible({ timeout: 15000 });
    console.log("Modal closed successfully.");

    await calibrationTrigger.click();
    await expect(
      page.getByText("MPC Auto-Selection Calibration")
    ).toBeVisible();
    console.log("Modal re-opened successfully.");

    // 6. Verify responsiveness - try to click a button in the modal
    // Note: The bootstrap might still be running, so we wait for the "Import" button to be enabled
    const importButton = page.getByRole("button", { name: "Import" });
    await expect(importButton).toBeEnabled({ timeout: 30000 });
    console.log("Bootstrap finished after re-open.");

    // No crash!
    expect(true).toBe(true);
  });
});
