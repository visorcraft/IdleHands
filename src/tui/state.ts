import type { TuiEvent } from './events.js';
import type { TuiState } from './types.js';

function clampCursor(buffer: string, cursor: number): number {
  return Math.max(0, Math.min(buffer.length, cursor));
}

export function createInitialTuiState(): TuiState {
  return {
    mode: 'chat',
    focus: 'input',
    inputBuffer: '',
    inputCursor: 0,
    inputHistory: [],
    historyIndex: null,
    transcript: [],
    toolEvents: [],
    alerts: [],
    statusText: undefined,
    activeRuntime: null,
    isStreaming: false,
    streamTargetId: undefined,
    confirmPending: undefined,
    branchPicker: undefined,
    stepNavigator: undefined,
    settingsMenu: undefined,
    hooksInspector: undefined,
    scroll: { transcript: 0, input: 0, status: 0, tools: 0, alerts: 0 },
  };
}

export function reduceTuiState(state: TuiState, ev: TuiEvent): TuiState {
  switch (ev.type) {
    case 'USER_INPUT_CHANGE': {
      const next = ev.text;
      return { ...state, inputBuffer: next, inputCursor: next.length, historyIndex: null };
    }

    case 'USER_INPUT_INSERT': {
      const before = state.inputBuffer.slice(0, state.inputCursor);
      const after = state.inputBuffer.slice(state.inputCursor);
      const inputBuffer = `${before}${ev.text}${after}`;
      return {
        ...state,
        inputBuffer,
        inputCursor: state.inputCursor + ev.text.length,
        historyIndex: null,
      };
    }

    case 'USER_INPUT_BACKSPACE': {
      if (state.inputCursor <= 0) return state;
      const before = state.inputBuffer.slice(0, state.inputCursor - 1);
      const after = state.inputBuffer.slice(state.inputCursor);
      return {
        ...state,
        inputBuffer: `${before}${after}`,
        inputCursor: state.inputCursor - 1,
        historyIndex: null,
      };
    }

    case 'USER_INPUT_DELETE_FORWARD': {
      if (state.inputCursor >= state.inputBuffer.length) return state;
      const before = state.inputBuffer.slice(0, state.inputCursor);
      const after = state.inputBuffer.slice(state.inputCursor + 1);
      return { ...state, inputBuffer: `${before}${after}`, historyIndex: null };
    }

    case 'USER_INPUT_CURSOR_MOVE': {
      return {
        ...state,
        inputCursor: clampCursor(state.inputBuffer, state.inputCursor + ev.delta),
      };
    }

    case 'USER_INPUT_CURSOR_HOME':
      return { ...state, inputCursor: 0 };

    case 'USER_INPUT_CURSOR_END':
      return { ...state, inputCursor: state.inputBuffer.length };

    case 'USER_INPUT_HISTORY_PREV': {
      if (!state.inputHistory.length) return state;
      const idx =
        state.historyIndex === null
          ? state.inputHistory.length - 1
          : Math.max(0, state.historyIndex - 1);
      const text = state.inputHistory[idx] ?? '';
      return { ...state, historyIndex: idx, inputBuffer: text, inputCursor: text.length };
    }

    case 'USER_INPUT_HISTORY_NEXT': {
      if (!state.inputHistory.length || state.historyIndex === null) return state;
      const idx = state.historyIndex + 1;
      if (idx >= state.inputHistory.length) {
        return { ...state, historyIndex: null, inputBuffer: '', inputCursor: 0 };
      }
      const text = state.inputHistory[idx] ?? '';
      return { ...state, historyIndex: idx, inputBuffer: text, inputCursor: text.length };
    }

    case 'USER_INPUT_SUBMIT': {
      const item = { id: `u_${Date.now()}`, role: 'user' as const, text: ev.text, ts: Date.now() };
      const inputHistory = ev.text.length ? [...state.inputHistory, ev.text] : state.inputHistory;
      return {
        ...state,
        inputBuffer: '',
        inputCursor: 0,
        historyIndex: null,
        inputHistory,
        transcript: [...state.transcript, item],
      };
    }

    case 'AGENT_STREAM_START': {
      const item = { id: ev.id, role: 'assistant_streaming' as const, text: '', ts: Date.now() };
      return {
        ...state,
        isStreaming: true,
        streamTargetId: ev.id,
        transcript: [...state.transcript, item],
      };
    }

    case 'AGENT_STREAM_TOKEN': {
      const transcript = state.transcript.map((t) =>
        t.id === ev.id ? { ...t, text: t.text + ev.token } : t
      );
      return { ...state, transcript };
    }

    case 'AGENT_STREAM_DONE': {
      const transcript = state.transcript.map((t) =>
        t.id === ev.id ? { ...t, role: 'assistant' as const } : t
      );
      return { ...state, isStreaming: false, streamTargetId: undefined, transcript };
    }

    case 'TOOL_START':
      return {
        ...state,
        toolEvents: [
          ...state.toolEvents,
          {
            id: ev.id,
            name: ev.name,
            phase: 'start',
            ts: Date.now(),
            detail: ev.detail,
            summary: ev.summary,
          },
        ],
      };
    case 'TOOL_END':
      return {
        ...state,
        toolEvents: [
          ...state.toolEvents,
          {
            id: ev.id,
            name: ev.name,
            phase: 'end',
            ts: Date.now(),
            detail: ev.detail,
            summary: ev.summary,
            durationMs: ev.durationMs,
          },
        ],
      };
    case 'TOOL_ERROR':
      return {
        ...state,
        toolEvents: [
          ...state.toolEvents,
          {
            id: ev.id,
            name: ev.name,
            phase: 'error',
            ts: Date.now(),
            detail: ev.detail,
            summary: ev.summary,
            durationMs: ev.durationMs,
          },
        ],
      };

    case 'TOOL_TAIL': {
      const idxFromEnd = [...state.toolEvents]
        .reverse()
        .findIndex((e) => e.id === ev.id && e.phase === 'start');
      if (idxFromEnd < 0) return state;
      const idx = state.toolEvents.length - 1 - idxFromEnd;
      const toolEvents = state.toolEvents.map((t, i) =>
        i === idx ? { ...t, detail: ev.tail } : t
      );
      return { ...state, toolEvents };
    }

    case 'RUNTIME_STATE_UPDATE':
      return { ...state, activeRuntime: ev.runtime };

    case 'ALERT_PUSH':
      return {
        ...state,
        alerts: [...state.alerts, { id: ev.id, level: ev.level, text: ev.text, ts: Date.now() }],
      };

    case 'ALERT_CLEAR':
      return { ...state, alerts: ev.id ? state.alerts.filter((a) => a.id !== ev.id) : [] };

    case 'STATUS_SET':
      return { ...state, statusText: ev.text };

    case 'STATUS_CLEAR':
      return { ...state, statusText: undefined };

    case 'CONFIRM_SHOW':
      return {
        ...state,
        confirmPending: {
          tool: ev.tool,
          summary: ev.summary,
          args: ev.args,
          diff: ev.diff,
          showDiff: false,
        },
      };

    case 'CONFIRM_TOGGLE_DIFF':
      if (!state.confirmPending) return state;
      return {
        ...state,
        confirmPending: {
          ...state.confirmPending,
          showDiff: !state.confirmPending.showDiff,
        },
      };

    case 'CONFIRM_DISMISS':
      return { ...state, confirmPending: undefined };

    case 'FOCUS_SET':
      return { ...state, focus: ev.panel };

    case 'SCROLL':
      return {
        ...state,
        scroll: { ...state.scroll, [ev.panel]: state.scroll[ev.panel] + ev.delta },
      };

    case 'SCROLL_SET':
      return { ...state, scroll: { ...state.scroll, [ev.panel]: Math.max(0, ev.value) } };

    case 'BRANCH_PICKER_OPEN':
      return {
        ...state,
        branchPicker: { branches: ev.branches, selectedIndex: 0, action: ev.action },
        stepNavigator: undefined,
        settingsMenu: undefined,
        hooksInspector: undefined,
      };

    case 'BRANCH_PICKER_MOVE': {
      if (!state.branchPicker) return state;
      const len = state.branchPicker.branches.length;
      if (len === 0) return state;
      const next = Math.max(0, Math.min(len - 1, state.branchPicker.selectedIndex + ev.delta));
      return { ...state, branchPicker: { ...state.branchPicker, selectedIndex: next } };
    }

    case 'BRANCH_PICKER_CLOSE':
      return { ...state, branchPicker: undefined };

    case 'STEP_NAV_OPEN': {
      const q = (ev.query ?? '').trim();
      const filtered = q
        ? ev.items.filter((i) => `${i.role} ${i.preview}`.toLowerCase().includes(q.toLowerCase()))
        : ev.items;
      return {
        ...state,
        stepNavigator: { items: filtered, selectedIndex: 0, query: q },
        branchPicker: undefined,
        settingsMenu: undefined,
        hooksInspector: undefined,
      };
    }

    case 'STEP_NAV_MOVE': {
      if (!state.stepNavigator) return state;
      const len = state.stepNavigator.items.length;
      if (len === 0) return state;
      const next = Math.max(0, Math.min(len - 1, state.stepNavigator.selectedIndex + ev.delta));
      return { ...state, stepNavigator: { ...state.stepNavigator, selectedIndex: next } };
    }

    case 'STEP_NAV_CLOSE':
      return { ...state, stepNavigator: undefined };

    case 'SETTINGS_OPEN':
      return {
        ...state,
        settingsMenu: { items: ev.items, selectedIndex: 0 },
        branchPicker: undefined,
        stepNavigator: undefined,
        hooksInspector: undefined,
      };

    case 'SETTINGS_MOVE': {
      if (!state.settingsMenu) return state;
      const len = state.settingsMenu.items.length;
      if (len === 0) return state;
      const next = Math.max(0, Math.min(len - 1, state.settingsMenu.selectedIndex + ev.delta));
      return { ...state, settingsMenu: { ...state.settingsMenu, selectedIndex: next } };
    }

    case 'SETTINGS_UPDATE': {
      if (!state.settingsMenu) return state;
      const selectedIndex =
        ev.selectedIndex == null
          ? Math.min(state.settingsMenu.selectedIndex, Math.max(0, ev.items.length - 1))
          : Math.max(0, Math.min(Math.max(0, ev.items.length - 1), ev.selectedIndex));
      return { ...state, settingsMenu: { items: ev.items, selectedIndex } };
    }

    case 'SETTINGS_CLOSE':
      return { ...state, settingsMenu: undefined };

    case 'HOOKS_INSPECTOR_OPEN':
      return {
        ...state,
        hooksInspector: { mode: ev.mode, lines: ev.lines, offset: 0 },
        branchPicker: undefined,
        stepNavigator: undefined,
        settingsMenu: undefined,
      };

    case 'HOOKS_INSPECTOR_MOVE': {
      if (!state.hooksInspector) return state;
      const max = Math.max(0, state.hooksInspector.lines.length - 1);
      const next = Math.max(0, Math.min(max, state.hooksInspector.offset + ev.delta));
      return { ...state, hooksInspector: { ...state.hooksInspector, offset: next } };
    }

    case 'HOOKS_INSPECTOR_CLOSE':
      return { ...state, hooksInspector: undefined };

    default:
      return state;
  }
}
