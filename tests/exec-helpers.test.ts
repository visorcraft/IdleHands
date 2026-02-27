import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizeExecCommandForSig,
  normalizeTestCommandForSig,
  detectAwkAsRead,
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

  it("normalizes awk NR range commands to collapse different ranges on same file", () => {
    const a = normalizeExecCommandForSig(
      "cd /home/user/project && awk 'NR>=285 && NR<=300' tests/FooTest.php"
    );
    const b = normalizeExecCommandForSig(
      "cd /home/user/project && awk 'NR>=285 && NR<=320' tests/FooTest.php"
    );
    const c = normalizeExecCommandForSig(
      "cd /home/user/project && awk 'NR>=292 && NR<=305' tests/FooTest.php"
    );
    assert.strictEqual(a, b, "different awk ranges on same file should produce same sig");
    assert.strictEqual(b, c, "different awk ranges on same file should produce same sig");
    assert.ok(a.includes("tests/FooTest.php"), "should preserve file path");
  });

  it("normalizes sed -n range commands to collapse different ranges on same file", () => {
    const a = normalizeExecCommandForSig(
      "cd /tmp && sed -n '10,20p' foo.ts"
    );
    const b = normalizeExecCommandForSig(
      "cd /tmp && sed -n '50,100p' foo.ts"
    );
    assert.strictEqual(a, b, "different sed ranges on same file should produce same sig");
    assert.ok(a.includes("foo.ts"), "should preserve file path");
  });

  it("does not normalize awk commands that are not range-reads", () => {
    const a = normalizeExecCommandForSig("awk '{print $1}' file.txt");
    assert.ok(!a.includes("<range>"), "non-range awk should not be normalized");
  });
});

describe("detectAwkAsRead", () => {
  it("detects awk NR range pattern and redirects to read_file", () => {
    const result = detectAwkAsRead(
      "cd /home/user/project && awk 'NR>=285 && NR<=300' tests/FooTest.php"
    );
    assert.ok(result !== null, "should detect awk range pattern");
    assert.ok(result.includes("read_file"), "should suggest read_file");
    assert.ok(result.includes("offset: 285"), "should include correct offset");
    assert.ok(result.includes("limit: 16"), "should include correct limit");
  });

  it("detects awk NR>= without upper bound", () => {
    const result = detectAwkAsRead("awk 'NR>=100' myfile.ts");
    assert.ok(result !== null, "should detect awk NR>= pattern");
    assert.ok(result.includes("offset: 100"), "should include correct offset");
  });

  it("detects awk NR== single line", () => {
    const result = detectAwkAsRead("awk 'NR==42' myfile.ts");
    assert.ok(result !== null, "should detect awk NR== pattern");
    assert.ok(result.includes("offset: 42"), "should include correct offset");
    assert.ok(result.includes("limit: 1"), "should include limit 1");
  });

  it("returns null for non-range awk commands", () => {
    assert.strictEqual(detectAwkAsRead("awk '{print $1}' file.txt"), null);
    assert.strictEqual(detectAwkAsRead("ls -la"), null);
    assert.strictEqual(detectAwkAsRead(""), null);
  });

  it("handles cd prefix chains", () => {
    const result = detectAwkAsRead(
      "cd /home/user/project && awk 'NR>=10 && NR<=20' src/main.ts"
    );
    assert.ok(result !== null, "should detect with cd prefix");
    assert.ok(result.includes("src/main.ts"), "should include file path");
  });

});
