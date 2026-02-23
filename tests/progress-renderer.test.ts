import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ProgressMessageRenderer } from '../dist/progress/progress-message-renderer.js';
import { renderDiscordMarkdown } from '../dist/progress/serialize-discord.js';
import { renderTelegramHtml } from '../dist/progress/serialize-telegram.js';
import { renderTuiLines } from '../dist/progress/serialize-tui.js';

test('progress renderer serializes consistently across Telegram/Discord/TUI', () => {
  const renderer = new ProgressMessageRenderer({
    maxToolLines: 6,
    maxTailLines: 3,
    maxDiffLines: 6,
    maxAssistantChars: 240,
  });

  const doc = renderer.render({
    banner: '🧹 Compacting context and retrying...',
    statusLine: '🔧 exec: npm test (10s tool, 40s total)',
    toolLines: ['◆ exec: npm test...', '✓ exec: rc=0, 88 lines'],
    toolTail: {
      name: 'exec',
      stream: 'stdout',
      lines: ['PASS src/a.test.ts', 'PASS src/b.test.ts'],
    },
    diff: {
      title: 'Δ src/agent.ts',
      lines: ['@@ -1,2 +1,3 @@', '+const x = 1;'],
    },
    stats: {
      turn: 2,
      toolCalls: 3,
      promptTokens: 1200,
      completionTokens: 300,
      promptTokensTurn: 400,
      completionTokensTurn: 120,
      ttftMs: 820,
      ttcMs: 4410,
      ppTps: 18.2,
      tgTps: 43.7,
    },
    assistantMarkdown: 'Done. Tests pass and patch applied.',
  });

  const tg = renderTelegramHtml(doc, { maxLen: 4096 });
  const dc = renderDiscordMarkdown(doc, { maxLen: 1900 });
  const tui = renderTuiLines(doc, { maxLines: 20 });

  assert.match(tg, /Compacting context and retrying/);
  assert.match(tg, /<pre>[\s\S]*exec: rc=0, 88 lines/);
  assert.match(tg, /<i>Δ src\/agent\.ts<\/i>/);

  assert.match(dc, /\*\*turn\*\*/);
  assert.match(dc, /```diff[\s\S]*\+const x = 1;/);
  assert.match(dc, /PASS src\/a\.test\.ts/);

  assert.ok(tui.some((l) => l.includes('turn: 2')));
  assert.ok(tui.some((l) => l.includes('Δ src/agent.ts')));
  assert.ok(tui.some((l) => l.includes('PASS src/a.test.ts')));
});

test('serializer truncation appends ellipsis when max length is exceeded', () => {
  const renderer = new ProgressMessageRenderer({
    maxAssistantChars: 10_000,
  });

  const doc = renderer.render({
    statusLine: '⏳ Thinking...',
    assistantMarkdown: 'x'.repeat(8_000),
  });

  const tg = renderTelegramHtml(doc, { maxLen: 500 });
  const dc = renderDiscordMarkdown(doc, { maxLen: 500 });

  assert.ok(tg.length <= 500);
  assert.ok(dc.length <= 500);
  assert.ok(tg.endsWith('…') || tg.includes('…'));
  assert.ok(dc.endsWith('…') || dc.includes('…'));
});
