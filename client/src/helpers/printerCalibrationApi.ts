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
  const res = await fetch(apiUrl('/api/printer-calibration/profiles'));
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, 'Failed to fetch printer profiles'));
  }
  return res.json();
};

export const createPrinterProfile = async (name: string, profile: PrinterCalibrationProfile): Promise<void> => {
  const res = await fetch(apiUrl(`/api/printer-calibration/profiles/${encodeURIComponent(name)}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, 'Failed to create printer profile'));
  }
};

export const deletePrinterProfile = async (name: string): Promise<void> => {
  const res = await fetch(apiUrl(`/api/printer-calibration/profiles/${encodeURIComponent(name)}`), {
    method: 'DELETE',
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, 'Failed to delete printer profile'));
  }
};

export const calculateProfile = async (req: CalculateProfileRequest): Promise<CalculatedPrinterCalibrationProfile> => {
  const res = await fetch(apiUrl('/api/printer-calibration/calculate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, 'Failed to calculate printer profile'));
  }
  return res.json();
};

export const generateCalibrationSheet = async (): Promise<Blob> => {
  const res = await fetch(apiUrl('/api/printer-calibration/sheet'));
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, 'Failed to generate calibration sheet'));
  }
  return res.blob();
};

export const applyCalibration = async (pdfBlob: Blob, profileName: string): Promise<Blob> => {
  const formData = new FormData();
  formData.append('file', pdfBlob, 'document.pdf');
  formData.append('profileName', profileName);

  const res = await fetch(apiUrl('/api/printer-calibration/apply'), {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    throw new Error(await readErrorMessage(res, 'Failed to apply printer calibration'));
  }
  return res.blob();
};
