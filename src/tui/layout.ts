export type TuiLayout = {
  cols: number;
  rows: number;
  statusRows: number;
  alertRows: number;
  toolsRows: number;
  inputRows: number;
  transcriptRows: number;
};

export function calculateLayout(rows: number, cols = 120): TuiLayout {
  const safeRows = Math.max(1, rows);
  const safeCols = Math.max(1, cols);
  const statusRows = 2;
  const alertRows = 1;
  const toolsRows = 2;
  const inputRows = 2;
  const transcriptRows = Math.max(3, safeRows - statusRows - alertRows - toolsRows - inputRows);
  return {
    cols: safeCols,
    rows: safeRows,
    statusRows,
    alertRows,
    toolsRows,
    inputRows,
    transcriptRows,
  };
}
