import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizeExecCommandForSig,
  normalizeTestCommandForSig,
} from "../dist/agent/exec-helpers.js";

describe("normalizeExecCommandForSig", () => {
  it("strips trailing tail pipes", () => {
    assert.strictEqual(
      normalizeExecCommandForSig("npm run build 2>&1 | tail -20"),
      "npm run build 2>&1"
    );
  });

  it("strips trailing head pipes", () => {
    assert.strictEqual(
      normalizeExecCommandForSig("cat file.txt | head -100"),
      "cat file.txt"
    );
  });

  it("strips multiple trailing filter pipes", () => {
    assert.strictEqual(
      normalizeExecCommandForSig("cmd | head -50 | tail -10"),
      "cmd"
    );
  });

  it("preserves commands without filter pipes", () => {
    assert.strictEqual(
      normalizeExecCommandForSig("npm run build"),
      "npm run build"
    );
  });
});

describe("normalizeTestCommandForSig", () => {
  describe("PHP/Laravel tests", () => {
    it("normalizes php artisan test with --filter", () => {
      const result = normalizeTestCommandForSig(
        "php artisan test --filter=AdminControllerTest 2>&1 | tail -50"
      );
      assert.strictEqual(result, "php artisan test --filter=AdminControllerTest");
    });

    it("normalizes phpunit with --filter", () => {
      const result = normalizeTestCommandForSig(
        "vendor/bin/phpunit --filter=FooTest --colors=always"
      );
      assert.strictEqual(result, "vendor/bin/phpunit --filter=FooTest");
    });
  });

  describe("Python tests", () => {
    it("normalizes pytest with file path", () => {
      const result = normalizeTestCommandForSig(
        "pytest tests/test_auth.py -v --tb=short"
      );
      assert.strictEqual(result, "pytest tests/test_auth.py");
    });

    it("normalizes pytest with -k pattern", () => {
      const result = normalizeTestCommandForSig(
        "pytest -k test_login -v"
      );
      assert.strictEqual(result, "pytest -k test_login");
    });
  });

  describe("Go tests", () => {
    it("normalizes go test with -run", () => {
      const result = normalizeTestCommandForSig(
        "go test ./... -run TestFoo -v"
      );
      assert.strictEqual(result, "go test -run TestFoo");
    });
  });

  describe("Rust tests", () => {
    it("normalizes cargo test", () => {
      const result = normalizeTestCommandForSig(
        "cargo test test_parse -- --nocapture"
      );
      assert.strictEqual(result, "cargo test test_parse");
    });
  });

  describe("non-test commands", () => {
    it("returns null for non-test commands", () => {
      assert.strictEqual(normalizeTestCommandForSig("npm run build"), null);
      assert.strictEqual(normalizeTestCommandForSig("ls -la"), null);
      assert.strictEqual(normalizeTestCommandForSig("git status"), null);
    });

    it("returns null for empty/null input", () => {
      assert.strictEqual(normalizeTestCommandForSig(""), null);
      assert.strictEqual(normalizeTestCommandForSig("   "), null);
    });
  });

  describe("with cd prefix", () => {
    it("strips cd prefix before normalizing", () => {
      const result = normalizeTestCommandForSig(
        "cd /project && php artisan test --filter=FooTest"
      );
      assert.strictEqual(result, "php artisan test --filter=FooTest");
    });
  });
});
