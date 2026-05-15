import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useToastStore } from "./toast";
import { useSettingsStore } from "./settings";

// Mock settings store
vi.mock("./settings", () => ({
    useSettingsStore: {
        getState: vi.fn(() => ({
            showProcessingToasts: true,
        })),
    },
}));

describe("useToastStore", () => {
    beforeEach(() => {
        // Reset store state before each test
        useToastStore.setState({ toasts: [] });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("addToast", () => {
        it("should add a toast with generated ID", () => {
            const { addToast } = useToastStore.getState();

            const id = addToast({
                type: "processing",
                message: "Test message",
                dismissible: true,
            });

            expect(id).toMatch(/^processing-\d+$/);
            expect(useToastStore.getState().toasts.length).toBe(1);
        });

        it("should add toast with correct properties", () => {
            const { addToast } = useToastStore.getState();

            addToast({
                type: "success",
                message: "Success!",
                dismissible: false,
            });

            const toast = useToastStore.getState().toasts[0];
            expect(toast.type).toBe("success");
            expect(toast.message).toBe("Success!");
            expect(toast.dismissible).toBe(false);
        });

        it("should support multiple toasts", () => {
            const { addToast } = useToastStore.getState();

            addToast({ type: "processing", message: "Processing", dismissible: true });
            addToast({ type: "metadata", message: "Metadata", dismissible: true });
            addToast({ type: "success", message: "Success", dismissible: false });

            expect(useToastStore.getState().toasts.length).toBe(3);
        });
    });

    describe("removeToast", () => {
        it("should remove toast by ID", () => {
            const { addToast, removeToast } = useToastStore.getState();
            const id = addToast({ type: "processing", message: "Test", dismissible: true });

            removeToast(id);

            expect(useToastStore.getState().toasts.length).toBe(0);
        });

        it("should only remove specified toast", () => {
            const { addToast, removeToast } = useToastStore.getState();
            const id1 = addToast({ type: "processing", message: "Test 1", dismissible: true });
            addToast({ type: "metadata", message: "Test 2", dismissible: true });

            removeToast(id1);

            const toasts = useToastStore.getState().toasts;
            expect(toasts.length).toBe(1);
            expect(toasts[0].message).toBe("Test 2");
        });

        it("should handle removing non-existent toast", () => {
            const { addToast, removeToast } = useToastStore.getState();
            addToast({ type: "processing", message: "Test", dismissible: true });

            removeToast("non-existent-id");

            expect(useToastStore.getState().toasts.length).toBe(1);
        });
    });

    describe("updateToast", () => {
        it("should update an existing toast by ID", () => {
            const { addToast, updateToast } = useToastStore.getState();
            const id = addToast({ type: "processing", message: "Test", dismissible: true });
            addToast({ type: "metadata", message: "Keep me", dismissible: true });

            updateToast(id, { message: "Updated", progress: 0.5 });

            const toast = useToastStore.getState().toasts[0];
            expect(toast.message).toBe("Updated");
            expect(toast.progress).toBe(0.5);
            expect(useToastStore.getState().toasts[1].message).toBe("Keep me");
        });
    });

    describe("clearToasts", () => {
        it("should remove all toasts", () => {
            const { addToast, clearToasts } = useToastStore.getState();
            addToast({ type: "processing", message: "Test 1", dismissible: true });
            addToast({ type: "metadata", message: "Test 2", dismissible: true });

            clearToasts();

            expect(useToastStore.getState().toasts.length).toBe(0);
        });
    });

    describe("showProcessingToast", () => {
        it("should add processing toast when enabled", () => {
            const { showProcessingToast } = useToastStore.getState();

            showProcessingToast();

            const toasts = useToastStore.getState().toasts;
            expect(toasts.length).toBe(1);
            expect(toasts[0].type).toBe("processing");
            expect(toasts[0].message).toBe("Processing images...");
        });

        it("should not add duplicate processing toast", () => {
            const { showProcessingToast } = useToastStore.getState();

            showProcessingToast();
            showProcessingToast();

            expect(useToastStore.getState().toasts.length).toBe(1);
        });

        it("should not add toast when disabled in settings", () => {
            vi.mocked(useSettingsStore.getState).mockReturnValue({
                showProcessingToasts: false,
            } as ReturnType<typeof useSettingsStore.getState>);

            const { showProcessingToast } = useToastStore.getState();
            showProcessingToast();

            expect(useToastStore.getState().toasts.length).toBe(0);

            // Restore mock
            vi.mocked(useSettingsStore.getState).mockReturnValue({
                showProcessingToasts: true,
            } as ReturnType<typeof useSettingsStore.getState>);
        });
    });

    describe("hideProcessingToast", () => {
        it("should remove only the generic processing toast", () => {
            const { showProcessingToast, hideProcessingToast, addToast } = useToastStore.getState();
            // Create the generic processing toast via showProcessingToast
            showProcessingToast();
            // Also add a custom processing toast (e.g., MPC upgrade with progress)
            addToast({ type: "processing", message: "MPC Upgrade (5/100)...", dismissible: true });
            addToast({ type: "metadata", message: "Other toast", dismissible: true });

            expect(useToastStore.getState().toasts.length).toBe(3);

            hideProcessingToast();

            const toasts = useToastStore.getState().toasts;
            // Should remove only the generic toast, keep the custom processing and metadata toasts
            expect(toasts.length).toBe(2);
            expect(toasts[0].message).toBe("MPC Upgrade (5/100)...");
            expect(toasts[1].type).toBe("metadata");
        });
    });

    describe("showMetadataToast", () => {
        it("should add metadata toast when enabled", () => {
            const { showMetadataToast } = useToastStore.getState();

            showMetadataToast();

            const toasts = useToastStore.getState().toasts;
            expect(toasts.length).toBe(1);
            expect(toasts[0].type).toBe("metadata");
            expect(toasts[0].message).toBe("Fetching metadata...");
        });

        it("should not add duplicate metadata toast", () => {
            const { showMetadataToast } = useToastStore.getState();

            showMetadataToast();
            showMetadataToast();

            expect(useToastStore.getState().toasts.length).toBe(1);
        });

        it("should not add toast when disabled in settings", () => {
            vi.mocked(useSettingsStore.getState).mockReturnValue({
                showProcessingToasts: false,
            } as ReturnType<typeof useSettingsStore.getState>);

            const { showMetadataToast } = useToastStore.getState();
            showMetadataToast();

            expect(useToastStore.getState().toasts.length).toBe(0);

            // Restore mock
            vi.mocked(useSettingsStore.getState).mockReturnValue({
                showProcessingToasts: true,
            } as ReturnType<typeof useSettingsStore.getState>);
        });
    });

    describe("hideMetadataToast", () => {
        it("should remove metadata toasts", () => {
            const { addToast, hideMetadataToast } = useToastStore.getState();
            addToast({ type: "metadata", message: "Metadata...", dismissible: true });
            addToast({ type: "processing", message: "Other toast", dismissible: true });

            hideMetadataToast();

            const toasts = useToastStore.getState().toasts;
            expect(toasts.length).toBe(1);
            expect(toasts[0].type).toBe("processing");
        });
    });

    describe("showSuccessToast", () => {
        it("should add success toast with card name", () => {
            const { showSuccessToast } = useToastStore.getState();

            showSuccessToast("Lightning Bolt");

            const toasts = useToastStore.getState().toasts;
            expect(toasts.length).toBe(1);
            expect(toasts[0].type).toBe("success");
            expect(toasts[0].message).toBe("Added Lightning Bolt");
            expect(toasts[0].dismissible).toBe(false);
        });

        it("should auto-dismiss after 2 seconds", () => {
            const { showSuccessToast } = useToastStore.getState();

            showSuccessToast("Lightning Bolt");
            expect(useToastStore.getState().toasts.length).toBe(1);

            vi.advanceTimersByTime(2000);

            expect(useToastStore.getState().toasts.length).toBe(0);
        });

        it("should remove existing success toasts before adding new one", () => {
            const { showSuccessToast } = useToastStore.getState();

            showSuccessToast("Lightning Bolt");
            showSuccessToast("Dark Ritual");

            const toasts = useToastStore.getState().toasts;
            expect(toasts.length).toBe(1);
            expect(toasts[0].message).toBe("Added Dark Ritual");
        });
    });

    describe("showCopyToast", () => {
        it("should add and auto-dismiss copy toasts", () => {
            const { showCopyToast } = useToastStore.getState();

            showCopyToast("Copied!");

            expect(useToastStore.getState().toasts).toHaveLength(1);
            expect(useToastStore.getState().toasts[0].type).toBe("copy");

            vi.advanceTimersByTime(2000);

            expect(useToastStore.getState().toasts).toHaveLength(0);
        });

        it("should remove an existing copy toast before adding a new one", () => {
            const { addToast, showCopyToast } = useToastStore.getState();
            addToast({ type: "copy", message: "Old copy", dismissible: true });

            showCopyToast("Copied!");

            expect(useToastStore.getState().toasts).toHaveLength(1);
            expect(useToastStore.getState().toasts[0].message).toBe("Copied!");
        });
    });

    describe("showInfoToast", () => {
        it("should add and auto-dismiss info toasts using copy styling", () => {
            const { showInfoToast } = useToastStore.getState();

            showInfoToast("Heads up");

            expect(useToastStore.getState().toasts).toHaveLength(1);
            expect(useToastStore.getState().toasts[0].type).toBe("copy");

            vi.advanceTimersByTime(4000);

            expect(useToastStore.getState().toasts).toHaveLength(0);
        });

        it("should remove an existing copy toast before adding info toast", () => {
            const { addToast, showInfoToast } = useToastStore.getState();
            addToast({ type: "copy", message: "Old info", dismissible: true });

            showInfoToast("Heads up");

            expect(useToastStore.getState().toasts).toHaveLength(1);
            expect(useToastStore.getState().toasts[0].message).toBe("Heads up");
        });
    });

    describe("showErrorToast", () => {
        it("should add and auto-dismiss error toasts", () => {
            const { showErrorToast } = useToastStore.getState();

            showErrorToast("Oops");

            expect(useToastStore.getState().toasts).toHaveLength(1);
            expect(useToastStore.getState().toasts[0].type).toBe("error");

            vi.advanceTimersByTime(8000);

            expect(useToastStore.getState().toasts).toHaveLength(0);
        });

        it("should remove an existing error toast before adding a new one", () => {
            const { addToast, showErrorToast } = useToastStore.getState();
            addToast({ type: "error", message: "Old error", dismissible: true });

            showErrorToast("Oops");

            expect(useToastStore.getState().toasts).toHaveLength(1);
            expect(useToastStore.getState().toasts[0].message).toBe("Oops");
        });
    });
});
