/**
 * Chat template verification: compares GGUF-embedded template against
 * the original from HuggingFace and optionally fixes mismatches.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { shellEscape } from '../utils.js';

import { runOnHost } from './executor.js';
import type { RuntimeModel, RuntimesConfig } from './types.js';

export interface TemplateCheckResult {
  modelId: string;
  source: string;
  ggufTemplate: string | null;
  hfTemplate: string | null;
  hfRepoUrl: string | null;
  match: boolean | null; // null = couldn't compare
  error?: string;
}

export interface TemplateFixResult extends TemplateCheckResult {
  fixed: boolean;
  templatePath?: string;
}

/**
 * Python script to extract chat template and base model repo URL from a GGUF file.
 * Works with the `gguf` Python package. Falls back to a simpler method if unavailable.
 */
const EXTRACT_SCRIPT = `
import sys, json
try:
    from gguf import GGUFReader
    r = GGUFReader(sys.argv[1])
    template = ''
    repo_url = ''
    base_name = ''
    for k in r.fields:
        v = bytes(r.fields[k].parts[-1]).decode(errors='replace')
        if k == 'tokenizer.chat_template':
            template = v
        elif k == 'general.base_model.0.repo_url':
            repo_url = v
        elif k == 'general.base_model.0.name':
            base_name = v
        elif k == 'general.name' and not base_name:
            base_name = v
    print(json.dumps({"template": template, "repo_url": repo_url, "base_name": base_name}))
except ImportError:
    print(json.dumps({"error": "gguf module not installed. Run: pip install gguf"}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`.trim();

/**
 * Extract the chat template embedded in a GGUF file on a remote (or local) host.
 */
export async function extractGgufTemplate(
  model: RuntimeModel,
  host: RuntimesConfig['hosts'][number]
): Promise<{ template: string; repoUrl: string; baseName: string; error?: string }> {
  // For multi-file GGUFs, only the first shard has metadata
  const source = model.source;

  const cmd = `python3 -c ${shellEscape(EXTRACT_SCRIPT)} ${shellEscape(source)}`;
  const result = await runOnHost(cmd, host, 30000);

  if (result.exitCode !== 0) {
    return { template: '', repoUrl: '', baseName: '', error: result.stderr || `exit code ${result.exitCode}` };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (parsed.error) {
      return { template: '', repoUrl: '', baseName: '', error: parsed.error };
    }
    return {
      template: parsed.template || '',
      repoUrl: parsed.repo_url || '',
      baseName: parsed.base_name || '',
    };
  } catch {
    return { template: '', repoUrl: '', baseName: '', error: 'Failed to parse extraction output' };
  }
}

/**
 * Fetch the chat template from a HuggingFace model repo's tokenizer_config.json.
 */
export async function fetchHfTemplate(repoUrl: string): Promise<{ template: string; error?: string }> {
  // repoUrl like https://huggingface.co/Qwen/Qwen3-Coder-Next
  // We need to fetch the raw tokenizer_config.json
  const match = repoUrl.match(/huggingface\.co\/([^/]+\/[^/]+)/);
  if (!match) {
    return { template: '', error: `Cannot parse HuggingFace repo from URL: ${repoUrl}` };
  }

  const repoId = match[1];
  const url = `https://huggingface.co/${repoId}/raw/main/tokenizer_config.json`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!resp.ok) {
      // Try resolve common patterns: base model might need -Instruct suffix, etc.
      return { template: '', error: `HuggingFace returned ${resp.status} for ${url}` };
    }
    const json = (await resp.json()) as any;
    const template = json?.chat_template;
    if (!template || typeof template !== 'string') {
      return { template: '', error: `No chat_template field in tokenizer_config.json for ${repoId}` };
    }
    return { template };
  } catch (e: any) {
    return { template: '', error: `Failed to fetch from HuggingFace: ${e?.message ?? e}` };
  }
}

/**
 * Normalize a template for comparison: strip comments, normalize whitespace.
 */
