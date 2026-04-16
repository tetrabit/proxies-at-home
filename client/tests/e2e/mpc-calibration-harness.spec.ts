import path from "node:path";
import { expect, test } from "@playwright/test";

const fixturePath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../fixtures/mpc-calibration-regression.v1.json"
);

test("imports calibration fixture and shows x/9 score", async ({ page }) => {
  await page.goto("/");

  await page.getByTestId("open-mpc-calibration-global").click();
  await expect(page.getByTestId("mpc-calibration-modal")).toBeVisible();

  await page
    .getByTestId("mpc-calibration-import-input")
    .setInputFiles(fixturePath);

  await page.getByTestId("mpc-calibration-run").click();

  await expect(page.getByTestId("mpc-calibration-scoreboard")).toContainText(
    "9/9"
  );
});
