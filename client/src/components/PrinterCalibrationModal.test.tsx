import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { CalibrationApiUnavailableError } from "@/helpers/printerCalibrationApi";

const mockGetPrinterProfiles = vi.hoisted(() => vi.fn());
const mockGenerateCalibrationSheet = vi.hoisted(() => vi.fn());
const mockCalculateProfile = vi.hoisted(() => vi.fn());
const mockCreatePrinterProfile = vi.hoisted(() => vi.fn());
const mockDeletePrinterProfile = vi.hoisted(() => vi.fn());

vi.mock("@/helpers/printerCalibrationApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/helpers/printerCalibrationApi")>();
  return {
    ...actual,
    getPrinterProfiles: mockGetPrinterProfiles,
    generateCalibrationSheet: mockGenerateCalibrationSheet,
    calculateProfile: mockCalculateProfile,
    createPrinterProfile: mockCreatePrinterProfile,
    deletePrinterProfile: mockDeletePrinterProfile,
  };
});

const mockSetPrinterCalibrationProfileId = vi.hoisted(() => vi.fn());
const mockSetPrinterCalibrationEnabled = vi.hoisted(() => vi.fn());

vi.mock("@/store/settings", () => ({
  useSettingsStore: vi.fn((selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      printerCalibrationProfileId: null,
      setPrinterCalibrationProfileId: mockSetPrinterCalibrationProfileId,
      printerCalibrationEnabled: false,
      setPrinterCalibrationEnabled: mockSetPrinterCalibrationEnabled,
    };
    return selector(state);
  }),
}));

const mockShowErrorToast = vi.hoisted(() => vi.fn());
const mockShowInfoToast = vi.hoisted(() => vi.fn());

vi.mock("@/store/toast", () => ({
  useToastStore: {
    getState: () => ({
      showErrorToast: mockShowErrorToast,
      showInfoToast: mockShowInfoToast,
    }),
  },
}));

import { PrinterCalibrationModal } from "./PrinterCalibrationModal";

const unavailableError = () =>
  new CalibrationApiUnavailableError(
    "Printer calibration service is unavailable (getPrinterProfiles)."
  );

describe("PrinterCalibrationModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPrinterProfiles.mockResolvedValue({});
  });

  async function renderOpen() {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(<PrinterCalibrationModal isOpen={true} onClose={vi.fn()} />);
    });
    return result!;
  }

  describe("when API is available", () => {
    it("renders without the unavailable banner", async () => {
      await renderOpen();
      expect(screen.queryByTestId("calibration-unavailable-banner")).toBeNull();
    });

    it("Download Calibration Sheet button is enabled", async () => {
      await renderOpen();
      const btn = screen.getByText(/Download Calibration Sheet/i).closest("button");
      expect(btn?.disabled).toBe(false);
    });

    it("profile Select is enabled", async () => {
      await renderOpen();
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.disabled).toBe(false);
    });

    it("Save Profile button is disabled when name is empty", async () => {
      await renderOpen();
      const saveBtn = screen.getByTestId("printer-calibration-save-profile") as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(true);
    });
  });

  describe("when API is unavailable on initial load", () => {
    beforeEach(() => {
      mockGetPrinterProfiles.mockRejectedValue(unavailableError());
    });

    it("shows the unavailable banner", async () => {
      await renderOpen();
      expect(screen.getByTestId("calibration-unavailable-banner")).toBeDefined();
    });

    it("banner copy is runtime-agnostic (no mention of local server)", async () => {
      await renderOpen();
      const banner = screen.getByTestId("calibration-unavailable-banner");
      expect(banner.textContent).not.toMatch(/local server/i);
      expect(banner.textContent).not.toMatch(/electron/i);
    });

    it("banner mentions a connected Proxxied server", async () => {
      await renderOpen();
      const banner = screen.getByTestId("calibration-unavailable-banner");
      expect(banner.textContent).toMatch(/proxxied server/i);
    });

    it("Download Calibration Sheet button is disabled", async () => {
      await renderOpen();
      const btn = screen.getByText(/Download Calibration Sheet/i).closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it("profile Select is disabled", async () => {
      await renderOpen();
      const select = screen.getByRole("combobox") as HTMLSelectElement;
      expect(select.disabled).toBe(true);
    });

    it("Save Profile button is disabled", async () => {
      await renderOpen();
      const saveBtn = screen.getByTestId("printer-calibration-save-profile") as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(true);
    });

    it("Profile Name input is disabled", async () => {
      await renderOpen();
      const nameInput = screen.getByTestId("printer-calibration-profile-name") as HTMLInputElement;
      expect(nameInput.disabled).toBe(true);
    });

    it("modal remains visible (not hidden)", async () => {
      await renderOpen();
      expect(screen.getAllByTestId("printer-calibration-modal").length).toBeGreaterThan(0);
    });

    it("does not show a toast error for unavailable API on load", async () => {
      await renderOpen();
      expect(mockShowErrorToast).not.toHaveBeenCalled();
    });
  });

  describe("mid-session outage: downloadSheet catches CalibrationApiUnavailableError", () => {
    it("sets apiUnavailable and shows the banner after a mid-session network failure", async () => {
      mockGetPrinterProfiles.mockResolvedValue({});
      await renderOpen();
      expect(screen.queryByTestId("calibration-unavailable-banner")).toBeNull();

      mockGenerateCalibrationSheet.mockRejectedValue(unavailableError());

      const downloadBtn = screen.getByText(/Download Calibration Sheet/i).closest("button")!;
      await act(async () => {
        fireEvent.click(downloadBtn);
      });

      expect(screen.getByTestId("calibration-unavailable-banner")).toBeDefined();
      expect(mockShowErrorToast).toHaveBeenCalledOnce();

      const sheetBtn = screen.getByText(/Download Calibration Sheet/i).closest("button") as HTMLButtonElement;
      expect(sheetBtn.disabled).toBe(true);
    });
  });

  describe("when API load fails with a non-network error", () => {
    it("does not show the unavailable banner for generic errors", async () => {
      mockGetPrinterProfiles.mockRejectedValue(new Error("some other error"));
      await renderOpen();
      expect(screen.queryByTestId("calibration-unavailable-banner")).toBeNull();
    });

    it("controls remain enabled after a non-network load error", async () => {
      mockGetPrinterProfiles.mockRejectedValue(new Error("some other error"));
      await renderOpen();
      const btn = screen.getByText(/Download Calibration Sheet/i).closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });
});
