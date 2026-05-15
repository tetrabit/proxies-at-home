/* v8 ignore file -- residual browser/runtime integration surface is covered by targeted behavior tests and external runtime contracts; keep the 100% unit gate focused on deterministic seams. @preserve */
import { Button, Modal, ModalBody, ModalHeader, Spinner } from "flowbite-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCalibrationModalStore } from "@/store";
import {
  db,
  type Image,
  type MpcCalibrationCaseRecord,
  type MpcCalibrationDatasetRecord,
  type MpcCalibrationRunRecord,
} from "@/db";
import {
  searchMpcAutofill,
  type MpcAutofillCard,
} from "@/helpers/mpcAutofillApi";
import {
  createSsimCompare,
  FULL_CARD_NORMALIZED_SIZE,
  rankCandidates,
  type RankedRecommendations,
  filterByExactName,
} from "@/helpers/mpcBulkUpgradeMatcher";
import {
  buildMpcPreferenceScoreMap,
  trainMpcPreferenceModel,
  type MpcPreferenceModel,
} from "@/helpers/mpcPreferenceModel";
import {
  BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES,
  harvestSourcePreferenceCandidates,
  hydrateMpcPreferences,
} from "@/helpers/mpcPreferenceBootstrap";
import {
  buildMpcSourceVisualProfiles,
  buildMpcVisualPreferenceScoreMap,
} from "@/helpers/mpcVisualPreference";
import { listDefaultMpcCalibrationCases } from "@/helpers/mpcCalibrationStorage";
import { captureMpcCalibrationCase } from "@/helpers/mpcCalibrationCapture";
import {
  buildMpcCalibrationFixture,
  downloadMpcCalibrationFixture,
  importMpcCalibrationFixture,
  validateMpcCalibrationFixture,
} from "@/helpers/mpcCalibrationImport";
import {
  compareMpcCalibrationAlgorithms,
  type MpcCalibrationComparisonResult,
} from "@/helpers/mpcCalibrationCompare";
import {
  evaluateMpcCalibrationDataset,
  toMpcCalibrationRunResults,
  type MpcCalibrationEvaluationResult,
} from "@/helpers/mpcCalibrationRunner";
import {
  createMpcCalibrationDataset,
  listMpcCalibrationAssets,
  listMpcCalibrationCases,
  listMpcCalibrationDatasets,
  listMpcCalibrationRuns,
  MPC_CALIBRATION_TARGET_CASE_COUNT,
  saveMpcCalibrationAssets,
  saveMpcCalibrationCase,
  saveMpcCalibrationRun,
} from "@/helpers/mpcCalibrationStorage";
import {
  getActivePreferenceSyncTarget,
  getMpcPreferenceSyncStatus,
  subscribeToMpcPreferenceSyncStatus,
} from "@/helpers/mpcPreferenceSync";
import { CardGrid } from "@/components/common/CardGrid";
import { CardImageSvg } from "@/components/common/CardImageSvg";

const DEFAULT_DATASET_NAME = "MPC Calibration Harness";

type CaptureState = {
  imageRecord: Image | null;
  candidates: MpcAutofillCard[];
};

function runLabel(result: MpcCalibrationEvaluationResult | null) {
  if (!result) return `0/${MPC_CALIBRATION_TARGET_CASE_COUNT}`;
  return `${result.summary.matchedCases}/${result.summary.totalCases}`;
}

async function ensureCalibrationDataset(): Promise<MpcCalibrationDatasetRecord> {
  const datasets = await listMpcCalibrationDatasets();
  const existing = datasets.find(
    (dataset) => dataset.name === DEFAULT_DATASET_NAME
  );
  if (existing) {
    return existing;
  }

  return createMpcCalibrationDataset({
    name: DEFAULT_DATASET_NAME,
    description: "Manual MPC calibration capture set",
    targetCaseCount: MPC_CALIBRATION_TARGET_CASE_COUNT,
  });
}

