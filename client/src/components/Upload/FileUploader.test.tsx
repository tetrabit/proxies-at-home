import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  inferCardNameFromFilename: vi.fn((name: string) => name.replace(/\.[^.]+$/, '')),
  addCustomImage: vi.fn().mockResolvedValue('image-id'),
  setLoadingTask: vi.fn(),
  showSuccessToast: vi.fn(),
  processCards: vi.fn().mockResolvedValue(undefined),
  cardbacksAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/helpers/mpc', () => ({
  inferCardNameFromFilename: (...args: [string]) => mocks.inferCardNameFromFilename(...args),
}));

vi.mock('@/helpers/dbUtils', () => ({
  addCustomImage: (...args: unknown[]) => mocks.addCustomImage(...args),
}));

vi.mock('@/store/loading', () => ({
  useLoadingStore: (selector: (state: { setLoadingTask: typeof mocks.setLoadingTask }) => unknown) => selector({ setLoadingTask: mocks.setLoadingTask }),
}));

vi.mock('@/store/toast', () => ({
  useToastStore: { getState: () => ({ showSuccessToast: mocks.showSuccessToast }) },
}));

vi.mock('@/hooks/useCardImport', () => ({
  useCardImport: ({ onComplete }: { onComplete?: () => void }) => ({
    processCards: async (intents: unknown[]) => {
      await mocks.processCards(intents);
      onComplete?.();
    },
  }),
}));

vi.mock('@/db', () => ({
  db: { cardbacks: { add: (...args: unknown[]) => mocks.cardbacksAdd(...args) } },
}));

vi.mock('../common', () => ({
  SplitButton: ({ label, sublabel, htmlFor, isOpen, onToggle, onSelect, onClose, options }: { label: string; sublabel?: string; htmlFor: string; isOpen: boolean; onToggle: () => void; onSelect: (value: string) => void; onClose: () => void; options: Array<{ value: string; label: string }> }) => (
    <div>
      <label htmlFor={htmlFor}>{label}</label>
      <span>{sublabel}</span>
      <button onClick={onToggle}>modes</button>
      {isOpen && options.map((option) => <button key={option.value} onClick={() => { onSelect(option.value); onClose(); }}>{option.label}</button>)}
    </div>
  ),
}));

import { FileUploader } from './FileUploader';

function uploadFiles(files: File[]) {
  const input = document.getElementById('upload-images-unified') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
  return input;
}

describe('FileUploader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addCustomImage.mockResolvedValue('image-id');
    mocks.processCards.mockResolvedValue(undefined);
    mocks.cardbacksAdd.mockResolvedValue(undefined);
  });

  it('renders upload button and default auto-detect mode', () => {
    render(<FileUploader />);
    expect(screen.getAllByText('Upload Images').length).toBeGreaterThan(0);
    expect(screen.getByText('Auto Detect Bleed')).toBeDefined();
  });

  it('uploads auto-detected files through card import and resets loading', async () => {
    const onUploadComplete = vi.fn();
    render(<FileUploader onUploadComplete={onUploadComplete} />);
    const file = new File(['img'], 'Lightning Bolt.png', { type: 'image/png' });

    uploadFiles([file]);

    await waitFor(() => expect(mocks.processCards).toHaveBeenCalled());
    expect(mocks.setLoadingTask).toHaveBeenNthCalledWith(1, 'Processing Images');
    expect(mocks.setLoadingTask).toHaveBeenLastCalledWith(null);
    expect(mocks.addCustomImage).toHaveBeenCalledWith(file, '-auto');
    expect(mocks.processCards.mock.calls[0][0][0]).toMatchObject({
      name: 'Lightning Bolt',
      quantity: 1,
      localImageId: 'image-id',
      preloadedData: { hasBuiltInBleed: undefined },
      sourcePreference: 'manual',
    });
    expect(onUploadComplete).toHaveBeenCalled();
  });

  it('uploads standard and with-bleed modes with the correct suffixes', async () => {
    render(<FileUploader />);
    fireEvent.click(screen.getByText('modes'));
    fireEvent.click(screen.getByText('Without Bleed'));
    uploadFiles([new File(['std'], 'std.jpg', { type: 'image/jpeg' })]);
    await waitFor(() => expect(mocks.addCustomImage).toHaveBeenCalledWith(expect.any(File), '-std'));

    fireEvent.click(screen.getByText('modes'));
    fireEvent.click(screen.getByText('With Bleed'));
    uploadFiles([new File(['mpc'], 'mpc.jpg', { type: 'image/jpeg' })]);
    await waitFor(() => expect(mocks.addCustomImage).toHaveBeenCalledWith(expect.any(File), '-mpc'));
  });

  it('adds cardbacks without showing loading or processing import intents', async () => {
    render(<FileUploader />);
    fireEvent.click(screen.getByText('modes'));
    fireEvent.click(screen.getByText('Cardback'));

    const fileA = new File(['back'], 'Back One.png', { type: 'image/png' });
    const fileB = new File(['back'], 'Back Two.png', { type: 'image/png' });
    uploadFiles([fileA, fileB]);

    await waitFor(() => expect(mocks.cardbacksAdd).toHaveBeenCalledTimes(2));
    expect(mocks.setLoadingTask).not.toHaveBeenCalled();
    expect(mocks.processCards).not.toHaveBeenCalled();
    expect(mocks.showSuccessToast).toHaveBeenCalledWith('2 cardbacks to library');
    expect(mocks.cardbacksAdd.mock.calls[0][0]).toMatchObject({
      originalBlob: fileA,
      displayName: 'Back One',
      hasBuiltInBleed: true,
    });
  });

  it('shows the singular cardback toast when only one file is uploaded', async () => {
    render(<FileUploader />);
    fireEvent.click(screen.getByText('modes'));
    fireEvent.click(screen.getByText('Cardback'));

    const file = new File(['back'], 'Solo Back.png', { type: 'image/png' });
    uploadFiles([file]);

    await waitFor(() => expect(mocks.cardbacksAdd).toHaveBeenCalledTimes(1));
    expect(mocks.showSuccessToast).toHaveBeenCalledWith('cardback to library');
  });

  it('clears the hidden file input on click and ignores empty changes', () => {
    render(<FileUploader mobile />);
    const input = document.getElementById('upload-images-unified') as HTMLInputElement;
    Object.defineProperty(input, 'value', { value: 'existing', writable: true });
    fireEvent.click(input);
    expect(input.value).toBe('');

    fireEvent.change(input, { target: { files: [] } });
    expect(mocks.setLoadingTask).not.toHaveBeenCalled();
  });
});
