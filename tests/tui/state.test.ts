import test from "node:test";
import assert from "node:assert/strict";
import { createInitialTuiState, reduceTuiState } from "../../dist/tui/state.js";

test("state reducer handles input + history + streaming lifecycle", () => {
  let s = createInitialTuiState();

  s = reduceTuiState(s, { type: "USER_INPUT_CHANGE", text: "hello" });
  assert.equal(s.inputBuffer, "hello");
  assert.equal(s.inputCursor, 5);

  s = reduceTuiState(s, { type: "USER_INPUT_SUBMIT", text: "hello" });
  assert.equal(s.inputBuffer, "");
  assert.equal(s.inputCursor, 0);
  assert.equal(s.inputHistory.at(-1), "hello");
  assert.equal(s.transcript.at(-1)?.role, "user");

  s = reduceTuiState(s, { type: "USER_INPUT_HISTORY_PREV" });
  assert.equal(s.inputBuffer, "hello");
  assert.equal(s.inputCursor, 5);

  s = reduceTuiState(s, { type: "AGENT_STREAM_START", id: "a1" });
  s = reduceTuiState(s, { type: "AGENT_STREAM_TOKEN", id: "a1", token: "hi" });
  s = reduceTuiState(s, { type: "AGENT_STREAM_DONE", id: "a1" });

  const item = s.transcript.find((x: any) => x.id === "a1");
  assert.ok(item);
  assert.equal(item?.text, "hi");
  assert.equal(item?.role, "assistant");
  assert.equal(s.isStreaming, false);
});

test("backspace at position 0 is a no-op", () => {
  const s0 = createInitialTuiState();
  const s1 = reduceTuiState(s0, { type: "USER_INPUT_BACKSPACE" });
  assert.equal(s1, s0);
});

test("cursor move clamping keeps cursor within bounds", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "USER_INPUT_CHANGE", text: "abc" });

  s = reduceTuiState(s, { type: "USER_INPUT_CURSOR_MOVE", delta: -999 });
  assert.equal(s.inputCursor, 0);

  s = reduceTuiState(s, { type: "USER_INPUT_CURSOR_MOVE", delta: 999 });
  assert.equal(s.inputCursor, 3);
});

test("insert at cursor position inserts into middle of text", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "USER_INPUT_CHANGE", text: "ac" });
  s = reduceTuiState(s, { type: "USER_INPUT_CURSOR_MOVE", delta: -1 }); // cursor at 1
  s = reduceTuiState(s, { type: "USER_INPUT_INSERT", text: "b" });

  assert.equal(s.inputBuffer, "abc");
  assert.equal(s.inputCursor, 2);
});

test("history navigation wraps as expected", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "USER_INPUT_SUBMIT", text: "one" });
  s = reduceTuiState(s, { type: "USER_INPUT_SUBMIT", text: "two" });

  s = reduceTuiState(s, { type: "USER_INPUT_HISTORY_PREV" });
  assert.equal(s.inputBuffer, "two");

  s = reduceTuiState(s, { type: "USER_INPUT_HISTORY_PREV" });
  assert.equal(s.inputBuffer, "one");

  s = reduceTuiState(s, { type: "USER_INPUT_HISTORY_PREV" });
  assert.equal(s.inputBuffer, "one");

  s = reduceTuiState(s, { type: "USER_INPUT_HISTORY_NEXT" });
  assert.equal(s.inputBuffer, "two");

  s = reduceTuiState(s, { type: "USER_INPUT_HISTORY_NEXT" });
  assert.equal(s.inputBuffer, "");
  assert.equal(s.historyIndex, null);
});

test("tool events append with correct phases", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "TOOL_START", id: "t1", name: "fetch", summary: "start", detail: "d1" });
  s = reduceTuiState(s, { type: "TOOL_END", id: "t1", name: "fetch", summary: "done", detail: "d2", durationMs: 12 });
  s = reduceTuiState(s, { type: "TOOL_ERROR", id: "t2", name: "exec", summary: "fail", detail: "d3", durationMs: 9 });

  assert.equal(s.toolEvents.length, 3);
  assert.equal(s.toolEvents[0]?.phase, "start");
  assert.equal(s.toolEvents[1]?.phase, "end");
  assert.equal(s.toolEvents[2]?.phase, "error");
});

test("alert push and clear by id and clear all", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "ALERT_PUSH", id: "a1", level: "info", text: "hello" });
  s = reduceTuiState(s, { type: "ALERT_PUSH", id: "a2", level: "warn", text: "world" });
  assert.equal(s.alerts.length, 2);

  s = reduceTuiState(s, { type: "ALERT_CLEAR", id: "a1" });
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0]?.id, "a2");

  s = reduceTuiState(s, { type: "ALERT_CLEAR" });
  assert.equal(s.alerts.length, 0);
});

test("focus set updates focused panel", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "FOCUS_SET", panel: "transcript" });
  assert.equal(s.focus, "transcript");
});

test("scroll adds delta to panel scroll value", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "SCROLL", panel: "transcript", delta: 2 });
  s = reduceTuiState(s, { type: "SCROLL", panel: "transcript", delta: -1 });
  assert.equal(s.scroll.transcript, 1);
});

test("runtime state update sets activeRuntime", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "RUNTIME_STATE_UPDATE", runtime: "agent:main" });
  assert.equal(s.activeRuntime, "agent:main");
});

test("stream token for wrong id does not modify other transcript items", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "AGENT_STREAM_START", id: "a1" });
  s = reduceTuiState(s, { type: "AGENT_STREAM_TOKEN", id: "wrong", token: "oops" });

  const item = s.transcript.find((x: any) => x.id === "a1");
  assert.ok(item);
  assert.equal(item?.text, "");
});

test("submit empty text does not add to input history", () => {
  let s = createInitialTuiState();
  s = reduceTuiState(s, { type: "USER_INPUT_SUBMIT", text: "" });
  assert.equal(s.inputHistory.length, 0);
});
