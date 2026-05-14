import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const toastState = vi.hoisted(() => ({
  toasts: [] as Array<{ id: string; type: string; message: string; dismissible?: boolean; progress?: number }>,
  removeToast: vi.fn(),
}));

vi.mock('@/store/toast', () => ({
  useToastStore: (selector: (state: typeof toastState) => unknown) => selector(toastState),
}));

import { ToastContainer } from './ToastContainer';

describe('ToastContainer variants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toastState.toasts = [];
  });

  it('renders nothing without toasts', () => {
    const { container } = render(<ToastContainer />);
    expect(container.textContent).toBe('');
  });

  it('renders success, copy, error, and progress variants and dismisses toast', () => {
    toastState.toasts = [
      { id: 'success', type: 'success', message: 'Saved', dismissible: true },
      { id: 'copy', type: 'copy', message: 'Copied' },
      { id: 'error', type: 'error', message: 'Failed', dismissible: true, progress: 1.5 },
      { id: 'loading', type: 'loading', message: 'Working', progress: -0.2 },
      { id: 'half', type: 'loading', message: 'Half', progress: 0.5 },
    ];

    const { container } = render(<ToastContainer />);

    expect(screen.getByText('Saved')).toBeDefined();
    expect(screen.getByText('Copied')).toBeDefined();
    expect(screen.getByText('Failed')).toBeDefined();
    expect(screen.getByText('Working')).toBeDefined();
    expect(screen.getByText('Half')).toBeDefined();
    expect(container.innerHTML).toContain('bg-green-600');
    expect(container.innerHTML).toContain('bg-red-600');
    expect(container.innerHTML).toContain('bg-blue-600');
    expect(container.querySelector('[style="width: 100%;"]')).toBeTruthy();
    expect(container.querySelector('[style="width: 50%;"]')).toBeTruthy();

    fireEvent.click(screen.getAllByLabelText('Dismiss')[0]);
    expect(toastState.removeToast).toHaveBeenCalledWith('success');
  });
});
