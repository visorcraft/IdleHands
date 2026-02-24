import { HostCommandRunner } from '../runtime/host-runner.js';
import type { RuntimeHost } from '../runtime/types.js';

const hostCommandRunner = new HostCommandRunner();

/** Run a shell command on a configured runtime host with timeout. */
export async function runHostCommand(
  host: RuntimeHost,
  command: string,
  timeoutSec = 5
): Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }> {
  return await hostCommandRunner.runOnHost(host, command, timeoutSec);
}
