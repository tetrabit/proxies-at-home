import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  importMissingTokens: vi.fn(),
  settings: {
    autoImportTokens: false,
  },
}));

vi.mock("./ImportOrchestrator", () => ({
  ImportOrchestrator: {
    importMissingTokens: hoisted.importMissingTokens,
  },
}));

vi.mock("@/store/settings", () => ({
  useSettingsStore: {
    getState: vi.fn(() => hoisted.settings),
  },
}));

import { handleAutoImportTokens, handleManualTokenImport } from "./tokenImportHelper";

describe("handleAutoImportTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.settings.autoImportTokens = false;
  });

  it("does not run when autoImportTokens=false and force is not set", async () => {
    await handleAutoImportTokens();
    expect(hoisted.importMissingTokens).not.toHaveBeenCalled();
  });

  it("runs when autoImportTokens=false but force=true (manual action)", async () => {
    await handleAutoImportTokens({ force: true, silent: false });
    expect(hoisted.importMissingTokens).toHaveBeenCalledTimes(1);
  });

  it("passes through abort signal and callbacks", async () => {
    const controller = new AbortController();
    const onComplete = vi.fn();
    const onNoTokens = vi.fn();
    await handleAutoImportTokens({ force: true, signal: controller.signal, onComplete, onNoTokens, silent: true });
    expect(hoisted.importMissingTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: controller.signal,
        onComplete,
        onNoTokens,
      })
    );
  });
});

describe("handleManualTokenImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.settings.autoImportTokens = false;
  });

  it("always runs regardless of autoImportTokens setting", async () => {
    hoisted.settings.autoImportTokens = false;
    await handleManualTokenImport();
    expect(hoisted.importMissingTokens).toHaveBeenCalledTimes(1);
  });

  it("always uses skipExisting=true and forceRefresh=true", async () => {
    await handleManualTokenImport({ silent: false });
    expect(hoisted.importMissingTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        skipExisting: true,
        forceRefresh: true,
      })
    );
  });

  it("passes through signal and callbacks", async () => {
    const controller = new AbortController();
    const onComplete = vi.fn();
    const onNoTokens = vi.fn();
    await handleManualTokenImport({ signal: controller.signal, onComplete, onNoTokens });
    expect(hoisted.importMissingTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        skipExisting: true,
        forceRefresh: true,
        signal: controller.signal,
        onComplete,
        onNoTokens,
      })
    );
  });
});

