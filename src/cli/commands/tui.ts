import type { IdlehandsConfig } from '../../types.js';
import { TuiController } from '../../tui/controller.js';
import { validateTerminal } from '../../tui/screen.js';

/**
 * Launch the fullscreen TUI. Validates terminal capabilities first;
 * returns false if the terminal isn't suitable (caller should fall back to CLI).
 */
export async function runTui(config: IdlehandsConfig, _args: any): Promise<boolean> {
  const check = validateTerminal();
  if (!check.ok) {
    console.log(`[tui] ${check.reason ?? 'unsupported terminal'}. Falling back to classic CLI.`);
    return false;
  }
  const controller = new TuiController(config);
  await controller.run();
  return true;
}
