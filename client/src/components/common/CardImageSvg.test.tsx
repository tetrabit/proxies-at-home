import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CardImageSvg } from './CardImageSvg';

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  callback: IntersectionObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  intersect(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

describe('CardImageSvg', () => {
  beforeEach(() => {
    MockIntersectionObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('lazy-loads the image once visible and marks it loaded', () => {
    const { container } = render(<CardImageSvg id="card-1" url="front.png" />);
    const svg = screen.getByRole('img', { name: 'Card image for card-1' });

    expect(container.querySelector('image')).toBeNull();
    act(() => MockIntersectionObserver.instances[0].intersect(svg));

    const image = container.querySelector('image')!;
    expect(image.getAttribute('href')).toBe('front.png');
    expect(image.getAttribute('clip-path') ?? image.getAttribute('clipPath')).toBe('url(#clip-card-1)');

    fireEvent.load(image);
    expect((image as SVGImageElement).style.opacity).toBe('1');
  });

  it('calls onLoad once when the current primary image loads', () => {
    const onLoad = vi.fn();
    const onError = vi.fn();
    const { container } = render(
      <CardImageSvg id="callback-primary" url="front.png" onLoad={onLoad} onError={onError} />
    );
    const svg = screen.getByRole('img', { name: 'Card image for callback-primary' });

    act(() => MockIntersectionObserver.instances[0].intersect(svg));
    fireEvent.load(container.querySelector('image')!);

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores non-intersecting observer entries', () => {
    const { container } = render(<CardImageSvg id="card-1" url="front.png" />);
    const svg = screen.getByRole('img', { name: 'Card image for card-1' });

    act(() => MockIntersectionObserver.instances[0].callback([{ isIntersecting: false, target: svg } as IntersectionObserverEntry], MockIntersectionObserver.instances[0] as unknown as IntersectionObserver));

    expect(container.querySelector('image')).toBeNull();
  });

  it('uses bleed dimensions, skips rounding, and switches to fallback once', () => {
    const onError = vi.fn();
    const { container } = render(
      <CardImageSvg
        id="bleed-card"
        url="front.png"
        fallbackUrl="fallback.png"
        rounded={false}
        bleed={{ amountMm: 3, sourceWidthMm: 69, sourceHeightMm: 94 }}
        onError={onError}
      />
    );
    const svg = screen.getByRole('img', { name: 'Card image for bleed-card' });
    expect(svg.getAttribute('viewBox')).toBe('3 3 63 88');
    expect(container.querySelector('clipPath')).toBeNull();

    act(() => MockIntersectionObserver.instances[0].intersect(svg));
    const image = container.querySelector('image')!;
    expect(image.getAttribute('width')).toBe('69');
    expect(image.getAttribute('height')).toBe('94');
    expect(image.getAttribute('clip-path') ?? image.getAttribute('clipPath')).toBeNull();

    // A primary-image error switches to the fallback and does not yet
    // report an error for the component.
    fireEvent.error(image);
    expect(container.querySelector('image')!.getAttribute('href')).toBe('fallback.png');
    expect(onError).not.toHaveBeenCalled();

    // Only an error on the fallback itself reports a terminal failure.
    act(() => {
      fireEvent.error(container.querySelector('image')!);
    });
    expect(container.querySelector('image')!.getAttribute('href')).toBe('fallback.png');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports onLoad only for the current image and defers it until visible', () => {
    const onLoad = vi.fn();
    const { container, rerender } = render(
      <CardImageSvg id="callback-deferred" url="front.png" onLoad={onLoad} />
    );
    const svg = screen.getByRole('img', { name: 'Card image for callback-deferred' });

    // The image is not visible yet: no load event can arrive.
    expect(container.querySelector('image')).toBeNull();
    expect(onLoad).not.toHaveBeenCalled();

    act(() => MockIntersectionObserver.instances[0].intersect(svg));
    expect(container.querySelector('image')!.getAttribute('href')).toBe('front.png');
    expect(onLoad).not.toHaveBeenCalled();

    act(() => {
      fireEvent.load(container.querySelector('image')!);
    });
    expect(onLoad).toHaveBeenCalledTimes(1);

    // A late load event from a previous URL must not re-report the callback.
    rerender(<CardImageSvg id="callback-deferred" url="back.png" onLoad={onLoad} />);
    act(() => {
      fireEvent.load(document.createElement('image'));
    });
    expect(onLoad).toHaveBeenCalledTimes(1);
  });

  it('resets load state when the URL changes', () => {
    const { container, rerender } = render(<CardImageSvg id="card-2" url="one.png" />);
    const svg = screen.getByRole('img', { name: 'Card image for card-2' });
    act(() => MockIntersectionObserver.instances[0].intersect(svg));
    fireEvent.load(container.querySelector('image')!);

    rerender(<CardImageSvg id="card-2" url="two.png" />);

    expect(container.querySelector('rect')).toBeTruthy();
    act(() => MockIntersectionObserver.instances.at(-1)!.intersect(svg));
    expect(container.querySelector('image')!.getAttribute('href')).toBe('two.png');
  });
});
