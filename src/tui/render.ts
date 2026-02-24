import { truncate } from '../shared/strings.js';

import { calculateLayout } from './layout.js';
import { clearScreen } from './screen.js';
import { resolveTuiTheme, type TuiColors } from './theme.js';
import type { TuiState, ToolEvent } from './types.js';

/** Cached theme colors — set once via setRenderTheme(). */
let C: TuiColors = resolveTuiTheme('default');

/** Call once at TUI startup to apply the active theme to all rendering. */
export function setRenderTheme(name?: string): void {
  C = resolveTuiTheme(name);
}

function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatToolUsage(e: ToolEvent): string {
  const durationMs =
    typeof e.durationMs === 'number' ? e.durationMs : Math.max(0, Date.now() - e.ts);
  const icon =
    e.phase === 'error'
      ? `${C.red}✗${C.reset}`
      : e.phase === 'end'
        ? `${C.green}✓${C.reset}`
        : `${C.yellow}⠋${C.reset}`;
  const base = `${icon} ${e.name} (${secs(durationMs)})`;
  if (e.phase === 'start' && e.detail) return `${base} — ${truncate(e.detail, 70)}`;
  return base;
}

function rolePrefix(role: string): string {
  switch (role) {
    case 'user':
      return `${C.cyan}you:${C.reset}`;
    case 'assistant':
    case 'assistant_streaming':
      return `${C.green}ai:${C.reset}`;
    case 'tool':
      return `${C.yellow}tool:${C.reset}`;
    case 'error':
      return `${C.red}err:${C.reset}`;
    default:
      return `${C.dim}sys:${C.reset}`;
  }
}

function placeRight(line: string, indicator: string, cols: number): string {
  if (!indicator || cols <= 0) return truncate(line, cols);
  if (indicator.length >= cols) return truncate(indicator, cols);
  const left = truncate(line, cols - indicator.length);
  return `${left.padEnd(cols - indicator.length, ' ')}${indicator}`;
}

function buildBranchOverlay(state: TuiState, width: number, height: number): string[] {
  const picker = state.branchPicker;
  if (!picker) return [];
  const inner = Math.max(10, width - 2);
  const lines: string[] = [];
  const title =
    picker.action === 'browse'
      ? 'Branches'
      : picker.action === 'checkout'
        ? 'Checkout Branch'
        : 'Merge Branch';
  lines.push(`${C.bold}${title}${C.reset}  (↑/↓ select, Enter confirm, Esc cancel)`);
  lines.push('');
  if (!picker.branches.length) {
    lines.push(`${C.dim}No branches saved.${C.reset}`);
  } else {
    for (let i = 0; i < picker.branches.length; i++) {
      const b = picker.branches[i]!;
      const sel = i === picker.selectedIndex;
      const when = new Date(b.ts).toLocaleString();
      const prefix = sel ? `${C.cyan}❯${C.reset}` : ' ';
      const name = sel ? `${C.bold}${b.name}${C.reset}` : b.name;
      lines.push(`${prefix} ${name}  ${C.dim}(${b.messageCount} msgs, ${when})${C.reset}`);
    }
    lines.push('');
    const selected = picker.branches[picker.selectedIndex];
    if (selected?.preview) {
      lines.push(`${C.dim}Preview:${C.reset} ${selected.preview}`);
    }
  }

  const contentRows = Math.max(3, height - 2);
  const body = lines.slice(0, contentRows).map((l) => truncate(l, inner - 2));
  while (body.length < contentRows) body.push('');

  const top = `┌${'─'.repeat(inner)}┐`;
  const mid = body.map((line) => `│ ${line.padEnd(inner - 2)} │`);
  const bot = `└${'─'.repeat(inner)}┘`;
  return [`${C.bold}${top}${C.reset}`, ...mid, `${C.bold}${bot}${C.reset}`];
}

