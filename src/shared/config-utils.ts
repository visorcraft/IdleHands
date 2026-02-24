import type { ApprovalMode } from '../types.js';

const APPROVAL_MODE_SET = new Set<ApprovalMode>(['plan', 'reject', 'default', 'auto-edit', 'yolo']);

export function normalizeApprovalMode(value: unknown): ApprovalMode | undefined;
export function normalizeApprovalMode(value: unknown, fallback: ApprovalMode): ApprovalMode;
export function normalizeApprovalMode(
  value: unknown,
  fallback?: ApprovalMode
): ApprovalMode | undefined {
  if (typeof value !== 'string') return fallback;
  const mode = value.trim().toLowerCase() as ApprovalMode;
  return APPROVAL_MODE_SET.has(mode) ? mode : fallback;
}
