import test from "node:test";
import assert from "node:assert/strict";
import * as screen from "../../dist/tui/screen.js";
import { calculateLayout } from "../../dist/tui/layout.js";

const hasProbe = typeof (screen as any).probeTermCapabilities === "function";
const hasValidate = typeof (screen as any).validateTerminal === "function";

if (hasProbe && hasValidate) {
  test("probeTermCapabilities returns expected capability shape", () => {
    const caps = (screen as any).probeTermCapabilities();
    for (const key of [
      "altScreen",
      "colors256",
      "trueColor",
      "unicode",
      "rows",
      "cols",
      "term",
      "isTmux",
      "isScreen",
      "isSsh",
    ]) {
      assert.ok(key in caps, `missing key: ${key}`);
    }
  });

  test("validateTerminal returns { ok } with optional reason string", () => {
    const result = (screen as any).validateTerminal();
    assert.equal(typeof result, "object");
    assert.equal(typeof result.ok, "boolean");
    if (result.ok === false) {
      assert.equal(typeof result.reason, "string");
      assert.ok(result.reason.length > 0);
    }
  });
} else {
  // probeTermCapabilities/validateTerminal are not exported yet in dist/tui/screen.js.
  // Replace todos with real tests when capability probing and validation are implemented.
  test.todo("probeTermCapabilities returns valid capability object shape");
  test.todo("validateTerminal returns { ok } and a reason string when invalid");
}

test("layout fallback for small terminals still returns valid dimensions", () => {
  const layout = calculateLayout(5, 30);
  assert.equal(layout.rows, 5);
  assert.equal(layout.cols, 30);
  assert.ok(layout.transcriptRows >= 3);
  assert.ok(layout.statusRows >= 0);
  assert.ok(layout.toolsRows >= 0);
  assert.ok(layout.inputRows >= 0);
});

test("layout minimum guarantees keep transcript and row counts positive", () => {
  for (const [rows, cols] of [
    [1, 10],
    [2, 20],
    [10, 80],
    [40, 120],
  ] as Array<[number, number]>) {
    const layout = calculateLayout(rows, cols);
    assert.ok(layout.transcriptRows >= 3, `transcriptRows too small for ${rows}x${cols}`);
    assert.ok(layout.statusRows > 0, `statusRows not positive for ${rows}x${cols}`);
    assert.ok(layout.toolsRows > 0, `toolsRows not positive for ${rows}x${cols}`);
    assert.ok(layout.inputRows > 0, `inputRows not positive for ${rows}x${cols}`);
  }
});
