import { Loader, UpdateNotification, AboutModal } from "@/components/common";
import { lazy, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { ImageProcessor } from "@/helpers/imageProcessor";
import { useShareUrl } from "@/hooks/useShareUrl";

import { db } from "@/db";
import {
  useCalibrationModalStore,
  useProjectStore,
  useUserPreferencesStore,
} from "@/store";
import { useToastStore } from "@/store/toast";
import { autoRestore } from "@/helpers/autoRestore";

const ProxyBuilderPage = lazy(() => import("@/pages/ProxyBuilderPage"));

function App() {
  const [showAbout, setShowAbout] = useState(false);
  const openCalibrationModal = useCalibrationModalStore(
    (state) => state.openModal
  );

  // Detect and load shared deck from ?share=xxx URL parameter
  useShareUrl();

  // Initialize Project Store
  useEffect(() => {
    let isCancelled = false;

    const initProject = async () => {
      // Check if already initialized to prevent race condition
      const existingProjectId = useProjectStore.getState().currentProjectId;
      if (existingProjectId) return;

      // 1. Load stores first
      await useProjectStore.getState().loadProjects();
      await useUserPreferencesStore.getState().load();

      // Double-check after async load (race condition guard)
      if (isCancelled || useProjectStore.getState().currentProjectId) return;

      const { projects } = useProjectStore.getState();

      // 2a. Auto-restore: if IndexedDB is empty, try to recover from server backups
      if (projects.length === 0) {
        const result = await autoRestore();
        if (result && result.restoredCount > 0) {
          // Reload projects after restore
          await useProjectStore.getState().loadProjects();
          const { projects: restored } = useProjectStore.getState();

          if (restored.length > 0 && !isCancelled) {
            // Show success toast
            const names = result.projectNames.join(", ");
            useToastStore
              .getState()
              .showInfoToast(
                `Restored ${result.restoredCount} project${result.restoredCount > 1 ? "s" : ""} from server: ${names}`
              );

            // Switch to the most recently updated project
            await useProjectStore.getState().switchProject(restored[0].id);
            return; // Done — skip default project creation
          }
        }
      }

      // 2. Ensure userPreferences record exists
      let userPrefs = await db.userPreferences.get("default");
      if (!userPrefs) {
        await db.userPreferences.add({
          id: "default",
          settings: {},
          favoriteCardbacks: [],
        });
        userPrefs = await db.userPreferences.get("default");
      }

      // 3. Determine which project to load
      let targetProjectId: string | undefined;

      // Priority 1: Last opened project (if it still exists)
      if (userPrefs?.lastProjectId) {
        const exists = projects.find((p) => p.id === userPrefs!.lastProjectId);
        if (exists) {
          targetProjectId = userPrefs.lastProjectId;
        }
      }

      // Priority 2: First available project
      if (!targetProjectId && projects.length > 0) {
        targetProjectId = projects[0].id;
      }

      // Priority 3: Create new project (only if truly empty)
      if (!targetProjectId) {
        // Final guard - check one more time before creating
        if (isCancelled) return;
        targetProjectId = await useProjectStore
          .getState()
          .createProject("My Project");
      }

      // 4. Switch to target project
      if (!isCancelled) {
        await useProjectStore.getState().switchProject(targetProjectId);
      }
    };

    initProject();

    return () => {
      isCancelled = true;
    };
  }, []);

  // Listen for Electron "About" menu click and settings button click
  useEffect(() => {
    // Electron menu handler
    if (window.electronAPI?.onShowAbout) {
      window.electronAPI.onShowAbout(() => {
        setShowAbout(true);
      });
    }

    // Settings button handler (works in web and Electron)
    const handleOpenAbout = () => setShowAbout(true);
    window.addEventListener("open-about-modal", handleOpenAbout);

    // Pre-warm workers
    ImageProcessor.getInstance().prewarm();

    return () =>
      window.removeEventListener("open-about-modal", handleOpenAbout);
  }, []);

  return (
    <>
      <h1 className="sr-only">Proxxied — MTG Proxy Builder and Print</h1>

      <Loader />
      <UpdateNotification />
      <AboutModal isOpen={showAbout} onClose={() => setShowAbout(false)} />

      <button
        type="button"
        className="fixed top-4 right-4 z-50 rounded-full bg-purple-600 p-3 text-white shadow-lg hover:bg-purple-700"
        data-testid="open-mpc-calibration-global"
        aria-label="Open MPC Calibration Harness"
        onClick={() =>
          openCalibrationModal({
            cardUuid: "global-calibration",
            card: {
              uuid: "global-calibration",
              name: "Calibration Session",
              order: 0,
              isUserUpload: false,
            },
          })
        }
      >
        <Sparkles className="size-5" />
      </button>

      <ProxyBuilderPage />
    </>
  );
}

export default App;
