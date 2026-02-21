export type IRDoc = {
  blocks: IRBlock[];
};

export type IRBlock =
  | { type: 'lines'; lines: IRLine[]; monospace?: boolean }
  | { type: 'code'; lines: string[]; lang?: string }
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

export function irLine(text: string, style: IRSpan['style'] = 'plain'): IRLine {
  return { spans: [{ text: String(text ?? ''), style }] };
}

export function irJoinLines(lines: string[], style: IRSpan['style'] = 'plain'): IRLine[] {
  return (lines ?? []).map((l) => irLine(l, style));
}
