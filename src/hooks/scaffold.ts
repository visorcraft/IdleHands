import fs from 'node:fs/promises';
import path from 'node:path';

export type HookPluginScaffoldResult = {
  pluginName: string;
  targetDir: string;
  files: string[];
};

export function normalizePluginName(raw: string): string {
  const cleaned = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!cleaned) return '';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(cleaned)) return '';
  return cleaned;
}

function templateIndex(pluginName: string): string {
  return `import type { HookPlugin } from 'idlehands/dist/hooks/index.js';

const plugin: HookPlugin = {
  name: '${pluginName}',
  capabilities: ['observe'],
  hooks: {
    ask_start: ({ askId }, ctx) => {
      console.error(\`[${pluginName}] ask_start \${askId} model=\${ctx.model}\`);
    },
  },
};

export default plugin;
`;
}

function templateReadme(pluginName: string): string {
  return `# ${pluginName}\n\nGenerated hook plugin scaffold for Idle Hands.\n\n## Files\n\n- \`index.ts\` — plugin entry (default export)\n\n## Configure Idle Hands\n\nAdd this plugin path to your config:\n\n\`\`\`json\n{\n  "hooks": {\n    "plugin_paths": ["./plugins/${pluginName}/dist/index.js"]\n  }\n}\n\`\`\`\n\nThen build your plugin and restart Idle Hands.\n`;
}

export async function scaffoldHookPlugin(opts: {
  pluginName: string;
  baseDir: string;
  force?: boolean;
}): Promise<HookPluginScaffoldResult> {
  const pluginName = normalizePluginName(opts.pluginName);
  if (!pluginName) {
    throw new Error('Invalid plugin name. Use lowercase letters/numbers plus . _ -');
  }

  const targetDir = path.resolve(opts.baseDir, pluginName);

  const exists = await fs
    .stat(targetDir)
    .then(() => true)
    .catch(() => false);
  if (exists && !opts.force) {
    throw new Error(`Target already exists: ${targetDir}`);
  }

  await fs.mkdir(targetDir, { recursive: true });

  const files = [path.join(targetDir, 'index.ts'), path.join(targetDir, 'README.md')];

  await fs.writeFile(files[0], templateIndex(pluginName), 'utf8');
  await fs.writeFile(files[1], templateReadme(pluginName), 'utf8');

  return {
    pluginName,
    targetDir,
    files,
  };
}
