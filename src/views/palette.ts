import { type Item } from "../api";
import { classifyBtn, importBtn, paletteBtn, paletteEl, paletteInputEl, paletteResultsEl } from "../dom";
import { goToView, openSettings } from "../main";
import { S } from "../state";
import { esc, fuzzyScore } from "../util";
import { exportSelected, openDetail, startBatchRefine, startMerge } from "./detail";

// ---------- command palette ----------
export type PaletteAction = { label: string; hint?: string; run: () => void };

export function paletteActions(): PaletteAction[] {
  const acts: PaletteAction[] = [
    { label: "Go to Dashboard", run: () => goToView("dashboard") },
    { label: "Go to Browse", run: () => goToView("library") },
    { label: "Go to Triage", hint: `${S.dupGroups.length} cluster(s)`, run: () => goToView("duplicates") },
    { label: "Go to Deploy", run: () => goToView("deploy") },
    { label: "Go to Archived", hint: `${S.archivedItems.length}`, run: () => goToView("archived") },
    { label: "Go to Deleted", hint: `${S.deletedItems.length}`, run: () => goToView("deleted") },
    { label: "Scan & import", run: () => importBtn.click() },
    { label: "Open Settings", run: () => openSettings() },
    { label: "Export selected items", hint: `${S.selection.size} selected`, run: () => exportSelected() },
    { label: "Batch refactor selected", hint: `${S.selection.size} selected`, run: () => startBatchRefine() },
  ];
  if (S.aiOk) acts.push({ label: "Classify all unclassified items", run: () => classifyBtn.click() });
  if (S.selection.size >= 2) {
    acts.push({ label: `Merge ${S.selection.size} selected → New`, run: () => startMerge("create") });
    acts.push({ label: `Merge ${S.selection.size} selected → Delete sources`, run: () => startMerge("delete") });
  }
  return acts;
}

export function paletteItemMatches(it: Item, q: string): boolean {
  return (
    it.name.toLowerCase().includes(q) ||
    it.description.toLowerCase().includes(q) ||
    (it.object ?? "").toLowerCase().includes(q) ||
    (it.verb ?? "").toLowerCase().includes(q)
  );
}

export let paletteFocus = 0;

// Subsequence fuzzy match: every char of `query` must appear in `target` in
// order (case-insensitive). Returns -1 on no match; otherwise a score that
// rewards consecutive-char runs and matches at the start of the target or of
// a word. Pure — no side effects.
// fuzzyScore lives in util.ts (imported above) — pure subsequence scorer for the palette.

export function renderPalette() {
  const q = paletteInputEl.value.trim().toLowerCase();
  // Empty query: all actions in original order. Otherwise fuzzy-match and sort
  // by score descending, keeping the original order for equal scores (stable).
  const actions = q
    ? paletteActions()
        .map((a, i) => ({ a, i, s: fuzzyScore(q, a.label) }))
        .filter((x) => x.s >= 0)
        .sort((x, y) => y.s - x.s || x.i - y.i)
        .map((x) => x.a)
    : paletteActions();
  const items = q ? S.allItems.filter((it) => paletteItemMatches(it, q)).slice(0, 20) : [];

  const rows: string[] = [];
  actions.forEach((a, i) => {
    rows.push(
      `<li class="pal-row${i === paletteFocus ? " focused" : ""}" data-kind="action" data-idx="${i}">` +
        `<span class="pal-icon">▸</span><span class="pal-label">${esc(a.label)}</span>` +
        (a.hint ? `<span class="pal-hint">${esc(a.hint)}</span>` : "") +
        `</li>`,
    );
  });
  items.forEach((it, i) => {
    const idx = actions.length + i;
    rows.push(
      `<li class="pal-row${idx === paletteFocus ? " focused" : ""}" data-kind="item" data-idx="${idx}" data-id="${it.id}">` +
        `<span class="badge ${it.item_type}">${it.item_type}</span><span class="pal-label">${esc(it.name)}</span>` +
        `<span class="pal-hint">${esc(it.description).slice(0, 60)}</span>` +
        `</li>`,
    );
  });

  paletteResultsEl.innerHTML = rows.length
    ? rows.join("")
    : `<li class="pal-empty">No matches.</li>`;

  for (const li of paletteResultsEl.querySelectorAll<HTMLLIElement>(".pal-row")) {
    li.addEventListener("click", () => runPaletteRow(li, actions));
  }
}

export function runPaletteRow(li: HTMLLIElement, actions: PaletteAction[]) {
  const idx = Number(li.dataset.idx);
  if (li.dataset.kind === "action") {
    actions[idx]?.run();
  } else {
    const id = Number(li.dataset.id);
    closePalette();
    openDetail(id);
    return;
  }
  closePalette();
}

export function openPalette() {
  paletteFocus = 0;
  paletteInputEl.value = "";
  paletteEl.hidden = false;
  renderPalette();
  paletteInputEl.focus();
}

export function closePalette() {
  paletteEl.hidden = true;
}

paletteBtn.addEventListener("click", openPalette);
paletteEl.addEventListener("click", (e) => {
  if (e.target === paletteEl) closePalette();
});
paletteInputEl.addEventListener("input", () => {
  paletteFocus = 0;
  renderPalette();
});
paletteInputEl.addEventListener("keydown", (e) => {
  const rowCount = paletteResultsEl.querySelectorAll(".pal-row").length;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteFocus = Math.min(paletteFocus + 1, Math.max(rowCount - 1, 0));
    renderPalette();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteFocus = Math.max(paletteFocus - 1, 0);
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const li = paletteResultsEl.querySelector<HTMLLIElement>(".pal-row.focused");
    if (li) li.click();
  } else if (e.key === "Escape") {
    closePalette();
  }
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    if (paletteEl.hidden) openPalette();
    else closePalette();
  }
});

