import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { add, sub } from '../src/math.js';

describe('math', () => {
  it('add adds', () => {
    assert.equal(add(2, 3), 5);
  });

  it('sub subtracts', () => {
    assert.equal(sub(7, 4), 3);
  });
});
