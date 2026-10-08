import { expect, test } from 'bun:test';
import { validEnrollmentScopes } from '../src/enrollment-scopes.ts';
import fixture from '../../tests/fixtures/enrollment-scopes.json';

for (const entry of fixture.cases) {
  test(`enrollment scope grammar: ${entry.name}`, () => {
    expect(validEnrollmentScopes(entry.scopes)).toBe(entry.valid);
  });
}
