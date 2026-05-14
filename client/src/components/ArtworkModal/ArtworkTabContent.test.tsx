import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Mock settings store
vi.mock('@/store', () => ({
    useSettingsStore: vi.fn((selector) => {
        const state = {
            preferredArtSource: 'scryfall',
            favoriteMpcSources: [],
        };
        return selector(state);
    }),
    useUserPreferencesStore: vi.fn((selector) => selector({ preferences: null })),
}));

vi.mock('flowbite-react', () => ({
    Button: ({ children, onClick, color, className, size, disabled, title }: { children: React.ReactNode; onClick?: () => void; color?: string; className?: string; size?: string; disabled?: boolean; title?: string }) => (
        <button onClick={onClick} data-color={color} className={className} data-size={size} disabled={disabled} title={title}>{children}</button>
    ),
    Checkbox: ({ checked, onChange, className }: { checked: boolean; onChange: (e: { target: { checked: boolean } }) => void; className?: string }) => (
        <input type="checkbox" checked={checked} onChange={onChange} className={className} data-testid="apply-to-all-checkbox" />
    ),
}));

vi.mock('lucide-react', () => ({
    Search: ({ className }: { className?: string }) => <span data-testid="search-icon" className={className}>🔍</span>,
    Filter: ({ className }: { className?: string }) => <span data-testid="filter-icon" className={className}>Funnel</span>,
    Image: ({ className }: { className?: string }) => <span data-testid="image-icon" className={className}>🖼️</span>,
    Settings: ({ className }: { className?: string }) => <span data-testid="settings-icon" className={className}>⚙️</span>,
}));

vi.mock('../common', () => ({
    ToggleButtonGroup: ({ options, value, onChange }: { options: { id: string; label?: string }[]; value: string; onChange: (value: string) => void }) => (
        <div data-testid={`toggle-${value}`}>
            {options.map((option) => (
                <button key={option.id} data-testid={`toggle-${option.id}`} onClick={() => onChange(option.id)}>
                    {option.label ?? option.id}
                </button>
            ))}
        </div>
    ),
    CardGrid: ({ children }: { children: React.ReactNode }) => <div data-testid="card-grid">{children}</div>,
    ArtSourceToggle: ({ value, onChange }: { value: string; onChange: (value: 'scryfall' | 'mpc') => void }) => (
        <div data-testid={`art-source-${value}`}>
            <button data-testid="source-scryfall" onClick={() => onChange('scryfall')}>Scryfall</button>
            <button data-testid="source-mpc" onClick={() => onChange('mpc')}>MPC</button>
        </div>
    ),
    FloatingZoomPanel: ({ onZoomChange }: { onZoomChange: (value: number) => void }) => (
        <button data-testid="floating-zoom-panel" onClick={() => onZoomChange(2)}>Zoom</button>
    ),
}));

vi.mock('./CardbackLibrary', () => ({
    CardbackLibrary: () => <div data-testid="cardback-library">CardbackLibrary</div>,
}));

// Mock the CardArtContent component from its direct module path.
vi.mock('../common/CardArtContent', () => ({
    CardArtContent: ({ artSource, onSelectCard }: { artSource: string; onSelectCard: (name: string, url?: string) => void }) => (
        <div
            data-testid={artSource === 'scryfall' ? 'scryfall-art-content' : 'mpc-art-content'}
            onClick={() => onSelectCard('Test Card', 'test-url')}
        >
            {artSource === 'scryfall' ? 'CardArtContent-Scryfall' : 'CardArtContent-MPC'}
        </div>
    ),
}));

vi.mock('@/helpers/cardbackLibrary', () => ({
    isCardbackId: (id: string) => id?.startsWith('cardback-'),
}));

import { ArtworkTabContent, type ArtworkTabContentProps } from './ArtworkTabContent';

