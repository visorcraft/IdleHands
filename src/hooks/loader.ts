import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { HookPlugin } from './types.js';

export type LoadedHookPlugin = {
  path: string;
  plugin: HookPlugin;
};

function isHookPlugin(value: any): value is HookPlugin {
  if (!value || typeof value !== 'object') return false;
  if (value.hooks && typeof value.hooks !== 'object') return false;
  if (value.setup && typeof value.setup !== 'function') return false;
  return Boolean(value.hooks || value.setup);
}

async function pluginFromModule(mod: any): Promise<HookPlugin | null> {
  const candidates = [
    mod?.default,
    mod?.plugin,
    typeof mod?.createPlugin === 'function' ? await mod.createPlugin() : null,
  ];

  for (const candidate of candidates) {
    if (isHookPlugin(candidate)) return candidate;
  }

  return null;
}

export async function loadHookPlugins(opts: {
  pluginPaths: string[];
  cwd: string;
  strict?: boolean;
  logger?: (message: string) => void;
}): Promise<LoadedHookPlugin[]> {
  const strict = opts.strict === true;
  const logger =
    opts.logger ??
    ((message: string) => {
      if (!process.env.IDLEHANDS_QUIET_WARNINGS) {
        console.warn(message);
      }
    });

  const loaded: LoadedHookPlugin[] = [];

  for (const entry of opts.pluginPaths) {
    const trimmed = String(entry ?? '').trim();
    if (!trimmed) continue;

    const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(opts.cwd, trimmed);

    try {
      const mod = await import(pathToFileURL(abs).href);
      const plugin = await pluginFromModule(mod);
      if (!plugin) {
        const msg = `[hooks] plugin ${abs} did not export a valid hook plugin`;
        if (strict) throw new Error(msg);
        logger(msg);
        continue;
      }
      loaded.push({ path: abs, plugin });
    } catch (error: any) {
      const msg = `[hooks] failed to load plugin ${abs}: ${error?.message ?? String(error)}`;
      if (strict) throw new Error(msg);
      logger(msg);
    }
  }

  return loaded;
}