function buildModelPickerOverlay(state: TuiState, width: number, height: number): string[] {
  const picker = state.modelPicker;
  if (!picker) return [];
  const inner = Math.max(20, width - 2);
  const lines: string[] = [];
  const pageSize = Math.max(5, height - 6);

  lines.push(
    `${C.bold}Model Picker${C.reset}  (↑/↓ move, Enter select, type to filter, Esc cancel)`
  );
  lines.push(`${C.dim}Filter:${C.reset} ${picker.query || '(type to search)'}`);
  lines.push('');

  const items = picker.filtered;
  if (!items.length) {
    lines.push(`${C.dim}No matching models.${C.reset}`);
  } else {
    const startIdx = Math.min(picker.offset, Math.max(0, items.length - pageSize));
    const endIdx = Math.min(startIdx + pageSize, items.length);

    for (let i = startIdx; i < endIdx; i += 1) {
      const item = items[i]!;
      const selected = i === picker.selectedIndex;
      const prefix = selected ? `${C.cyan}❯${C.reset}` : ' ';
      const name = selected ? `${C.bold}${item.displayName}${C.reset}` : item.displayName;
      const status = item.enabled ? `${C.green}●${C.reset}` : `${C.red}○${C.reset}`;
      lines.push(`${prefix} ${status} ${name}`);
      if (selected) {
        lines.push(`    ${C.dim}${item.source}${C.reset}`);
      }
    }

    if (items.length > pageSize) {
      lines.push('');
      lines.push(`${C.dim}Showing ${startIdx + 1}-${endIdx} of ${items.length}${C.reset}`);
    }
  }

  const contentRows = Math.max(5, height - 2);
  const body = lines.slice(0, contentRows).map((l) => truncate(l, inner - 2));
  while (body.length < contentRows) body.push('');

  const top = `┌${'─'.repeat(inner)}┐`;
  const mid = body.map((line) => `│ ${line.padEnd(inner - 2)} │`);
  const bot = `└${'─'.repeat(inner)}┘`;
  return [`${C.bold}${top}${C.reset}`, ...mid, `${C.bold}${bot}${C.reset}`];
}

function buildOverlay(state: TuiState, width: number, height: number): string[] {
  const pending = state.confirmPending;
  if (!pending) return [];
  const inner = Math.max(10, width - 2);
  const lines: string[] = [];
  const prompt = pending.diff ? '[Y]es  [N]o  [D]iff' : '[Y]es  [N]o';
  lines.push(`tool: ${pending.tool}`);
  lines.push(`summary: ${pending.summary}`);
  lines.push(prompt);
  if (pending.showDiff && pending.diff) {
    lines.push('');
    lines.push(...pending.diff.split(/\r?\n/));
  }

  const contentRows = Math.max(3, height - 2);
  const body = lines.slice(0, contentRows).map((l) => truncate(l, inner - 2));
  while (body.length < contentRows) body.push('');

  const top = `┌${'─'.repeat(inner)}┐`;
  const mid = body.map((line) => `│ ${line.padEnd(inner - 2)} │`);
  const bot = `└${'─'.repeat(inner)}┘`;
  return [`${C.bold}${top}${C.reset}`, ...mid, `${C.bold}${bot}${C.reset}`];
}

function buildStepNavigatorOverlay(state: TuiState, width: number, height: number): string[] {
  const nav = state.stepNavigator;
  if (!nav) return [];
  const inner = Math.max(20, width - 2);
  const lines: string[] = [];
  lines.push(
    `${C.bold}Step Navigator${C.reset}  (↑/↓ move, Enter jump, type to filter, Backspace, Esc close)`
  );
  lines.push(`${C.dim}Filter:${C.reset} ${nav.query || '(none)'}`);
  lines.push('');

  if (!nav.items.length) {
    lines.push(`${C.dim}No matching steps.${C.reset}`);
  } else {
    for (let i = 0; i < nav.items.length; i += 1) {
      const item = nav.items[i]!;
      const selected = i === nav.selectedIndex;
      const prefix = selected ? `${C.cyan}❯${C.reset}` : ' ';
      const role = selected ? `${C.bold}${item.role}${C.reset}` : `${item.role}`;
      lines.push(`${prefix} ${role}: ${item.preview}`);
    }
  }

  const contentRows = Math.max(4, height - 2);
  const body = lines.slice(0, contentRows).map((l) => truncate(l, inner - 2));
  while (body.length < contentRows) body.push('');

  const top = `┌${'─'.repeat(inner)}┐`;
  const mid = body.map((line) => `│ ${line.padEnd(inner - 2)} │`);
  const bot = `└${'─'.repeat(inner)}┘`;
  return [`${C.bold}${top}${C.reset}`, ...mid, `${C.bold}${bot}${C.reset}`];
}

function buildSettingsOverlay(state: TuiState, width: number, height: number): string[] {
  const menu = state.settingsMenu;
  if (!menu) return [];
  const inner = Math.max(20, width - 2);
  const lines: string[] = [];
  lines.push(`${C.bold}Quick Settings${C.reset}  (↑/↓ select, ←/→ adjust, Enter apply, Esc close)`);
  lines.push('');

  if (!menu.items.length) {
    lines.push(`${C.dim}No settings available.${C.reset}`);
  } else {
    for (let i = 0; i < menu.items.length; i += 1) {
      const item = menu.items[i]!;
      const selected = i === menu.selectedIndex;
      const prefix = selected ? `${C.cyan}❯${C.reset}` : ' ';
      const label = selected ? `${C.bold}${item.label}${C.reset}` : item.label;
      lines.push(`${prefix} ${label}: ${item.value}`);
      if (selected && item.hint) lines.push(`   ${C.dim}${item.hint}${C.reset}`);
    }
  }

  const contentRows = Math.max(4, height - 2);
  const body = lines.slice(0, contentRows).map((l) => truncate(l, inner - 2));
  while (body.length < contentRows) body.push('');

  const top = `┌${'─'.repeat(inner)}┐`;
  const mid = body.map((line) => `│ ${line.padEnd(inner - 2)} │`);
  const bot = `└${'─'.repeat(inner)}┘`;
  return [`${C.bold}${top}${C.reset}`, ...mid, `${C.bold}${bot}${C.reset}`];
}

