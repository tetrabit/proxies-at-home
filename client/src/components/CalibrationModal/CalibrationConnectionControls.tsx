import { Button } from "flowbite-react";
import { useEffect, useRef, useState } from "react";
import { db } from "@/db";
import { pairMpcCalibrationWeb } from "@/helpers/mpcCalibrationWebPairing";
import { createMpcCalibrationOperationScope } from "@/helpers/mpcCalibrationOperationScope";
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
  const [pairing, setPairing] = useState(false);
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

  const beginWebPairing = () => {
    cancelPairing();
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
        setMessage("Web service paired. Connecting sync…");
        return;
      }
      setMessage(result.kind === "cancelled" ? "Web pairing cancelled." : pairingLabels[result.status]);
    });
  };

  const connectElectron = () => {
    if (!electronServiceAvailable()) {
      setMessage("Configured Electron service is unavailable.");
      return;
    }
    selectLinked("linked-electron");
    setMessage("Connecting configured Electron service…");
  };

  const disable = () => {
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
      </div>
      <p data-testid="mpc-calibration-connection-message" className="text-xs text-gray-600 dark:text-gray-300" aria-live="polite">
        {message ?? `Connection status: ${status}.`}
      </p>
    </section>
  );
}
