import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function sh(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function trySh(cmd) {
  try {
    return sh(cmd);
  } catch {
    return "";
  }
}

function listAllTests() {
  const out = trySh('git ls-files "**/*.test.ts" "**/*.e2e.test.ts"');
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

function getBaseRef() {
  const envBase = process.env.GITHUB_BASE_REF?.trim();
  if (envBase) {
    // Ensure base ref exists locally (checkout often fetches a shallow ref only)
    trySh(`git fetch origin ${envBase} --depth=50`);
    const mergeBase = trySh(`git merge-base HEAD origin/${envBase}`);
    if (mergeBase) {
      return mergeBase;
    }
  }
  // Fallback for local/dev runs
  return trySh("git merge-base HEAD origin/main") || trySh("git rev-parse HEAD~1") || "";
}

function changedFiles(base) {
  if (!base) {
    return [];
  }
  const out = trySh(`git diff --name-only ${base}...HEAD`);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

function impactedTests(changed, allTests) {
  const testSet = new Set();

  // 1) If a test file changed directly, include it.
  for (const f of changed) {
    if (/\.test\.ts$|\.e2e\.test\.ts$/.test(f)) {
      testSet.add(f);
    }
  }

  // 2) For source file changes, include colocated / similarly named tests.
  for (const f of changed) {
    if (!/\.(ts|tsx|js|mjs|cjs|json|md)$/.test(f)) {
      continue;
    }

    const dir = path.dirname(f);
    const base = path.basename(f).replace(/\.(ts|tsx|js|mjs|cjs|json|md)$/i, "");

    for (const t of allTests) {
      if (path.dirname(t) === dir) {
        testSet.add(t);
        continue;
      }
      const tBase = path.basename(t).replace(/\.e2e\.test\.ts$|\.test\.ts$/i, "");
      if (tBase === base || tBase.startsWith(`${base}.`) || base.startsWith(`${tBase}.`)) {
        testSet.add(t);
      }
    }
  }

  // 3) If core/runtime/config changed, always include a small smoke pack.
  const touchedCore = changed.some((f) =>
    /^(src\/auto-reply|src\/agents|src\/infra|src\/commands|src\/config|src\/gateway|src\/routing)\//.test(
      f,
    ),
  );
  if (touchedCore) {
    [
      "src/commands/agent.test.ts",
      "src/commands/message.test.ts",
      "src/auto-reply/inbound.test.ts",
      "src/auto-reply/reply/route-reply.test.ts",
      "src/agents/model-selection.test.ts",
      "src/infra/outbound/message.test.ts",
    ].forEach((t) => {
      if (fs.existsSync(path.join(ROOT, t))) {
        testSet.add(t);
      }
    });
  }

  return [...testSet].toSorted((a, b) => a.localeCompare(b));
}

const allTests = listAllTests();
const base = getBaseRef();
const changed = changedFiles(base);
const impacted = impactedTests(changed, allTests);

console.log(
  `[impacted-tests] base=${base || "<none>"} changed=${changed.length} impacted=${impacted.length}`,
);

if (impacted.length === 0) {
  console.log("[impacted-tests] No impacted tests found; running fast smoke set.");
  const smoke = [
    "src/commands/agent.test.ts",
    "src/commands/message.test.ts",
    "src/auto-reply/inbound.test.ts",
    "src/agents/model-selection.test.ts",
  ].filter((t) => fs.existsSync(path.join(ROOT, t)));

  const r = spawnSync("pnpm", ["test", ...smoke], {
    stdio: "inherit",
    cwd: ROOT,
    shell: process.platform === "win32",
  });
  process.exit(r.status ?? 1);
}

// Keep cap so PR checks stay predictable.
const capped = impacted.slice(0, 120);
if (impacted.length > capped.length) {
  console.log(
    `[impacted-tests] Capped impacted test list to ${capped.length}/${impacted.length} files.`,
  );
}

const result = spawnSync("pnpm", ["test", ...capped], {
  stdio: "inherit",
  cwd: ROOT,
  shell: process.platform === "win32",
  env: {
    ...process.env,
    IDLEHANDS_TEST_PROFILE: process.env.IDLEHANDS_TEST_PROFILE || "low",
  },
});

process.exit(result.status ?? 1);
