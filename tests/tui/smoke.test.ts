import test from "node:test";
import assert from "node:assert/strict";
import { calculateLayout } from "../../dist/tui/layout.js";
import { createInitialTuiState } from "../../dist/tui/state.js";

test("tui smoke: layout and initial state are valid", () => {
  const layout = calculateLayout(30);
  assert.equal(layout.statusRows, 2);
  assert.equal(layout.inputRows, 2);
  assert.ok(layout.transcriptRows >= 3);

  const s = createInitialTuiState();
  assert.equal(s.mode, "chat");
  assert.equal(s.focus, "input");
  assert.equal(s.transcript.length, 0);
});
