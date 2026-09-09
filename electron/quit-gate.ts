export interface BeforeQuitEvent {
  preventDefault(): void;
}

export interface QuitGateApp {
  on(event: "before-quit", listener: (event: BeforeQuitEvent) => void): void;
  quit(): void;
}

export interface QuitGateOptions {
  timeoutMs?: number;
  logger?: (message: string, error?: unknown) => void;
}

/** Registers the single cleanup/reentry gate used by every desktop quit path. */
export function registerMicroserviceQuitGate(
  appLike: QuitGateApp,
  stopMicroservice: () => Promise<void>,
  { timeoutMs = 5000, logger = console.error }: QuitGateOptions = {}
): void {
  let isQuitReentryAllowed = false;
  let quitCleanupPromise: Promise<void> | null = null;

  appLike.on("before-quit", (event) => {
    if (isQuitReentryAllowed) {
      return;
    }

    event.preventDefault();
    if (quitCleanupPromise) {
      return;
    }

    quitCleanupPromise = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          logger("[Electron] Timed out stopping Scryfall microservice during quit.");
          resolve();
        }, timeoutMs);
      });

      try {
        await Promise.race([stopMicroservice(), timeoutPromise]);
      } catch (error) {
        logger("[Electron] Failed to stop Scryfall microservice during quit:", error);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        isQuitReentryAllowed = true;
        appLike.quit();
      }
    })();
  });
}
