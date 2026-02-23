export type IRDoc = {
  blocks: IRBlock[];
};

export type IRBlock =
  | { type: 'lines'; lines: IRLine[]; monospace?: boolean }
  | { type: 'kv'; items: IRKvItem[] }
  | { type: 'code'; lines: string[]; lang?: string }
  | { type: 'diff'; lines: string[]; title?: string }
  | { type: 'markdown'; markdown: string }
  | { type: 'divider' }
  | { type: 'spacer'; lines?: number };

export type IRLine = {
  spans: IRSpan[];
};

export type IRSpan = {
  text: string;
  style?: 'plain' | 'bold' | 'dim' | 'code';
};

export type IRKvItem = {
  key: string;
  value: string;
  keyStyle?: IRSpan['style'];
  valueStyle?: IRSpan['style'];
};

export function irLine(text: string, style: IRSpan['style'] = 'plain'): IRLine {
  return { spans: [{ text: String(text ?? ''), style }] };
}

export function irKvItem(
  key: string,
  value: string,
  keyStyle: IRSpan['style'] = 'bold',
  valueStyle: IRSpan['style'] = 'plain'
): IRKvItem {
  return { key: String(key ?? ''), value: String(value ?? ''), keyStyle, valueStyle };
}
