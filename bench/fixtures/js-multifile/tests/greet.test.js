import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/index.js';

describe('greet', () => {
  it('formats as "Hello, Name!"', () => {
    assert.equal(main('User'), 'Hello, User!');
  });
});
