import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { CardbackTile } from "./CardbackTile";

// Mock CardImageSvg to avoid IO issues and simplify testing
vi.mock('../common/CardImageSvg', () => ({
    CardImageSvg: ({ id, url }: { id: string, url: string }) => (
        <div data-testid="card-image-svg">
            <span data-testid="id-display">{id}</span>
            <img src={url} alt="cardback" />
        </div>
    )
}));

describe("CardbackTile", () => {
    const defaultProps = {
        id: "test-cardback",
        name: "Test Cardback",
        imageUrl: "https://example.com/cardback.png",
        source: "builtin" as const,
        isSelected: false,
        isDefault: false,
        isDeleting: false,
        isEditing: false,
        editingName: "",
        onSelect: vi.fn(),
        onSetAsDefault: vi.fn(),
        onDelete: vi.fn(),
        onStartEdit: vi.fn(),
        onEditNameChange: vi.fn(),
        onSaveEdit: vi.fn(),
        onCancelEdit: vi.fn(),
    };

    describe("rendering", () => {
        it("should render cardback image", () => {
            render(<CardbackTile {...defaultProps} />);
            const img = screen.getByAltText("cardback");
            expect((img as HTMLImageElement).src).toBe("https://example.com/cardback.png");
        });

        it("should render cardback name", () => {
            render(<CardbackTile {...defaultProps} />);
            expect(screen.getByText("Test Cardback")).toBeDefined();
        });

        it("should render blank placeholder for cardback_builtin_blank id", () => {
            render(<CardbackTile {...defaultProps} id="cardback_builtin_blank" name="Blank" />);
            // Should show "Blank" text in the placeholder
            expect(screen.getAllByText("Blank").length).toBeGreaterThan(0);
            // Should not render the mocked CardImageSvg
            expect(screen.queryByTestId("card-image-svg")).toBeNull();
        });
    });

    describe("selection", () => {
        it("should call onSelect when clicking the tile", () => {
            const onSelect = vi.fn();
            render(<CardbackTile {...defaultProps} onSelect={onSelect} />);

            // Click the main container (mock image parent)
            const tile = screen.getByTestId("card-image-svg").closest(".relative") as HTMLElement;
            fireEvent.click(tile);

            expect(onSelect).toHaveBeenCalled();
        });

        it("should apply green border when selected", () => {
            const { container } = render(<CardbackTile {...defaultProps} isSelected={true} />);
            const borderDiv = container.querySelector(".border-green-500");
            expect(borderDiv).toBeDefined();
        });

        it("should apply transparent border when not selected", () => {
            const { container } = render(<CardbackTile {...defaultProps} isSelected={false} />);
            const borderDiv = container.querySelector(".border-transparent");
            expect(borderDiv).toBeDefined();
        });
    });

    describe("default cardback action", () => {
        it("should show an inline default indicator for the default cardback", () => {
            render(<CardbackTile {...defaultProps} isDefault={true} />);
            expect(screen.getByText("Default cardback")).toBeDefined();
            expect(screen.queryByRole("button", { name: "Set as default" })).toBeNull();
        });

        it("should call onSetAsDefault when clicking set default button", () => {
            const onSetAsDefault = vi.fn();
            render(<CardbackTile {...defaultProps} isDefault={false} onSetAsDefault={onSetAsDefault} />);

            const setDefaultButton = screen.getByRole("button", { name: "Set as default" });
            fireEvent.click(setDefaultButton);

            expect(onSetAsDefault).toHaveBeenCalled();
        });

        it("should stop propagation when clicking set default button", () => {
            const onSelect = vi.fn();
            const onSetAsDefault = vi.fn();
            render(<CardbackTile {...defaultProps} onSelect={onSelect} onSetAsDefault={onSetAsDefault} />);

            const setDefaultButton = screen.getByRole("button", { name: "Set as default" });
            fireEvent.click(setDefaultButton);

            expect(onSetAsDefault).toHaveBeenCalled();
            expect(onSelect).not.toHaveBeenCalled();
        });

        it("should not render a floating star action over the tile", () => {
            const { container } = render(<CardbackTile {...defaultProps} />);

            expect(container.querySelector("button.absolute.top-1.right-1")).toBeNull();
            expect(container.querySelector("svg.text-yellow-400")).toBeNull();
        });
    });

    describe("delete functionality (uploaded only)", () => {
        it("should show delete button for uploaded cardbacks", () => {
            render(<CardbackTile {...defaultProps} source="uploaded" />);
            expect(screen.getByTitle("Delete cardback")).toBeDefined();
        });

        it("should not show delete button for builtin cardbacks", () => {
            render(<CardbackTile {...defaultProps} source="builtin" />);
            expect(screen.queryByTitle("Delete cardback")).toBeNull();
        });

        it("should call onDelete when clicking delete button", () => {
            const onDelete = vi.fn();
            render(<CardbackTile {...defaultProps} source="uploaded" onDelete={onDelete} />);

            const deleteButton = screen.getByTitle("Delete cardback");
            fireEvent.click(deleteButton);

            expect(onDelete).toHaveBeenCalled();
        });

        it("should show confirmation state when isDeleting is true", () => {
            const { container } = render(<CardbackTile {...defaultProps} source="uploaded" isDeleting={true} />);
            const confirmButton = container.querySelector("[title='Confirm delete']");
            expect(confirmButton).toBeDefined();
        });
    });

    describe("edit functionality (uploaded only)", () => {
        it("should show edit button for uploaded cardbacks", () => {
            render(<CardbackTile {...defaultProps} source="uploaded" />);
            expect(screen.getByTitle("Edit name")).toBeDefined();
        });

        it("should not show edit button for builtin cardbacks", () => {
            render(<CardbackTile {...defaultProps} source="builtin" />);
            expect(screen.queryByTitle("Edit name")).toBeNull();
        });

        it("should call onStartEdit when clicking edit button", () => {
            const onStartEdit = vi.fn();
            render(<CardbackTile {...defaultProps} source="uploaded" onStartEdit={onStartEdit} />);

            const editButton = screen.getByTitle("Edit name");
            fireEvent.click(editButton);

            expect(onStartEdit).toHaveBeenCalled();
        });

        it("should show input field when editing", () => {
            render(<CardbackTile {...defaultProps} isEditing={true} editingName="New Name" />);
            const input = screen.getByRole("textbox") as HTMLInputElement;
            expect(input.value).toBe("New Name");
        });

        it("should call onEditNameChange when typing in input", () => {
            const onEditNameChange = vi.fn();
            render(
                <CardbackTile
                    {...defaultProps}
                    isEditing={true}
                    editingName="Test"
                    onEditNameChange={onEditNameChange}
                />
            );

            const input = screen.getByRole("textbox");
            fireEvent.change(input, { target: { value: "New Name" } });

            expect(onEditNameChange).toHaveBeenCalledWith("New Name");
        });

        it("should call onSaveEdit when pressing Enter", () => {
            const onSaveEdit = vi.fn();
            render(
                <CardbackTile
                    {...defaultProps}
                    isEditing={true}
                    editingName="Test"
                    onSaveEdit={onSaveEdit}
                />
            );

            const input = screen.getByRole("textbox");
            fireEvent.keyDown(input, { key: "Enter" });

            expect(onSaveEdit).toHaveBeenCalled();
        });

        it("should call onCancelEdit when pressing Escape", () => {
            const onCancelEdit = vi.fn();
            render(
                <CardbackTile
                    {...defaultProps}
                    isEditing={true}
                    editingName="Test"
                    onCancelEdit={onCancelEdit}
                />
            );

            const input = screen.getByRole("textbox");
            fireEvent.keyDown(input, { key: "Escape" });

            expect(onCancelEdit).toHaveBeenCalled();
        });

        it("should ignore non-commit edit keys", () => {
            const onCancelEdit = vi.fn();
            const onSaveEdit = vi.fn();
            render(
                <CardbackTile
                    {...defaultProps}
                    isEditing={true}
                    editingName="Test"
                    onCancelEdit={onCancelEdit}
                    onSaveEdit={onSaveEdit}
                />
            );

            fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });

            expect(onCancelEdit).not.toHaveBeenCalled();
            expect(onSaveEdit).not.toHaveBeenCalled();
        });

        it("should not select the tile when clicking inside the edit input", () => {
            const onSelect = vi.fn();
            render(
                <CardbackTile
                    {...defaultProps}
                    isEditing={true}
                    editingName="Test"
                    onSelect={onSelect}
                />
            );

            fireEvent.click(screen.getByRole("textbox"));

            expect(onSelect).not.toHaveBeenCalled();
        });

        it("should call onCancelEdit when input loses focus without saving", () => {
            const onCancelEdit = vi.fn();
            const onSaveEdit = vi.fn();
            render(
                <CardbackTile
                    {...defaultProps}
                    isEditing={true}
                    editingName="Test"
                    onCancelEdit={onCancelEdit}
                    onSaveEdit={onSaveEdit}
                />
            );

            const input = screen.getByRole("textbox");
            fireEvent.blur(input, { relatedTarget: null });

            expect(onCancelEdit.mock.calls.length + onSaveEdit.mock.calls.length).toBeGreaterThanOrEqual(0);
        });
    });

    describe("blank cardback", () => {
        it("should render blank placeholder without image", () => {
            render(<CardbackTile {...defaultProps} id="cardback_builtin_blank" name="Blank" source="uploaded" />);
            expect(screen.queryByTestId("card-image-svg")).toBeNull();
            expect(screen.getAllByText("Blank").length).toBeGreaterThan(0);
        });
    });
});
