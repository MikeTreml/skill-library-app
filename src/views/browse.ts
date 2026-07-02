import { type Item } from "../api";
import { router } from "../router";
import { dupesEl, emptyEl, listEl, paletteEl, selbarEl, statusEl } from "../dom";
import { S } from "../state";
import { esc } from "../util";
import { archiveSelected, classifySelected, deleteSelected, exportSelected, openDetail, startBatchRefine, startMerge } from "./detail";
// ---------- rows + content ----------
export function chips(it: Item): string {
  const c: string[] = [];
  if (it.object) c.push(`<span class="chip obj">${esc(it.object)}${it.sub_object ? " › " + esc(it.sub_object) : ""}</span>`);
  if (it.verb) c.push(`<span class="chip verb">${esc(it.verb)}</span>`);
  if (it.qualifier) c.push(`<span class="chip qual">${esc(it.qualifier)}</span>`);
  if (it.has_variants) c.push(`<span class="chip warn">⚠ variants</span>`);
  return c.join("");
}

export function itemRow(
  it: Item,
  opts: { select?: boolean; restore?: "archive" | "delete"; cursor?: boolean } = {},
): string {
  const cb = opts.select
    ? `<input type="checkbox" class="sel" data-id="${it.id}"${S.selection.has(it.id) ? " checked" : ""} />`
    : "";
  const restore = opts.restore
    ? `<button class="restore" data-id="${it.id}" data-kind="${opts.restore}">Restore</button>`
    : "";
  return (
    `<li class="item${it.id === S.selectedId ? " active" : ""}${opts.cursor ? " cursor" : ""}" data-id="${it.id}">${cb}` +
    `<span class="badge ${it.item_type}">${it.item_type}</span><span class="name">${esc(it.name)}</span>${chips(it)}` +
    `<span class="desc">${esc(it.description)}</span>${restore}</li>`
  );
}

export function visibleItems(): Item[] {
  const q = S.query.trim().toLowerCase();
  return S.allItems.filter((it) => {
    if (S.typeFilter !== "all" && it.item_type !== S.typeFilter) return false;
    if (S.objectFilter === "__none__" && it.object) return false;
    if (S.objectFilter && S.objectFilter !== "__none__" && it.object !== S.objectFilter) return false;
    if (S.tagFilter && !(S.itemTagsMap.get(it.id) ?? []).includes(S.tagFilter)) return false;
    if (!q) return true;
    return it.name.toLowerCase().includes(q) || it.description.toLowerCase().includes(q);
  });
}

export function renderSelbar() {
  const n = S.selection.size;
  // The selection bar (merge/delete/etc.) is available wherever items have
  // checkboxes: the Library list and the Duplicates groups.
  if (n === 0 || (S.view !== "library" && S.view !== "duplicates")) {
    selbarEl.hidden = true;
    selbarEl.innerHTML = "";
    return;
  }
  selbarEl.hidden = false;
  const dis = n < 2 ? " disabled" : "";
  selbarEl.innerHTML =
    `<span>${n} selected</span>` +
    `<button id="mc" class="add-btn"${dis} title="AI-merge into a new item; keep the sources">Merge → New</button>` +
    `<button id="md" class="add-btn"${dis} title="AI-merge into a new item, then delete the sources">Merge → Delete</button>` +
    `<button id="clsel" class="add-btn">Classify</button>` +
    `<button id="rfsel" class="add-btn" title="AI-refactor all selected, then review one by one">Refactor</button>` +
    `<button id="arch" class="add-btn">Archive</button>` +
    `<button id="exp" class="add-btn" title="Export selected items as a shareable .tar.gz">Export…</button>` +
    `<button id="del" class="add-btn danger" title="Remove (recoverable from the Deleted view)">Delete</button>` +
    `<button id="clr" class="add-btn">Clear</button>`;
  document.getElementById("mc")!.addEventListener("click", () => startMerge("create"));
  document.getElementById("md")!.addEventListener("click", () => startMerge("delete"));
  document.getElementById("clsel")!.addEventListener("click", classifySelected);
  document.getElementById("rfsel")!.addEventListener("click", startBatchRefine);
  document.getElementById("arch")!.addEventListener("click", archiveSelected);
  document.getElementById("exp")!.addEventListener("click", exportSelected);
  document.getElementById("del")!.addEventListener("click", deleteSelected);
  document.getElementById("clr")!.addEventListener("click", () => {
    S.selection.clear();
    router.renderMain();
  });
}

export function renderList() {
  const items = visibleItems();
  if (S.cursorIdx > items.length - 1) S.cursorIdx = Math.max(0, items.length - 1);
  listEl.innerHTML = items.map((it, i) => itemRow(it, { select: true, cursor: i === S.cursorIdx })).join("");
  emptyEl.hidden = S.allItems.length > 0;
  statusEl.textContent = S.allItems.length ? `${items.length} of ${S.allItems.length} items` : "";
}


// ---------- Browse keyboard navigation (j/k/arrows + Space select + Enter open) ----------
export function onBrowseKey(e: KeyboardEvent) {
  if (S.view !== "library" || !paletteEl.hidden) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return; // don't shadow shortcuts like Ctrl+K
  // Don't steal keys from the search box, modal/detail inputs, or dropdowns.
  const tag = (document.activeElement as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const items = visibleItems();
  if (!items.length) return;
  if (e.key === "j" || e.key === "ArrowDown") {
    e.preventDefault();
    S.cursorIdx = Math.min(S.cursorIdx + 1, items.length - 1);
    renderList();
    listEl.querySelector(".item.cursor")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === "k" || e.key === "ArrowUp") {
    e.preventDefault();
    S.cursorIdx = Math.max(S.cursorIdx - 1, 0);
    renderList();
    listEl.querySelector(".item.cursor")?.scrollIntoView({ block: "nearest" });
  } else if (e.key === " ") {
    e.preventDefault();
    const it = items[S.cursorIdx];
    if (!it) return;
    if (S.selection.has(it.id)) S.selection.delete(it.id);
    else S.selection.add(it.id);
    renderList();
    renderSelbar();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const it = items[S.cursorIdx];
    if (it) openDetail(it.id);
  }
}
document.addEventListener("keydown", onBrowseKey);

export function renderArchived() {
  dupesEl.innerHTML = S.archivedItems.length
    ? `<ul class="items">${S.archivedItems.map((it) => itemRow(it, { restore: "archive" })).join("")}</ul>`
    : `<p class="empty">No archived items.</p>`;
  statusEl.textContent = `${S.archivedItems.length} archived`;
}

export function renderDeleted() {
  dupesEl.innerHTML = S.deletedItems.length
    ? `<p class="nav-note">Deleted items are kept out of re-import. Restore moves the copy back.</p>` +
      `<ul class="items">${S.deletedItems.map((it) => itemRow(it, { restore: "delete" })).join("")}</ul>`
    : `<p class="empty">No deleted items.</p>`;
  statusEl.textContent = `${S.deletedItems.length} deleted`;
}

