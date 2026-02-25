type RuntimeModelLike = {
  id: string;
  display_name: string;
  enabled?: boolean;
};

export type RuntimeModelPickerItem = {
  ordinal: number;
  id: string;
  displayName: string;
  isActive: boolean;
};

export type RuntimeModelPickerPage = {
  page: number;
  totalPages: number;
  perPage: number;
  totalModels: number;
  hasPrev: boolean;
  hasNext: boolean;
  items: RuntimeModelPickerItem[];
};

export const TELEGRAM_MODELS_PER_PAGE = 8;
export const DISCORD_MODELS_PER_PAGE = 10;

export function truncateLabel(input: string, max = 48): string {
  const text = String(input ?? '').trim();
  if (max <= 1) return text.slice(0, Math.max(0, max));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizePerPage(perPage?: number): number {
  const n = Number.isFinite(perPage) ? Math.floor(Number(perPage)) : TELEGRAM_MODELS_PER_PAGE;
  return Math.max(1, Math.min(25, n));
}

export function buildRuntimeModelPickerPage(
  models: RuntimeModelLike[],
  opts?: {
    page?: number;
    perPage?: number;
    activeModelId?: string | null;
  }
): RuntimeModelPickerPage {
  const enabled = (models ?? []).filter((m) => m && m.enabled !== false);
  const perPage = normalizePerPage(opts?.perPage);
  const totalModels = enabled.length;
  const totalPages = Math.max(1, Math.ceil(totalModels / perPage));

  const requestedPage = Number.isFinite(opts?.page) ? Math.floor(Number(opts?.page)) : 0;
  const page = Math.max(0, Math.min(totalPages - 1, requestedPage));

  const start = page * perPage;
  const selected = enabled.slice(start, start + perPage);
  const activeId = opts?.activeModelId ?? null;

  const items = selected.map((m, i) => ({
    ordinal: start + i + 1,
    id: m.id,
    displayName: m.display_name,
    isActive: !!activeId && m.id === activeId,
  }));

  return {
    page,
    totalPages,
    perPage,
    totalModels,
    hasPrev: page > 0,
    hasNext: page < totalPages - 1,
    items,
  };
}

export function formatRuntimeModelPickerText(
  page: RuntimeModelPickerPage,
  opts?: {
    header?: string;
    maxDisplayName?: number;
    maxModelId?: number;
  }
): string {
  const header = opts?.header ?? '📋 Select a model to switch to:';
  const maxDisplayName = opts?.maxDisplayName ?? 72;
  const maxModelId = opts?.maxModelId ?? 80;

  const lines: string[] = [];
  lines.push(`${header} (page ${page.page + 1}/${page.totalPages}, total ${page.totalModels})`);
  lines.push('');

  if (!page.items.length) {
    lines.push('No models on this page.');
  } else {
    for (const item of page.items) {
      const marker = item.isActive ? '★' : ' ';
      lines.push(
        `${String(item.ordinal).padStart(2, '0')}. ${marker} ${truncateLabel(item.displayName, maxDisplayName)}`
      );
      lines.push(`    id: ${truncateLabel(item.id, maxModelId)}`);
    }
  }

  lines.push('');
  lines.push('Tap a number button below to switch.');
  return lines.join('\n');
}