describe('ArtworkTabContent', () => {
    const defaultProps: ArtworkTabContentProps = {
        modalCard: { uuid: '1', name: 'Test Card', order: 0, isUserUpload: false },
        linkedBackCard: undefined,
        selectedFace: 'front',
        isDFC: false,
        previewCardData: null,
        showCardbackLibrary: false,
        setShowCardbackLibrary: vi.fn(),
        applyToAll: false,
        setApplyToAll: vi.fn(),
        tabLabels: { front: 'Test Card', back: 'Back' },
        cardbackOptions: [],
        setCardbackOptions: vi.fn(),
        defaultCardbackId: 'default-cardback',
        filteredImageUrls: undefined,
        displayData: {
            name: 'Test Card',
            imageUrls: ['https://example.com/image.jpg'],
            id: 'test-id',
            selectedArtId: undefined,
            processedDisplayUrl: null,
        },
        zoomLevel: 100,
        onOpenSearch: vi.fn(),
        onSelectCardback: vi.fn(),
        onSetAsDefaultCardback: vi.fn(),
        onSelectArtwork: vi.fn(),
        onSelectMpcArt: vi.fn(),
        onClose: vi.fn(),
        onRequestDelete: vi.fn(),
        onExecuteDelete: vi.fn(),
        artSource: 'scryfall',
        setArtSource: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('rendering', () => {
        it('should return null when modalCard is null', () => {
            const { container } = render(<ArtworkTabContent {...defaultProps} modalCard={null} />);
            expect(container.innerHTML).toBe('');
        });

        it('should render search button', () => {
            render(<ArtworkTabContent {...defaultProps} />);
            expect(screen.getAllByText('Search for a different card...').length).toBeGreaterThan(0);
        });

        it('should render apply-to-all checkbox', () => {
            render(<ArtworkTabContent {...defaultProps} />);
            expect(screen.getByTestId('apply-to-all-checkbox')).toBeDefined();
        });

        it('should render card name in apply-to-all label', () => {
            render(<ArtworkTabContent {...defaultProps} />);
            expect(screen.getByText(/Apply to all cards named "Test Card"/)).toBeDefined();
        });
    });

    describe('search button', () => {
        it('should call onOpenSearch when clicked', () => {
            render(<ArtworkTabContent {...defaultProps} />);
            fireEvent.click(screen.getAllByText('Search for a different card...')[0]);
            expect(defaultProps.onOpenSearch).toHaveBeenCalled();
        });
    });

    describe('apply to all', () => {
        it('should call setApplyToAll when checkbox changes', () => {
            render(<ArtworkTabContent {...defaultProps} />);
            const checkbox = screen.getByTestId('apply-to-all-checkbox');
            fireEvent.click(checkbox);
            expect(defaultProps.setApplyToAll).toHaveBeenCalled();
        });
    });

    describe('scryfall art content', () => {
        it('should render scryfall art content when artSource is scryfall', () => {
            render(<ArtworkTabContent {...defaultProps} />);
            expect(screen.getByTestId('scryfall-art-content')).toBeDefined();
        });

        // Note: Get All Prints button is now hidden for Scryfall (prints auto-load)
        // The button only shows for MPC as "Get All Art"
    });

    describe('mpc art content', () => {
        it('should render mpc art content when artSource is mpc', () => {
            render(<ArtworkTabContent {...defaultProps} artSource="mpc" />);
            expect(screen.getByTestId('mpc-art-content')).toBeDefined();
        });

        // Note: Get All Art button was removed - MPC search is automatic via useMpcSearch hook
    });

    describe('cardback library', () => {
        it('should show Use Cardback button for back face without DFC', () => {
            render(<ArtworkTabContent
                {...defaultProps}
                selectedFace="back"
                linkedBackCard={{ uuid: '2', name: 'Back', order: 0, isUserUpload: false }}
            />);
            expect(screen.getAllByText('Use Cardback').length).toBeGreaterThan(0);
        });

        it('should call setShowCardbackLibrary when Use Cardback clicked', () => {
            const setShowCardbackLibrary = vi.fn();
            render(<ArtworkTabContent
                {...defaultProps}
                selectedFace="back"
                linkedBackCard={{ uuid: '2', name: 'Back', order: 0, isUserUpload: false }}
                setShowCardbackLibrary={setShowCardbackLibrary}
            />);
            fireEvent.click(screen.getAllByText('Use Cardback')[0]);
            expect(setShowCardbackLibrary).toHaveBeenCalledWith(true);
        });

        it('should not show Use Cardback button for DFC cards', () => {
            render(<ArtworkTabContent
                {...defaultProps}
                selectedFace="back"
                isDFC={true}
                linkedBackCard={{ uuid: '2', name: 'Back', order: 0, isUserUpload: false }}
            />);
            expect(screen.queryByText('Use Cardback')).toBeNull();
        });
    });

    // Note: Loading state tests removed - isGettingMore prop was removed
    // CardArtContent now handles loading state internally via useScryfallPrints and useMpcSearch

    describe('additional coverage paths', () => {
    it('calls optional mobile landscape tab callbacks', () => {
        const setSelectedFace = vi.fn();
        const setActiveTab = vi.fn();
        render(<ArtworkTabContent {...defaultProps} setSelectedFace={setSelectedFace} setActiveTab={setActiveTab} activeTab="artwork" />);

        fireEvent.click(screen.getByTestId('toggle-back'));
        fireEvent.click(screen.getByTestId('toggle-settings'));

        expect(setSelectedFace).toHaveBeenCalledWith('back');
        expect(setActiveTab).toHaveBeenCalledWith('settings');
    });

    it('renders the cardback library grid when requested', () => {
        render(<ArtworkTabContent {...defaultProps} selectedFace="back" showCardbackLibrary linkedBackCard={undefined} />);

        expect(screen.getByTestId('card-grid')).toBeDefined();
        expect(screen.getByTestId('cardback-library')).toBeDefined();
    });

    it('routes scryfall and mpc card selections through the expected callbacks', () => {
        const onSelectArtwork = vi.fn();
        const onSelectMpcArt = vi.fn();
        render(<ArtworkTabContent {...defaultProps} artSource="mpc" onSelectArtwork={onSelectArtwork} onSelectMpcArt={onSelectMpcArt} />);

        fireEvent.click(screen.getByTestId('scryfall-select-card'));
        fireEvent.click(screen.getByTestId('mpc-select-card'));
        fireEvent.click(screen.getByTestId('mpc-select-mpc-card'));

        expect(onSelectArtwork).toHaveBeenCalledWith('test-url', 'Test Card', undefined);
        expect(onSelectArtwork).toHaveBeenCalledWith('test-url');
        expect(onSelectMpcArt).toHaveBeenCalledWith({ id: 'mpc-1', name: 'MPC Card', imageUrl: 'mpc-url' });
    });

    it('switches MPC source, shows active filter badge, and calls zoom control', () => {
        const setArtSource = vi.fn();
        const setZoomLevel = vi.fn();
        render(<ArtworkTabContent {...defaultProps} artSource="mpc" setArtSource={setArtSource} setZoomLevel={setZoomLevel} />);

        fireEvent.click(screen.getByTestId('mpc-filter-count'));
        expect(screen.getByText('3')).toBeDefined();

        fireEvent.click(screen.getByTestId('mpc-switch-source'));
        fireEvent.click(screen.getByTestId('floating-zoom-panel'));

        expect(setArtSource).toHaveBeenCalledWith('scryfall');
        expect(setZoomLevel).toHaveBeenCalledWith(2);
    });

    it('uses fallback modal card names when display data is empty and hides artwork for cardback ids', () => {
        render(<ArtworkTabContent
            {...defaultProps}
            selectedFace="back"
            linkedBackCard={{ uuid: 'back', name: 'Back Name', order: 1, isUserUpload: false, imageId: 'cardback-1' }}
            displayData={{ name: undefined, imageUrls: undefined, id: undefined, selectedArtId: undefined, processedDisplayUrl: null }}
        />);

        expect(screen.getByText(/Apply to all cards named "Back"/)).toBeDefined();
        expect(screen.getByTestId('cardback-library')).toBeDefined();
    });
});
});