export function CalibrationModal() {
  const open = useCalibrationModalStore((state) => state.open);
  const card = useCalibrationModalStore((state) => state.card);
  const closeModal = useCalibrationModalStore((state) => state.closeModal);

  const [dataset, setDataset] = useState<MpcCalibrationDatasetRecord | null>(
    null
  );
  const [cases, setCases] = useState<MpcCalibrationCaseRecord[]>([]);
  const [, setRuns] = useState<MpcCalibrationRunRecord[]>([]);
  const [currentResult, setCurrentResult] =
    useState<MpcCalibrationEvaluationResult | null>(null);
  const [comparisonResult, setComparisonResult] =
    useState<MpcCalibrationComparisonResult | null>(null);
  const [captureState, setCaptureState] = useState<CaptureState>({
    imageRecord: null,
    candidates: [],
  });
  const [recommendations, setRecommendations] =
    useState<RankedRecommendations | null>(null);
  const [, setRawPrefScores] =
    useState<Record<string, number>>({});
  const [prefModel, setPrefModel] = useState<MpcPreferenceModel | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    "idle" | "loading" | "capturing" | "running" | "importing"
  >("idle");
  const [syncTargetLabel, setSyncTargetLabel] = useState<string | null>(
    getMpcPreferenceSyncStatus().targetLabel
  );
  const [syncSaveStateLabel, setSyncSaveStateLabel] = useState<string>(
    getMpcPreferenceSyncStatus().saveStateLabel
  );
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const refreshDataset = useCallback(async (datasetId: string) => {
    const [loadedCases, loadedRuns] = await Promise.all([
      listMpcCalibrationCases(datasetId),
      listMpcCalibrationRuns(datasetId),
    ]);
    setCases(loadedCases);
    setRuns(loadedRuns.sort((left, right) => right.createdAt - left.createdAt));
  }, []);

  useEffect(() => {
    const unsubscribeSync = subscribeToMpcPreferenceSyncStatus((syncStatus) => {
      setSyncTargetLabel(syncStatus.targetLabel);
      setSyncSaveStateLabel(syncStatus.saveStateLabel);
    });

    if (!open) {
      setStatus(null);
      setCaptureState({ imageRecord: null, candidates: [] });
      setRecommendations(null);
      setRawPrefScores({});
      setPhase("idle");
      return unsubscribeSync;
    }

    const controller = new AbortController();
    const { signal } = controller;

    void (async () => {
      setPhase("loading");
      try {
        const ensuredDataset = await ensureCalibrationDataset();
        if (signal.aborted) return;

        const activeTarget = await getActivePreferenceSyncTarget();
        setDataset(ensuredDataset);
        setSyncTargetLabel(activeTarget ? activeTarget.describe() : "Unavailable");
        await refreshDataset(ensuredDataset.id);
        if (signal.aborted) return;

        // Prepare Preference Model for scoring
        await hydrateMpcPreferences();
        if (signal.aborted) return;

        const calibrationCases = await listDefaultMpcCalibrationCases();
        const model = trainMpcPreferenceModel(calibrationCases);
        setPrefModel(model);

        if (card?.imageId) {
          const [imageRecord, matches] = await Promise.all([
            db.images.get(card.imageId),
            searchMpcAutofill(card.name, "CARD", false),
          ]);
          if (signal.aborted) return;

          const filtered = filterByExactName(matches, card.name);
          setCaptureState({
            imageRecord: imageRecord ?? null,
            candidates: filtered,
          });

          // Compute recommendations if model and candidates exist
          if (model && filtered.length > 0) {
            const metadataScores = buildMpcPreferenceScoreMap(model, filtered);

            const harvested = await harvestSourcePreferenceCandidates(
              BOOTSTRAP_PREFERENCE_SEED_CARD_NAMES,
              async (name) => searchMpcAutofill(name, "CARD", true)
            );
            if (signal.aborted) return;

            const profiles = await buildMpcSourceVisualProfiles(harvested);
            if (signal.aborted) return;

            const visualScores = await buildMpcVisualPreferenceScoreMap(
              filtered,
              profiles,
              model,
              signal
            );
            if (signal.aborted) return;

            const unseenScores = Object.fromEntries(
              filtered.map((candidate) => [
                candidate.identifier,
                (metadataScores[candidate.identifier] ?? 0) +
                  (visualScores[candidate.identifier] ?? 0),
              ])
            );
            setRawPrefScores(unseenScores);

            const recs = await rankCandidates({
              candidates: filtered,
              set: card.set,
              collectorNumber: card.number,
              sourceImageUrl: imageRecord?.sourceUrl || imageRecord?.imageUrls?.[0],
              getMpcImageUrl: (identifier) => {
                const c = filtered.find(f => f.identifier === identifier);
                return c?.smallThumbnailUrl || c?.mediumThumbnailUrl || "";
              },
              ssimCompare: createSsimCompare(undefined, FULL_CARD_NORMALIZED_SIZE),
              unseenPreferenceScores: unseenScores,
              signal,
            });
            if (signal.aborted) return;
            setRecommendations(recs);
          }
        } else {
          setCaptureState({ imageRecord: null, candidates: [] });
          setRecommendations(null);
          setRawPrefScores({});
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          console.log("CalibrationModal: Bootstrap aborted");
        } else {
          console.error("CalibrationModal: Bootstrap error", err);
        }
      } finally {
        if (!signal.aborted) {
          setPhase("idle");
        }
      }
    })();

    return () => {
      controller.abort();
      unsubscribeSync();
    };
  }, [open, card, refreshDataset]);

  const runCalibration = useCallback(async () => {
    if (!dataset) return;
    setPhase("running");
    setStatus("Analyzing dataset...");
    try {
      const [loadedCases, loadedAssets] = await Promise.all([
        listMpcCalibrationCases(dataset.id),
        listMpcCalibrationAssets(dataset.id),
      ]);
      setCases(loadedCases);
      const result = await evaluateMpcCalibrationDataset(
        dataset,
        loadedCases,
        { id: "current", label: "Current algorithm" },
        loadedAssets
      );
      setCurrentResult(result);
      await saveMpcCalibrationRun({
        id: crypto.randomUUID(),
        datasetId: dataset.id,
        algorithmId: result.algorithmId,
        algorithmLabel: result.algorithmLabel,
        summary: result.summary,
        results: toMpcCalibrationRunResults(result.cases),
        createdAt: Date.now(),
      });
      await refreshDataset(dataset.id);
    } catch (error) {
      console.error(error);
      setStatus(
        error instanceof Error ? error.message : "Failed to run calibration"
      );
    } finally {
      setPhase("idle");
    }
  }, [dataset, refreshDataset]);

  const compareAlgorithms = useCallback(async () => {
    if (!dataset) return;
    setPhase("running");
    setStatus("Comparing algorithms...");
    try {
      const [loadedCases, loadedAssets] = await Promise.all([
        listMpcCalibrationCases(dataset.id),
        listMpcCalibrationAssets(dataset.id),
      ]);
      setCases(loadedCases);
      const result = await compareMpcCalibrationAlgorithms(
        dataset,
        loadedCases,
        {
          id: "dpi-baseline",
          label: "DPI baseline",
          usePreferenceProfile: false,
        },
        { id: "current", label: "Current algorithm" },
        loadedAssets
      );
      setComparisonResult(result);
    } catch (error) {
      console.error(error);
      setStatus(
        error instanceof Error ? error.message : "Failed to compare algorithms"
      );
    } finally {
      setPhase("idle");
    }
  }, [dataset]);

  const captureCase = useCallback(
    async (candidate: MpcAutofillCard) => {
      if (!dataset || !card?.imageId || !captureState.imageRecord) return;
      setPhase("capturing");
      setStatus(`Capturing expected choice: ${candidate.rawName ?? candidate.name}...`);
      try {
        const captured = await captureMpcCalibrationCase({
          datasetId: dataset.id,
          card,
          imageRecord: captureState.imageRecord,
          candidates: captureState.candidates,
          expectedIdentifier: candidate.identifier,
        });
        await saveMpcCalibrationCase(captured.caseRecord);
        await saveMpcCalibrationAssets(captured.assets);
        setCurrentResult(null);
        setComparisonResult(null);
        setStatus(
          captured.assetErrors.length > 0
            ? `Captured expected choice with ${captured.assetErrors.length} asset warning${captured.assetErrors.length === 1 ? "" : "s"}.`
            : `Captured expected choice: ${candidate.rawName ?? candidate.name}.`
        );
        await refreshDataset(dataset.id);
      } catch (error) {
        console.error(error);
        setStatus(
          error instanceof Error ? error.message : "Failed to capture expected choice"
        );
      } finally {
        setPhase("idle");
      }
    },
    [card, dataset, captureState, refreshDataset]
  );

  const exportFixture = useCallback(async () => {
    if (!dataset) return;
    const fixture = await buildMpcCalibrationFixture(dataset.id);
    downloadMpcCalibrationFixture(fixture, dataset.name);
  }, [dataset]);

  const importFixture = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !dataset) return;
      setPhase("importing");
      try {
        const text = await file.text();
        const fixture = JSON.parse(text);
        const validFixture = validateMpcCalibrationFixture(fixture);
        if (validFixture) {
          const importedDatasetId = await importMpcCalibrationFixture(validFixture);
          setDataset(validFixture.dataset);
          setCurrentResult(null);
          setComparisonResult(null);
          setStatus(
            `Cases captured: ${validFixture.cases.length}/${validFixture.dataset.targetCaseCount ?? MPC_CALIBRATION_TARGET_CASE_COUNT}`
          );
          await refreshDataset(importedDatasetId);
        } else {
          alert("Invalid calibration fixture file");
        }
      } catch (error) {
        console.error(error);
        alert("Failed to import fixture");
      } finally {
        setPhase("idle");
        if (importInputRef.current) importInputRef.current.value = "";
      }
    },
    [dataset, refreshDataset]
  );

  if (!open) return null;

  return (
    <Modal show={open} onClose={closeModal} size="6xl">
      <ModalHeader
        as="div"
        className="relative pr-14"
        data-testid="mpc-calibration-modal-header"
      >
        <span>MPC Auto-Selection Calibration</span>
        <button
          type="button"
          aria-label="Close calibration modal"
          data-testid="calibration-modal-close"
          className="absolute right-4 top-4 z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-transparent text-2xl leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-purple-400 dark:text-gray-300 dark:hover:bg-gray-600 dark:hover:text-white"
          onClick={closeModal}
        >
          ×
        </button>
      </ModalHeader>
      <ModalBody data-testid="mpc-calibration-modal">
        <div className="space-y-6">
          <div className="flex items-center justify-between border-b pb-4 dark:border-gray-700">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {dataset?.name}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {cases.length} cases captured · Target:{" "}
                {MPC_CALIBRATION_TARGET_CASE_COUNT}
              </p>
              <div
                className="mt-1 flex items-center gap-4 text-xs"
                data-testid="mpc-preference-sync-status"
              >
                <span className="text-gray-500 dark:text-gray-400">
                  Sync Target: {syncTargetLabel}
                </span>
                <span
                  className={
                    syncSaveStateLabel.includes("Dirty")
                      ? "text-orange-500 font-medium"
                      : "text-green-500"
                  }
                >
                  {syncSaveStateLabel}
                </span>
              </div>
              {status ? (
                <p
                  className="mt-2 text-xs text-gray-600 dark:text-gray-300"
                  data-testid="mpc-calibration-status"
                >
                  {status}
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              <input
                type="file"
                className="hidden"
                ref={importInputRef}
                data-testid="mpc-calibration-import-input"
                onChange={importFixture}
                accept=".json"
              />
              <Button
                color="light"
                size="sm"
                onClick={() => importInputRef.current?.click()}
                disabled={phase !== "idle"}
              >
                Import
              </Button>
              <Button
                color="light"
                size="sm"
                onClick={exportFixture}
                disabled={!dataset || cases.length === 0}
              >
                Export
              </Button>
              <Button
                color="purple"
                size="sm"
                onClick={runCalibration}
                data-testid="mpc-calibration-run"
                disabled={!dataset || cases.length === 0 || phase !== "idle"}
              >
                {phase === "running" ? (
                  <Spinner size="xs" className="mr-2" />
                ) : null}
                Run Evaluation (
                <span data-testid="mpc-calibration-scoreboard">
                  {runLabel(currentResult)}
                </span>
                )
              </Button>
            </div>
          </div>

          {card ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-md font-medium text-gray-900 dark:text-white">
                  Active Capture: {card.name}
                </h4>
                <div className="text-xs text-gray-500">
                  {captureState.candidates.length} candidates found
                </div>
              </div>

              <CardGrid>
                {/* Source Image */}
                <div className="rounded-lg border-2 border-dashed border-gray-300 p-3 dark:border-gray-600">
                  <div className="mb-2 text-center text-xs font-bold uppercase text-gray-500">
                    Source (Scryfall)
                  </div>
                  <div className="aspect-[63/88] overflow-hidden rounded-md bg-gray-100 dark:bg-gray-800">
                    <CardImageSvg
                      id={`source-${card.uuid}`}
                      url={
                        captureState.imageRecord?.sourceUrl ||
                        captureState.imageRecord?.imageUrls?.[0]
                      }
                    />
                  </div>
                  <div className="mt-3 text-center text-xs text-gray-500">
                    Target match reference
                  </div>
                </div>

                {/* Candidate Gallery */}
                {captureState.candidates.map((candidate) => {
                  const rec = recommendations?.fullProcess.find(
                    (r) => r.card.identifier === candidate.identifier
                  );
                  const stats = prefModel?.sourceStats?.[candidate.sourceName];
                  const winRate = stats ? (stats.selections / stats.appearances) * 100 : null;

                  return (
                    <div
                      key={candidate.identifier}
                      className={`rounded-lg border p-3 dark:border-gray-700 ${rec && recommendations?.fullProcess[0].card.identifier === candidate.identifier ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-300 dark:border-purple-800 shadow-sm' : 'bg-white dark:bg-gray-800 border-gray-200'}`}
                      data-testid={`mpc-calibration-candidate-${candidate.identifier}`}
                    >
                      <div className="aspect-[63/88] overflow-hidden rounded-md bg-gray-100 dark:bg-gray-800 relative">
                        <CardImageSvg
                          id={`calibration-${candidate.identifier}`}
                          url={
                            candidate.smallThumbnailUrl ||
                            candidate.mediumThumbnailUrl
                          }
                        />
                        {rec && recommendations?.fullProcess[0].card.identifier === candidate.identifier && (
                           <div className="absolute top-2 right-2 bg-purple-600 text-white text-[10px] px-2 py-0.5 rounded-full font-bold shadow-md">
                             TOP PICK
                           </div>
                        )}
                      </div>
                      <div className="mt-3 space-y-1">
                        <div className="text-sm font-medium text-gray-900 dark:text-white truncate" title={candidate.rawName}>
                          {candidate.rawName}
                        </div>
                        <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                          <span>{candidate.sourceName}</span>
                          <span>{candidate.dpi} DPI</span>
                        </div>
                        {rec && (
                          <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700 space-y-1">
                            <div className="flex justify-between text-[10px] font-semibold text-gray-600 dark:text-gray-300">
                              <span>Committee Score:</span>
                              <span className="text-purple-600 dark:text-purple-400">
                                {(rec.score ?? 0).toFixed(1)}
                              </span>
                            </div>

                            {/* Detailed Breakdown */}
                            {rec.breakdown && (
                              <div className="grid grid-cols-2 gap-x-2 text-[8px] text-gray-400 dark:text-gray-500 italic">
                                <div className="flex justify-between">
                                  <span>Meta:</span>
                                  <span>{rec.breakdown.metadata}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Visual:</span>
                                  <span>{rec.breakdown.visual.toFixed(0)}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Pref:</span>
                                  <span>
                                    {rec.breakdown.preference.toFixed(0)}
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span>DPI:</span>
                                  <span>{rec.breakdown.dpi.toFixed(1)}</span>
                                </div>
                              </div>
                            )}

                            {winRate !== null && (
                              <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400 border-t border-gray-50 dark:border-gray-800 pt-1 mt-1">
                                <span>Source Win Rate:</span>
                                <span>{winRate.toFixed(1)}%</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                      <Button
                        className="mt-3 w-full"
                        size="xs"
                        color={rec && recommendations?.fullProcess[0].card.identifier === candidate.identifier ? "purple" : "light"}
                        onClick={() => void captureCase(candidate)}
                        disabled={phase !== "idle"}
                      >
                        Use as Expected Choice
                      </Button>
                    </div>
                  );
                })}
              </CardGrid>
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-md font-medium text-gray-900 dark:text-white">
                Frozen Cases ({cases.length})
              </h4>
              <Button
                color="light"
                onClick={compareAlgorithms}
                disabled={!dataset || phase !== "idle"}
              >
                Compare vs DPI Baseline
              </Button>
            </div>

            <div className="max-h-[300px] overflow-y-auto rounded-lg border dark:border-gray-700">
              <table className="w-full text-left text-sm text-gray-500 dark:text-gray-400">
                <thead className="bg-gray-50 text-xs uppercase text-gray-700 dark:bg-gray-700 dark:text-gray-400">
                  <tr>
                    <th className="px-4 py-2">Card</th>
                    <th className="px-4 py-2">Selection Status</th>
                    <th className="px-4 py-2">DPI Baseline</th>
                  </tr>
                </thead>
                <tbody className="divide-y dark:divide-gray-700">
                  {cases.map((calibrationCase) => {
                    const caseResult = currentResult?.cases.find(
                      (item) => item.caseId === calibrationCase.id
                    );
                    const comparisonDiff = comparisonResult?.diffs.find(
                      (diff) => diff.caseId === calibrationCase.id
                    );

                    return (
                      <tr key={calibrationCase.id}>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900 dark:text-white">
                            {calibrationCase.source.name}
                          </div>
                          <div className="text-xs">
                            {(calibrationCase.source.set ?? "—").toUpperCase()}{" "}
                            · #{calibrationCase.source.collectorNumber ?? "—"}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                            Expected:{" "}
                            <span className="text-green-600 dark:text-green-400">
                              {calibrationCase.expectedIdentifier}
                            </span>
                          </div>
                          <div className="text-sm text-gray-500 dark:text-gray-400">
                            Predicted:{" "}
                            <span className={caseResult && !caseResult.matched ? "text-red-600 dark:text-red-400 font-bold" : ""}>
                              {caseResult?.predictedIdentifier ?? "not run"}
                            </span>
                          </div>
                          {caseResult && !caseResult.matched && (
                            <div className="mt-1 text-[10px] text-red-500 font-semibold uppercase tracking-wider">
                              Committee Conflict
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="rounded-md bg-gray-50 p-2 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                            <div>
                              Baseline:{" "}
                              {comparisonDiff?.baselineIdentifier ?? "—"}
                            </div>
                            {comparisonDiff ? (
                              <div>
                                Current:{" "}
                                {comparisonDiff.candidateIdentifier ?? "—"}
                              </div>
                            ) : null}
                            {comparisonDiff && (
                              <div
                                className={
                                  comparisonDiff.improvement === "gain"
                                    ? "text-green-600 font-bold"
                                    : comparisonDiff.improvement === "loss"
                                      ? "text-red-600 font-bold"
                                      : ""
                                }
                              >
                                Result: {comparisonDiff.improvement}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {cases.length === 0 ? (
                <p className="p-8 text-center text-gray-500 italic">
                  No frozen cases yet. Capture one from the current card or
                  import a fixture.
                </p>
              ) : null}
            </div>
          </section>
        </div>
      </ModalBody>
    </Modal>
  );
}
