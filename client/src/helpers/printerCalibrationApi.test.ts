import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getPrinterProfiles,
  createPrinterProfile,
  generateCalibrationSheet,
  applyCalibration,
  calculateProfile,
  deletePrinterProfile,
  CalibrationApiUnavailableError,
} from "./printerCalibrationApi";

vi.mock("@/constants", () => ({
  apiUrl: (path: string) => path,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeOkJsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(body),
    blob: () => Promise.resolve(new Blob([JSON.stringify(body)])),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body: { error?: string }): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("printerCalibrationApi – network error normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getPrinterProfiles", () => {
    it("returns profiles on success", async () => {
      const profiles = { myPrinter: { name: "myPrinter", front_x_mm: 1, front_y_mm: 2, back_x_mm: 3, back_y_mm: 4 } };
      mockFetch.mockResolvedValueOnce(makeOkJsonResponse(profiles));
      await expect(getPrinterProfiles()).resolves.toEqual(profiles);
    });

    it("throws CalibrationApiUnavailableError on TypeError (network failure)", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(getPrinterProfiles()).rejects.toBeInstanceOf(CalibrationApiUnavailableError);
    });

    it("CalibrationApiUnavailableError message mentions the service", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      const err = await getPrinterProfiles().catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/printer calibration service is unavailable/i);
    });

    it("preserves server HTTP error as plain Error (not CalibrationApiUnavailableError)", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(500, { error: "internal server error" }));
      const err = await getPrinterProfiles().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(CalibrationApiUnavailableError);
      expect((err as Error).message).toBe("internal server error");
    });
  });

  describe("createPrinterProfile", () => {
    it("resolves on success", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      await expect(
        createPrinterProfile("test", { name: "test", front_x_mm: 0, front_y_mm: 0, back_x_mm: 0, back_y_mm: 0 })
      ).resolves.toBeUndefined();
    });

    it("throws CalibrationApiUnavailableError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(
        createPrinterProfile("test", { name: "test", front_x_mm: 0, front_y_mm: 0, back_x_mm: 0, back_y_mm: 0 })
      ).rejects.toBeInstanceOf(CalibrationApiUnavailableError);
    });

    it("preserves server 400 error message", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(400, { error: "profile already exists" }));
      const err = await createPrinterProfile("test", { name: "test", front_x_mm: 0, front_y_mm: 0, back_x_mm: 0, back_y_mm: 0 }).catch((e: unknown) => e);
      expect((err as Error).message).toBe("profile already exists");
      expect(err).not.toBeInstanceOf(CalibrationApiUnavailableError);
    });
  });

  describe("generateCalibrationSheet", () => {
    it("returns a Blob on success", async () => {
      const blob = new Blob(["pdf-data"], { type: "application/pdf" });
      mockFetch.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(blob) } as unknown as Response);
      await expect(generateCalibrationSheet()).resolves.toBe(blob);
    });

    it("throws CalibrationApiUnavailableError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(generateCalibrationSheet()).rejects.toBeInstanceOf(CalibrationApiUnavailableError);
    });

    it("preserves server error on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(503, { error: "service unavailable" }));
      const err = await generateCalibrationSheet().catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(CalibrationApiUnavailableError);
      expect((err as Error).message).toBe("service unavailable");
    });
  });

  describe("applyCalibration", () => {
    it("returns a Blob on success", async () => {
      const resultBlob = new Blob(["result-pdf"], { type: "application/pdf" });
      mockFetch.mockResolvedValueOnce({ ok: true, blob: () => Promise.resolve(resultBlob) } as unknown as Response);
      const inputBlob = new Blob(["input-pdf"]);
      await expect(applyCalibration(inputBlob, "myProfile")).resolves.toBe(resultBlob);
    });

    it("throws CalibrationApiUnavailableError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(applyCalibration(new Blob(), "myProfile")).rejects.toBeInstanceOf(CalibrationApiUnavailableError);
    });

    it("preserves server error on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(422, { error: "invalid profile" }));
      const err = await applyCalibration(new Blob(), "bad").catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(CalibrationApiUnavailableError);
      expect((err as Error).message).toBe("invalid profile");
    });

    it("includes pageMode in form data when provided", async () => {
      mockFetch.mockResolvedValueOnce(makeOkJsonResponse({ ok: true }));
      await applyCalibration(new Blob(["input"]), "myProfile", {
        pageMode: "back-only",
      });

      const fetchArgs = mockFetch.mock.calls[0];
      const request = fetchArgs[1] as { body: FormData };
      expect(request.body.get("profileName")).toBe("myProfile");
      expect(request.body.get("pageMode")).toBe("back-only");
    });

    it("omits pageMode when not provided", async () => {
      mockFetch.mockResolvedValueOnce(makeOkJsonResponse({ ok: true }));
      await applyCalibration(new Blob(["input"]), "myProfile");

      const fetchArgs = mockFetch.mock.calls[0];
      const request = fetchArgs[1] as { body: FormData };
      expect(request.body.get("pageMode")).toBeNull();
    });
  });

  describe("calculateProfile", () => {
    it("throws CalibrationApiUnavailableError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(
        calculateProfile({ front_x_measured_mm: 0, front_y_measured_mm: 0, back_x_measured_mm: 0, back_y_measured_mm: 0 })
      ).rejects.toBeInstanceOf(CalibrationApiUnavailableError);
    });
  });

  describe("deletePrinterProfile", () => {
    it("resolves on success", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true } as Response);
      await expect(deletePrinterProfile("test")).resolves.toBeUndefined();
    });

    it("preserves server error on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(404, { error: "profile not found" }));
      const err = await deletePrinterProfile("missing").catch((e: unknown) => e);
      expect((err as Error).message).toBe("profile not found");
    });
  });
});
