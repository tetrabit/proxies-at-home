import { Modal, ModalHeader, ModalBody, ModalFooter, Label, Button, TextInput, Select, ToggleSwitch } from "flowbite-react";
import { useCallback, useEffect, useState } from "react";
import { useSettingsStore } from "@/store/settings";
import { useToastStore } from "@/store/toast";
import * as api from "@/helpers/printerCalibrationApi";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export function PrinterCalibrationModal({ isOpen, onClose }: Props) {
  const printerCalibrationProfileId = useSettingsStore((s) => s.printerCalibrationProfileId);
  const setPrinterCalibrationProfileId = useSettingsStore((s) => s.setPrinterCalibrationProfileId);
  const printerCalibrationEnabled = useSettingsStore((s) => s.printerCalibrationEnabled);
  const setPrinterCalibrationEnabled = useSettingsStore((s) => s.setPrinterCalibrationEnabled);

  const [profiles, setProfiles] = useState<Record<string, api.PrinterCalibrationProfile>>({});
  const [newProfileName, setNewProfileName] = useState("");
  const [measurements, setMeasurements] = useState({
    front_x_measured_mm: 107.95,
    front_y_measured_mm: 139.70,
    back_x_measured_mm: 107.95,
    back_y_measured_mm: 139.70,
  });

  const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

  const fetchProfiles = useCallback(async () => {
    try {
      const data = await api.getPrinterProfiles();
      setProfiles(data);
    } catch (e: unknown) {
      // Ignored if API is not available
      console.error(e);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchProfiles();
    }
  }, [isOpen, fetchProfiles]);

  const downloadSheet = async () => {
    try {
      const blob = await api.generateCalibrationSheet();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "printer_calibration_sheet.pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: unknown) {
      useToastStore.getState().showErrorToast(getErrorMessage(e));
    }
  };

  const handleCreateProfile = async () => {
    if (!newProfileName.trim()) return;
    try {
      const calculatedProfile = await api.calculateProfile(measurements);
      const profileName = newProfileName.trim();
      const profileData: api.PrinterCalibrationProfile = {
        name: profileName,
        front_x_mm: calculatedProfile.front_x_mm,
        front_y_mm: calculatedProfile.front_y_mm,
        back_x_mm: calculatedProfile.back_x_mm,
        back_y_mm: calculatedProfile.back_y_mm,
      };
      await api.createPrinterProfile(profileName, profileData);
      useToastStore.getState().showInfoToast(`Created profile: ${profileName}`);
      await fetchProfiles();
      setPrinterCalibrationProfileId(profileName);
      setNewProfileName("");
    } catch (e: unknown) {
      useToastStore.getState().showErrorToast(getErrorMessage(e));
    }
  };

  const handleDeleteProfile = async (name: string) => {
    if (!window.confirm(`Delete profile '${name}'?`)) return;
    try {
      await api.deletePrinterProfile(name);
      useToastStore.getState().showInfoToast(`Deleted profile: ${name}`);
      if (printerCalibrationProfileId === name) {
        setPrinterCalibrationProfileId(null);
      }
      await fetchProfiles();
    } catch (e: unknown) {
      useToastStore.getState().showErrorToast(getErrorMessage(e));
    }
  };

  return (
    <Modal show={isOpen} onClose={onClose} size="3xl" data-testid="printer-calibration-modal">
      <ModalHeader>Printer Calibration</ModalHeader>
      <ModalBody>
        <div className="space-y-6">
          <div className="rounded-md bg-gray-50 dark:bg-gray-800 p-3 text-sm text-gray-700 dark:text-gray-200">
            <p className="mb-2">
              Printer calibration applies a global offset to the entire back page of duplex PDFs.
              This corrects for hardware misalignment when printing.
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Download and print the calibration sheet (100% scale, long-edge duplex).</li>
              <li>Measure distances from the printed marks to the edge of the paper.</li>
              <li>Enter measurements below to create a profile.</li>
              <li>Enable the profile to automatically apply it to back-page exports.</li>
            </ol>
          </div>

          <div className="flex gap-4 items-end border-b pb-4 dark:border-gray-700">
              <Button color="gray" onClick={downloadSheet} className="w-full">
                Download Calibration Sheet (US Letter)
              </Button>
          </div>

          <div>
            <h3 className="font-semibold mb-3">1. Select or Manage Profiles</h3>
            <div className="flex items-center gap-4 mb-4">
              <ToggleSwitch
                checked={printerCalibrationEnabled}
                label="Apply Profile on Export"
                onChange={setPrinterCalibrationEnabled}
              />
              <Select
                value={printerCalibrationProfileId || ""}
                onChange={(e) => setPrinterCalibrationProfileId(e.target.value || null)}
                className="flex-1"
              >
                <option value="">-- No Profile Selected --</option>
                {Object.values(profiles).map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </Select>
              {printerCalibrationProfileId && (
                <Button color="failure" size="sm" onClick={() => handleDeleteProfile(printerCalibrationProfileId)}>
                  Delete
                </Button>
              )}
            </div>
            {printerCalibrationProfileId && profiles[printerCalibrationProfileId] && (
              <div className="text-sm bg-gray-100 dark:bg-gray-700 p-3 rounded font-mono">
                Active Offsets: 
                Front: ({profiles[printerCalibrationProfileId].front_x_mm.toFixed(2)}, {profiles[printerCalibrationProfileId].front_y_mm.toFixed(2)}) mm | 
                Back: ({profiles[printerCalibrationProfileId].back_x_mm.toFixed(2)}, {profiles[printerCalibrationProfileId].back_y_mm.toFixed(2)}) mm
              </div>
            )}
          </div>

          <div>
            <h3 className="font-semibold mb-3">2. Create New Profile</h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Front - Left Edge to Center (mm)</Label>
                <TextInput
                  type="number" step="0.01"
                  value={measurements.front_x_measured_mm}
                  onChange={e => setMeasurements({...measurements, front_x_measured_mm: parseFloat(e.target.value) || 0})}
                />
              </div>
              <div>
                <Label>Front - Bottom Edge to Center (mm)</Label>
                <TextInput
                  type="number" step="0.01"
                  value={measurements.front_y_measured_mm}
                  onChange={e => setMeasurements({...measurements, front_y_measured_mm: parseFloat(e.target.value) || 0})}
                />
              </div>
              <div>
                <Label>Back - Left Edge to Center (mm)</Label>
                <TextInput
                  type="number" step="0.01"
                  value={measurements.back_x_measured_mm}
                  onChange={e => setMeasurements({...measurements, back_x_measured_mm: parseFloat(e.target.value) || 0})}
                />
              </div>
              <div>
                <Label>Back - Bottom Edge to Center (mm)</Label>
                <TextInput
                  type="number" step="0.01"
                  value={measurements.back_y_measured_mm}
                  onChange={e => setMeasurements({...measurements, back_y_measured_mm: parseFloat(e.target.value) || 0})}
                />
              </div>
            </div>
            <div className="flex gap-2 items-end mt-4">
              <div className="flex-1">
                <Label>Profile Name</Label>
                <TextInput 
                  data-testid="printer-calibration-profile-name"
                  value={newProfileName} 
                  onChange={e => setNewProfileName(e.target.value)} 
                  placeholder="e.g., Office Brother Printer" 
                />
              </div>
              <Button color="green" onClick={handleCreateProfile} disabled={!newProfileName.trim()} data-testid="printer-calibration-save-profile">
                Save Profile
              </Button>
            </div>
          </div>

        </div>
      </ModalBody>
      <ModalFooter>
        <Button color="gray" onClick={onClose} className="ml-auto">Close</Button>
      </ModalFooter>
    </Modal>
  );
}
