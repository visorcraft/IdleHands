/**
 * Anton autonomous task runner — session config builders and factory wrapper.
 */

import type { IdlehandsConfig } from '../types.js';
import type { AgentSession } from '../agent.js';
import { createSession } from '../agent.js';
import type { AntonRunConfig } from './types.js';

/**
 * Build session config for main task execution sessions.
 */
export function buildSessionConfig(base: IdlehandsConfig, config: AntonRunConfig): IdlehandsConfig {
  return {
    ...base,
    dir: config.projectDir,
    approval_mode: config.approvalMode,
    no_confirm: config.approvalMode === 'yolo',
    verbose: false,
    quiet: true,
    max_iterations: 50,
    timeout: config.taskTimeoutSec,
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
export async function defaultCreateSession(config: IdlehandsConfig, apiKey?: string): Promise<AgentSession> {
  return createSession({
    config,
    apiKey,
    confirm: async () => true,  // auto-approve for autonomous loop
  });
}