function buildHooksInspectorOverlay(state: TuiState, width: number, height: number): string[] {
  const inspector = state.hooksInspector;
  if (!inspector) return [];

  const inner = Math.max(20, width - 2);
  const lines: string[] = [];
  lines.push(`${C.bold}Hook Inspector${C.reset} (${inspector.mode})  (↑/↓ scroll, Esc close)`);
  lines.push('');

  const visibleRows = Math.max(4, height - 4);
  const start = Math.max(
    0,
    Math.min(inspector.offset, Math.max(0, inspector.lines.length - visibleRows))
  );
  const slice = inspector.lines.slice(start, start + visibleRows);

  if (!slice.length) {
    lines.push(`${C.dim}No data.${C.reset}`);
  } else {
    lines.push(...slice);
  }

  const remaining = Math.max(0, inspector.lines.length - (start + slice.length));
  if (start > 0 || remaining > 0) {
    lines.push('');
    lines.push(`${C.dim}scroll:${C.reset} ${start} lines above, ${remaining} below`);
  }

  const contentRows = Math.max(4, height - 2);
  const body = lines.slice(0, contentRows).map((l) => truncate(l, inner - 2));
  while (body.length < contentRows) body.push('');

  const top = `┌${'─'.repeat(inner)}┐`;
  const mid = body.map((line) => `│ ${line.padEnd(inner - 2)} │`);
  const bot = `└${'─'.repeat(inner)}┘`;
  return [`${C.bold}${top}${C.reset}`, ...mid, `${C.bold}${bot}${C.reset}`];
}

