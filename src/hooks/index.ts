export { HookManager } from './manager.js';
export { loadHookPlugins, type LoadedHookPlugin } from './loader.js';
export {
  scaffoldHookPlugin,
  normalizePluginName,
  type HookPluginScaffoldResult,
} from './scaffold.js';
export { HOOK_CAPABILITIES } from './types.js';
export type {
  HookCapability,
  HookEventMap,
  HookEventName,
  HookDispatchContext,
  HookHandler,
  HookPlugin,
  HookPluginInfo,
  HookRegistrationApi,
  HookStatsSnapshot,
  HookSystemConfig,
} from './types.js';
