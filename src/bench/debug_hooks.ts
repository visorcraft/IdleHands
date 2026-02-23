export function installBenchDebugHooks() {
  const onUncaught = (e: any) => {
    try {
      console.error('[bench-debug] uncaughtException:', e);
    } catch {}
  };
  const onUnhandled = (e: any) => {
    try {
      console.error('[bench-debug] unhandledRejection:', e);
    } catch {}
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
}
