import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock("@/hooks/usePageViewSettings", () => ({
    usePageViewSettings: vi.fn(),
}));

vi.mock("@/store", () => ({
    useCardEditorModalStore: vi.fn(),
}));

vi.mock("../ZoomControls", () => ({
    ZoomControls: () => <div data-testid="zoom-controls">ZoomControls</div>,
}));

vi.mock("../UndoRedoControls", () => ({
    UndoRedoControls: () => <div data-testid="undo-redo-controls">UndoRedoControls</div>,
}));

vi.mock("@/hooks/useOnClickOutside", () => ({
    useOnClickOutside: (_ref: unknown, handler: () => void) => {
        (window as unknown as { __outsideHandler?: () => void }).__outsideHandler = handler;
    },
}));

vi.mock("react", async () => {
    const actual = await vi.importActual<typeof import('react')>('react');
    const nullRef = {};
    Object.defineProperty(nullRef, 'current', {
        configurable: true,
        enumerable: true,
        get: () => null,
        set: () => undefined,
    });
    return {
        ...actual,
        useRef: () => nullRef,
    };
});

import { PageViewFloatingControls } from "./PageViewFloatingControls";
import { usePageViewSettings } from "@/hooks/usePageViewSettings";
import { useCardEditorModalStore } from "@/store";

describe("PageViewFloatingControls ref guard", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(usePageViewSettings).mockReturnValue({
            settingsPanelWidth: 300,
            isSettingsPanelCollapsed: false,
            uploadPanelWidth: 300,
            isUploadPanelCollapsed: false,
        });
        vi.mocked(useCardEditorModalStore).mockImplementation((selector: (state: { open: boolean }) => unknown) => selector({
            open: false,
        }));
    });

    it("keeps the mobile zoom controls open when the internal ref is unavailable", () => {
        render(<PageViewFloatingControls hasCards={true} mobile={true} />);

        fireEvent.click(screen.getByRole("button"));
        expect(screen.getByTestId("zoom-controls")).toBeDefined();

        fireEvent.click(document.body);
        expect(screen.getByTestId("zoom-controls")).toBeDefined();
    });
});
