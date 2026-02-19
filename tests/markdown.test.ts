import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown } from '../dist/markdown.js';

describe('markdown renderer', () => {
  it('renders bold text with ANSI', () => {
    const out = renderMarkdown('**hello**', { color: true });
    assert.ok(out.includes('\x1b[1m'));
    assert.ok(out.includes('hello'));
  });

  it('renders inline code with cyan', () => {
    const out = renderMarkdown('use `npm test`', { color: true });
    assert.ok(out.includes('\x1b[36m'));
    assert.ok(out.includes('npm test'));
  });

  it('renders headings with bold', () => {
    const out = renderMarkdown('# Title\n## Section', { color: true });
    assert.ok(out.includes('Title'));
    assert.ok(out.includes('Section'));
    // Both should have bold
    assert.ok(out.includes('\x1b[1m'));
  });

  it('renders fenced code blocks with box', () => {
    const out = renderMarkdown('```js\nconsole.log("hi")\n```', { color: true });
    assert.ok(out.includes('┌'));
    assert.ok(out.includes('│'));
    assert.ok(out.includes('└'));
    assert.ok(out.includes('console.log'));
  });

  it('renders bullet lists with bullets', () => {
    const out = renderMarkdown('- item one\n- item two', { color: true });
    assert.ok(out.includes('• item one'));
    assert.ok(out.includes('• item two'));
  });

  it('renders links as text (url)', () => {
    const out = renderMarkdown('[click](https://example.com)', { color: true });
    assert.ok(out.includes('click'));
    assert.ok(out.includes('https://example.com'));
  });

  it('strips markdown when color is off', () => {
    const out = renderMarkdown('**bold** `code` ~~strike~~', { color: false });
    assert.ok(!out.includes('\x1b'));
    assert.ok(out.includes('bold'));
    assert.ok(out.includes('code'));
    assert.ok(out.includes('strike'));
  });

  it('collapses think blocks when not verbose', () => {
    const out = renderMarkdown('<think>\nlong reasoning here\n</think>\nAnswer', { color: true, verbose: false });
    assert.ok(out.includes('[thinking...'));
    assert.ok(out.includes('Answer'));
    assert.ok(!out.includes('long reasoning'));
  });

  it('shows think blocks in verbose mode', () => {
    const out = renderMarkdown('<think>\nreasoning\n</think>\nAnswer', { color: true, verbose: true });
    assert.ok(out.includes('reasoning'));
    assert.ok(out.includes('Answer'));
  });

  it('handles strikethrough', () => {
    const out = renderMarkdown('~~deleted~~', { color: true });
    assert.ok(out.includes('\x1b[9m'));
    assert.ok(out.includes('deleted'));
  });

  it('handles numbered lists', () => {
    const out = renderMarkdown('1. first\n2. second', { color: true });
    assert.ok(out.includes('first'));
    assert.ok(out.includes('second'));
  });

  it('handles unclosed code blocks gracefully', () => {
    const out = renderMarkdown('```\nsome code\nno closing fence', { color: true });
    assert.ok(out.includes('some code'));
    assert.ok(out.includes('┌'));
  });

  it('handles horizontal rules', () => {
    const out = renderMarkdown('---', { color: true });
    assert.ok(out.includes('─'));
  });

  it('renders markdown tables with aligned borders', () => {
    const md = '| Name | Value |\n| --- | --- |\n| Foo | 123 |\n| BarBaz | 9 |';
    const out = renderMarkdown(md, { color: true });
    assert.ok(out.includes('┌'));
    assert.ok(out.includes('┬') || out.includes('┼'));
    assert.ok(out.includes('Foo'));
    assert.ok(out.includes('BarBaz'));
  });

  it('applies syntax highlighting for js code blocks', () => {
    const md = '```js\nconst x = 42\n```';
    const out = renderMarkdown(md, { color: true });
    assert.ok(out.includes('const'));
    assert.ok(out.includes('\x1b[35m') || out.includes('\x1b[33m'));
  });
});
