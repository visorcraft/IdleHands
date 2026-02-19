import test from "node:test";
import assert from "node:assert/strict";
import { TuiConfirmProvider } from "../../dist/tui/confirm.js";

function makeRequest(command = "npm test") {
  return {
    tool: "exec",
    args: { command },
    summary: `Run ${command}`,
    mode: "suggest" as any,
  };
}

test("isPending starts false", () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  assert.equal(provider.isPending, false);
  assert.equal(events.length, 0);
});

test("confirm() dispatches CONFIRM_SHOW and sets isPending", async () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  const promise = provider.confirm(makeRequest("npm test"));

  assert.equal(provider.isPending, true);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "CONFIRM_SHOW");

  provider.resolve(true);
  await promise;
});

test("resolve(true) dismisses and resolves confirm promise true", async () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  const promise = provider.confirm(makeRequest("npm test"));

  assert.equal(provider.isPending, true);

  provider.resolve(true);
  const result = await promise;

  assert.equal(result, true);
  assert.equal(provider.isPending, false);
  assert.equal(events[1]?.type, "CONFIRM_DISMISS");
});

test("resolve(false) dismisses and resolves confirm promise false", async () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  const promise = provider.confirm(makeRequest("npm test"));

  provider.resolve(false);
  const result = await promise;

  assert.equal(result, false);
  assert.equal(provider.isPending, false);
  assert.equal(events[0]?.type, "CONFIRM_SHOW");
  assert.equal(events[1]?.type, "CONFIRM_DISMISS");
});

test("toggleDiff dispatches CONFIRM_TOGGLE_DIFF", () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  provider.toggleDiff();

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "CONFIRM_TOGGLE_DIFF");
});

test("remembered decisions auto-approve second matching confirm without CONFIRM_SHOW", async () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  const first = provider.confirm(makeRequest("npm test"));
  assert.equal(events[0]?.type, "CONFIRM_SHOW");
  provider.resolve(true);
  const firstResult = await first;
  assert.equal(firstResult, true);

  const beforeSecond = events.length;
  const secondResult = await provider.confirm(makeRequest("npm test"));
  assert.equal(secondResult, true);

  const secondEvents = events.slice(beforeSecond);
  assert.equal(secondEvents.length, 1);
  assert.equal(secondEvents[0]?.type, "ALERT_PUSH");
  assert.equal(secondEvents[0]?.level, "info");
});

test("showBlocked dispatches ALERT_PUSH with level error", async () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  await provider.showBlocked({ tool: "exec", reason: "policy denied" } as any);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "ALERT_PUSH");
  assert.equal(events[0]?.level, "error");
  assert.match(events[0]?.text ?? "", /^\[blocked\] exec: policy denied/);
});

test("resolve without pending is a no-op", () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  provider.resolve(true);
  provider.resolve(false);

  assert.equal(provider.isPending, false);
  assert.equal(events.length, 0);
});

test("clearRemembered clears memory and requires confirm again", async () => {
  const events: any[] = [];
  const dispatch = (e: any) => events.push(e);
  const provider = new TuiConfirmProvider(dispatch);

  const first = provider.confirm(makeRequest("npm test"));
  provider.resolve(true);
  await first;

  await provider.confirm(makeRequest("npm test"));
  assert.equal(events.at(-1)?.type, "ALERT_PUSH");

  provider.clearRemembered();

  const before = events.length;
  const thirdPromise = provider.confirm(makeRequest("npm test"));
  const afterEvents = events.slice(before);
  assert.equal(afterEvents[0]?.type, "CONFIRM_SHOW");
  assert.equal(provider.isPending, true);

  provider.resolve(true);
  await thirdPromise;
});
