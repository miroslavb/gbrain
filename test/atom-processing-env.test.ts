import { expect, test } from 'bun:test';
import { isStripped, renamedOptInMessage } from './helpers/operator-env-policy.ts';

test('the atom Postgres opt-in survives the standard test environment scrub', () => {
  expect(isStripped('GBRAIN_TEST_ATOM_POSTGRES')).toBe(false);
  expect(isStripped('GBRAIN_ATOM_TEST_POSTGRES')).toBe(true);
});

test('the retired atom Postgres opt-in fails with a rename diagnostic without exposing its URL', () => {
  const message = renamedOptInMessage('GBRAIN_ATOM_TEST_POSTGRES', 'postgres://fixture:secret@127.0.0.1/gbrain_test');
  expect(message).toContain('GBRAIN_ATOM_TEST_POSTGRES was renamed to GBRAIN_TEST_ATOM_POSTGRES');
  expect(message).toContain('unset GBRAIN_ATOM_TEST_POSTGRES');
  expect(message).not.toContain('fixture:secret');
});
