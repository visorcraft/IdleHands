export type TuiMode = 'chat' | 'command' | 'help' | 'search';
export type PanelId = 'transcript' | 'input' | 'status' | 'tools' | 'alerts';

export type TranscriptRole =
  | 'user'
  | 'assistant'
  | 'assistant_streaming'
  | 'tool'
  | 'system'
  | 'error';

export interface TranscriptItem {
  id: string;
  role: TranscriptRole;
  text: string;
  ts: number;
  meta?: Record<string, unknown>;
}

export interface ToolEvent {
  id: string;
  name: string;
  phase: 'start' | 'end' | 'error';
  ts: number;
  detail?: string;
  summary?: string;
  durationMs?: number;
}

export interface AlertItem {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  ts: number;
}

export interface ActiveRuntimeView {
  modelId?: string;
  backendId?: string;
  hostId?: string;
  endpoint?: string;
  healthy?: boolean;
}

export interface BranchPickerItem {
  name: string;
  ts: number;
  messageCount: number;
  preview: string;
}

export interface BranchPickerState {
  branches: BranchPickerItem[];
  selectedIndex: number;
  action: 'checkout' | 'merge' | 'browse';
}

export interface StepNavigatorItem {
  id: string;
  ts: number;
  role: TranscriptRole;
  preview: string;
  lineStart: number;
}

export interface StepNavigatorState {
  items: StepNavigatorItem[];
  selectedIndex: number;
  query: string;
}

export interface SettingsMenuItem {
  key: string;
  label: string;
  value: string;
  hint?: string;
}

export interface SettingsMenuState {
  items: SettingsMenuItem[];
  selectedIndex: number;
}

export interface HooksInspectorState {
  mode: 'status' | 'errors' | 'slow' | 'plugins';
  lines: string[];
  offset: number;
}

export interface TuiState {
  mode: TuiMode;
  focus: PanelId;
  inputBuffer: string;
  inputCursor: number;
  inputHistory: string[];
  historyIndex: number | null;
  transcript: TranscriptItem[];
  toolEvents: ToolEvent[];
  alerts: AlertItem[];
  statusText?: string;
  activeRuntime: ActiveRuntimeView | null;
  isStreaming: boolean;
  streamTargetId?: string;
  confirmPending?: {
    tool: string;
    summary: string;
    args?: Record<string, unknown>;
    diff?: string;
    showDiff: boolean;
  };
  branchPicker?: BranchPickerState;
  stepNavigator?: StepNavigatorState;
  settingsMenu?: SettingsMenuState;
  hooksInspector?: HooksInspectorState;
  scroll: Record<PanelId, number>;
}

export interface TuiRefs {
  screen: unknown;
  panels: Partial<Record<PanelId, unknown>>;
}
