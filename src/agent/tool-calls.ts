import type { ToolCall } from '../types.js';

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

  // Case 3: find a JSON object substring (handles tool_calls wrapper OR single tool-call)
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
