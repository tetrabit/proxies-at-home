import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  getPrinterProfiles,
  createPrinterProfile,
  generateCalibrationSheet,
  applyCalibration,
  calculateProfile,
  deletePrinterProfile,
  CalibrationApiUnavailableError,
} from "./printerCalibrationApi";
import { PrivateApiIdentityUnavailableError } from './privateApi';

const mockFetch = vi.fn();

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
    vi.stubGlobal('fetch', mockFetch);
    vi.stubGlobal('electronAPI', {
      getPrivateApiBootstrap: vi.fn().mockResolvedValue({
        baseUrl: 'http://127.0.0.1:4555',
        bearer: 'calibration-test-bearer',
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fails locally with a typed identity error without treating it as an unavailable network service', async () => {
    vi.stubGlobal('electronAPI', undefined);

    const error = await getPrinterProfiles().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PrivateApiIdentityUnavailableError);
    expect(error).not.toBeInstanceOf(CalibrationApiUnavailableError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  describe("getPrinterProfiles", () => {
    it("returns profiles on success", async () => {
      const profiles = { myPrinter: { name: "myPrinter", front_x_mm: 1, front_y_mm: 2, back_x_mm: 3, back_y_mm: 4 } };
      mockFetch.mockResolvedValueOnce(makeOkJsonResponse(profiles));
      const result = await getPrinterProfiles();
      expect(result).toEqual(profiles);
      expect(mockFetch).toHaveBeenCalledOnce();
      expect(mockFetch.mock.calls[0]?.[0]).toBe(
        'http://127.0.0.1:4555/api/printer-calibration/profiles'
      );
      const options = mockFetch.mock.calls[0]?.[1] as RequestInit;
      expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
      expect(new Headers(options.headers).get('Authorization')).toBe('Bearer calibration-test-bearer');
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

    it("falls back to the default message when the error body has no error field", async () => {
      mockFetch.mockResolvedValueOnce(makeErrorResponse(500, {}));
      const err = await getPrinterProfiles().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CalibrationApiUnavailableError);
      expect((err as Error).message).toMatch(/printer calibration service is unavailable/i);
    });

    it("falls back to the default message when the error body is not JSON", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 500,
        ok: false,
        statusText: "Server Error",
        json: () => Promise.reject(new Error("not json")),
      } as unknown as Response);

      const err = await getPrinterProfiles().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CalibrationApiUnavailableError);
      expect((err as Error).message).toMatch(/printer calibration service is unavailable/i);
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

    it("preserves FormData, pageMode, and an AbortSignal through the private adapter", async () => {
      mockFetch.mockResolvedValueOnce(makeOkJsonResponse({ ok: true }));
      const controller = new AbortController();
      await applyCalibration(new Blob(["input"]), "myProfile", {
        pageMode: "back-only",
        signal: controller.signal,
      });

      const fetchArgs = mockFetch.mock.calls[0];
      expect(fetchArgs?.[0]).toBe('http://127.0.0.1:4555/api/printer-calibration/apply');
      const request = fetchArgs?.[1] as { body: FormData; signal?: AbortSignal; headers?: HeadersInit };
      expect(request.body).toBeInstanceOf(FormData);
      expect(request.body.get("profileName")).toBe("myProfile");
      expect(request.body.get("pageMode")).toBe("back-only");
      expect(request.signal).toBe(controller.signal);
      expect(new Headers(request.headers).get('Authorization')).toBe('Bearer calibration-test-bearer');
    });

    it("forwards grouped-duplex metadata with the existing upload and AbortSignal", async () => {
      mockFetch.mockResolvedValueOnce(makeOkJsonResponse({ ok: true }));
      const controller = new AbortController();
      const input = new Blob(["input"], { type: "application/pdf" });

      await applyCalibration(input, "myProfile", {
        pageMode: "grouped-duplex",
        frontPageCount: 2,
        signal: controller.signal,
      });

      const fetchArgs = mockFetch.mock.calls[0];
      const request = fetchArgs?.[1] as { body: FormData; signal?: AbortSignal };
      expect(request.body).toBeInstanceOf(FormData);
      expect(request.body.get("file")).toBeInstanceOf(File);
      expect(request.body.get("profileName")).toBe("myProfile");
      expect(request.body.get("pageMode")).toBe("grouped-duplex");
      expect(request.body.get("frontPageCount")).toBe("2");
      expect(request.signal).toBe(controller.signal);
    });

    it("omits grouped-duplex metadata when not provided", async () => {
      mockFetch.mockResolvedValueOnce(makeOkJsonResponse({ ok: true }));
      await applyCalibration(new Blob(["input"]), "myProfile");

      const fetchArgs = mockFetch.mock.calls[0];
      const request = fetchArgs[1] as { body: FormData };
      expect(request.body.get("pageMode")).toBeNull();
      expect(request.body.get("frontPageCount")).toBeNull();
    });
  });

  describe("calculateProfile", () => {
    it("throws CalibrationApiUnavailableError on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));
      await expect(
        calculateProfile({ front_x_measured_mm: 0, front_y_measured_mm: 0, back_x_measured_mm: 0, back_y_measured_mm: 0 })
      ).rejects.toBeInstanceOf(CalibrationApiUnavailableError);
    });

    it("returns a calculated profile on success", async () => {
      const profile = {
        front_x_mm: 10,
        front_y_mm: 20,
        back_x_mm: 30,
        back_y_mm: 40,
      };
      mockFetch.mockResolvedValueOnce(makeOkJsonResponse(profile));

      await expect(
        calculateProfile({
          front_x_measured_mm: 1,
          front_y_measured_mm: 2,
          back_x_measured_mm: 3,
          back_y_measured_mm: 4,
        })
      ).resolves.toEqual(profile);
    });

    it("preserves server error on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(
        makeErrorResponse(422, { error: "invalid measurement data" })
      );

      const err = await calculateProfile({
        front_x_measured_mm: 1,
        front_y_measured_mm: 2,
        back_x_measured_mm: 3,
        back_y_measured_mm: 4,
      }).catch((e: unknown) => e);

      expect(err).not.toBeInstanceOf(CalibrationApiUnavailableError);
      expect((err as Error).message).toBe("invalid measurement data");
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

    it("marks non-Error failures as raw rethrows", async () => {
      mockFetch.mockRejectedValueOnce("offline");
      const err = await getPrinterProfiles().catch((e: unknown) => e);
      expect(err).toBe("offline");
    });
  });
});
