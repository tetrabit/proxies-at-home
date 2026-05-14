import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('flowbite-react', () => ({
  Checkbox: ({ id, checked, onChange }: { id: string; checked: boolean; onChange: React.ChangeEventHandler<HTMLInputElement> }) => (
    <input id={id} type="checkbox" checked={checked} onChange={onChange} />
  ),
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => <label htmlFor={htmlFor}>{children}</label>,
}));

vi.mock('./index', () => ({
  AutoTooltip: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => <span data-tooltip={String(content)}>{children}</span>,
  ToggleButtonGroup: ({ options, value, onChange }: { options: { id: string; label: string }[]; value: string; onChange: (value: string) => void }) => (
    <div data-testid="channel-toggle" data-value={value}>
      {options.map((option) => <button key={option.id} onClick={() => onChange(option.id)}>{option.label}</button>)}
    </div>
  ),
}));

import { UpdateChannelSelector } from './UpdateChannelSelector';

describe('UpdateChannelSelector', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('renders nothing outside Electron', () => {
    const { container } = render(<UpdateChannelSelector />);
    expect(container).toBeEmptyDOMElement();
  });

  it('loads update state and changes channel/auto-update settings', async () => {
    (window as unknown as { electronAPI: Partial<Window['electronAPI']> }).electronAPI = {
      getUpdateChannel: vi.fn().mockResolvedValue('stable'),
      getAppVersion: vi.fn().mockResolvedValue('2.0.0'),
      getAutoUpdateEnabled: vi.fn().mockResolvedValue(true),
      setUpdateChannel: vi.fn().mockResolvedValue(true),
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      setAutoUpdateEnabled: vi.fn().mockResolvedValue(undefined),
    };

    render(<UpdateChannelSelector />);

    await waitFor(() => expect(screen.getByText('v2.0.0')).toBeDefined());
    expect(screen.getByTestId('channel-toggle')).toHaveAttribute('data-value', 'stable');

    fireEvent.click(screen.getByText('Latest'));
    await waitFor(() => expect(window.electronAPI!.setUpdateChannel).toHaveBeenCalledWith('latest'));
    expect(window.electronAPI!.checkForUpdates).toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('Check for updates automatically'));
    await waitFor(() => expect(window.electronAPI!.setAutoUpdateEnabled).toHaveBeenCalledWith(false));
  });

  it('ignores duplicate channel changes and logs API failures', async () => {
    const error = new Error('boom');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (window as unknown as { electronAPI: Partial<Window['electronAPI']> }).electronAPI = {
      getUpdateChannel: vi.fn().mockResolvedValue('latest'),
      getAppVersion: vi.fn().mockResolvedValue('2.0.0'),
      getAutoUpdateEnabled: vi.fn().mockResolvedValue(true),
      setUpdateChannel: vi.fn().mockRejectedValue(error),
      checkForUpdates: vi.fn(),
      setAutoUpdateEnabled: vi.fn().mockRejectedValue(error),
    };

    render(<UpdateChannelSelector />);
    await waitFor(() => expect(screen.getByTestId('channel-toggle')).toHaveAttribute('data-value', 'latest'));

    fireEvent.click(screen.getByText('Latest'));
    expect(window.electronAPI!.setUpdateChannel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Stable'));
    await waitFor(() => expect(consoleSpy).toHaveBeenCalledWith('Failed to set update channel:', error));

    fireEvent.click(screen.getByLabelText('Check for updates automatically'));
    await waitFor(() => expect(consoleSpy).toHaveBeenCalledWith('Failed to set auto-update enabled:', error));
  });

  it('logs initial metadata failures and stays hidden until Electron is detected', async () => {
    const error = new Error('info failed');
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    (window as unknown as { electronAPI: Partial<Window['electronAPI']> }).electronAPI = {
      getUpdateChannel: vi.fn().mockRejectedValue(error),
    };

    render(<UpdateChannelSelector />);

    await waitFor(() => expect(consoleSpy).toHaveBeenCalledWith('Failed to get update info:', error));
    expect(screen.getByText('Update Channel')).toBeDefined();
  });
});
