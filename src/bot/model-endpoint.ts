/** Probe model endpoint health via /v1/models. */
export async function probeModelEndpoint(endpoint: string): Promise<boolean> {
  try {
    const base = endpoint.replace(/\/+$/, '');
    const r = await fetch(`${base}/v1/models`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Wait until model endpoint becomes reachable or timeout expires. */
export async function waitForModelEndpoint(
  endpoint: string,
  timeoutMs = 60_000,
  intervalMs = 2_500
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeModelEndpoint(endpoint)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
