import { describe, expect, it } from 'vitest';
import {
  createErrorResult,
  createPartialResult,
  createSuccessResult,
  isImportSuccessful,
  type ImportFailure,
} from './importResult';

describe('importResult', () => {
  it('creates full success results and identifies successful imports', () => {
    const result = createSuccessResult(['a', 'b']);
    expect(result).toEqual({ status: 'success', cardUuids: ['a', 'b'], count: 2 });
    expect(isImportSuccessful(result)).toBe(true);
  });

  it('creates partial results with failures and treats them as successful imports', () => {
    const failures: ImportFailure[] = [
      { intent: { name: 'Missing', quantity: 1 }, error: 'not found', retryable: false },
    ];
    const result = createPartialResult(['ok'], failures);
    expect(result).toEqual({ status: 'partial', cardUuids: ['ok'], count: 1, failures });
    expect(isImportSuccessful(result)).toBe(true);
  });

  it('creates retryable and non-retryable error results', () => {
    expect(createErrorResult('bad')).toEqual({ status: 'error', error: 'bad', retryable: false });
    const retryable = createErrorResult('timeout', true);
    expect(retryable.retryable).toBe(true);
    expect(isImportSuccessful(retryable)).toBe(false);
  });
});
