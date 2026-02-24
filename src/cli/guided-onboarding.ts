const BOLD = '\x1b[1m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** Called when createSession fails — suggests setup when runtime is unconfigured. */
export async function guidedRuntimeOnboarding(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const { loadRuntimes } = await import('../runtime/store.js');
  try {
    const rt = await loadRuntimes();
    if (rt.hosts.length > 0 && rt.backends.length > 0 && rt.models.length > 0) return false;
  } catch {
    return false;
  }

  console.log(
    `\n  ${YELLOW}⚠${RESET} No models found. Run ${BOLD}idlehands setup${RESET} for guided configuration.\n`
  );
  return false;
}
