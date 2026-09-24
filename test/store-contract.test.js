import { test } from 'node:test';
import { createMemoryStore } from '../src/db/memory-store.js';
import { contractCases } from './store-contract.js';

for (const testCase of contractCases) {
  test('memory store: ' + testCase.name, async () => {
    await testCase.run(createMemoryStore());
  });
}
