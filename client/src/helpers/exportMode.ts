export type ExportMode =
  | 'fronts'
  | 'interleaved-all'
  | 'interleaved-custom'
  | 'duplex'
  | 'duplex-collated'
  | 'backs'
  | 'visible_faces';

/**
 * `perCardBackOffsets` are intended for duplex/back grid exports where the back
 * is rendered into the same slot positions as the corresponding front grid.
 *
 * For interleaved/visible-face exports, backs are exported as their own pages
 * and should not inherit grid-slot back offsets.
 */
export function exportModeUsesPerCardBackOffsets(mode: ExportMode): boolean {
  return mode === 'duplex' || mode === 'duplex-collated' || mode === 'backs';
}

