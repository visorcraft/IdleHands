import type { ToolCall } from '../types.js';

export type ArgValidationIssue = {
  field: string;
  message: string;
  value?: unknown;
};

/** @internal Exported for testing. Parses tool calls from model content when tool_calls array is empty. */
export function parseToolCallsFromContent(content: string): ToolCall[] | null {
  // Fallback parser: if model printed JSON tool_calls in content.
  const trimmed = content.trim();

  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // Case 1: whole content is JSON
  const whole = tryParse(trimmed);
  if (whole?.tool_calls && Array.isArray(whole.tool_calls)) return whole.tool_calls;
  if (whole?.name && whole?.arguments) {
    return [
      {
        id: 'call_0',
        type: 'function',
        function: { name: String(whole.name), arguments: JSON.stringify(whole.arguments) }
      }
    ];
  }

  // Case 2: raw JSON array of tool calls (model writes [{name, arguments}, ...])
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    const arrSub = tryParse(trimmed.slice(arrStart, arrEnd + 1));
    if (Array.isArray(arrSub) && arrSub.length > 0 && arrSub[0]?.name) {
      return arrSub.map((item: any, i: number) => ({
        id: `call_${i}`,
        type: 'function' as const,
        function: {
          name: String(item.name),
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
        }
      }));
    }
  }

  // Case 3: concatenated JSON objects (common malformed content-mode output):
  // {"name":"tool1","arguments":{...}}
  // {"name":"tool2","arguments":{...}}
  // ...
  // We recover each top-level JSON object and parse tool calls from them.
  const seqCalls: ToolCall[] = [];
  {
    const objects: string[] = [];
    let depth = 0;
    let start = -1;
    let inStr = false;
    let esc = false;

    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];

      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === '\\') {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }

      if (ch === '"') {
        inStr = true;
        continue;
      }

      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        if (depth > 0) depth--;
        if (depth === 0 && start !== -1) {
          objects.push(trimmed.slice(start, i + 1));
          start = -1;
        }
      }
    }

    if (objects.length > 1) {
      for (const [i, obj] of objects.entries()) {
        const parsed = tryParse(obj);
        if (parsed?.tool_calls && Array.isArray(parsed.tool_calls)) {
          for (const call of parsed.tool_calls) {
            if (call?.function?.name) seqCalls.push(call);
          }
          continue;
        }
        if (parsed?.name && parsed?.arguments != null) {
          seqCalls.push({
            id: `call_seq_${i}`,
            type: 'function',
            function: {
              name: String(parsed.name),
              arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments ?? {})
            }
          });
        }
      }
    }
  }
  if (seqCalls.length > 0) return seqCalls;

  // Case 4: find a JSON object substring (handles tool_calls wrapper OR single tool-call)
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    const sub = tryParse(trimmed.slice(start, end + 1));
    if (sub?.tool_calls && Array.isArray(sub.tool_calls)) return sub.tool_calls;
    if (sub?.name && sub?.arguments) {
      return [
        {
          id: 'call_0',
          type: 'function',
          function: { name: String(sub.name), arguments: typeof sub.arguments === 'string' ? sub.arguments : JSON.stringify(sub.arguments) }
        }
      ];
    }
  }

  // Case 4: XML tool calls — used by Qwen, Hermes, and other models whose chat
  // templates emit <tool_call><function=name><parameter=key>value</parameter></function></tool_call>.
  // When llama-server's XML→JSON conversion fails (common with large write_file content),
  // the raw XML leaks into the content field. This recovers it.
  const xmlCalls = parseXmlToolCalls(trimmed);
  if (xmlCalls?.length) return xmlCalls;


  // Case 5: Lightweight function-tag calls (seen in some Qwen content-mode outputs):
  // <function=tool_name>
  // {...json args...}
  // </function>
  // or single-line <function=tool_name>{...}</function>
  const fnTagCalls = parseFunctionTagToolCalls(trimmed);
  if (fnTagCalls?.length) return fnTagCalls;

  return null;
}

/**
 * Parse XML-style tool calls from content.
 * Format: <tool_call><function=name><parameter=key>value</parameter>...</function></tool_call>
 * Handles multiple tool call blocks and arbitrary parameter names/values.
 */
