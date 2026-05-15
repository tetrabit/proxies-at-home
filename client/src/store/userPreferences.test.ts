import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { useUserPreferencesStore } from "./userPreferences";
import { db } from "../db";
import { useSettingsStore } from "./settings";

// Mock Dexie
vi.mock("../db", () => ({
    db: {
        userPreferences: {
            get: vi.fn(),
            add: vi.fn(),
            put: vi.fn(),
        },
    },
}));

describe("useUserPreferencesStore", () => {
    const initialState = useSettingsStore.getState();

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset stores
        useUserPreferencesStore.setState({ preferences: null, isLoading: false });
        useSettingsStore.setState(initialState);
    });

    describe("load", () => {
        it("should load existing preferences from db", async () => {
            const mockPrefs = {
                id: "default",
                settings: { someSetting: "value" },
                favoriteCardbacks: ["cb1"],
                favoriteMpcSources: [],
                favoriteMpcTags: [],
                favoriteMpcDpi: null,
                favoriteMpcSort: null,
            };
            (db.userPreferences.get as Mock).mockResolvedValue(mockPrefs);

            await useUserPreferencesStore.getState().load();

            expect(db.userPreferences.get).toHaveBeenCalledWith("default");
            expect(useUserPreferencesStore.getState().preferences).toEqual(mockPrefs);
            expect(useUserPreferencesStore.getState().isLoading).toBe(false);
        });

        it("should initialize missing favorite arrays when loading old preferences", async () => {
            const oldPrefs = {
                id: "default",
                settings: {},
                favoriteCardbacks: [],
                favoriteMpcDpi: null,
                favoriteMpcSort: null,
            };
            (db.userPreferences.get as Mock).mockResolvedValue(oldPrefs);

            await useUserPreferencesStore.getState().load();

            const loaded = useUserPreferencesStore.getState().preferences;
            expect(loaded?.favoriteMpcSources).toEqual([]);
            expect(loaded?.favoriteMpcTags).toEqual([]);
        });

        it("should initialize with built-in defaults if no preferences exist", async () => {
            (db.userPreferences.get as Mock).mockResolvedValue(undefined); // No prefs found

            // Set some state in settings store to mimic "built-in" defaults (current state)
            useSettingsStore.setState({ columns: 5 });

            await useUserPreferencesStore.getState().load();

            expect(db.userPreferences.add).toHaveBeenCalled();
            const addedPrefs = (db.userPreferences.add as Mock).mock.calls[0][0];

            expect(addedPrefs.id).toBe("default");
            expect(addedPrefs.settings.columns).toBe(5);
            expect(useUserPreferencesStore.getState().preferences).toEqual(addedPrefs);
        });

        it("should repair legacy UI state when loading old preferences", async () => {
            const legacyPrefs = {
                id: "default",
                settings: {},
                favoriteCardbacks: [],
                favoriteMpcSources: [],
                favoriteMpcTags: [],
                favoriteMpcDpi: null,
                favoriteMpcSort: null,
                settingsPanelState: {
                    order: ["Application", "Layout", "Bleed & Guides", "Card", "Export"],
                },
            };
            (db.userPreferences.get as Mock).mockResolvedValue(legacyPrefs);

            await useUserPreferencesStore.getState().load();

            const loaded = useUserPreferencesStore.getState().preferences;
            expect(loaded?.settingsPanelState?.collapsed).toEqual({});
            expect(loaded?.settingsPanelState?.order[0]).toBe("projects");
            expect(loaded?.settingsPanelState?.order.at(-1)).toBe("application");
        });

        it("should preserve valid ids while repairing mixed legacy order", async () => {
            const mixedPrefs = {
                id: "default",
                settings: {},
                favoriteCardbacks: [],
                favoriteMpcSources: [],
                favoriteMpcTags: [],
                favoriteMpcDpi: null,
                favoriteMpcSort: null,
                settingsPanelState: {
                    order: ["layout", "Application", "Export"],
                    collapsed: {},
                },
            };
            (db.userPreferences.get as Mock).mockResolvedValue(mixedPrefs);

            await useUserPreferencesStore.getState().load();

            const loaded = useUserPreferencesStore.getState().preferences;
            expect(loaded?.settingsPanelState?.order?.[0]).toBe("projects");
            expect(loaded?.settingsPanelState?.order).toContain("layout");
            expect(loaded?.settingsPanelState?.order).toContain("export");
            expect(loaded?.settingsPanelState?.order?.at(-1)).toBe("application");
        });

        it("should tolerate missing forced order positions during repair", async () => {
            const legacyPrefs = {
                id: "default",
                settings: {},
                favoriteCardbacks: [],
                favoriteMpcSources: [],
                favoriteMpcTags: [],
                favoriteMpcDpi: null,
                favoriteMpcSort: null,
                settingsPanelState: {
                    order: ["Application", "Layout"],
                    collapsed: {},
                },
            };
            const originalIndexOf = Array.prototype.indexOf;
            const indexOfSpy = vi.spyOn(Array.prototype, "indexOf").mockImplementation(function (this: unknown[], searchElement: unknown, fromIndex?: number) {
                if (searchElement === "projects" || searchElement === "application") {
                    return -1;
                }
                return originalIndexOf.call(this, searchElement as never, fromIndex as never);
            });
            (db.userPreferences.get as Mock).mockResolvedValue(legacyPrefs);

            await useUserPreferencesStore.getState().load();

            expect(useUserPreferencesStore.getState().preferences?.settingsPanelState?.order).toContain("projects");
            expect(useUserPreferencesStore.getState().preferences?.settingsPanelState?.order).toContain("application");
            indexOfSpy.mockRestore();
        });

        it("should preserve fully populated valid preferences without repairing them", async () => {
            const validPrefs = {
                id: "default",
                settings: {},
                favoriteCardbacks: [],
                favoriteMpcSources: ["source-a"],
                favoriteMpcTags: ["tag-a"],
                favoriteMpcDpi: 200,
                favoriteMpcSort: "name" as const,
                settingsPanelState: {
                    order: ["projects", "layout", "bleed", "card", "guides", "darken", "filterSort", "export", "application"],
                    collapsed: { layout: true },
                },
                settingsPanelWidth: 480,
                isSettingsPanelCollapsed: true,
                isUploadPanelCollapsed: true,
                uploadPanelWidth: 512,
                cardEditorSectionCollapsed: { basic: true },
                cardEditorSectionOrder: ["basic", "enhance", "darkPixels", "holographic", "colorReplace", "gamma", "colorEffects", "borderEffects"],
                filterSectionCollapsed: { Source: true, Quality: true },
            };
            (db.userPreferences.get as Mock).mockResolvedValue(validPrefs);

            await useUserPreferencesStore.getState().load();

            const loaded = useUserPreferencesStore.getState().preferences;
            expect(db.userPreferences.add).not.toHaveBeenCalled();
            expect(loaded).toEqual(validPrefs);
        });

        it("should log and recover when loading preferences fails", async () => {
            const error = new Error("boom");
            const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
            (db.userPreferences.get as Mock).mockRejectedValue(error);

            await useUserPreferencesStore.getState().load();

            expect(consoleSpy).toHaveBeenCalledWith("Failed to load user preferences:", error);
            expect(useUserPreferencesStore.getState().isLoading).toBe(false);
            consoleSpy.mockRestore();
        });
    });

    describe("saveCurrentAsDefaults", () => {
        it("should save current settings store state as user defaults", async () => {
            // Setup initial state
            useUserPreferencesStore.setState({
                preferences: {
                    id: 'default',
                    settings: {},
                    favoriteCardbacks: ['existing'],
                    favoriteMpcSources: [],
                    favoriteMpcTags: [],
                    favoriteMpcDpi: null,
                    favoriteMpcSort: null,
                }
            });

            // Modify settings
            useSettingsStore.setState({ zoom: 2.5 });

            await useUserPreferencesStore.getState().saveCurrentAsDefaults();

            expect(db.userPreferences.put).toHaveBeenCalled();
            const savedPrefs = (db.userPreferences.put as Mock).mock.calls[0][0];

            expect(savedPrefs.settings.zoom).toBe(2.5);
            expect(savedPrefs.favoriteCardbacks).toEqual(['existing']); // Should preserve cardbacks
            expect(savedPrefs.favoriteMpcSources).toEqual([]);
            expect(savedPrefs.favoriteMpcTags).toEqual([]);
            expect(useUserPreferencesStore.getState().preferences).toEqual(savedPrefs);
        });

        it("should save defaults when no preferences are currently loaded", async () => {
            useUserPreferencesStore.setState({ preferences: null });
            useSettingsStore.setState({ zoom: 1.25, hasHydrated: true });

            await useUserPreferencesStore.getState().saveCurrentAsDefaults();

            const savedPrefs = (db.userPreferences.put as Mock).mock.calls[0][0];
            expect(savedPrefs.id).toBe("default");
            expect(savedPrefs.favoriteCardbacks).toEqual([]);
            expect(savedPrefs.favoriteMpcSources).toEqual([]);
            expect(savedPrefs.favoriteMpcTags).toEqual([]);
            expect(savedPrefs.favoriteMpcDpi).toBeNull();
            expect(savedPrefs.favoriteMpcSort).toBeNull();
            expect(savedPrefs.settings.zoom).toBe(1.25);
        });
    });

    describe("resetToBuiltIn", () => {
        it("should reset settings to factory defaults and save them as user defaults", async () => {
            // Mock settings reset
            const resetSpy = vi.spyOn(useSettingsStore.getState(), 'resetSettings');

            await useUserPreferencesStore.getState().resetToBuiltIn();

            expect(resetSpy).toHaveBeenCalled();
            expect(db.userPreferences.put).toHaveBeenCalled(); // Should save the reset state
        });
    });

    describe("UI State Persistence", () => {
        beforeEach(() => {
            // Seed store with basic preferences
            useUserPreferencesStore.setState({
                preferences: {
                    id: 'default',
                    settings: {},
                    favoriteCardbacks: [],
                    favoriteMpcSources: [],
                    favoriteMpcTags: [],
                    favoriteMpcDpi: null,
                    favoriteMpcSort: null,
                    settingsPanelState: { order: [], collapsed: {} },
                    settingsPanelWidth: 320,
                    isSettingsPanelCollapsed: false,
                    isUploadPanelCollapsed: false,
                    uploadPanelWidth: 320,
                    cardEditorSectionCollapsed: {},
                    cardEditorSectionOrder: [],
                    filterSectionCollapsed: {},
                }
            });
        });

        it("should persist settings panel state", async () => {
            const newState = { order: ['A', 'B'], collapsed: { A: true } };
            await useUserPreferencesStore.getState().setSettingsPanelState(newState);

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.settingsPanelState).toEqual(newState);
            expect(db.userPreferences.put).toHaveBeenCalledWith(prefs);
        });

        it("should persist panel widths", async () => {
            await useUserPreferencesStore.getState().setSettingsPanelWidth(500);

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.settingsPanelWidth).toBe(500);
            expect(db.userPreferences.put).toHaveBeenCalledWith(prefs);
        });

        it("should persist favorite MPC dpi", async () => {
            await useUserPreferencesStore.getState().setFavoriteMpcDpi(300);

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.favoriteMpcDpi).toBe(300);
            expect(db.userPreferences.put).toHaveBeenCalledWith(prefs);
        });

        it("should persist settings panel collapse and favorite sort", async () => {
            await useUserPreferencesStore.getState().setIsSettingsPanelCollapsed(true);
            await useUserPreferencesStore.getState().setFavoriteMpcSort("source");

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.isSettingsPanelCollapsed).toBe(true);
            expect(prefs?.favoriteMpcSort).toBe("source");
            expect(db.userPreferences.put).toHaveBeenCalledWith(prefs);
        });

        it("should persist upload panel collapse and width", async () => {
            await useUserPreferencesStore.getState().setIsUploadPanelCollapsed(true);
            await useUserPreferencesStore.getState().setUploadPanelWidth(640);

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.isUploadPanelCollapsed).toBe(true);
            expect(prefs?.uploadPanelWidth).toBe(640);
            expect(db.userPreferences.put).toHaveBeenCalledWith(prefs);
        });

        it("should persist card editor section collapse state", async () => {
            const newCollapsed = { 'basic': true };
            await useUserPreferencesStore.getState().setCardEditorSectionCollapsed(newCollapsed);

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.cardEditorSectionCollapsed).toEqual(newCollapsed);
            expect(db.userPreferences.put).toHaveBeenCalledWith(prefs);
        });

        it("should persist card editor section order", async () => {
            const newOrder = ["basic", "enhance"];
            await useUserPreferencesStore.getState().setCardEditorSectionOrder(newOrder);

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.cardEditorSectionOrder).toEqual(newOrder);
            expect(db.userPreferences.put).toHaveBeenCalledWith(prefs);
        });

        it("should persist filter section collapse state", async () => {
            const newCollapsed = { Source: true };
            await useUserPreferencesStore.getState().setFilterSectionCollapsed(newCollapsed);

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.filterSectionCollapsed).toEqual(newCollapsed);
            expect(db.userPreferences.put).toHaveBeenCalledWith(prefs);
        });

        it("should toggle MPC favorite source", async () => {
            await useUserPreferencesStore.getState().toggleFavoriteMpcSource("source1");

            let prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.favoriteMpcSources).toContain("source1");
            expect(db.userPreferences.put).toHaveBeenCalledTimes(1);

            await useUserPreferencesStore.getState().toggleFavoriteMpcSource("source1");

            prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.favoriteMpcSources).not.toContain("source1");
            expect(db.userPreferences.put).toHaveBeenCalledTimes(2);
        });

        it("should initialize MPC favorite sources/tags arrays when missing", async () => {
            useUserPreferencesStore.setState({
                preferences: {
                    id: "default",
                    settings: {},
                    favoriteCardbacks: [],
                    favoriteMpcSources: undefined as never,
                    favoriteMpcTags: undefined as never,
                    favoriteMpcDpi: null,
                    favoriteMpcSort: null,
                },
            });

            await useUserPreferencesStore.getState().toggleFavoriteMpcSource("source2");
            await useUserPreferencesStore.getState().toggleFavoriteMpcTag("tag2");

            const prefs = useUserPreferencesStore.getState().preferences;
            expect(prefs?.favoriteMpcSources).toEqual(["source2"]);
            expect(prefs?.favoriteMpcTags).toEqual(["tag2"]);
        });

        it("should toggle MPC favorite tags on and off", async () => {
            await useUserPreferencesStore.getState().toggleFavoriteMpcTag("tag1");
            expect(useUserPreferencesStore.getState().preferences?.favoriteMpcTags).toContain("tag1");

            await useUserPreferencesStore.getState().toggleFavoriteMpcTag("tag1");
            expect(useUserPreferencesStore.getState().preferences?.favoriteMpcTags).not.toContain("tag1");
        });

        it("should ignore preference updates when no preferences are loaded", async () => {
            useUserPreferencesStore.setState({ preferences: null });

            await useUserPreferencesStore.getState().toggleFavoriteMpcSource("source0");
            await useUserPreferencesStore.getState().toggleFavoriteMpcTag("tag1");
            await useUserPreferencesStore.getState().setFavoriteMpcDpi(300);
            await useUserPreferencesStore.getState().setFavoriteMpcSort("name");
            await useUserPreferencesStore.getState().setSettingsPanelWidth(480);
            await useUserPreferencesStore.getState().setSettingsPanelState({ order: ["x"], collapsed: {} });
            await useUserPreferencesStore.getState().setIsSettingsPanelCollapsed(true);
            await useUserPreferencesStore.getState().setIsUploadPanelCollapsed(true);
            await useUserPreferencesStore.getState().setUploadPanelWidth(640);
            await useUserPreferencesStore.getState().setCardEditorSectionCollapsed({ basic: true });
            await useUserPreferencesStore.getState().setCardEditorSectionOrder(["basic"]);
            await useUserPreferencesStore.getState().setFilterSectionCollapsed({ Source: true });

            expect(db.userPreferences.put).not.toHaveBeenCalled();
        });
    });
});
