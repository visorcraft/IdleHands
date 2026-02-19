import test from "node:test";
import assert from "node:assert/strict";
import { resolveTuiTheme } from "../../dist/tui/theme.js";

test("resolveTuiTheme returns all required color slots", () => {
  const c = resolveTuiTheme("default");
  assert.ok(c.dim, "dim");
  assert.ok(c.bold, "bold");
  assert.ok(c.red, "red");
  assert.ok(c.yellow, "yellow");
  assert.ok(c.green, "green");
  assert.ok(c.cyan, "cyan");
  assert.ok(c.magenta, "magenta");
  assert.ok(c.blue, "blue");
  assert.ok(c.reset, "reset");
});

test("hacker theme maps cyan/yellow/magenta/blue to green ANSI", () => {
  const c = resolveTuiTheme("hacker");
  // Green ANSI SGR = \x1b[32m
  assert.ok(c.cyan.includes("\x1b[32m"), `cyan=${c.cyan}`);
  assert.ok(c.yellow.includes("\x1b[32m"), `yellow=${c.yellow}`);
  assert.ok(c.magenta.includes("\x1b[32m"), `magenta=${c.magenta}`);
  assert.ok(c.blue.includes("\x1b[32m"), `blue=${c.blue}`);
});

test("minimal theme maps most color slots to dim", () => {
  const c = resolveTuiTheme("minimal");
  // Dim ANSI SGR = \x1b[2m
  assert.ok(c.yellow.includes("\x1b[2m"), `yellow=${c.yellow}`);
  assert.ok(c.green.includes("\x1b[2m"), `green=${c.green}`);
  assert.ok(c.cyan.includes("\x1b[2m"), `cyan=${c.cyan}`);
});

test("dark theme uses bold+cyan for cyan slot", () => {
  const c = resolveTuiTheme("dark");
  assert.ok(c.cyan.includes("\x1b[1m"), "has bold");
  assert.ok(c.cyan.includes("\x1b[36m"), "has cyan");
});

test("light theme swaps cyan and blue", () => {
  const c = resolveTuiTheme("light");
  assert.ok(c.cyan.includes("\x1b[34m"), "cyan slot has blue ANSI");
  assert.ok(c.blue.includes("\x1b[36m"), "blue slot has cyan ANSI");
});

test("unknown theme falls back to default", () => {
  const c = resolveTuiTheme("nonexistent");
  const d = resolveTuiTheme("default");
  assert.equal(c.cyan, d.cyan);
  assert.equal(c.red, d.red);
});

test("undefined theme name falls back to default", () => {
  const c = resolveTuiTheme(undefined);
  const d = resolveTuiTheme("default");
  assert.equal(c.green, d.green);
});
