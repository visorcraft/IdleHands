import test from "node:test";
import assert from "node:assert/strict";
import { calculateLayout } from "../../dist/tui/layout.js";

test("calculateLayout normal terminal: rows are sane and sum to total", () => {
  const layout = calculateLayout(30, 120);
  assert.equal(layout.rows, 30);
  assert.equal(layout.cols, 120);
  assert.ok(layout.transcriptRows >= 3);
  assert.equal(layout.statusRows + layout.alertRows + layout.toolsRows + layout.inputRows + layout.transcriptRows, layout.rows);
});

test("calculateLayout tiny terminal keeps transcript minimum and non-negative", () => {
  const layout = calculateLayout(8, 40);
  assert.equal(layout.rows, 8);
  assert.equal(layout.cols, 40);
  assert.ok(layout.transcriptRows >= 3);
  assert.ok(layout.statusRows >= 0);
  assert.ok(layout.toolsRows >= 0);
  assert.ok(layout.inputRows >= 0);
});

test("calculateLayout very wide terminal preserves cols", () => {
  const layout = calculateLayout(50, 300);
  assert.equal(layout.rows, 50);
  assert.equal(layout.cols, 300);
  assert.ok(layout.transcriptRows >= 3);
});

test("calculateLayout minimum clamp on rows=1 keeps transcript positive", () => {
  const layout = calculateLayout(1, 20);
  assert.equal(layout.rows, 1);
  assert.ok(layout.transcriptRows >= 3);
});

test("calculateLayout default cols is 120", () => {
  const layout = calculateLayout(30);
  assert.equal(layout.cols, 120);
});
