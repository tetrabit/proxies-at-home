import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createCalibrationHarnessFixtureProvider } from './calibrationHarnessFixtures.js';

function providerForTest() {
  return createCalibrationHarnessFixtureProvider({
    parentName: `calibration-harness-fixtures-test-${randomUUID()}`,
  });
}

describe('createCalibrationHarnessFixtureProvider', () => {
  it('initializes an absent controlled parent non-recursively beneath its module-derived repository root', () => {
    const fixtures = providerForTest();
    expect(fs.existsSync(fixtures.fixtureParent)).toBe(false);

    const run = fixtures.createInvocationRoot();

    expect(path.dirname(fixtures.fixtureParent)).toBe(path.join(fixtures.repositoryRoot, '.review-artifacts'));
    expect(fs.lstatSync(fixtures.fixtureParent).isDirectory()).toBe(true);
    expect(path.dirname(run)).toBe(fixtures.fixtureParent);
  });

  it('does not depend on the caller working directory', () => {
    const originalWorkingDirectory = process.cwd();
    try {
      process.chdir(path.dirname(originalWorkingDirectory));
      const fixtures = providerForTest();
      const run = fixtures.createInvocationRoot();
      expect(run.startsWith(`${fixtures.repositoryRoot}${path.sep}`)).toBe(true);
    } finally {
      process.chdir(originalWorkingDirectory);
    }
  });

  it('rejects lexical escapes before allocating a fixture directory', () => {
    const fixtures = providerForTest();
    const escapedParent = path.join(fixtures.fixtureParent, '..');

    expect(() => fixtures.createExclusiveDirectory(escapedParent)).toThrow('fixture path must be a contained descendant');
    expect(() => fixtures.createInvocationRoot('../escape')).toThrow('fixture identifier must be a single path segment');
  });

  it('refuses a symbolic-link ancestor before it writes a child', () => {
    const fixtures = providerForTest();
    const run = fixtures.createInvocationRoot();
    const hostileAncestor = path.join(run, randomUUID());
    const rejectedChild = path.join(hostileAncestor, 'must-not-be-written');
    fs.symlinkSync(run, hostileAncestor, 'dir');

    expect(() => fixtures.createExclusiveDirectory(hostileAncestor, 'must-not-be-written'))
      .toThrow('fixture path must not have a symbolic-link ancestor');
    expect(fs.existsSync(rejectedChild)).toBe(false);
  });

  it('rejects an exclusive collision without modifying the existing sentinel', () => {
    const fixtures = providerForTest();
    const identifier = randomUUID();
    const run = fixtures.createInvocationRoot(identifier);
    const sentinel = path.join(run, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'preserve-me', 'utf8');

    expect(() => fixtures.createInvocationRoot(identifier)).toThrow('exclusive fixture collision');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('preserve-me');
  });

  it('allocates distinct retained runs without reusing a prior directory', () => {
    const fixtures = providerForTest();
    const first = fixtures.createInvocationRoot();
    const firstSentinel = path.join(first, 'sentinel.txt');
    fs.writeFileSync(firstSentinel, 'first-run', 'utf8');
    const second = fixtures.createInvocationRoot();

    expect(second).not.toBe(first);
    expect(fs.readFileSync(firstSentinel, 'utf8')).toBe('first-run');
    expect(fs.lstatSync(second).isDirectory()).toBe(true);
  });
});
