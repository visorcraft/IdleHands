/**
 * Anton autonomous task runner — session config builders and factory wrapper.
 */

import type { AgentSession } from '../agent.js';
import { createSession } from '../agent.js';
import type { IdlehandsConfig } from '../types.js';

import type { AntonRunConfig } from './types.js';

/**
 * Build session config for main task execution sessions.
 */
export function buildSessionConfig(base: IdlehandsConfig, config: AntonRunConfig): IdlehandsConfig {
  const taskMaxIterations =
    Number.isFinite(config.taskMaxIterations) && config.taskMaxIterations > 0
      ? Math.floor(config.taskMaxIterations)
      : 50;

  return {
    ...base,
    dir: config.projectDir,
    approval_mode: config.approvalMode,
    no_confirm: config.approvalMode === 'yolo',
    verbose: false,
    quiet: true,
    max_iterations: taskMaxIterations,
    timeout: config.taskTimeoutSec,
    compact_at: 0.65,
    compact_min_tail: 4,
  };
}

/**
 * Build session config for preflight discovery/review sessions.
 * Uses stricter limits while keeping core tools available for plan-file writes.
 */
export function buildPreflightConfig(
  base: IdlehandsConfig,
  config: AntonRunConfig,
  stageTimeoutSec: number,
  maxIterationsOverride?: number
): IdlehandsConfig {
  const preflightMaxIterations =
    Number.isFinite(maxIterationsOverride) && Number(maxIterationsOverride) > 0
      ? Math.floor(Number(maxIterationsOverride))
      : Number.isFinite(config.preflightSessionMaxIterations) &&
          Number(config.preflightSessionMaxIterations) > 0
        ? Math.floor(Number(config.preflightSessionMaxIterations))
        : 500;

  const preflightTimeoutCapSec =
    Number.isFinite(config.preflightSessionTimeoutSec) &&
    Number(config.preflightSessionTimeoutSec) > 0
      ? Math.floor(Number(config.preflightSessionTimeoutSec))
      : Math.max(10, Math.floor(Number(config.taskTimeoutSec) || 600));

  return {
    ...base,
    dir: config.projectDir,
    approval_mode: config.approvalMode,
    no_confirm: config.approvalMode === 'yolo',
    verbose: false,
    quiet: true,
    max_iterations: preflightMaxIterations,
    timeout: Math.max(10, Math.min(Math.floor(stageTimeoutSec), preflightTimeoutCapSec)),
    compact_at: 0.65,
    compact_min_tail: 4,
    no_tools: false,
    trifecta: { enabled: false },
    mcp: { servers: [] },
    lsp: { enabled: false },
    sub_agents: { enabled: false },
  };
}

/**
 * Build session config for decompose-only sessions.
 * No tools — forces the model to emit a text-only decompose response.
 */
export function buildDecomposeConfig(
  base: IdlehandsConfig,
  config: AntonRunConfig
): IdlehandsConfig {
  return {
    ...base,
    dir: config.projectDir,
    approval_mode: config.approvalMode,
    no_confirm: config.approvalMode === 'yolo',
    verbose: false,
    quiet: true,
    max_iterations: 1,
    timeout: config.taskTimeoutSec,
    compact_at: 0.65,
    no_tools: true,
    trifecta: { enabled: false },
    mcp: { servers: [] },
    lsp: { enabled: false },
    sub_agents: { enabled: false },
  };
}

/**
 * Build session config for L2 AI verification sessions.
 * Minimal, fast config optimized for verification tasks.
 */
export function buildVerifyConfig(base: IdlehandsConfig, config: AntonRunConfig): IdlehandsConfig {
  return {
    ...base,
    dir: config.projectDir,
    model: config.verifyModel || base.model,
    approval_mode: 'yolo' as const,
    no_confirm: true,
    verbose: false,
    quiet: true,
    max_iterations: 1,
    no_tools: true,
    trifecta: { enabled: false },
    mcp: { servers: [] },
    lsp: { enabled: false },
    sub_agents: { enabled: false },
  };
}

/**
 * Default session factory for autonomous execution.
 * Auto-approves all agent confirmations.
 */
export async function defaultCreateSession(
  config: IdlehandsConfig,
  apiKey?: string
): Promise<AgentSession> {
  return createSession({
    config,
    apiKey,
    confirm: async () => true, // auto-approve for autonomous loop
  });
}
