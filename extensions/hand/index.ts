import type {
  AnyAgentTool,
  IdleHandsPluginApi,
  IdleHandsPluginToolFactory,
} from "../../src/plugins/types.js";
import { createHandTool } from "./src/hand-tool.js";

export default function register(api: IdleHandsPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) {
        return null;
      }
      return createHandTool(api) as AnyAgentTool;
    }) as IdleHandsPluginToolFactory,
    { optional: true },
  );
}
