import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('flowbite-react', () => ({
  Modal: ({ show, onClose, children }: { show: boolean; onClose: () => void; children: React.ReactNode }) => show ? <div role="dialog" onKeyDown={onClose}>{children}</div> : null,
  ModalHeader: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock('@/assets', () => ({ logoSvg: 'logo.svg' }));

import { AboutModal } from './AboutModal';

describe('AboutModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  it('renders product details and opens external links in browsers', () => {
    render(<AboutModal isOpen onClose={vi.fn()} />);

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByAltText('Proxxied').getAttribute('src')).toBe('logo.svg');
    expect(screen.queryByText('Version')).toBeNull();

    fireEvent.click(screen.getByText('View on GitHub'));
    fireEvent.click(screen.getByText('Visit Website'));
    fireEvent.click(screen.getByText('Buy Me a Coffee'));

    expect(window.open).toHaveBeenCalledWith('https://github.com/kclipsto/proxies-at-home', '_blank', 'noopener,noreferrer');
    expect(window.open).toHaveBeenCalledWith('https://proxxied.com', '_blank', 'noopener,noreferrer');
    expect(window.open).toHaveBeenCalledWith('https://buymeacoffee.com/proxxied', '_blank', 'noopener,noreferrer');
  });

  it('loads Electron version/channel only when open', async () => {
    (window as unknown as { electronAPI: Partial<Window['electronAPI']> }).electronAPI = {
      getAppVersion: vi.fn().mockResolvedValue('1.2.3'),
      getUpdateChannel: vi.fn().mockResolvedValue('stable'),
    };

    const { rerender } = render(<AboutModal isOpen={false} onClose={vi.fn()} />);
    expect(window.electronAPI!.getAppVersion).not.toHaveBeenCalled();

    rerender(<AboutModal isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByText('v1.2.3')).toBeDefined());
    expect(screen.getByText('Stable')).toBeDefined();
  });

  it('logs Electron metadata failures without hiding the modal', async () => {
    const error = new Error('metadata failed');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (window as unknown as { electronAPI: Partial<Window['electronAPI']> }).electronAPI = {
      getAppVersion: vi.fn().mockRejectedValue(error),
      getUpdateChannel: vi.fn().mockResolvedValue('latest'),
    };

    render(<AboutModal isOpen onClose={vi.fn()} />);

    await waitFor(() => expect(consoleSpy).toHaveBeenCalledWith('Failed to get app info:', error));
    expect(screen.getByText('About Proxxied')).toBeDefined();
  });
});
