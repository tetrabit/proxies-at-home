import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import LoadingOverlay from './LoadingOverlay';

describe('LoadingOverlay', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should render task text', () => {
        render(
            <LoadingOverlay
                task="Loading cards..."
                progress={50}
                onCancel={null}
            />
        );

        expect(screen.getByText('Loading cards...')).toBeDefined();
    });

    it('should show progress percentage', () => {
        render(
            <LoadingOverlay
                task="Processing"
                progress={75}
                onCancel={null}
            />
        );

        expect(screen.getByText('75%')).toBeDefined();
    });

    it('should show sheen animation when progress is negative', () => {
        const { container } = render(
            <LoadingOverlay
                task="Processing"
                progress={-1}
                onCancel={null}
            />
        );

        const sheenElement = container.querySelector('.animate-sheen');
        expect(sheenElement).toBeDefined();
    });

    it('should show cancel button when onCancel is provided', () => {
        const onCancel = vi.fn();
        render(
            <LoadingOverlay
                task="Processing"
                progress={50}
                onCancel={onCancel}
            />
        );

        expect(screen.getByText('Cancel')).toBeDefined();
    });

    it('should not show cancel button when onCancel is null', () => {
        render(
            <LoadingOverlay
                task="Processing"
                progress={50}
                onCancel={null}
            />
        );

        expect(screen.queryByText('Cancel')).toBeNull();
    });

    it('should update elapsed time after the interval fires', () => {
        render(
            <LoadingOverlay
                task="Processing"
                progress={50}
                onCancel={null}
            />
        );

        act(() => {
            vi.advanceTimersByTime(1000);
        });

        expect(screen.getByText(/Elapsed:/)).toBeDefined();
    });

    it('should format elapsed time with minutes when enough time has passed', () => {
        render(
            <LoadingOverlay
                task="Processing"
                progress={50}
                onCancel={null}
            />
        );

        act(() => {
            vi.advanceTimersByTime(61000);
        });

        expect(screen.getByText(/Elapsed: 1m /)).toBeDefined();
    });
});
