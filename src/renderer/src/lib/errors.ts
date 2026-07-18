/** Human-readable message: strips Electron's "Error invoking remote method '…':" wrapper. */
export function errText(err: unknown): string {
  const s = err instanceof Error ? err.message : String(err)
  return s.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
