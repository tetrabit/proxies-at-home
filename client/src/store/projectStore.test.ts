
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useProjectStore } from "./projectStore";
import { db } from "../db";
import { useSettingsStore } from "./settings";
import type { CardOption } from "../../../shared/types";

const mockClearHistory = vi.hoisted(() => vi.fn());
const mockCancelAllProcessing = vi.hoisted(() => vi.fn());

vi.mock("./undoRedo", () => ({
    useUndoRedoStore: {
        getState: () => ({
            clearHistory: mockClearHistory,
            pushAction: vi.fn(),
        }),
    },
}));

vi.mock("../helpers/cancellationService", () => ({
    cancelAllProcessing: mockCancelAllProcessing,
}));

describe("Project Switching (Relational Architecture)", () => {
    beforeEach(async () => {
        // Reset DB
        await db.cards.clear();
        await db.projects.clear();
        await db.userPreferences.clear();

        // Reset stores
        useProjectStore.setState({ currentProjectId: null, projects: [], isLoading: false });
        useSettingsStore.getState().resetSettings();
    });

    it("should maintain data integrity in a single cards table when switching projects", async () => {
        // 1. Create Project A
        const projectIdA = await useProjectStore.getState().createProject("Project A");

        // 2. Add a card to Project A
        const cardA: CardOption = {
            uuid: crypto.randomUUID(),
            name: "Smaug",
            order: 1,
            isUserUpload: false,
            set: "LTR",
            number: "208",
            projectId: projectIdA,
            category: "Commander",
            needs_token: true,
            token_parts: [
                { id: "t1", name: "Treasure", uri: "https://api.scryfall.com/tokens/123" }
            ]
        };
        await db.cards.add(cardA);

        // 3. Create Project B (Active Project switches to B)
        const projectIdB = await useProjectStore.getState().createProject("Project B");

        // 4. Add a card to Project B
        const cardB: CardOption = {
            uuid: crypto.randomUUID(),
            name: "Sol Ring",
            order: 1,
            isUserUpload: false,
            projectId: projectIdB,
            category: "Artifact"
        };
        await db.cards.add(cardB);

        // 5. Verify DB State (Single Source of Truth)
        const allCards = await db.cards.toArray();
        expect(allCards).toHaveLength(2);

        // Check Project A Card
        const storedCardA = allCards.find(c => c.projectId === projectIdA);
        expect(storedCardA).toBeDefined();
        expect(storedCardA?.name).toBe("Smaug");
        expect(storedCardA?.token_parts).toHaveLength(1);
        expect(storedCardA?.token_parts?.[0].name).toBe("Treasure");

        // Check Project B Card
        const storedCardB = allCards.find(c => c.projectId === projectIdB);
        expect(storedCardB).toBeDefined();
        expect(storedCardB?.name).toBe("Sol Ring");

        // 6. "Switch" back to Project A
        // In the relational model, this is just updating a state pointer
        await useProjectStore.getState().switchProject(projectIdA);
        expect(useProjectStore.getState().currentProjectId).toBe(projectIdA);

        // 7. Verify UI Query Logic (Simulation)
        // This effectively tests what the UI does: query by projectId
        const projectACards = await db.cards.where('projectId').equals(projectIdA).toArray();
        expect(projectACards).toHaveLength(1);
        expect(projectACards[0].uuid).toBe(cardA.uuid);

        const projectBCards = await db.cards.where('projectId').equals(projectIdB).toArray();
        expect(projectBCards).toHaveLength(1);
        expect(projectBCards[0].uuid).toBe(cardB.uuid);
    });

    it("should cascadingly delete cards when a project is deleted", async () => {
        const projectId = await useProjectStore.getState().createProject("To Delete");
        const card: CardOption = {
            uuid: crypto.randomUUID(),
            name: "Delete Me",
            order: 1,
            isUserUpload: false,
            projectId: projectId
        };
        await db.cards.add(card);

        expect(await db.cards.count()).toBe(1);

        await useProjectStore.getState().deleteProject(projectId);

        expect(await db.cards.count()).toBe(0);
    });

    it("should load projects ordered by last opened time", async () => {
        await db.projects.add({
            id: "project-old",
            name: "Old",
            createdAt: 1,
            lastOpenedAt: 1,
            cardCount: 0,
            settings: {},
        });
        await db.projects.add({
            id: "project-new",
            name: "New",
            createdAt: 2,
            lastOpenedAt: 2,
            cardCount: 0,
            settings: {},
        });

        await useProjectStore.getState().loadProjects();

        expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["project-new", "project-old"]);
    });

    it("should create projects with default user preference settings", async () => {
        await db.userPreferences.put({
            id: "default",
            settings: { zoom: 2 },
            favoriteCardbacks: [],
            favoriteMpcSources: [],
            favoriteMpcTags: [],
            favoriteMpcDpi: null,
            favoriteMpcSort: null,
        });

        const projectId = await useProjectStore.getState().createProject("Defaults");
        const created = await db.projects.get(projectId);

        expect(created?.settings).toEqual({ zoom: 2 });
    });

    it("should ignore switch requests for the current project", async () => {
        const projectId = await useProjectStore.getState().createProject("Current");
        await useProjectStore.getState().switchProject(projectId);
        mockClearHistory.mockClear();
        mockCancelAllProcessing.mockClear();

        await useProjectStore.getState().switchProject(projectId);

        expect(mockClearHistory).not.toHaveBeenCalled();
        expect(mockCancelAllProcessing).not.toHaveBeenCalled();
    });

    it("should surface a missing project as a logged switch failure", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        await useProjectStore.getState().switchProject("missing-project");

        expect(errorSpy).toHaveBeenCalled();
        expect(useProjectStore.getState().isLoading).toBe(false);
        errorSpy.mockRestore();
    });

    it("should create a replacement project when deleting the active final project", async () => {
        const currentId = await useProjectStore.getState().createProject("Only Project");
        await useProjectStore.getState().switchProject(currentId);

        await useProjectStore.getState().deleteProject(currentId);

        expect(useProjectStore.getState().currentProjectId).not.toBe(currentId);
        expect(useProjectStore.getState().projects).toHaveLength(1);
    });

    it("should switch to another project when deleting the active one and others remain", async () => {
        const projectIdA = await useProjectStore.getState().createProject("Project A");
        const projectIdB = await useProjectStore.getState().createProject("Project B");
        await useProjectStore.getState().switchProject(projectIdA);

        await useProjectStore.getState().deleteProject(projectIdA);

        expect(useProjectStore.getState().currentProjectId).toBe(projectIdB);
    });

    it("should log delete failures", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const deleteSpy = vi.spyOn(db.projects, "delete").mockRejectedValue(new Error("boom"));
        const projectId = await useProjectStore.getState().createProject("Broken");

        await useProjectStore.getState().deleteProject(projectId);

        expect(errorSpy).toHaveBeenCalledWith("[ProjectStore] Delete failed:", expect.any(Error));
        deleteSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it("should rename a project and refresh the list", async () => {
        const projectId = await useProjectStore.getState().createProject("Rename Me");
        await useProjectStore.getState().renameProject(projectId, "Renamed");

        const updated = await db.projects.get(projectId);
        expect(updated?.name).toBe("Renamed");
        expect(useProjectStore.getState().projects.find((p) => p.id === projectId)?.name).toBe("Renamed");
    });
});
