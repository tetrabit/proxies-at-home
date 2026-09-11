import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:5173";
const cardName = process.env.SMOKE_CARD_NAME ?? "Sol Ring";
const timestamp = new Date().toISOString().replaceAll(":", "-");
const artifactDir = path.resolve(
  process.env.SMOKE_ARTIFACT_DIR ??
    `.review-artifacts/mpc-upgrade-smoke-${timestamp}`
);
const profileDir = path.join(artifactDir, "profile");
const screenshotPath = path.join(artifactDir, "mpc-upgrade.png");
const reportPath = path.join(artifactDir, "smoke.json");

await mkdir(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  viewport: { width: 1440, height: 1000 },
});

try {
  const page = context.pages()[0] ?? (await context.newPage());
  const events = {
    console: [],
    pageErrors: [],
    network: { mpcSearch: {}, mpcImages: {} },
  };

  page.on("console", (message) => {
    if (message.type() === "error" || /mpc/i.test(message.text())) {
      events.console.push({ type: message.type(), text: message.text() });
    }
  });
  page.on("pageerror", (error) => events.pageErrors.push(error.message));
  page.on("response", (response) => {
    const category = /\/api\/mpcfill\/search/.test(response.url())
      ? "mpcSearch"
      : /\/api\/cards\/images\/mpc/.test(response.url())
        ? "mpcImages"
        : null;
    if (category) {
      const status = String(response.status());
      events.network[category][status] =
        (events.network[category][status] ?? 0) + 1;
    }
  });

  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
  await page.getByPlaceholder(/1x Sol Ring/).first().fill(`1 ${cardName}`);
  await page.getByRole("button", { name: "Fetch Cards", exact: true }).first().click();

  const importedCard = page.locator("[data-dnd-sortable-item]").first();
  await importedCard.waitFor({ state: "visible", timeout: 90_000 });
  await importedCard.click({ button: "right" });
  await page.getByTestId("card-context-menu-mpc-upgrade").click();

  const modal = page.getByRole("dialog", { name: new RegExp(`MPC Upgrade — ${cardName}`, "i") });
  await modal.waitFor({ state: "visible", timeout: 10_000 });
  const candidates = modal.getByTestId("mpc-upgrade-recommendation-card");
  await candidates.first().waitFor({ state: "visible", timeout: 90_000 });

  const candidateCount = await candidates.count();
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const report = {
    baseUrl,
    cardName,
    candidateCount,
    modalText: (await modal.innerText()).slice(0, 5_000),
    events,
    screenshotPath,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ candidateCount, reportPath, screenshotPath }, null, 2));

  if (candidateCount === 0) process.exitCode = 1;
} finally {
  await context.close();
}
