/** A bounded sweep advances past busy or failed items and wraps at the end. */
export interface RecoveryCursor {
  created_at: string;
  id: string;
}

export function nextRecoveryCursor(rows: readonly RecoveryCursor[], limit: number): RecoveryCursor | null {
  return rows.length === limit ? rows[rows.length - 1]! : null;
}
