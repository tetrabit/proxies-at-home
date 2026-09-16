import { Button } from "flowbite-react";
import { useEffect, useRef, useState } from "react";
import { db } from "@/db";
import { pairMpcCalibrationWeb } from "@/helpers/mpcCalibrationWebPairing";
import { createMpcCalibrationOperationScope } from "@/helpers/mpcCalibrationOperationScope";
import { selectMpcCalibrationTransport } from "@/helpers/mpcCalibrationTransportSelection";
import {
  MpcCalibrationReconciliationError,
  reconcileMpcCalibrationMerge,
  resetMpcCalibrationToRemote,
} from "@/helpers/mpcCalibrationReconcileAction";
import { useMpcCalibrationSyncStore } from "@/store/mpcCalibrationSync";

const pairingLabels = {
  offline: "Web service is offline.",
  authentication: "Web service authentication failed.",
  "invalid-operation": "Web pairing is unavailable.",
  unavailable: "Web pairing is unavailable.",
} as const;

type ActivePairing = Readonly<{
  scope: ReturnType<typeof createMpcCalibrationOperationScope>;
  operation: ReturnType<ReturnType<typeof createMpcCalibrationOperationScope>["captureUiOperation"]>;
  input: HTMLInputElement;
  inputGeneration: number;
  selectionRevision: number;
  selection: ReturnType<typeof useMpcCalibrationSyncStore.getState>["selection"];
}>;

type ConnectionProgress = Readonly<{
  selectionRevision: number;
  target: "linked-web" | "linked-electron";
  message: string;
}>;

function sameSelection(
  current: ReturnType<typeof useMpcCalibrationSyncStore.getState>,
  active: ActivePairing,
): boolean {
  if (current.selectionRevision !== active.selectionRevision) return false;
  return current.selection.kind === active.selection.kind
    && (current.selection.kind !== "linked"
      || active.selection.kind === "linked" && current.selection.target === active.selection.target);
}

function electronRenderer(): boolean {
  try {
    return typeof window !== "undefined"
      && typeof window.electronAPI !== "undefined";
  } catch {
    return false;
  }
}

function electronServiceAvailable(): boolean {
  try {
    return typeof window !== "undefined"
      && typeof window.electronAPI?.calibrationHarnessExecute === "function";
  } catch {
    return false;
  }
}

/**
 * Explicit renderer controls. Credential bytes remain in the uncontrolled input
 * and the exact current input generation only; neither store nor status owns it.
 */
