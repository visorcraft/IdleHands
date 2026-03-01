import type { IdleHandsPluginApi } from "idlehands/plugin-sdk";
import { createAcpxPluginConfigSchema } from "./src/config.js";
import { createAcpxRuntimeService } from "./src/service.js";

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "ACP runtime backend powered by the acpx CLI.",
  configSchema: createAcpxPluginConfigSchema(),
  register(api: IdleHandsPluginApi) {
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
      }),
    );
  },
};

export default plugin;
