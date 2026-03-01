/**
 * Fetch interceptor for slot affinity
 *
 * Wraps global fetch to inject id_slot into llama-server requests
 * based on session-to-slot mapping.
 */

let originalFetch: typeof globalThis.fetch | null = null;
let isInstalled = false;
let targetBaseUrl: string | null = null;

/**
 * Install the fetch interceptor for slot affinity.
 * Can be called multiple times; only installs once.
 */
export function installSlotAffinityFetch(llamaServerBaseUrl: string): void {
  if (isInstalled) {
    // Update target URL if changed
    targetBaseUrl = llamaServerBaseUrl.replace(/\/+$/, "");
    return;
  }

  originalFetch = globalThis.fetch;
  targetBaseUrl = llamaServerBaseUrl.replace(/\/+$/, "");

  const wrappedFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

    // Only intercept llama-server chat completion requests
    if (!targetBaseUrl || !url.startsWith(targetBaseUrl) || !url.includes("/chat/completions")) {
      return originalFetch!(input, init);
    }

    // Get slot from current context
    const slotId = getCurrentSlotId();
    if (slotId === undefined) {
      return originalFetch!(input, init);
    }

    // Parse and modify the request body to include id_slot
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        body.id_slot = slotId;
        body.n_cache_reuse = 0; // Disable checkpoint restore (buggy with hybrid models)

        const newInit: RequestInit = {
          ...init,
          body: JSON.stringify(body),
        };

        console.log(`[slot-affinity] Injected id_slot=${slotId}, n_cache_reuse=0 into request`);
        return originalFetch!(input, newInit);
      } catch (e) {
        // If parsing fails, forward original request
        console.warn("[slot-affinity] Failed to parse request body:", e);
      }
    }

    return originalFetch!(input, init);
  };

  // Copy over any additional properties from original fetch (like preconnect)
  // Using Object.assign to preserve the function while adding properties
  Object.assign(wrappedFetch, originalFetch);

  globalThis.fetch = wrappedFetch as typeof globalThis.fetch;

  isInstalled = true;
  console.log(`[slot-affinity] Fetch interceptor installed for ${targetBaseUrl}`);
}

// Current slot ID for the active request
// Note: This is a simplified approach. For true async isolation,
// we'd need AsyncLocalStorage, but this works for single-threaded
// request handling patterns.
let currentSlotId: number | undefined;

export function setCurrentSlotId(slotId: number | undefined): void {
  currentSlotId = slotId;
}

export function getCurrentSlotId(): number | undefined {
  return currentSlotId;
}
