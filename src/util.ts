// Pure, state-free helpers shared across the UI. Keep this module free of DOM
// and state imports so anything can depend on it without cycles.

/// HTML-escape for interpolation into innerHTML template literals. Escapes
/// &, <, > and " — safe for both text content and double-quoted attributes.
export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/// Subsequence fuzzy match score for the command palette.
/// Returns -1 when the query chars don't all appear in order in the target;
/// otherwise higher = better (consecutive runs and word/start boundaries win).
export function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 0;
  let score = 0;
  let searchFrom = 0;
  let prevMatch = -2;
  for (const ch of q) {
    const idx = t.indexOf(ch, searchFrom);
    if (idx === -1) return -1; // chars not all present in order
    score += 1; // base point per matched char
    if (idx === prevMatch + 1) score += 2; // consecutive run
    if (idx === 0) score += 3; // start of target
    else if (!/[a-z0-9]/.test(t[idx - 1])) score += 2; // word boundary
    prevMatch = idx;
    searchFrom = idx + 1;
  }
  return score;
}
