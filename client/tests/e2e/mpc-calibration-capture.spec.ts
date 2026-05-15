import { expect, test } from "@playwright/test";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64"
);

async function mockCalibrationNetwork(page: import("@playwright/test").Page) {
  await page.route("**/api/backup", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ backups: [] }),
    });
  });

  await page.route("**/api/mpcfill/search", async (route) => {
    const postData = route.request().postDataJSON();
    const query = postData?.query || "Sol Ring";
    const expectedName = `${query} [C21] {267}`;
    const otherName = `${query} [ALT] {1}`;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        cards: [
          {
            identifier: "mpc-expected",
            name: expectedName,
            rawName: expectedName,
            smallThumbnailUrl: "/api/cards/images/mpc?id=mpc-expected&size=small",
            mediumThumbnailUrl:
              "/api/cards/images/mpc?id=mpc-expected&size=large",
            dpi: 1200,
            tags: ["clean"],
            sourceName: "Expected Source",
            source: "Expected Source",
            extension: "png",
            size: 100,
          },
          {
            identifier: "mpc-other",
            name: otherName,
            rawName: otherName,
            smallThumbnailUrl: "/api/cards/images/mpc?id=mpc-other&size=small",
            mediumThumbnailUrl: "/api/cards/images/mpc?id=mpc-other&size=large",
            dpi: 600,
            tags: [],
            sourceName: "Other Source",
            source: "Other Source",
            extension: "png",
            size: 100,
          },
        ],
      }),
    });
  });

  await page.route("**/api/cards/images/proxy*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: tinyPng,
    });
  });

  await page.route("**/api/cards/images/mpc*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: tinyPng,
    });
  });
}

async function seedCalibrationCard(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const request = indexedDB.open("ProxxiedDB");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });

    await new Promise<void>((resolve, reject) => {
      const requestedStores = [
        "projects",
        "userPreferences",
        "cards",
        "images",
        "mpcSearchCache",
        "mpcCalibrationDatasets",
        "mpcCalibrationCases",
        "mpcCalibrationAssets",
        "mpcCalibrationRuns",
      ];
      const stores = requestedStores.filter((storeName) =>
        db.objectStoreNames.contains(storeName)
      );
      const tx = db.transaction(stores, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);

      for (const storeName of stores) {
        tx.objectStore(storeName).clear();
      }

      const now = Date.now();
      tx.objectStore("projects").put({
        id: "e2e-project",
        name: "E2E Calibration Project",
        createdAt: now,
        lastOpenedAt: now,
        cardCount: 1,
        settings: {},
      });
      tx.objectStore("userPreferences").put({
        id: "default",
        settings: {},
        favoriteCardbacks: [],
        lastProjectId: "e2e-project",
      });
      tx.objectStore("images").put({
        id: "e2e-image",
        refCount: 1,
        sourceUrl:
          "https://cards.scryfall.io/normal/front/e/2/e2e-sol-ring.jpg",
      });
      tx.objectStore("cards").put({
        uuid: "e2e-card",
        name: "Sol Ring",
        order: 10,
        imageId: "e2e-image",
        isUserUpload: false,
        set: "C21",
        number: "267",
        projectId: "e2e-project",
      });
    });

    db.close();
  });
}

test("captures an expected MPC choice and runs calibration from a real card", async ({
  page,
}) => {
  await mockCalibrationNetwork(page);

  await page.goto("/");
  await expect(page).toHaveTitle(/Proxxied/);
  await expect(page.getByTestId("open-mpc-calibration-harness")).toBeVisible({
    timeout: 30_000,
  });
  await seedCalibrationCard(page);
  await page.reload();

  const firstCard = page.locator("[data-dnd-sortable-item]").first();
  await expect(firstCard).toBeVisible({ timeout: 30_000 });
  await firstCard.click({ button: "right" });
  await page.getByTestId("card-context-menu-mpc-calibration").click();

  await expect(page.getByTestId("mpc-calibration-modal")).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByTestId("mpc-calibration-candidate-mpc-expected")
  ).toBeVisible({ timeout: 30_000 });

  await page
    .getByTestId("mpc-calibration-candidate-mpc-expected")
    .getByRole("button", { name: "Use as Expected Choice" })
    .click();

  await expect(page.getByTestId("mpc-calibration-status")).toContainText(
    "Captured expected choice",
    { timeout: 30_000 }
  );
  await expect(page.getByText(/1 cases captured/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(/Expected:\s*mpc-expected/i)).toBeVisible();

  await page.getByTestId("mpc-calibration-run").click();
  await expect(page.getByTestId("mpc-calibration-scoreboard")).toContainText(
    "1/1",
    { timeout: 30_000 }
  );
});
