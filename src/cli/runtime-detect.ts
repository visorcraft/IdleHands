/** Get active runtime endpoint if runtime subsystem is available. */
export async function getActiveRuntimeEndpoint(): Promise<string | null> {
  try {
    const { loadActiveRuntime } = await import('../runtime/executor.js');
    const active = await loadActiveRuntime();
    return active?.endpoint ?? null;
  } catch {
    return null;
  }
}