export function renderTui(state: TuiState): void {
  const layout = calculateLayout(process.stdout.rows ?? 30, process.stdout.columns ?? 120);
  const cols = layout.cols;

  clearScreen();

  const runtime = state.activeRuntime;
  const s1 = [
    `${C.bold}Idle Hands TUI${C.reset}`,
    `${C.dim}model=${C.reset}${runtime?.modelId ?? '-'}`,
    `${C.dim}host=${C.reset}${runtime?.hostId ?? '-'}`,
    `${C.dim}streaming=${C.reset}${state.isStreaming ? 'yes' : 'no'}`,
  ].join(' | ');
  process.stdout.write(truncate(s1, cols) + '\n');

  const health = runtime?.healthy ? `${C.green}●${C.reset}` : `${C.red}○${C.reset}`;
  const s2 = [
    `${C.dim}backend=${C.reset}${runtime?.backendId ?? '-'}`,
    `${C.dim}endpoint=${C.reset}${runtime?.endpoint ?? '-'}`,
    `${C.dim}health=${C.reset}${health}`,
    `${C.dim}keys=${C.reset}^G steps ^O settings /hooks`,
  ].join(' | ');
  process.stdout.write(truncate(s2, cols) + '\n');

  const transcriptLines: string[] = [];
  for (const item of state.transcript) {
    const chunks = String(item.text ?? '').split('\n');
    transcriptLines.push(`${rolePrefix(item.role)} ${chunks[0] ?? ''}`);
    for (const c of chunks.slice(1)) transcriptLines.push(`     ${c}`);
  }

  const maxScrollBack = Math.max(0, transcriptLines.length - layout.transcriptRows);
  const scrollBack = Math.max(0, Math.min(state.scroll.transcript, maxScrollBack));
  const end = transcriptLines.length - scrollBack;
  const start = Math.max(0, end - layout.transcriptRows);
  const visible = transcriptLines.slice(start, end);
  while (visible.length < layout.transcriptRows) visible.push('');

  const olderAbove = start;
  const newerBelow = scrollBack;

  const alert = state.alerts[state.alerts.length - 1];
  const statusText = state.statusText;
  const scrollStatus =
    newerBelow > 0 ? `↓${newerBelow} more` : olderAbove > 0 ? `↑${olderAbove} more` : '';

  const showAlert = alert && (alert.level === 'warn' || alert.level === 'error');
  if (showAlert && alert) {
    const color = alert.level === 'error' ? C.red : C.yellow;
    const alertText = `${color}[${alert.level}]${C.reset} ${alert.text}`;
    process.stdout.write(placeRight(alertText, scrollStatus, cols) + '\n');
  } else if (statusText) {
    process.stdout.write(placeRight(statusText, scrollStatus, cols) + '\n');
  } else if (alert) {
    const color = alert.level === 'error' ? C.red : alert.level === 'warn' ? C.yellow : C.dim;
    const alertText = `${color}[${alert.level}]${C.reset} ${alert.text}`;
    process.stdout.write(placeRight(alertText, scrollStatus, cols) + '\n');
  } else {
    process.stdout.write(placeRight(`${C.dim}[info]${C.reset} ready`, scrollStatus, cols) + '\n');
  }

  if (olderAbove > 0 && visible.length > 0) {
    visible[0] = placeRight(visible[0] ?? '', `${C.dim}↑${olderAbove}${C.reset}`, cols);
  }
  if (newerBelow > 0 && visible.length > 0) {
    visible[visible.length - 1] = placeRight(
      visible[visible.length - 1] ?? '',
      `${C.dim}↓${newerBelow}${C.reset}`,
      cols
    );
  }

  // Overlay rendering (confirm or branch picker — mutually exclusive)
  const activeOverlay = state.confirmPending
    ? buildOverlay(
        state,
        Math.min(Math.max(36, Math.floor(cols * 0.75)), cols - 2),
        Math.min(
          layout.transcriptRows,
          state.confirmPending.showDiff ? Math.max(8, Math.floor(layout.transcriptRows * 0.9)) : 6
        )
      )
    : state.branchPicker
      ? buildBranchOverlay(
          state,
          Math.min(Math.max(36, Math.floor(cols * 0.75)), cols - 2),
          Math.min(layout.transcriptRows, Math.max(8, Math.floor(layout.transcriptRows * 0.9)))
        )
      : state.stepNavigator
        ? buildStepNavigatorOverlay(
            state,
            Math.min(Math.max(44, Math.floor(cols * 0.8)), cols - 2),
            Math.min(layout.transcriptRows, Math.max(10, Math.floor(layout.transcriptRows * 0.92)))
          )
        : state.settingsMenu
          ? buildSettingsOverlay(
              state,
              Math.min(Math.max(44, Math.floor(cols * 0.8)), cols - 2),
              Math.min(
                layout.transcriptRows,
                Math.max(10, Math.floor(layout.transcriptRows * 0.92))
              )
            )
          : state.hooksInspector
            ? buildHooksInspectorOverlay(
                state,
                Math.min(Math.max(50, Math.floor(cols * 0.85)), cols - 2),
                Math.min(
                  layout.transcriptRows,
                  Math.max(10, Math.floor(layout.transcriptRows * 0.92))
                )
              )
            : state.modelPicker
              ? buildModelPickerOverlay(
                  state,
                  Math.min(Math.max(50, Math.floor(cols * 0.85)), cols - 2),
                  Math.min(
                    layout.transcriptRows,
                    Math.max(10, Math.floor(layout.transcriptRows * 0.85))
                  )
                )
              : null;

  if (activeOverlay) {
    const boxW = Math.min(Math.max(36, Math.floor(cols * 0.75)), cols - 2);
    const top = Math.max(0, Math.floor((layout.transcriptRows - activeOverlay.length) / 2));
    const left = Math.max(0, Math.floor((cols - boxW) / 2));
    for (let i = 0; i < activeOverlay.length; i += 1) {
      const idx = top + i;
      if (idx < 0 || idx >= visible.length) continue;
      const base = visible[idx].padEnd(cols, '');
      const line = activeOverlay[i] ?? '';
      visible[idx] = `${base.slice(0, left)}${line}${base.slice(left + line.length)}`;
    }
  }

  for (const l of visible) process.stdout.write(truncate(l, cols) + '\n');

  const recent = state.toolEvents.slice(-3);
  const t1 = recent.length ? recent.map(formatToolUsage).join(' | ') : `${C.dim}idle${C.reset}`;
  process.stdout.write(truncate(t1, cols) + '\n');

  const done = [...state.toolEvents]
    .reverse()
    .find((e) => e.phase === 'end' || e.phase === 'error');
  const summary = done
    ? `${done.name}: ${done.summary ?? done.detail ?? 'completed'}`
    : 'no completed tools yet';
  process.stdout.write(truncate(`${C.dim}last:${C.reset} ${summary}`, cols) + '\n');

  process.stdout.write('─'.repeat(Math.max(10, Math.min(cols, 80))) + '\n');
  process.stdout.write(truncate(`> ${state.inputBuffer}`, cols) + '\n');
}