function normalizeTemplate(t: string): string {
  // Remove Jinja comments
  return t.replace(/\{#[\s\S]*?#\}/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Check if a model's GGUF-embedded template matches the HuggingFace original.
 */
export async function checkTemplate(
  model: RuntimeModel,
  config: RuntimesConfig
): Promise<TemplateCheckResult> {
  // Find the host this model would run on
  const hostId = Array.isArray(model.host_policy) ? model.host_policy[0] : undefined;
  const host = hostId
    ? config.hosts.find((h) => h.id === hostId && h.enabled)
    : config.hosts.find((h) => h.enabled);

  if (!host) {
    return {
      modelId: model.id,
      source: model.source,
      ggufTemplate: null,
      hfTemplate: null,
      hfRepoUrl: null,
      match: null,
      error: 'No enabled host found for this model',
    };
  }

  // Extract GGUF template
  const gguf = await extractGgufTemplate(model, host);
  if (gguf.error) {
    return {
      modelId: model.id,
      source: model.source,
      ggufTemplate: null,
      hfTemplate: null,
      hfRepoUrl: gguf.repoUrl || null,
      match: null,
      error: `GGUF extraction failed: ${gguf.error}`,
    };
  }

  if (!gguf.repoUrl) {
    return {
      modelId: model.id,
      source: model.source,
      ggufTemplate: gguf.template || null,
      hfTemplate: null,
      hfRepoUrl: null,
      match: null,
      error: 'No base_model repo URL found in GGUF metadata. Cannot auto-fetch HuggingFace template.',
    };
  }

  // Fetch HuggingFace template
  const hf = await fetchHfTemplate(gguf.repoUrl);
  if (hf.error) {
    return {
      modelId: model.id,
      source: model.source,
      ggufTemplate: gguf.template || null,
      hfTemplate: null,
      hfRepoUrl: gguf.repoUrl,
      match: null,
      error: `HuggingFace fetch failed: ${hf.error}`,
    };
  }

  const match = normalizeTemplate(gguf.template) === normalizeTemplate(hf.template);

  return {
    modelId: model.id,
    source: model.source,
    ggufTemplate: gguf.template,
    hfTemplate: hf.template,
    hfRepoUrl: gguf.repoUrl,
    match,
  };
}

/**
 * Check and optionally fix a model's chat template.
 * If mismatched, saves the correct HF template to templates/<name>.jinja
 * and updates the model's chat_template field in the provided config.
 */
export async function checkAndFixTemplate(
  model: RuntimeModel,
  config: RuntimesConfig
): Promise<TemplateFixResult> {
  const result = await checkTemplate(model, config);

  if (result.match === true) {
    return { ...result, fixed: false };
  }

  if (result.match === null || !result.hfTemplate) {
    return { ...result, fixed: false };
  }

  // Template mismatch — save the correct one
  const baseName = result.hfRepoUrl?.match(/huggingface\.co\/[^/]+\/([^/]+)/)?.[1] || model.id;
  const safeName = baseName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
  const filename = `${safeName}.jinja`;
  const templateDir = path.resolve('templates');
  const templatePath = path.join(templateDir, filename);

  try {
    await fs.mkdir(templateDir, { recursive: true });

    // Add attribution header
    const header = `{#- Chat template for ${baseName}
    Source: ${result.hfRepoUrl}/blob/main/tokenizer_config.json
    Auto-extracted by IdleHands /check_template command.
    The GGUF-embedded template was found to differ from the original. -#}\n`;

    await fs.writeFile(templatePath, header + result.hfTemplate);

    // Update model config
    model.chat_template = `templates/${filename}`;
    if (!model.launch.start_cmd.includes('{chat_template_args}')) {
      model.launch.start_cmd = model.launch.start_cmd.replace(
        '--jinja',
        '{chat_template_args} --jinja'
      );
    }

    return { ...result, fixed: true, templatePath: `templates/${filename}` };
  } catch (e: any) {
    return { ...result, fixed: false, error: `Failed to save template: ${e?.message ?? e}` };
  }
}
