import { apiUrl } from "@/constants";

export interface PrinterCalibrationProfile {
  name: string;
  front_x_mm: number;
  front_y_mm: number;
  back_x_mm: number;
  back_y_mm: number;
}

export interface CalculatedPrinterCalibrationProfile {
  front_x_mm: number;
  front_y_mm: number;
  back_x_mm: number;
  back_y_mm: number;
  paper_size?: string;
  duplex_mode?: string;
}

export interface CalculateProfileRequest {
  front_x_measured_mm: number;
  front_y_measured_mm: number;
  back_x_measured_mm: number;
  back_y_measured_mm: number;
}

export type CalibrationPageMode = "duplex" | "back-only";

/**
 * Wraps a network-level fetch rejection (TypeError / "Failed to fetch" / CORS /
 * unreachable host) into a printer-calibration-specific message so the UI can
 * distinguish "API unavailable" from a real server-side error.
 *
 * HTTP errors (4xx / 5xx) are preserved as-is from the server JSON body.
 */
export class CalibrationApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationApiUnavailableError";
  }
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Browser throws TypeError for network-level failures (no response received)
  return (
    err instanceof TypeError ||
    err.message === "Failed to fetch" ||
    err.message.toLowerCase().includes("network") ||
    err.message.toLowerCase().includes("failed to fetch")
  );
}

async function withCalibrationNetworkGuard<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (isNetworkError(err)) {
      throw new CalibrationApiUnavailableError(
        `Printer calibration service is unavailable (${operation}). ` +
          "Make sure the local server or Electron app is running."
      );
    }
    throw err;
  }
}

async function readErrorMessage(
  res: Response,
  fallback: string
): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error || fallback;
  } catch {
    return fallback;
  }
}

export const getPrinterProfiles = async (): Promise<Record<string, PrinterCalibrationProfile>> => {
  return withCalibrationNetworkGuard("getPrinterProfiles", async () => {
    const res = await fetch(apiUrl('/api/printer-calibration/profiles'));
    if (!res.ok) {
      throw new Error(await readErrorMessage(res, 'Failed to fetch printer profiles'));
    }
    return res.json() as Promise<Record<string, PrinterCalibrationProfile>>;
  });
};

export const createPrinterProfile = async (name: string, profile: PrinterCalibrationProfile): Promise<void> => {
  return withCalibrationNetworkGuard("createPrinterProfile", async () => {
    const res = await fetch(apiUrl(`/api/printer-calibration/profiles/${encodeURIComponent(name)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    });
    if (!res.ok) {
      throw new Error(await readErrorMessage(res, 'Failed to create printer profile'));
    }
  });
};

export const deletePrinterProfile = async (name: string): Promise<void> => {
  return withCalibrationNetworkGuard("deletePrinterProfile", async () => {
    const res = await fetch(apiUrl(`/api/printer-calibration/profiles/${encodeURIComponent(name)}`), {
      method: 'DELETE',
    });
    if (!res.ok) {
      throw new Error(await readErrorMessage(res, 'Failed to delete printer profile'));
    }
  });
};

export const calculateProfile = async (req: CalculateProfileRequest): Promise<CalculatedPrinterCalibrationProfile> => {
  return withCalibrationNetworkGuard("calculateProfile", async () => {
    const res = await fetch(apiUrl('/api/printer-calibration/calculate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(await readErrorMessage(res, 'Failed to calculate printer profile'));
    }
    return res.json() as Promise<CalculatedPrinterCalibrationProfile>;
  });
};

export const generateCalibrationSheet = async (): Promise<Blob> => {
  return withCalibrationNetworkGuard("generateCalibrationSheet", async () => {
    const res = await fetch(apiUrl('/api/printer-calibration/sheet'));
    if (!res.ok) {
      throw new Error(await readErrorMessage(res, 'Failed to generate calibration sheet'));
    }
    return res.blob();
  });
};

export const applyCalibration = async (
  pdfBlob: Blob,
  profileName: string,
  options?: { pageMode?: CalibrationPageMode }
): Promise<Blob> => {
  return withCalibrationNetworkGuard("applyCalibration", async () => {
    const formData = new FormData();
    formData.append('file', pdfBlob, 'document.pdf');
    formData.append('profileName', profileName);
    if (options?.pageMode) {
      formData.append('pageMode', options.pageMode);
    }

    const res = await fetch(apiUrl('/api/printer-calibration/apply'), {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      throw new Error(await readErrorMessage(res, 'Failed to apply printer calibration'));
    }
    return res.blob();
  });
};
