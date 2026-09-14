import React, { useCallback, useEffect, useRef, useState } from 'react';

interface CardImageSvgProps {
    /** Primary image URL */
    url: string;
    /** Fallback image URL (optional) */
    fallbackUrl?: string;
    /** Unique identifier for clip path generation */
    id: string;
    /** Bleed configuration */
    bleed?: {
        /** Amount of bleed to crop from each side (in mm) */
        amountMm: number;
        /** Total width of the source image including bleed (in mm) */
        sourceWidthMm: number;
        /** Total height of the source image including bleed (in mm) */
        sourceHeightMm: number;
    };
    /** Whether to round corners (default: true) */
    rounded?: boolean;
    /** Called when the current image successfully loads */
    onLoad?: () => void;
    /** Called when neither the primary nor fallback image can load */
    onError?: () => void;
}

/**
 * Renders a card image using SVG for precise sub-pixel positioning and cropping.
 * Supports exact mm-based bleed trimming and R2.5mm rounded corners.
 * Uses IntersectionObserver for lazy loading to prevent mass simultaneous fetches.
 */
export const CardImageSvg: React.FC<CardImageSvgProps> = ({
    url,
    fallbackUrl,
    id,
    bleed,
    rounded = true,
    onLoad,
    onError,
}) => {
    const svgRef = useRef<SVGSVGElement>(null);
    const [isVisible, setIsVisible] = useState(false);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [useFallback, setUseFallback] = useState(false);
    const loadTokenRef = useRef(0);
    const onLoadRef = useRef(onLoad);
    const onErrorRef = useRef(onError);
    useEffect(() => {
        onLoadRef.current = onLoad;
        onErrorRef.current = onError;
    }, [onLoad, onError]);
    const notifyLoad = useCallback((token: number) => {
        if (token === loadTokenRef.current) {
            onLoadRef.current?.();
        }
    }, []);
    const notifyError = useCallback((token: number) => {
        if (token === loadTokenRef.current) {
            onErrorRef.current?.();
        }
    }, []);

    // Standard card dimensions
    const CARD_WIDTH = 63;
    const CARD_HEIGHT = 88;
    const CORNER_RADIUS = 2.5;

    // ViewBox always defines the "visible" card area
    // For bleed images, we start the viewBox offset by the bleed amount
    const viewBoxX = bleed ? bleed.amountMm : 0;
    const viewBoxY = bleed ? bleed.amountMm : 0;

    const clipId = `clip-${id}`;

    // Reset states when URL changes (including isVisible for re-sorted cards)
    // A new load attempt is started so late callbacks from the previous image
    // are ignored instead of being reported as the current image's result.
    useEffect(() => {
        loadTokenRef.current += 1;
        setHasLoaded(false);
        setUseFallback(false);
        // Don't reset isVisible here - it's managed by IntersectionObserver
    }, [url]);

    // Set up IntersectionObserver for lazy loading
    // Once visible, stay loaded (URL is now static, no need to track exit)
    // Re-run when url changes to handle sorted/reordered cards
    useEffect(() => {
        const svg = svgRef.current;
        if (!svg) return;

        // Reset visibility when url changes to re-observe
        setIsVisible(false);

        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        setIsVisible(true);
                        // Once visible, stop observing (image stays loaded)
                        observer.unobserve(svg);
                    }
                });
            },
            {
                // Start loading slightly before the element comes into view
                rootMargin: '100px',
                threshold: 0,
            }
        );

        observer.observe(svg);

        return () => {
            observer.disconnect();
        };
    }, [url]);

    // Determine actual URL to use (primary or fallback)
    const actualUrl = useFallback && fallbackUrl ? fallbackUrl : url;
    const renderUrl = isVisible ? actualUrl : '';

    return (
        <svg
            ref={svgRef}
            viewBox={`${viewBoxX} ${viewBoxY} ${CARD_WIDTH} ${CARD_HEIGHT}`}
            className="w-full h-full block"
            preserveAspectRatio="xMidYMid meet"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label={`Card image for ${id}`}
        >
            <defs>
                {rounded && (
                    <clipPath id={clipId}>
                        <rect
                            x={viewBoxX}
                            y={viewBoxY}
                            width={CARD_WIDTH}
                            height={CARD_HEIGHT}
                            rx={CORNER_RADIUS}
                            ry={CORNER_RADIUS}
                        />
                    </clipPath>
                )}
            </defs>

            {/* Placeholder background while loading */}
            {!hasLoaded && (
                <rect
                    x={viewBoxX}
                    y={viewBoxY}
                    width={CARD_WIDTH}
                    height={CARD_HEIGHT}
                    rx={rounded ? CORNER_RADIUS : 0}
                    ry={rounded ? CORNER_RADIUS : 0}
                    fill="#1f2937"
                    className="animate-pulse"
                />
            )}

            {/* Only render image element when visible, hide until loaded */}
            {isVisible && (
                <image
                    href={renderUrl}
                    x="0"
                    y="0"
                    // If bleed, use source dimensions. If not, fill the card area (63x88)
                    width={bleed ? bleed.sourceWidthMm : CARD_WIDTH}
                    height={bleed ? bleed.sourceHeightMm : CARD_HEIGHT}
                    preserveAspectRatio="xMidYMid slice"
                    clipPath={rounded ? `url(#${clipId})` : undefined}
                    style={{ opacity: hasLoaded ? 1 : 0 }}
                    onLoad={() => {
                        setHasLoaded(true);
                        notifyLoad(loadTokenRef.current);
                    }}
                    onError={() => {
                        // Switch to fallback URL if available and not already using it
                        if (fallbackUrl && !useFallback) {
                            setUseFallback(true);
                            setHasLoaded(false); // Reset to show placeholder while fallback loads
                        } else {
                            notifyError(loadTokenRef.current);
                        }
                    }}
                />
            )}
        </svg>
    );
};
