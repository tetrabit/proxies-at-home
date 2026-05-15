import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
    parseMpcXml: vi.fn(() => [{ name: 'Test Card', quantity: 1, mpcId: '123' }]),
    processCards: vi.fn().mockResolvedValue(undefined),
    setSortBy: vi.fn(),
    showErrorToast: vi.fn(),
}));

vi.mock('@/helpers/importParsers', () => ({
    parseMpcXml: (...args: [string]) => mocks.parseMpcXml(...args),
}));

vi.mock('@/hooks/useCardImport', () => ({
    useCardImport: ({ onComplete }: { onComplete?: () => void }) => ({
        processCards: async (intents: unknown[]) => {
            await mocks.processCards(intents);
            onComplete?.();
        },
    }),
}));

vi.mock('@/store/settings', () => ({
    useSettingsStore: {
        getState: () => ({ setSortBy: mocks.setSortBy }),
    },
}));

vi.mock('@/store/toast', () => ({
    useToastStore: {
        getState: () => ({ showErrorToast: mocks.showErrorToast }),
    },
}));

import { MpcImportSection } from './MpcImportSection';

function input() {
    return document.getElementById('import-mpc-xml') as HTMLInputElement;
}

function uploadXml(contents = '<xml>test</xml>') {
    const file = new File([contents], 'test.xml', { type: 'text/xml' });
    fireEvent.change(input(), { target: { files: [file] } });
    return file;
}

describe('MpcImportSection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.parseMpcXml.mockReturnValue([{ name: 'Test Card', quantity: 1, mpcId: '123' }]);
        mocks.processCards.mockResolvedValue(undefined);
    });

    it('renders the import button', () => {
        render(<MpcImportSection mobile />);
        expect(screen.getByText('Import MPC XML')).toBeDefined();
    });

    it('imports parsed MPC XML, sorts manually, calls completion, and clears the input', async () => {
        const onUploadComplete = vi.fn();
        render(<MpcImportSection onUploadComplete={onUploadComplete} />);

        const fileInput = input();
        uploadXml('<cards><card name="Island" /></cards>');

        await waitFor(() => expect(mocks.processCards).toHaveBeenCalledWith([{ name: 'Test Card', quantity: 1, mpcId: '123' }]));
        expect(mocks.parseMpcXml).toHaveBeenCalledWith('<cards><card name="Island" /></cards>');
        expect(mocks.setSortBy).toHaveBeenCalledWith('manual');
        expect(onUploadComplete).toHaveBeenCalled();
        expect(fileInput.value).toBe('');
    });

    it('ignores change events without a file', () => {
        render(<MpcImportSection />);
        fireEvent.change(input(), { target: { files: [] } });
        expect(mocks.parseMpcXml).not.toHaveBeenCalled();
        expect(mocks.processCards).not.toHaveBeenCalled();
    });

    it('shows an error toast and clears the input when the file contains no cards', async () => {
        mocks.parseMpcXml.mockReturnValue([]);
        render(<MpcImportSection />);

        const fileInput = input();
        uploadXml('<empty />');

        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('No cards found in the file.'));
        expect(mocks.processCards).not.toHaveBeenCalled();
        expect(fileInput.value).toBe('');
    });

    it('shows parser errors and clears the input', async () => {
        const error = new Error('Invalid MPC export');
        mocks.parseMpcXml.mockImplementation(() => { throw error; });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        render(<MpcImportSection />);

        const fileInput = input();
        uploadXml('<bad />');

        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Invalid MPC export'));
        expect(consoleError).toHaveBeenCalledWith(error);
        expect(mocks.processCards).not.toHaveBeenCalled();
        expect(fileInput.value).toBe('');
        consoleError.mockRestore();
    });


    it('uses the generic parse error message for non-Error failures', async () => {
        mocks.parseMpcXml.mockImplementation(() => { throw 'bad xml'; });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        render(<MpcImportSection />);

        uploadXml('');

        await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('Failed to parse file or import cards.'));
        expect(consoleError).toHaveBeenCalledWith('bad xml');
        expect(mocks.processCards).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('clears the hidden input before opening the file picker', () => {
        render(<MpcImportSection />);
        const fileInput = input();
        Object.defineProperty(fileInput, 'value', { value: 'existing.xml', writable: true });
        fireEvent.click(fileInput);
        expect(fileInput.value).toBe('');
    });

    it('imports parsed MPC XML without completion callback and clears the input', async () => {
        render(<MpcImportSection />);

        const fileInput = input();
        uploadXml('<cards><card name="Island" /></cards>');

        await waitFor(() => expect(mocks.processCards).toHaveBeenCalledWith([{ name: 'Test Card', quantity: 1, mpcId: '123' }]));
        expect(mocks.parseMpcXml).toHaveBeenCalledWith('<cards><card name="Island" /></cards>');
        expect(mocks.setSortBy).toHaveBeenCalledWith('manual');
        expect(fileInput.value).toBe('');
    });
});
