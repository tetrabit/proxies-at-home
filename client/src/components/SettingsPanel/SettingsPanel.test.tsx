import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Settings } from 'lucide-react';

const sortableState = vi.hoisted(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null as unknown,
    transition: null as string | null,
    isDragging: false,
}));

// Mock @dnd-kit/sortable
vi.mock('@dnd-kit/sortable', () => ({
    useSortable: () => sortableState,
}));

vi.mock('@dnd-kit/utilities', () => ({
    CSS: {
        Translate: {
            toString: (transform: unknown) => transform ? 'translateX(10px)' : '',
        },
    },
}));

import { SettingsPanel } from './SettingsPanel';

describe('SettingsPanel', () => {
    beforeEach(() => {
        sortableState.transform = null;
        sortableState.transition = null;
        sortableState.isDragging = false;
        sortableState.setNodeRef.mockClear();
    });
    it('should render title', () => {
        const onToggle = vi.fn();
        render(
            <SettingsPanel
                id="test"
                title="Test Panel"
                isOpen={false}
                onToggle={onToggle}
                icon={Settings}
            >
                <div>Content</div>
            </SettingsPanel>
        );

        expect(screen.getByText('Test Panel')).toBeDefined();
    });

    it('should show children when open', () => {
        const onToggle = vi.fn();
        render(
            <SettingsPanel
                id="test"
                title="Test Panel"
                isOpen={true}
                onToggle={onToggle}
                icon={Settings}
            >
                <div>Content Here</div>
            </SettingsPanel>
        );

        expect(screen.getByText('Content Here')).toBeDefined();
    });

    it('should hide children when closed', () => {
        const onToggle = vi.fn();
        render(
            <SettingsPanel
                id="test"
                title="Test Panel"
                isOpen={false}
                onToggle={onToggle}
                icon={Settings}
            >
                <div>Content Here</div>
            </SettingsPanel>
        );

        expect(screen.queryByText('Content Here')).toBeNull();
    });

    it('should call onToggle when header is clicked', () => {
        const onToggle = vi.fn();
        render(
            <SettingsPanel
                id="test"
                title="Test Panel"
                isOpen={false}
                onToggle={onToggle}
                icon={Settings}
            >
                <div>Content</div>
            </SettingsPanel>
        );

        fireEvent.click(screen.getByText('Test Panel'));
        expect(onToggle).toHaveBeenCalled();
    });


    it('applies mobile and dragging styles while suppressing open content during drag', () => {
        sortableState.transform = { x: 10 };
        sortableState.transition = 'transform 120ms';
        sortableState.isDragging = true;

        render(
            <SettingsPanel
                id="dragging"
                title="Dragging Panel"
                isOpen={true}
                onToggle={vi.fn()}
                icon={Settings}
                mobile
            >
                <div>Hidden While Dragging</div>
            </SettingsPanel>
        );

        const panel = document.getElementById('settings-panel-dragging')!;
        expect(panel.style.transform).toBe('translateX(10px)');
        expect(panel.style.transition).toBe('transform 120ms');
        expect(panel.style.zIndex).toBe('10');
        expect(panel.style.opacity).toBe('0.5');
        expect(panel.className).toContain('landscape:border');
        expect(screen.queryByText('Hidden While Dragging')).toBeNull();
    });

    it('does not render badge chrome for zero badges or missing clear handlers', () => {
        const { rerender } = render(
            <SettingsPanel
                id="zero-badge"
                title="Zero Badge"
                isOpen={false}
                onToggle={vi.fn()}
                icon={Settings}
                badge={0}
            >
                <div>Content</div>
            </SettingsPanel>
        );

        expect(screen.queryByText('0')).toBeNull();
        expect(screen.queryByTitle('Clear all filters')).toBeNull();

        rerender(
            <SettingsPanel
                id="badge-no-clear"
                title="Badge No Clear"
                isOpen={false}
                onToggle={vi.fn()}
                icon={Settings}
                badge={2}
            >
                <div>Content</div>
            </SettingsPanel>
        );

        expect(screen.getByText('2')).toBeDefined();
        expect(screen.queryByTitle('Clear all filters')).toBeNull();
    });

    it('should show badge when provided', () => {
        const onToggle = vi.fn();
        render(
            <SettingsPanel
                id="test"
                title="Test Panel"
                isOpen={false}
                onToggle={onToggle}
                icon={Settings}
                badge={5}
            >
                <div>Content</div>
            </SettingsPanel>
        );

        expect(screen.getByText('5')).toBeDefined();
    });

    it('should clear badge without toggling the panel', () => {
        const onToggle = vi.fn();
        const onClearBadge = vi.fn();
        render(
            <SettingsPanel
                id="test"
                title="Test Panel"
                isOpen={false}
                onToggle={onToggle}
                icon={Settings}
                badge={3}
                onClearBadge={onClearBadge}
            >
                <div>Content</div>
            </SettingsPanel>
        );

        fireEvent.click(screen.getByTitle('Clear all filters'));

        expect(onClearBadge).toHaveBeenCalledOnce();
        expect(onToggle).not.toHaveBeenCalled();
    });
});
