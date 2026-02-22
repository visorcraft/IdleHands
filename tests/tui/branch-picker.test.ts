import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialTuiState, reduceTuiState } from '../../dist/tui/state.js';

test('BRANCH_PICKER_OPEN sets branchPicker state', () => {
  const s0 = createInitialTuiState();
  const branches = [
    { name: 'feature-a', ts: Date.now(), messageCount: 5, preview: 'last message' },
    { name: 'bugfix-b', ts: Date.now() - 1000, messageCount: 3, preview: 'fix stuff' },
  ];
  const s1 = reduceTuiState(s0, { type: 'BRANCH_PICKER_OPEN', branches, action: 'browse' });
  assert.ok(s1.branchPicker);
  assert.equal(s1.branchPicker.branches.length, 2);
  assert.equal(s1.branchPicker.selectedIndex, 0);
  assert.equal(s1.branchPicker.action, 'browse');
});

test('BRANCH_PICKER_MOVE navigates selection with clamping', () => {
  const s0 = createInitialTuiState();
  const branches = [
    { name: 'a', ts: 1, messageCount: 1, preview: '' },
    { name: 'b', ts: 2, messageCount: 2, preview: '' },
    { name: 'c', ts: 3, messageCount: 3, preview: '' },
  ];
  let s = reduceTuiState(s0, { type: 'BRANCH_PICKER_OPEN', branches, action: 'checkout' });
  assert.equal(s.branchPicker!.selectedIndex, 0);

  s = reduceTuiState(s, { type: 'BRANCH_PICKER_MOVE', delta: 1 });
  assert.equal(s.branchPicker!.selectedIndex, 1);

  s = reduceTuiState(s, { type: 'BRANCH_PICKER_MOVE', delta: 1 });
  assert.equal(s.branchPicker!.selectedIndex, 2);

  // Clamp at end
  s = reduceTuiState(s, { type: 'BRANCH_PICKER_MOVE', delta: 1 });
  assert.equal(s.branchPicker!.selectedIndex, 2);

  // Move back
  s = reduceTuiState(s, { type: 'BRANCH_PICKER_MOVE', delta: -1 });
  assert.equal(s.branchPicker!.selectedIndex, 1);

  // Clamp at start
  s = reduceTuiState(s, { type: 'BRANCH_PICKER_MOVE', delta: -10 });
  assert.equal(s.branchPicker!.selectedIndex, 0);
});

test('BRANCH_PICKER_CLOSE clears branchPicker', () => {
  const s0 = createInitialTuiState();
  const s1 = reduceTuiState(s0, {
    type: 'BRANCH_PICKER_OPEN',
    branches: [{ name: 'x', ts: 1, messageCount: 1, preview: '' }],
    action: 'merge',
  });
  assert.ok(s1.branchPicker);
  const s2 = reduceTuiState(s1, { type: 'BRANCH_PICKER_CLOSE' });
  assert.equal(s2.branchPicker, undefined);
});

test('BRANCH_PICKER_MOVE on empty branches is a no-op', () => {
  const s0 = createInitialTuiState();
  const s1 = reduceTuiState(s0, { type: 'BRANCH_PICKER_OPEN', branches: [], action: 'browse' });
  const s2 = reduceTuiState(s1, { type: 'BRANCH_PICKER_MOVE', delta: 1 });
  assert.equal(s2.branchPicker!.selectedIndex, 0);
});

test('BRANCH_PICKER_MOVE without picker open is a no-op', () => {
  const s0 = createInitialTuiState();
  const s1 = reduceTuiState(s0, { type: 'BRANCH_PICKER_MOVE', delta: 1 });
  assert.equal(s1.branchPicker, undefined);
});
