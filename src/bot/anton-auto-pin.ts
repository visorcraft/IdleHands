import { firstToken } from '../cli/command-utils.js';

const NON_START_SUBCOMMANDS = new Set(['status', 'stop', 'last', 'help']);

/** True when `/anton ...` args represent a run start (not status/stop/last/help). */
export function isAntonRunStartArgs(args: string): boolean {
  const sub = firstToken((args || '').trim());
  return !!sub && !NON_START_SUBCOMMANDS.has(sub);
}

/** Gate for automatic pinning before Anton start. */
export function shouldAutoPinBeforeAntonStart(opts: {
  args: string;
  autoPinEnabled: boolean;
  dirPinned: boolean;
}): boolean {
  return opts.autoPinEnabled && !opts.dirPinned && isAntonRunStartArgs(opts.args);
}
