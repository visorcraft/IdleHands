import type { IdleHandsConfig } from "./config.js";

export function ensurePluginAllowlisted(cfg: IdleHandsConfig, pluginId: string): IdleHandsConfig {
  const allow = cfg.plugins?.allow;
  if (!Array.isArray(allow) || allow.includes(pluginId)) {
    return cfg;
  }
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      allow: [...allow, pluginId],
    },
  };
}
