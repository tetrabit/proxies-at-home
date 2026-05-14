import { describe, expect, it } from 'vitest';
import { normalizeDfcName } from './cardNameUtils';

describe('normalizeDfcName', () => {
  it('returns the front face for double-faced card names', () => {
    expect(normalizeDfcName('Invasion of Zendikar // Awakened Skyclave')).toBe(
      'Invasion of Zendikar'
    );
  });

  it('leaves non-DFC names and differently-spaced separators unchanged', () => {
    expect(normalizeDfcName('Lightning Bolt')).toBe('Lightning Bolt');
    expect(normalizeDfcName('A//B')).toBe('A//B');
  });
});