function parseXmlToolCalls(content: string): ToolCall[] | null {
  // Quick bailout: no point parsing if there's no <tool_call> marker
  if (!content.includes('<tool_call>')) return null;

  const calls: ToolCall[] = [];

  // Match each <tool_call>...</tool_call> block.
  // Using a manual scan instead of a single greedy regex to handle nested angle brackets
  // in parameter values (e.g. TypeScript generics, JSX, comparison operators).
  let searchFrom = 0;
  while (searchFrom < content.length) {
    const blockStart = content.indexOf('<tool_call>', searchFrom);
    if (blockStart === -1) break;

    const blockEnd = content.indexOf('</tool_call>', blockStart);
    if (blockEnd === -1) break; // Truncated — can't recover partial tool calls

    const block = content.slice(blockStart + '<tool_call>'.length, blockEnd);
    searchFrom = blockEnd + '</tool_call>'.length;

    // Extract function name: <function=name>...</function>
    const fnMatch = block.match(/<function=(\w[\w.-]*)>/);
    if (!fnMatch) continue;

    const fnName = fnMatch[1];
    const fnStart = block.indexOf(fnMatch[0]) + fnMatch[0].length;
    const fnEnd = block.lastIndexOf('</function>');
    const fnBody = fnEnd !== -1 ? block.slice(fnStart, fnEnd) : block.slice(fnStart);

    // Extract parameters: <parameter=key>value</parameter>
    // Uses bracket-matching (depth counting) so that parameter values containing
    // literal <parameter=...>...</parameter> (e.g. writing XML files) are handled
    // correctly instead of being truncated at the inner close tag.
    const args: Record<string, string> = {};
    const openRe = /<parameter=(\w[\w.-]*)>/g;
    const closeTag = '</parameter>';

    let paramMatch: RegExpExecArray | null;
    while ((paramMatch = openRe.exec(fnBody)) !== null) {
      const paramName = paramMatch[1];
      const valueStart = paramMatch.index + paramMatch[0].length;

      // Bracket-match: find the </parameter> that balances this open tag.
      // Depth starts at 1; nested <parameter=...> increments, </parameter> decrements.
      let depth = 1;
      let scanPos = valueStart;
      let closeIdx = -1;

      while (scanPos < fnBody.length && depth > 0) {
        const nextOpen = fnBody.indexOf('<parameter=', scanPos);
        const nextClose = fnBody.indexOf(closeTag, scanPos);

        if (nextClose === -1) break; // No more close tags — truncated

        if (nextOpen !== -1 && nextOpen < nextClose) {
          // An open tag comes before the next close — increase depth
          depth++;
          scanPos = nextOpen + 1; // advance past '<' to avoid re-matching
        } else {
          // Close tag comes first — decrease depth
          depth--;
          if (depth === 0) {
            closeIdx = nextClose;
          }
          scanPos = nextClose + closeTag.length;
        }
      }

      if (closeIdx === -1) {
        // No matching close tag — take rest of body as value (truncated output)
        args[paramName] = fnBody.slice(valueStart).trim();
        break;
      }

      // Trim exactly the template-added leading/trailing newline, preserve internal whitespace
      let value = fnBody.slice(valueStart, closeIdx);
      if (value.startsWith('\n')) value = value.slice(1);
      if (value.endsWith('\n')) value = value.slice(0, -1);
      args[paramName] = value;

      // Advance the regex past the close tag so the next openRe.exec starts after it
      openRe.lastIndex = closeIdx + closeTag.length;
    }

    if (fnName && Object.keys(args).length > 0) {
      calls.push({
        id: `call_xml_${calls.length}`,
        type: 'function',
        function: {
          name: fnName,
          arguments: JSON.stringify(args)
        }
      });
    }
  }

  return calls.length > 0 ? calls : null;
}

/** Check for missing required params by tool name — universal pre-dispatch validation */
export function getMissingRequiredParams(toolName: string, args: Record<string, unknown>): string[] {
  const required: Record<string, string[]> = {
    read_file: ['path'],
    read_files: ['requests'],
    write_file: ['path', 'content'],
    apply_patch: ['patch', 'files'],
    edit_range: ['path', 'start_line', 'end_line', 'replacement'],
    edit_file: ['path', 'old_text', 'new_text'],
    insert_file: ['path', 'line', 'text'],
    list_dir: ['path'],
    search_files: ['pattern', 'path'],
    exec: ['command'],
    spawn_task: ['task'],
    sys_context: [],
    vault_search: ['query'],
    vault_note: ['key', 'value']
  };
  const req = required[toolName];
  if (!req) return [];
  return req.filter(p => args[p] === undefined || args[p] === null);
}

