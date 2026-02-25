import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildRuntimeModelPickerPage,
  filterRuntimeModels,
  formatRuntimeModelPickerText,
  truncateLabel,
} from '../dist/bot/runtime-model-picker.js';

function models(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `model-${i + 1}`,
    display_name: `Very Long Runtime Model Name ${i + 1} That Might Be Verbose`,
    enabled: true,
  }));
}

describe('runtime model picker helpers', () => {
  it('builds first page with expected ordinals and boundaries', () => {
    const page = buildRuntimeModelPickerPage(models(12), { page: 0, perPage: 5 });
    assert.equal(page.page, 0);
    assert.equal(page.totalPages, 3);
    assert.equal(page.items.length, 5);
    assert.equal(page.items[0].ordinal, 1);
    assert.equal(page.items[4].ordinal, 5);
    assert.equal(page.hasPrev, false);
    assert.equal(page.hasNext, true);
  });

  it('clamps page bounds safely', () => {
    const low = buildRuntimeModelPickerPage(models(3), { page: -50, perPage: 2 });
    assert.equal(low.page, 0);

    const high = buildRuntimeModelPickerPage(models(3), { page: 999, perPage: 2 });
    assert.equal(high.page, 1);
    assert.equal(high.hasNext, false);
  });

  it('marks active model correctly', () => {
    const page = buildRuntimeModelPickerPage(models(6), {
      page: 0,
      perPage: 6,
      activeModelId: 'model-4',
    });
    assert.equal(page.items.find((i) => i.id === 'model-4')?.isActive, true);
    assert.equal(page.items.find((i) => i.id === 'model-1')?.isActive, false);
  });

  it('filters models by id/display_name and multiple terms', () => {
    const all = models(8);
    assert.equal(filterRuntimeModels(all, '').length, 8);
    assert.equal(filterRuntimeModels(all, 'model-3').length, 1);
    assert.equal(filterRuntimeModels(all, 'runtime name 4').length, 1);
    assert.equal(filterRuntimeModels(all, 'runtime 999').length, 0);
  });

  it('formats list text with page counters, active marker, and query', () => {
    const page = buildRuntimeModelPickerPage(models(6), {
      page: 0,
      perPage: 3,
      activeModelId: 'model-2',
    });
    const text = formatRuntimeModelPickerText(page, {
      header: 'Pick model',
      maxDisplayName: 32,
      maxModelId: 32,
      query: 'qwen coder',
    });

    assert.ok(text.includes('Pick model (page 1/2, total 6)'));
    assert.ok(text.includes('Filter: "qwen coder"'));
    assert.ok(text.includes('02. ★'));
    assert.ok(text.includes('id: model-2'));
    assert.ok(text.includes('Tap a number button below to switch.'));
  });

  it('truncateLabel adds ellipsis when needed', () => {
    assert.equal(truncateLabel('abcdef', 4), 'abc…');
    assert.equal(truncateLabel('abc', 4), 'abc');
  });
});
