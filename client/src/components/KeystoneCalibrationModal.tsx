import { Modal, ModalHeader, ModalBody, ModalFooter, Label, Button, TextInput } from "flowbite-react";
import { useCallback, useMemo, useState } from "react";
import { apiUrl } from "@/constants";
import { useSettingsStore } from "@/store/settings";
import { useToastStore } from "@/store/toast";
import { keystoneTransformToPerCardOffsets, type KeystoneExtraTransform } from "@/helpers/keystoneCalibration";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

type KeystoneAnalyzeResponse = {
  back_shift_mm: { x: number; y: number };
  front: { translation_mm: { x: number; y: number }; rot_deg: number; scale: number };
  back: { translation_mm: { x: number; y: number }; rot_deg: number; scale: number };
  extra: KeystoneExtraTransform & { scale?: number };
  raw?: { stdout: string };
  error?: string;
};

function presetToPaper(preset: string | undefined): "letter" | "a4" {
  if (!preset) return "letter";
  const p = preset.toLowerCase();
  if (p === "a4") return "a4";
  return "letter";
}

export function KeystoneCalibrationModal({ isOpen, onClose }: Props) {
  const pageWidth = useSettingsStore((s) => s.pageWidth);
  const pageHeight = useSettingsStore((s) => s.pageHeight);
  const pageSizeUnit = useSettingsStore((s) => s.pageSizeUnit);
  const pageSizePreset = useSettingsStore((s) => s.pageSizePreset);
  const columns = useSettingsStore((s) => s.columns);
  const rows = useSettingsStore((s) => s.rows);
  const cardSpacingMm = useSettingsStore((s) => s.cardSpacingMm);
  const bleedEdge = useSettingsStore((s) => s.bleedEdge);
  const bleedEdgeWidth = useSettingsStore((s) => s.bleedEdgeWidth);
  const bleedEdgeUnit = useSettingsStore((s) => s.bleedEdgeUnit);
  const cardPositionX = useSettingsStore((s) => s.cardPositionX);
  const cardPositionY = useSettingsStore((s) => s.cardPositionY);
  const useCustomBackOffset = useSettingsStore((s) => s.useCustomBackOffset);
  const cardBackPositionX = useSettingsStore((s) => s.cardBackPositionX);
  const cardBackPositionY = useSettingsStore((s) => s.cardBackPositionY);
  const setPerCardBackOffsets = useSettingsStore((s) => s.setPerCardBackOffsets);
  const setKeystoneLastTransform = useSettingsStore((s) => s.setKeystoneLastTransform);

  const [paper, setPaper] = useState<"letter" | "a4">(() => presetToPaper(pageSizePreset));
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [backFile, setBackFile] = useState<File | null>(null);
  const [frontPage, setFrontPage] = useState(1);
  const [backPage, setBackPage] = useState(1);
  const [dpi, setDpi] = useState(300);
  const [borderInsetMm, setBorderInsetMm] = useState<string>("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<KeystoneAnalyzeResponse | null>(null);

  const canAnalyze = !!frontFile && !!backFile && !isAnalyzing;

  const downloadCalibrationPdf = useCallback(async () => {
    try {
      const url = apiUrl(`/api/keystone/calibration?paper=${paper}`);
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Failed to generate calibration PDF (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      const dlUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = dlUrl;
      a.download = `keystone_calibration_${paper}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(dlUrl), 1000);
    } catch (e: unknown) {
      useToastStore.getState().showErrorToast(e instanceof Error ? e.message : String(e));
    }
  }, [paper]);

  const analyze = useCallback(async () => {
    if (!frontFile || !backFile) return;
    setIsAnalyzing(true);
    setResult(null);

    try {
      const fd = new FormData();
      fd.append("front", frontFile);
      fd.append("back", backFile);
      fd.append("paper", paper);
      fd.append("dpi", String(dpi));
      fd.append("frontPage", String(frontPage));
      fd.append("backPage", String(backPage));
      if (borderInsetMm.trim() !== "") fd.append("borderInsetMm", borderInsetMm.trim());

      const res = await fetch(apiUrl("/api/keystone/analyze"), {
        method: "POST",
        body: fd,
      });

      const json = (await res.json().catch(() => ({}))) as KeystoneAnalyzeResponse;
      if (!res.ok) {
        throw new Error(json?.error || `Analyze failed (HTTP ${res.status})`);
      }

      setResult(json);
      useToastStore.getState().showInfoToast("Keystone analysis complete.");
    } catch (e: unknown) {
      useToastStore.getState().showErrorToast(e instanceof Error ? e.message : String(e));
    } finally {
      setIsAnalyzing(false);
    }
  }, [frontFile, backFile, paper, dpi, frontPage, backPage, borderInsetMm]);

  const computedOffsets = useMemo(() => {
    if (!result?.extra) return null;
    return keystoneTransformToPerCardOffsets(result.extra, {
      pageSizeUnit,
      pageWidth,
      pageHeight,
      columns,
      rows,
      cardSpacingMm,
      bleedEdge,
      bleedEdgeWidth,
      bleedEdgeUnit,
      cardPositionX,
      cardPositionY,
      useCustomBackOffset,
      cardBackPositionX,
      cardBackPositionY,
    });
  }, [
    result,
    pageSizeUnit,
    pageWidth,
    pageHeight,
    columns,
    rows,
    cardSpacingMm,
    bleedEdge,
    bleedEdgeWidth,
    bleedEdgeUnit,
    cardPositionX,
    cardPositionY,
    useCustomBackOffset,
    cardBackPositionX,
    cardBackPositionY,
  ]);

  const apply = useCallback(() => {
    if (!computedOffsets || !result?.extra) return;
    setPerCardBackOffsets(computedOffsets);
    setKeystoneLastTransform({
      rot_deg: result.extra.rot_deg,
      translation_mm: result.extra.translation_mm,
      appliedAt: Date.now(),
    });
    useToastStore.getState().showInfoToast(
      `Applied keystone offsets: rot=${result.extra.rot_deg.toFixed(3)}deg, t=(${result.extra.translation_mm.x.toFixed(2)}, ${result.extra.translation_mm.y.toFixed(2)})mm`,
    );
  }, [computedOffsets, result, setPerCardBackOffsets, setKeystoneLastTransform]);

  return (
    <Modal show={isOpen} onClose={onClose} size="3xl">
      <ModalHeader>Keystone Calibration (Scan Front + Back)</ModalHeader>
      <ModalBody>
        <div className="space-y-4">
          <div className="rounded-md bg-gray-50 dark:bg-gray-800 p-3 text-sm text-gray-700 dark:text-gray-200">
            <div>
              Print the calibration sheet duplex at 100% scale (no fit-to-page), then scan both sides with full page edges visible.
            </div>
            <div className="mt-2 text-xs">
              <a
                className="text-blue-600 hover:underline dark:text-blue-400"
                href="https://github.com/kclipsto/proxies-at-home/blob/main/docs/KEYSTONE_CALIBRATION.md"
                target="_blank"
                rel="noreferrer"
              >
                Help / Troubleshooting
              </a>
              <span className="ml-2 text-gray-500 dark:text-gray-400">
                (also in repo: docs/KEYSTONE_CALIBRATION.md)
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="keystone-paper">Paper</Label>
              <select
                id="keystone-paper"
                value={paper}
                onChange={(e) => setPaper(e.target.value as "letter" | "a4")}
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white p-2 text-sm dark:border-gray-600 dark:bg-gray-700"
              >
                <option value="letter">Letter</option>
                <option value="a4">A4</option>
              </select>
            </div>

            <div className="flex items-end">
              <Button color="gray" onClick={downloadCalibrationPdf} className="w-full">
                Download Calibration PDF
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="front-scan">Front Scan (PDF or image)</Label>
              <input
                id="front-scan"
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => setFrontFile(e.target.files?.[0] ?? null)}
                className="mt-1 block w-full text-sm"
              />
              <div className="mt-2">
                <Label htmlFor="front-page">Front Page (if PDF)</Label>
                <TextInput
                  id="front-page"
                  type="number"
                  min={1}
                  step={1}
                  value={frontPage}
                  onChange={(e) => setFrontPage(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            </div>

            <div>
              <Label htmlFor="back-scan">Back Scan (PDF or image)</Label>
              <input
                id="back-scan"
                type="file"
                accept="application/pdf,image/*"
                onChange={(e) => setBackFile(e.target.files?.[0] ?? null)}
                className="mt-1 block w-full text-sm"
              />
              <div className="mt-2">
                <Label htmlFor="back-page">Back Page (if PDF)</Label>
                <TextInput
                  id="back-page"
                  type="number"
                  min={1}
                  step={1}
                  value={backPage}
                  onChange={(e) => setBackPage(Math.max(1, Number(e.target.value) || 1))}
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label htmlFor="keystone-dpi">DPI (PDF rasterization)</Label>
              <TextInput
                id="keystone-dpi"
                type="number"
                min={72}
                max={1200}
                step={1}
                value={dpi}
                onChange={(e) => setDpi(Math.max(72, Math.min(1200, Number(e.target.value) || 300)))}
              />
            </div>
            <div className="col-span-2">
              <Label htmlFor="keystone-border-inset">Border Inset (mm, optional)</Label>
              <TextInput
                id="keystone-border-inset"
                type="number"
                step={0.5}
                value={borderInsetMm}
                onChange={(e) => setBorderInsetMm(e.target.value)}
                placeholder="Leave blank unless scans are cropped to the printed border"
              />
            </div>
          </div>

          {result && (
            <div className="rounded-md border border-gray-200 dark:border-gray-700 p-3 text-sm">
              <div className="font-semibold mb-2">Results</div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-gray-600 dark:text-gray-300">Back shift (raw)</div>
                  <div className="font-mono">
                    x={result.back_shift_mm.x.toFixed(2)}mm, y={result.back_shift_mm.y.toFixed(2)}mm
                  </div>
                </div>
                <div>
                  <div className="text-gray-600 dark:text-gray-300">Applied transform (used)</div>
                  <div className="font-mono">
                    rot={result.extra.rot_deg.toFixed(3)}deg, t=(
                    {result.extra.translation_mm.x.toFixed(2)},{result.extra.translation_mm.y.toFixed(2)})mm
                  </div>
                </div>
              </div>
              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                Note: scale is currently ignored in Proxxied (v1).
              </div>
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <div className="flex justify-between items-center w-full">
          <Button color="gray" onClick={onClose}>Close</Button>
          <div className="flex gap-2">
            <Button color="green" onClick={analyze} disabled={!canAnalyze}>
              {isAnalyzing ? "Analyzing..." : "Analyze Scans"}
            </Button>
            <Button color="blue" onClick={apply} disabled={!computedOffsets}>
              Apply Offsets
            </Button>
          </div>
        </div>
      </ModalFooter>
    </Modal>
  );
}