const TOOL_ALLOWED_KEYS: Record<string, string[]> = {
  read_file: ['path', 'offset', 'limit', 'search', 'context', 'format', 'max_bytes'],
  read_files: ['requests'],
  write_file: ['path', 'content'],
  apply_patch: ['patch', 'files', 'strip'],
  edit_range: ['path', 'start_line', 'end_line', 'replacement'],
  edit_file: ['path', 'old_text', 'new_text', 'replace_all'],
  insert_file: ['path', 'line', 'text'],
  list_dir: ['path', 'recursive', 'max_entries'],
  search_files: ['pattern', 'path', 'include', 'max_results'],
  exec: ['command', 'cwd', 'timeout'],
  spawn_task: ['task', 'context_files', 'model', 'endpoint', 'max_iterations', 'max_tokens', 'timeout_sec', 'system_prompt', 'approval_mode'],
  sys_context: ['kind', 'tail_lines', 'include_journal', 'include_logs'],
  vault_search: ['query', 'limit'],
  vault_note: ['key', 'value'],
};

const isInt = (v: unknown): boolean => Number.isInteger(v);
const isStr = (v: unknown): boolean => typeof v === 'string';
const isBool = (v: unknown): boolean => typeof v === 'boolean';

function checkRange(field: string, value: unknown, min?: number, max?: number): ArgValidationIssue | null {
  if (value == null) return null;
  if (!isInt(value)) return { field, message: 'must be an integer', value };
  if (min != null && (value as number) < min) return { field, message: `must be >= ${min}`, value };
  if (max != null && (value as number) > max) return { field, message: `must be <= ${max}`, value };
  return null;
}