export function CalibrationConnectionControls() {
  const selection = useMpcCalibrationSyncStore((state) => state.selection);
  const selectionRevision = useMpcCalibrationSyncStore((state) => state.selectionRevision);
  const status = useMpcCalibrationSyncStore((state) => state.status);
  const selectLinked = useMpcCalibrationSyncStore((state) => state.selectLinked);
  const disableCurrentConnection = useMpcCalibrationSyncStore((state) => state.disableCurrentConnection);
  const credentialInput = useRef<HTMLInputElement | null>(null);
  const credentialGeneration = useRef(0);
  const activePairing = useRef<ActivePairing | null>(null);
  const uiEpoch = useRef(0);
  const renderedUiKey = useRef<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionProgress, setConnectionProgress] = useState<ConnectionProgress | null>(null);
  const [pairing, setPairing] = useState(false);
  const [reconciling, setReconciling] = useState<"merge" | "reset" | null>(null);
  const isElectron = electronRenderer();
  const uiKey = `${isElectron}:${selectionRevision}`;
  if (renderedUiKey.current !== uiKey) {
    renderedUiKey.current = uiKey;
    uiEpoch.current += 1;
  }

  const clearActiveCredential = (active: ActivePairing) => {
    if (credentialInput.current === active.input && credentialGeneration.current === active.inputGeneration) {
      active.input.value = "";
    }
  };

  const abortActivePairing = () => {
    const active = activePairing.current;
    if (active === null) return;
    activePairing.current = null;
    active.scope.dispose();
    setPairing(false);
  };

  const cancelPairing = () => {
    const active = activePairing.current;
    if (active === null) return;
    clearActiveCredential(active);
    abortActivePairing();
    setConnectionProgress(null);
    setMessage("Web pairing cancelled.");
  };

  useEffect(() => {
    const active = activePairing.current;
    if (active !== null && !sameSelection(useMpcCalibrationSyncStore.getState(), active)) {
      abortActivePairing();
    }
  }, [isElectron, selection, selectionRevision]);

  useEffect(() => {
    const input = credentialInput.current;
    return () => {
      uiEpoch.current += 1;
      abortActivePairing();
      if (input !== null) input.value = "";
    };
  }, []);

  useEffect(() => {
    // A re-selection (or any lifecycle re-run) supersedes an in-flight
    // reconciliation; the new admission owns the queue/hydration from here.
    setReconciling(null);
  }, [selectionRevision]);

  /**
   * Explicit conflict recovery. "merge" keeps every local row, adds the
   * remote-only rows, and queues the union for the existing publish path;
   * "reset" discards the local calibration tables so the next admission
   * re-pairs and re-hydrates from the remote snapshot. Both re-select the
   * linked target so the lifecycle re-admits.
   */
  const reconcile = (mode: "merge" | "reset") => {
    const state = useMpcCalibrationSyncStore.getState();
    if (state.selection.kind !== "linked") return;
    const target = state.selection.target;
    const epoch = uiEpoch.current;
    const selectionSnapshot = state.selectionRevision;
    const stillCurrent = () => uiEpoch.current === epoch
      && useMpcCalibrationSyncStore.getState().selectionRevision === selectionSnapshot;
    setReconciling(mode);
    const finish = (nextMessage: string) => {
      if (!stillCurrent()) return;
      setMessage(nextMessage);
      useMpcCalibrationSyncStore.getState().selectLinked(target);
    };
    const fail = (caught: unknown) => {
      if (!stillCurrent()) return;
      setMessage(
        caught instanceof MpcCalibrationReconciliationError
          ? caught.message
          : "Reconciliation failed unexpectedly; try Reset to remote.",
      );
    };
    const done = () => {
      if (stillCurrent()) setReconciling(null);
    };
    if (mode === "merge") {
      void reconcileMpcCalibrationMerge({
        database: db,
        transport: selectMpcCalibrationTransport({ target }),
      })
        .then((result) => finish(
          `Merged local and remote (${result.delta.cases} remote case${result.delta.cases === 1 ? "" : "s"}, ${result.delta.assets} assets added); publishing…`,
        ))
        .catch(fail)
        .finally(done);
      return;
    }
    void resetMpcCalibrationToRemote(db)
      .then(() => finish("Local calibration data cleared. Reconnecting to the remote snapshot…"))
      .catch(fail)
      .finally(done);
  };

  const beginWebPairing = () => {
    cancelPairing();
    setConnectionProgress(null);
    const input = credentialInput.current;
    if (input === null) return;
    const state = useMpcCalibrationSyncStore.getState();
    const scope = createMpcCalibrationOperationScope({
      target: "linked-web",
      identity: null,
      controller: "calibration-modal-web-pairing",
    });
    const capturedOperation = scope.captureUiOperation();
    const operation = {
      ...capturedOperation,
      isCurrent() {
        return capturedOperation.isCurrent.call(capturedOperation)
          && sameSelection(useMpcCalibrationSyncStore.getState(), active);
      },
    };
    const active: ActivePairing = {
      scope,
      operation,
      input,
      inputGeneration: credentialGeneration.current,
      selectionRevision: state.selectionRevision,
      selection: state.selection,
    };
    activePairing.current = active;
    setPairing(true);
    setMessage("Pairing web service…");

    void pairMpcCalibrationWeb({
      database: db,
      target: "linked-web",
      operation,
      transientCredential: {
        take: () => input.value,
        clear: () => {
          clearActiveCredential(active);
        },
      },
    }).then((result) => {
      if (activePairing.current !== active) return;
      activePairing.current = null;
      scope.dispose();
      setPairing(false);
      const current = useMpcCalibrationSyncStore.getState();
      if (!sameSelection(current, active)) return;
      if (result.kind === "paired") {
        selectLinked("linked-web");
        const selected = useMpcCalibrationSyncStore.getState();
        if (selected.selection.kind === "linked" && selected.selection.target === "linked-web") {
          setMessage(null);
          setConnectionProgress({
            selectionRevision: selected.selectionRevision,
            target: "linked-web",
            message: "Web service paired. Connecting sync…",
          });
        }
        return;
      }
      setConnectionProgress(null);
      setMessage(result.kind === "cancelled" ? "Web pairing cancelled." : pairingLabels[result.status]);
    });
  };

  const connectElectron = () => {
    if (!electronServiceAvailable()) {
      setConnectionProgress(null);
      setMessage("Configured Electron service is unavailable.");
      return;
    }
    setConnectionProgress(null);
    setMessage(null);
    selectLinked("linked-electron");
    const selected = useMpcCalibrationSyncStore.getState();
    if (selected.selection.kind === "linked" && selected.selection.target === "linked-electron") {
      setConnectionProgress({
        selectionRevision: selected.selectionRevision,
        target: "linked-electron",
        message: "Connecting configured Electron service…",
      });
    }
  };

  const disable = () => {
    setConnectionProgress(null);
    setMessage(null);
    const epoch = uiEpoch.current;
    const selectionSnapshot = useMpcCalibrationSyncStore.getState().selectionRevision;
    const current = () => uiEpoch.current === epoch
      && useMpcCalibrationSyncStore.getState().selectionRevision === selectionSnapshot;
    void Promise.resolve()
      .then(disableCurrentConnection)
      .then((result) => {
        if (!current()) return;
        if (result === undefined) {
          setMessage("No active linked connection can be disabled.");
          return;
        }
        if (result.kind === "disabled") {
          setMessage("Calibration sync disabled locally.");
          return;
        }
        setMessage(result.kind === "cancelled" ? "Disable request cancelled." : pairingLabels[result.status]);
      })
      .catch(() => {
        if (current()) setMessage("Unable to disable calibration sync.");
      });
  };

  const linked = selection.kind === "linked";
  const connectionProgressIsCurrent = connectionProgress !== null
    && selection.kind === "linked"
    && selection.target === connectionProgress.target
    && selectionRevision === connectionProgress.selectionRevision;
  const displayedMessage = message
    ?? (connectionProgressIsCurrent && status === "authenticating"
      ? connectionProgress.message
      : `Connection status: ${status}.`);
  return (
    <section className="mt-3 space-y-2" aria-label="Calibration sync connection controls">
      <div className="flex flex-wrap gap-2">
        {isElectron ? (
          <Button size="xs" color="light" onClick={connectElectron}>
            Connect configured service
          </Button>
        ) : <>
          <label className="block text-xs text-gray-500 dark:text-gray-400" htmlFor="mpc-calibration-web-credential">
            Web pairing credential
          </label>
          <input
            ref={credentialInput}
            id="mpc-calibration-web-credential"
            data-testid="mpc-calibration-web-credential"
            type="password"
            autoComplete="off"
            className="w-full rounded border px-2 py-1 text-sm dark:bg-gray-800"
            onChange={() => { credentialGeneration.current += 1; }}
          />
          <Button size="xs" color="purple" onClick={beginWebPairing} disabled={pairing}>
            Pair web service
          </Button>
          {pairing ? (
            <Button size="xs" color="light" onClick={cancelPairing}>Cancel web pairing</Button>
          ) : null}
        </>}
        {linked ? (
          <Button size="xs" color="failure" onClick={disable}>
            Disable calibration sync
          </Button>
        ) : null}
        {linked && (status === "conflict" || status === "blocked") && reconciling === null ? (
          <>
            {status === "conflict" ? (
              <Button size="xs" color="purple" onClick={() => reconcile("merge")}>
                Merge local and remote
              </Button>
            ) : null}
            <Button size="xs" color="light" onClick={() => reconcile("reset")}>
              Reset to remote
            </Button>
          </>
        ) : null}
        {linked && reconciling !== null ? (
          <Button size="xs" color="light" disabled>
            {reconciling === "merge" ? "Merging…" : "Resetting…"}
          </Button>
        ) : null}
      </div>
      {linked && (status === "conflict" || status === "blocked") && reconciling === null ? (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {status === "conflict"
            ? "Merge keeps every local capture and adds the remote-only rows."
            : "Reset discards local calibration data and re-downloads the remote snapshot."}
        </p>
      ) : null}
      <p data-testid="mpc-calibration-connection-message" className="text-xs text-gray-600 dark:text-gray-300" aria-live="polite">
        {displayedMessage}
      </p>
    </section>
  );
}
