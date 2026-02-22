/**
 * Model/server commands: /model, /server, /perf, /cost, /stats, /offline, /capture.
 */

import path from 'node:path';

import { estimateTokensFromMessages } from '../../history.js';
import { err as errFmt, warn as warnFmt } from '../../term.js';
import { projectDir } from '../../utils.js';
import type { SlashCommand } from '../command-registry.js';
import { restTokens } from '../command-utils.js';
import { estimateCostLine, formatCount, formatTps, formatKv, mean, percentile } from '../status.js';

// Track current escalation tier for the terminal session
let currentEscalationTier = 0;

export const modelCommands: SlashCommand[] = [
  {
    name: '/escalate',
    description: 'Escalate to a larger model',
    async execute(ctx, args) {
      const escalation = ctx.config.escalation;
      if (!escalation?.models?.length) {
        console.log('No escalation models configured.');
        console.log('Add "escalation": { "models": ["model1", "model2"] } to your config.');
        return true;
      }

      const models = escalation.models as string[];
      const tiers = escalation.tiers as Array<{ endpoint?: string }> | undefined;
      const arg = args.trim().toLowerCase();

      let targetTier: number;
      let targetModel: string;
      let targetEndpoint: string | undefined;

      if (arg === 'next' || arg === '') {
        // Escalate to next tier
        if (currentEscalationTier >= models.length) {
          console.log(
            `Already at maximum escalation tier (${currentEscalationTier}/${models.length}).`
          );
          console.log(`Current model: ${ctx.session.model}`);
          return true;
        }
        targetTier = currentEscalationTier;
        targetModel = models[targetTier];
        targetEndpoint = tiers?.[targetTier]?.endpoint;
      } else if (/^\d+$/.test(arg)) {
        // Escalate to specific tier
        const tier = parseInt(arg, 10);
        if (tier < 0 || tier >= models.length) {
          console.log(`Invalid tier ${tier}. Available tiers: 0-${models.length - 1}`);
          return true;
        }
        targetTier = tier;
        targetModel = models[tier];
        targetEndpoint = tiers?.[tier]?.endpoint;
      } else {
        // Escalate to specific model by name
        const idx = models.findIndex(
          (m) => m.toLowerCase() === arg || m.toLowerCase().includes(arg)
        );
        if (idx === -1) {
          console.log(`Model "${arg}" not found in escalation chain.`);
          console.log(`Available: ${models.join(', ')}`);
          return true;
        }
        targetTier = idx;
        targetModel = models[idx];
        targetEndpoint = tiers?.[idx]?.endpoint;
      }

      try {
        if (targetEndpoint) {
          await ctx.session.setEndpoint(targetEndpoint, targetModel);
          ctx.config.endpoint = targetEndpoint.replace(/\/+$/, '');
        } else {
          ctx.session.setModel(targetModel);
        }
        currentEscalationTier = targetTier + 1;
        console.log(ctx.S.green(`✓ Escalated to tier ${targetTier}: ${targetModel}`));
        console.log(ctx.S.dim(`  Endpoint: ${targetEndpoint || ctx.config.endpoint}`));
        console.log(ctx.S.dim(`  Harness: ${ctx.session.harness}`));
      } catch (e: any) {
        console.error(errFmt(`ESCALATE: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/deescalate',
    description: 'Return to base model',
    async execute(ctx) {
      if (currentEscalationTier === 0) {
        console.log('Already at base model.');
        console.log(`Current model: ${ctx.session.model}`);
        return true;
      }

      const baseModel = ctx.config.model || '';
      const baseEndpoint = ctx.config.endpoint || '';

      try {
        if (baseModel) {
          ctx.session.setModel(baseModel);
        }
        // Note: endpoint doesn't change back automatically in terminal mode
        // since we don't store the original endpoint separately
        currentEscalationTier = 0;
        console.log(ctx.S.green(`✓ De-escalated to base model: ${ctx.session.model}`));
        console.log(ctx.S.dim(`  Endpoint: ${baseEndpoint}`));
        console.log(ctx.S.dim(`  Harness: ${ctx.session.harness}`));
      } catch (e: any) {
        console.error(errFmt(`DEESCALATE: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/stats',
    description: 'Session statistics',
    async execute(ctx) {
      const promptTokens =
        ctx.session.usage.prompt > 0
          ? ctx.session.usage.prompt
          : estimateTokensFromMessages(ctx.session.messages);
      const completionTokens = ctx.session.usage.completion;
      const currentContext = ctx.session.currentContextTokens;
      const ctxW = ctx.session.contextWindow || 0;
      const ctxPct = ctxW > 0
        ? Math.min(100, (currentContext / ctxW) * 100).toFixed(1)
        : '?';

      const turns = Math.max(0, ctx.session.messages.filter((m: any) => m.role === 'user').length);
      const toolCalls = ctx.session.messages.reduce((sum: number, m: any) => {
        if (m.role !== 'assistant') return sum;
        return sum + (Array.isArray(m.tool_calls) ? m.tool_calls.length : 0);
      }, 0);

      let filesModified = 0;
      if (ctx.session.replay) {
        try {
          const checkpoints = await ctx.session.replay.list(10_000);
          filesModified = new Set(checkpoints.map((cp: any) => cp.filePath).filter(Boolean)).size;
        } catch {
          filesModified = 0;
        }
      }

      const elapsedMs = Date.now() - ctx.sessionStartedMs;
      const elapsedMin = Math.floor(elapsedMs / 60_000);
      const elapsedSec = Math.floor((elapsedMs % 60_000) / 1000);

      const lines = [
        'Session stats:',
        `  Turns: ${turns}`,
        `  Tool calls: ${toolCalls}`,
        `  Tokens (prompt): ~${promptTokens.toLocaleString()}`,
        `  Tokens (completion): ~${completionTokens.toLocaleString()}`,
        `  Context usage: ~${currentContext.toLocaleString()} / ${ctxW.toLocaleString()} (${ctxPct}%)`,
        `  Time: ${elapsedMin}m ${elapsedSec}s`,
        `  Files modified: ${filesModified}`,
        `  Model: ${ctx.session.model}`,
        `  Harness: ${ctx.session.harness}`,
        `  ${estimateCostLine({ model: ctx.session.model, endpoint: ctx.config.endpoint, promptTokens, completionTokens })}`,
      ];
      console.log(lines.join('\n'));
      return true;
    },
  },
  {
    name: '/server',
    description: 'Server health stats',
    async execute(ctx) {
      const snap = await ctx.readServerHealth(true);
      if (!snap) {
        console.log('Server health unavailable.');
        return true;
      }
      if (snap.unsupported) {
        console.log('Server does not expose /health.');
        return true;
      }
      if (!snap.ok) {
        console.log(`Server health check failed: ${snap.error || 'unknown error'}`);
        return true;
      }
      const lines = [
        'Server stats:',
        `  Endpoint: ${ctx.config.endpoint}`,
        `  Status: ${snap.statusText || 'ok'}`,
        `  Model: ${snap.model || ctx.session.model}`,
        `  Context: ${snap.contextSize != null ? formatCount(snap.contextSize) : '?'} tokens`,
        `  Slots: ${snap.slotCount != null ? formatCount(snap.slotCount) : '?'}`,
        `  Pending requests: ${snap.pendingRequests != null ? formatCount(snap.pendingRequests) : '?'}`,
        `  KV cache: ${formatKv(snap.kvUsed, snap.kvTotal) || 'unknown'}`,
        `  Prompt speed: ${formatTps(snap.ppTps)}`,
        `  Generation speed: ${formatTps(snap.tgTps)}`,
      ];
      console.log(lines.join('\n'));
      return true;
    },
  },
  {
    name: '/perf',
    description: 'Performance summary',
    async execute(ctx) {
      if (!ctx.perfSamples.length) {
        console.log('No performance samples yet. Run a prompt first.');
        return true;
      }
      const ttfts = ctx.perfSamples
        .map((s) => s.ttftMs)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      const ttcs = ctx.perfSamples
        .map((s) => s.ttcMs)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      const pps = ctx.perfSamples
        .map((s) => s.ppTps)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      const tgs = ctx.perfSamples
        .map((s) => s.tgTps)
        .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
      const totalPrompt = ctx.perfSamples.reduce((sum, s) => sum + (s.promptTokens || 0), 0);
      const totalCompletion = ctx.perfSamples.reduce(
        (sum, s) => sum + (s.completionTokens || 0),
        0
      );

      const lines = [
        'Performance summary:',
        `  Turns sampled: ${ctx.perfSamples.length}`,
        `  Avg TTFT: ${mean(ttfts) != null ? `${mean(ttfts)!.toFixed(0)} ms` : '-'}`,
        `  Avg TTC: ${mean(ttcs) != null ? `${mean(ttcs)!.toFixed(0)} ms` : '-'}`,
        `  p50 TTC: ${percentile(ttcs, 50) != null ? `${percentile(ttcs, 50)!.toFixed(0)} ms` : '-'}`,
        `  p95 TTC: ${percentile(ttcs, 95) != null ? `${percentile(ttcs, 95)!.toFixed(0)} ms` : '-'}`,
        `  Avg pp speed: ${mean(pps) != null ? formatTps(mean(pps)) : '-'}`,
        `  Avg tg speed: ${mean(tgs) != null ? formatTps(mean(tgs)) : '-'}`,
        `  Prompt tokens: ${totalPrompt.toLocaleString()}`,
        `  Completion tokens: ${totalCompletion.toLocaleString()}`,
        `  Total tokens generated: ${(totalPrompt + totalCompletion).toLocaleString()}`,
      ];
      console.log(lines.join('\n'));
      return true;
    },
  },
  {
    name: '/cost',
    description: 'Token cost estimate',
    async execute(ctx) {
      const est = estimateTokensFromMessages(ctx.session.messages);
      const u = ctx.session.usage;
      console.log(`Estimated context tokens: ~${est}`);
      console.log(`Messages in session: ${ctx.session.messages.length}`);
      if (u.prompt > 0 || u.completion > 0) {
        console.log(
          `Cumulative server-reported usage: ${u.prompt} prompt + ${u.completion} completion = ${u.prompt + u.completion} total`
        );
      } else {
        console.log(ctx.S.dim('(no server-reported usage available)'));
      }
      return true;
    },
  },
  {
    name: '/offline',
    description: 'Toggle offline mode',
    async execute(ctx, args) {
      const arg = args.toLowerCase();
      if (!arg || arg === 'status') {
        console.log(`Offline mode: ${ctx.config.offline ? 'on' : 'off'}`);
        return true;
      }
      if (arg === 'on' || arg === 'enable') {
        ctx.config.offline = true;
        console.log('Offline mode: on (internet-dependent internal features disabled)');
        return true;
      }
      if (arg === 'off' || arg === 'disable') {
        ctx.config.offline = false;
        console.log('Offline mode: off');
        return true;
      }
      console.log('Usage: /offline [on|off|status]');
      return true;
    },
  },
  {
    name: '/capture',
    description: 'Toggle request/response capture',
    async execute(ctx, _args, line) {
      const parts = restTokens(line);
      const action = (parts[0] || '').toLowerCase();
      const fileArg = parts[1] ? path.resolve(projectDir(ctx.config), parts[1]) : undefined;

      if (!action) {
        console.log(
          `Capture: ${ctx.session.capturePath ? `on (${ctx.session.capturePath})` : 'off'}`
        );
        console.log('Usage: /capture on [path] | /capture off | /capture last [path]');
        return true;
      }
      try {
        if (action === 'on') {
          const target = await ctx.session.captureOn(fileArg);
          console.log(`Capture enabled: ${target}`);
          return true;
        }
        if (action === 'off') {
          ctx.session.captureOff();
          console.log('Capture disabled.');
          return true;
        }
        if (action === 'last') {
          const target = await ctx.session.captureLast(fileArg);
          console.log(`Captured last request/response to: ${target}`);
          return true;
        }
        console.log('Usage: /capture on [path] | /capture off | /capture last [path]');
      } catch (e: any) {
        console.error(errFmt(`CAPTURE: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
  {
    name: '/model',
    description: 'View/switch model',
    async execute(ctx, _args, line) {
      const parts = restTokens(line);
      const arg1 = parts[0];

      const warnAndMaybeCompactForContext = async () => {
        const used = estimateTokensFromMessages(ctx.session.messages);
        const ctxW = ctx.session.contextWindow || 0;
        if (ctxW > 0 && used > ctxW) {
          console.log(
            warnFmt(
              `[model] Warning: new model context is ${ctxW.toLocaleString()} but session is at ~${used.toLocaleString()} tokens - compaction recommended`,
              ctx.S
            )
          );
          const compacted = await ctx.session.compactHistory();
          console.log(
            ctx.S.dim(
              `[model] auto-compact: ${compacted.beforeMessages} → ${compacted.afterMessages} messages (~${compacted.freedTokens} tokens freed)`
            )
          );
        } else if (ctxW > 0 && used > ctxW * 0.8) {
          console.log(
            warnFmt(
              `[model] Warning: session is at ~${used.toLocaleString()} / ${ctxW.toLocaleString()} tokens`,
              ctx.S
            )
          );
        }
      };

      if (!arg1) {
        console.log(ctx.S.dim('Current model: ') + ctx.S.cyan(ctx.session.model));
        console.log(
          ctx.S.dim('Current endpoint: ') +
          String((ctx.session as any).endpoint ?? ctx.config.endpoint)
        );
        console.log(ctx.S.dim('Current harness: ') + ctx.S.magenta(ctx.session.harness));
        console.log(
          ctx.S.dim('Context window: ') + `${ctx.session.contextWindow.toLocaleString()} tokens`
        );
        console.log('Usage: /model <name> | /model <endpoint> <name> | /model list');
        return true;
      }

      if (arg1.toLowerCase() === 'list') {
        try {
          const models = await ctx.session.listModels();
          if (!models.length) {
            console.log('No models reported by endpoint.');
          } else {
            console.log('Available models:');
            for (const id of models) {
              console.log(`  ${id === ctx.session.model ? '•' : '-'} ${id}`);
            }
          }
        } catch (e: any) {
          console.error(errFmt(`MODEL LIST: ${e?.message ?? String(e)}`, ctx.S));
        }
        return true;
      }

      if (/^https?:\/\//i.test(arg1)) {
        const endpoint = arg1;
        const modelName = parts[2];
        if (!modelName) {
          console.log('Usage: /model <endpoint> <name>');
          return true;
        }
        try {
          await ctx.session.setEndpoint(endpoint, modelName);
          ctx.config.endpoint = endpoint.replace(/\/+$/, '');
          console.log(ctx.S.dim('Endpoint: ') + ctx.config.endpoint);
          console.log(ctx.S.dim('Model: ') + ctx.S.cyan(ctx.session.model));
          console.log(ctx.S.dim('Harness: ') + ctx.S.magenta(ctx.session.harness));
          await warnAndMaybeCompactForContext();
        } catch (e: any) {
          console.error(errFmt(`MODEL SWITCH: ${e?.message ?? String(e)}`, ctx.S));
        }
        return true;
      }

      try {
        ctx.session.setModel(arg1);
        console.log(ctx.S.dim('Model: ') + ctx.S.cyan(ctx.session.model));
        console.log(ctx.S.dim('Harness: ') + ctx.S.magenta(ctx.session.harness));
        await warnAndMaybeCompactForContext();
      } catch (e: any) {
        console.error(errFmt(`MODEL: ${e?.message ?? String(e)}`, ctx.S));
      }
      return true;
    },
  },
];
