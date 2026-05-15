import { useEffect, type RefObject } from "react";

type Event = MouseEvent | TouchEvent;

export function resolveClickOutsideTarget(event: Event): Node | null {
    return (event?.target as Node) || null;
}

export function useOnClickOutside<T extends HTMLElement = HTMLElement>(
    ref: RefObject<T | null>,
    handler: (event: Event) => void
) {
    useEffect(() => {
        const listener = (event: Event) => {
            const el = ref?.current;
            if (!el || el.contains(resolveClickOutsideTarget(event))) {
                return;
            }

            handler(event);
        };

        document.addEventListener("mousedown", listener);
        document.addEventListener("touchstart", listener);

        return () => {
            document.removeEventListener("mousedown", listener);
            document.removeEventListener("touchstart", listener);
        };
    }, [ref, handler]);
}