export function getArgValidationIssues(toolName: string, args: Record<string, unknown>): ArgValidationIssue[] {
  const issues: ArgValidationIssue[] = [];
  const allowed = TOOL_ALLOWED_KEYS[toolName] ?? [];

  // Unknown keys
  for (const k of Object.keys(args ?? {})) {
    if (!allowed.includes(k)) {
      issues.push({ field: k, message: 'unknown property', value: (args as any)[k] });
    }
  }

  // Per-tool checks (lightweight runtime schema validation)
  switch (toolName) {
    case 'read_file': {
      if (args.path != null && !isStr(args.path)) issues.push({ field: 'path', message: 'must be a string', value: args.path });
      const off = checkRange('offset', args.offset, 1, 1_000_000); if (off) issues.push(off);
      const lim = checkRange('limit', args.limit, 1, 240); if (lim) issues.push(lim);
      const ctx = checkRange('context', args.context, 0, 80); if (ctx) issues.push(ctx);
      const mb = checkRange('max_bytes', args.max_bytes, 256, 20_000); if (mb) issues.push(mb);
      if (args.search != null && !isStr(args.search)) issues.push({ field: 'search', message: 'must be a string', value: args.search });
      if (args.format != null && !['plain', 'numbered', 'sparse'].includes(String(args.format))) {
        issues.push({ field: 'format', message: 'must be one of: plain, numbered, sparse', value: args.format });
      }
      break;
    }
    case 'read_files': {
      if (!Array.isArray(args.requests)) {
        issues.push({ field: 'requests', message: 'must be an array', value: args.requests });
      } else {
        for (let i = 0; i < args.requests.length; i++) {
          const r = args.requests[i] as any;
          if (!r || typeof r !== 'object') {
            issues.push({ field: `requests[${i}]`, message: 'must be an object', value: r });
            continue;
          }
          const nested = getArgValidationIssues('read_file', r);
          for (const n of nested) issues.push({ ...n, field: `requests[${i}].${n.field}` });
        }
      }
      break;
    }
    case 'apply_patch': {
      if (args.patch != null && !isStr(args.patch)) issues.push({ field: 'patch', message: 'must be a string', value: args.patch });
      if (args.files != null && (!Array.isArray(args.files) || args.files.some((f) => typeof f !== 'string'))) {
        issues.push({ field: 'files', message: 'must be an array of strings', value: args.files });
      }
      const strip = checkRange('strip', args.strip, 0, 5); if (strip) issues.push(strip);
      break;
    }
    case 'edit_range': {
      if (args.path != null && !isStr(args.path)) issues.push({ field: 'path', message: 'must be a string', value: args.path });
      const s = checkRange('start_line', args.start_line, 1); if (s) issues.push(s);
      const e = checkRange('end_line', args.end_line, 1); if (e) issues.push(e);
      if (isInt(args.start_line) && isInt(args.end_line) && (args.end_line as number) < (args.start_line as number)) {
        issues.push({ field: 'end_line', message: 'must be >= start_line', value: args.end_line });
      }
      if (args.replacement != null && !isStr(args.replacement)) issues.push({ field: 'replacement', message: 'must be a string', value: args.replacement });
      break;
    }
    case 'search_files': {
      if (args.pattern != null && !isStr(args.pattern)) issues.push({ field: 'pattern', message: 'must be a string', value: args.pattern });
      if (args.path != null && !isStr(args.path)) issues.push({ field: 'path', message: 'must be a string', value: args.path });
      if (args.include != null && !isStr(args.include)) issues.push({ field: 'include', message: 'must be a string', value: args.include });
      const mr = checkRange('max_results', args.max_results, 1, 100); if (mr) issues.push(mr);
      break;
    }
    case 'exec': {
      if (args.command != null && !isStr(args.command)) issues.push({ field: 'command', message: 'must be a string', value: args.command });
      if (args.cwd != null && !isStr(args.cwd)) issues.push({ field: 'cwd', message: 'must be a string', value: args.cwd });
      const t = checkRange('timeout', args.timeout, 1, 120); if (t) issues.push(t);
      break;
    }
    case 'write_file':
      if (args.path != null && !isStr(args.path)) issues.push({ field: 'path', message: 'must be a string', value: args.path });
      if (args.content != null && !isStr(args.content)) issues.push({ field: 'content', message: 'must be a string', value: args.content });
      break;
    case 'edit_file':
      if (args.path != null && !isStr(args.path)) issues.push({ field: 'path', message: 'must be a string', value: args.path });
      if (args.old_text != null && !isStr(args.old_text)) issues.push({ field: 'old_text', message: 'must be a string', value: args.old_text });
      if (args.new_text != null && !isStr(args.new_text)) issues.push({ field: 'new_text', message: 'must be a string', value: args.new_text });
      if (args.replace_all != null && !isBool(args.replace_all)) issues.push({ field: 'replace_all', message: 'must be a boolean', value: args.replace_all });
      break;
    case 'insert_file': {
      if (args.path != null && !isStr(args.path)) issues.push({ field: 'path', message: 'must be a string', value: args.path });
      const ln = checkRange('line', args.line); if (ln) issues.push(ln);
      if (args.text != null && !isStr(args.text)) issues.push({ field: 'text', message: 'must be a string', value: args.text });
      break;
    }
    case 'list_dir':
      if (args.path != null && !isStr(args.path)) issues.push({ field: 'path', message: 'must be a string', value: args.path });
      if (args.recursive != null && !isBool(args.recursive)) issues.push({ field: 'recursive', message: 'must be a boolean', value: args.recursive });
      { const me = checkRange('max_entries', args.max_entries, 1, 500); if (me) issues.push(me); }
      break;
    case 'vault_search':
      if (args.query != null && !isStr(args.query)) issues.push({ field: 'query', message: 'must be a string', value: args.query });
      { const lim2 = checkRange('limit', args.limit, 1, 50); if (lim2) issues.push(lim2); }
      break;
    case 'vault_note':
      if (args.key != null && !isStr(args.key)) issues.push({ field: 'key', message: 'must be a string', value: args.key });
      if (args.value != null && !isStr(args.value)) issues.push({ field: 'value', message: 'must be a string', value: args.value });
      break;
  }

  return issues;
}

/** Strip markdown code fences (```json ... ```) from tool argument strings */
export function stripMarkdownFences(s: string): string {
  const trimmed = s.trim();
  // Match ```json\n...\n``` or ```\n...\n```
  const m = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/.exec(trimmed);
  return m ? m[1] : s;
}

function parseFunctionTagToolCalls(content: string): ToolCall[] | null {
  const m = content.match(/<function=([\w.-]+)>([\s\S]*?)<\/function>/i);
  if (!m) return null;

  const name = m[1];
  const body = (m[2] ?? '').trim();

  // If body contains JSON object, use it as arguments; else empty object.
  let args = '{}';
  const jsonStart = body.indexOf('{');
  const jsonEnd = body.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    const sub = body.slice(jsonStart, jsonEnd + 1);
    try {
      JSON.parse(sub);
      args = sub;
    } catch {
      // keep {}
    }
  }

  return [{
    id: 'call_0',
    type: 'function',
    function: { name, arguments: args }
  }];
}
