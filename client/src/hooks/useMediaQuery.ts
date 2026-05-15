import { useState, useEffect } from "react";

export function getInitialMediaQueryMatch(query: string): boolean {
    if (typeof window !== "undefined") {
        return window.matchMedia(query).matches;
    }
    return false;
}

export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => getInitialMediaQueryMatch(query));

    useEffect(() => {
        const media = window.matchMedia(query);
        setMatches(media.matches);

        const listener = () => setMatches(media.matches);
        media.addEventListener("change", listener);
        return () => media.removeEventListener("change", listener);
    }, [query]);

    return matches;
}
