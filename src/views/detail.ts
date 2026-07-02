import { type MergeResult, type RefineResult, addItemTag, applyRefinement, applyRefinementAsNew, archiveItem, classifyAll, deleteItems, exportItems, getItemContent, hasRefineBackup, itemSync, markUsed, mergeItems, pullFromLocation, pushToLocation, readPlacement, refineItem, removeItemTag, revertRefine, saveMerge } from "../api";
import { router } from "../router";
import { detailEl, statusEl } from "../dom";
import { S, itemById } from "../state";
import { esc } from "../util";
import { chips } from "./browse";
import { save } from "@tauri-apps/plugin-dialog";

export const DIRECTIVES = [
  "Generalize: open it beyond a single tool or topic to broader options",
  "Specialize: narrow and sharpen its focus",
  "Tighten guardrails: add validation, error handling, and safety boundaries",
  "Clarify the trigger/description so it activates at the right time",
  "Add concrete examples",
  "Tighten the prose; remove redundancy",
  "Modernize: update to current best practices and APIs",
];
export const TOOLS = [
  "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "LSP", "Bash",
  "PowerShell", "Monitor", "WebFetch", "WebSearch", "Agent", "Skill",
];



// ---------- detail / preview ----------
export function closeDetail() {
  S.selectedId = null;
  detailEl.hidden = true;
  detailEl.innerHTML = "";
  router.renderMain();
}

export async function openDetail(id: number) {
  const it = itemById(id) ?? S.archivedItems.find((i) => i.id === id);
  if (!it) return;
  S.selectedId = id;
  router.renderMain();
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><span class="badge ${it.item_type}">${it.item_type}</span><b>${esc(it.name)}</b></div>` +
    `<button id="detail-refine" class="rf-btn" title="Refactor & improve">✦</button>` +
    `<button id="detail-revert" class="rf-btn" title="Revert last refine (toggles between current and backed-up version)" hidden>↩</button>` +
    `<button id="detail-used" class="rf-btn" title="Mark as used (usage tracking)">✓</button>` +
    `<button id="detail-archive" class="rf-btn" title="Archive">🗄</button>` +
    `<button id="detail-close" class="src-rm" title="Close">✕</button></div>` +
    `<div class="detail-chips">${chips(it)}</div>` +
    (it.description ? `<p class="detail-desc">${esc(it.description)}</p>` : "") +
    `<div class="detail-path" title="${esc(it.library_path)}">${esc(it.library_path)}</div>` +
    `<div class="tag-panel" id="tag-panel"></div>` +
    `<div class="sync-panel" id="sync-panel"></div>` +
    `<pre class="detail-body">Loading…</pre>`;
  document.getElementById("detail-close")!.addEventListener("click", closeDetail);
  document.getElementById("detail-refine")!.addEventListener("click", () => openRefine(id));
  const revertBtn = document.getElementById("detail-revert") as HTMLButtonElement;
  hasRefineBackup(id)
    .then((has) => {
      revertBtn.hidden = !has;
    })
    .catch(() => {});
  revertBtn.addEventListener("click", async () => {
    if (!confirm("Revert to the version before the last refine? (You can toggle back.)")) return;
    try {
      await revertRefine(id);
      await router.load();
      openDetail(id); // re-render with restored content
      statusEl.textContent = "Reverted last refine.";
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  });
  document.getElementById("detail-used")!.addEventListener("click", async () => {
    try {
      await markUsed(id);
      await router.load();
      const it2 = itemById(id);
      statusEl.textContent = it2 ? `Marked used (${it2.use_count}× total).` : "Marked used.";
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  });
  document.getElementById("detail-archive")!.addEventListener("click", async () => {
    await archiveItem(id, true);
    closeDetail();
    await router.load();
    statusEl.textContent = "Archived.";
  });
  renderTagPanel(id);
  renderSyncPanel(id);
  const body = detailEl.querySelector(".detail-body")!;
  try {
    body.textContent = await getItemContent(id);
  } catch (e) {
    body.textContent = `Error: ${e}`;
  }
}

// ---------- tags (user-defined, orthogonal to AI taxonomy) ----------
export function renderTagPanel(id: number) {
  const el = document.getElementById("tag-panel");
  if (!el) return;
  const tags = S.itemTagsMap.get(id) ?? [];
  const chipsHtml = tags.length
    ? tags
        .map(
          (t) =>
            `<span class="tag-chip">#${esc(t)}<button class="tag-rm" data-tag="${esc(t)}" title="Remove tag">✕</button></span>`,
        )
        .join(" ")
    : `<span class="nav-note">No tags yet.</span>`;
  el.innerHTML =
    `<div class="rf-head">Tags</div><div class="tag-list">${chipsHtml}</div>` +
    `<div class="add-row"><input id="tag-input" class="dir-input" placeholder="add a tag (e.g. core)" /><button id="tag-add" class="add-btn">+ Tag</button></div>`;
  const input = document.getElementById("tag-input") as HTMLInputElement;
  const doAdd = async () => {
    const t = input.value.trim();
    if (!t) return;
    try {
      await addItemTag(id, t);
      await router.load();
      if (S.selectedId === id) renderTagPanel(id);
      statusEl.textContent = `Tagged #${t.toLowerCase()}`;
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  };
  document.getElementById("tag-add")!.addEventListener("click", doAdd);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doAdd();
  });
  for (const b of el.querySelectorAll<HTMLButtonElement>(".tag-rm"))
    b.addEventListener("click", async () => {
      try {
        await removeItemTag(id, b.dataset.tag!);
        await router.load();
        if (S.selectedId === id) renderTagPanel(id);
      } catch (e) {
        statusEl.textContent = `Error: ${e}`;
      }
    });
}

// ---------- sync & deploy ----------
export async function renderSyncPanel(id: number) {
  const el = document.getElementById("sync-panel");
  if (!el) return;
  try {
    const places = await itemSync(id);
    if (!places.length) {
      el.innerHTML = `<div class="rf-head">Locations &amp; sync</div><div class="nav-note">No tracked locations.</div>`;
      return;
    }
    el.innerHTML =
      `<div class="rf-head">Locations &amp; sync</div>` +
      places
        .map(
          (p) =>
            `<div class="sync-row"><span class="sdot ${p.status}"></span>` +
            `<span class="sync-label" title="${esc(p.abs_path)}">${esc(p.location_label)}</span>` +
            `<span class="sync-status">${p.status.replace("_", " ")}</span>` +
            `<button class="sbtn" data-act="diff" data-pid="${p.id}">Diff</button>` +
            `<button class="sbtn" data-act="push" data-pid="${p.id}">Push →</button>` +
            `<button class="sbtn" data-act="pull" data-pid="${p.id}">← Pull</button></div>`,
        )
        .join("");
    for (const b of el.querySelectorAll<HTMLButtonElement>(".sbtn"))
      b.addEventListener("click", () => onSyncAction(id, Number(b.dataset.pid), b.dataset.act!));
  } catch (e) {
    el.innerHTML = `<div class="nav-note">Sync error: ${esc(String(e))}</div>`;
  }
}

export async function onSyncAction(id: number, pid: number, act: string) {
  try {
    if (act === "diff") {
      const [lib, loc] = await Promise.all([getItemContent(id), readPlacement(pid)]);
      detailEl.innerHTML =
        `<div class="detail-head"><div class="detail-title"><b>Library vs location</b></div><button id="sd-x" class="src-rm" title="Back">✕</button></div>` +
        `<div class="rf-head">Library (canonical)</div><pre class="detail-body">${esc(lib)}</pre>` +
        `<div class="rf-head">Location</div><pre class="detail-body dim">${esc(loc)}</pre>`;
      document.getElementById("sd-x")!.addEventListener("click", () => openDetail(id));
      return;
    }
    if (act === "push") {
      await pushToLocation(pid);
      statusEl.textContent = "Pushed library → location (original backed up).";
    } else if (act === "pull") {
      await pullFromLocation(pid);
      await router.load();
      statusEl.textContent = "Pulled location → library (original backed up).";
    }
    await renderSyncPanel(id);
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
}

// ---------- refactor & improve ----------
export function openRefine(id: number) {
  const it = itemById(id);
  if (!it) return;
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Refactor: ${esc(it.name)}</b></div><button id="rf-x" class="src-rm" title="Cancel">✕</button></div>` +
    `<div class="rf-head">Directives</div>` +
    DIRECTIVES.map((d, i) => `<label class="rf-chk"><input type="checkbox" data-dir="${i}" /> ${esc(d.split(":")[0])}</label>`).join("") +
    `<div class="rf-head">Tools — click to + add / − remove</div>` +
    `<div class="rf-tools">${TOOLS.map((t) => `<button class="rf-tool" data-tool="${t}" data-state="0">${t}</button>`).join("")}</div>` +
    `<div class="add-row"><button id="rf-run" class="primary">✦ Run refine</button></div><p id="rf-status" class="status"></p>`;
  document.getElementById("rf-x")!.addEventListener("click", () => openDetail(id));
  for (const b of detailEl.querySelectorAll<HTMLButtonElement>(".rf-tool"))
    b.addEventListener("click", () => {
      const s = (Number(b.dataset.state) + 1) % 3;
      b.dataset.state = String(s);
      b.className = "rf-tool" + (s === 1 ? " add" : s === 2 ? " remove" : "");
    });
  document.getElementById("rf-run")!.addEventListener("click", () => runRefine(id, it.name));
}

export async function runRefine(id: number, name: string) {
  const rfStatus = document.getElementById("rf-status")!;
  if (!S.aiOk) {
    rfStatus.textContent = "Set a valid OPENAI_API_KEY (then restart) to refine.";
    return;
  }
  const dirs: string[] = [];
  for (const c of detailEl.querySelectorAll<HTMLInputElement>("input[data-dir]"))
    if (c.checked) dirs.push(DIRECTIVES[Number(c.dataset.dir)]);
  const toolsAdd: string[] = [];
  const toolsRemove: string[] = [];
  for (const b of detailEl.querySelectorAll<HTMLButtonElement>(".rf-tool")) {
    if (b.dataset.state === "1") toolsAdd.push(b.dataset.tool!);
    else if (b.dataset.state === "2") toolsRemove.push(b.dataset.tool!);
  }
  if (!dirs.length && !toolsAdd.length && !toolsRemove.length) {
    rfStatus.textContent = "Pick at least one directive or tool change.";
    return;
  }
  rfStatus.textContent = "Refining…";
  try {
    showRefineDiff(id, name, await refineItem(id, dirs, toolsAdd, toolsRemove));
  } catch (e) {
    rfStatus.textContent = `Error: ${e}`;
  }
}

export function showRefineDiff(id: number, name: string, res: RefineResult) {
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Refined: ${esc(name)}</b></div><button id="rf-x2" class="src-rm" title="Discard">✕</button></div>` +
    `<div class="add-row"><input id="rf-name" class="dir-input" value="${esc(name)} (refined)" /></div>` +
    `<div class="add-row"><button id="rf-save" class="primary">Save (overwrite)</button>` +
    `<button id="rf-savenew" class="add-btn">Save as new</button>` +
    `<button id="rf-back" class="add-btn">Back</button></div><p id="rf-status" class="status"></p>` +
    `<div class="rf-head">Proposed</div><pre class="detail-body">${esc(res.proposed)}</pre>` +
    `<div class="rf-head">Original</div><pre class="detail-body dim">${esc(res.original)}</pre>`;
  const rfErr = (e: unknown) => (document.getElementById("rf-status")!.textContent = `Error: ${e}`);
  document.getElementById("rf-x2")!.addEventListener("click", () => openDetail(id));
  document.getElementById("rf-back")!.addEventListener("click", () => openRefine(id));
  document.getElementById("rf-save")!.addEventListener("click", async () => {
    try {
      await applyRefinement(id, res.proposed);
      await router.load();
      openDetail(id);
      statusEl.textContent = "Refinement saved (original backed up).";
    } catch (e) {
      rfErr(e);
    }
  });
  document.getElementById("rf-savenew")!.addEventListener("click", async () => {
    const nm = (document.getElementById("rf-name") as HTMLInputElement).value.trim() || `${name} (refined)`;
    try {
      const newId = await applyRefinementAsNew(id, res.proposed, nm);
      await router.load();
      openDetail(newId);
      statusEl.textContent = "Saved as a new item (original kept).";
    } catch (e) {
      rfErr(e);
    }
  });
}

// ---------- batch refactor (staging-tray → directive picker → approve/reject queue) ----------
export type BatchProposal = { id: number; name: string; original: string; proposed: string };

export function startBatchRefine() {
  if (!S.aiOk) {
    statusEl.textContent = "Set a valid OPENAI_API_KEY (then restart) to refactor.";
    return;
  }
  if (!S.selection.size) return;
  const ids = [...S.selection];
  // Reuse the single-item directive picker UI, but wire the Run button to the batch runner.
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Batch refactor: ${ids.length} item(s)</b></div><button id="brf-x" class="src-rm" title="Cancel">✕</button></div>` +
    `<div class="rf-head">Directives (applied to every selected item)</div>` +
    DIRECTIVES.map((d, i) => `<label class="rf-chk"><input type="checkbox" data-dir="${i}" /> ${esc(d.split(":")[0])}</label>`).join("") +
    `<div class="rf-head">Tools — click to + add / − remove</div>` +
    `<div class="rf-tools">${TOOLS.map((t) => `<button class="rf-tool" data-tool="${t}" data-state="0">${t}</button>`).join("")}</div>` +
    `<div class="add-row"><button id="brf-run" class="primary">✦ Run on ${ids.length} item(s)</button></div><p id="brf-status" class="status"></p>`;
  document.getElementById("brf-x")!.addEventListener("click", closeDetail);
  for (const b of detailEl.querySelectorAll<HTMLButtonElement>(".rf-tool"))
    b.addEventListener("click", () => {
      const s = (Number(b.dataset.state) + 1) % 3;
      b.dataset.state = String(s);
      b.className = "rf-tool" + (s === 1 ? " add" : s === 2 ? " remove" : "");
    });
  document.getElementById("brf-run")!.addEventListener("click", () => runBatchRefine(ids));
}

export async function runBatchRefine(ids: number[]) {
  const st = document.getElementById("brf-status")!;
  const dirs: string[] = [];
  for (const c of detailEl.querySelectorAll<HTMLInputElement>("input[data-dir]"))
    if (c.checked) dirs.push(DIRECTIVES[Number(c.dataset.dir)]);
  const toolsAdd: string[] = [];
  const toolsRemove: string[] = [];
  for (const b of detailEl.querySelectorAll<HTMLButtonElement>(".rf-tool")) {
    if (b.dataset.state === "1") toolsAdd.push(b.dataset.tool!);
    else if (b.dataset.state === "2") toolsRemove.push(b.dataset.tool!);
  }
  if (!dirs.length && !toolsAdd.length && !toolsRemove.length) {
    st.textContent = "Pick at least one directive or tool change.";
    return;
  }
  const proposals: BatchProposal[] = [];
  for (let i = 0; i < ids.length; i++) {
    const it = itemById(ids[i]);
    if (!it) continue;
    st.textContent = `Refining ${i + 1}/${ids.length}: ${it.name}…`;
    try {
      const res = await refineItem(ids[i], dirs, toolsAdd, toolsRemove);
      proposals.push({ id: ids[i], name: it.name, original: res.original, proposed: res.proposed });
    } catch (e) {
      st.textContent = `Error on ${it.name}: ${e}`;
      return;
    }
  }
  if (!proposals.length) {
    st.textContent = "Nothing to review.";
    return;
  }
  reviewBatch(proposals, 0);
}

export function reviewBatch(proposals: BatchProposal[], idx: number) {
  if (idx >= proposals.length) {
    S.selection.clear();
    detailEl.hidden = true;
    detailEl.innerHTML = "";
    router.load().then(() => (statusEl.textContent = `Batch refactor complete (${proposals.length} reviewed).`));
    return;
  }
  const p = proposals[idx];
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Review ${idx + 1}/${proposals.length}: ${esc(p.name)}</b></div><button id="brv-x" class="src-rm" title="Stop reviewing">✕</button></div>` +
    `<div class="add-row"><button id="brv-approve" class="primary">✓ Approve (overwrite)</button>` +
    `<button id="brv-skip" class="add-btn">Skip</button></div><p id="brv-status" class="status"></p>` +
    `<div class="rf-head">Proposed</div><pre class="detail-body">${esc(p.proposed)}</pre>` +
    `<div class="rf-head">Original</div><pre class="detail-body dim">${esc(p.original)}</pre>`;
  document.getElementById("brv-x")!.addEventListener("click", () => reviewBatch(proposals, proposals.length));
  document.getElementById("brv-skip")!.addEventListener("click", () => reviewBatch(proposals, idx + 1));
  document.getElementById("brv-approve")!.addEventListener("click", async () => {
    try {
      await applyRefinement(p.id, p.proposed);
      reviewBatch(proposals, idx + 1);
    } catch (e) {
      document.getElementById("brv-status")!.textContent = `Error: ${e}`;
    }
  });
}

// ---------- merge / archive / delete ----------
export type MergeMode = "create" | "delete";

export async function startMerge(mode: MergeMode) {
  if (S.selection.size < 2) return;
  if (!S.aiOk) {
    statusEl.textContent = "Set a valid OPENAI_API_KEY (then restart) to merge.";
    return;
  }
  const ids = [...S.selection];
  statusEl.textContent = "Merging…";
  try {
    showMergeReview(ids, mode, await mergeItems(ids));
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
}

export function showMergeReview(ids: number[], mode: MergeMode, res: MergeResult) {
  const del = mode === "delete";
  detailEl.hidden = false;
  detailEl.innerHTML =
    `<div class="detail-head"><div class="detail-title"><b>Merge → ${del ? "Delete sources" : "New"}</b></div><button id="mg-x" class="src-rm" title="Discard">✕</button></div>` +
    `<div class="detail-path">Sources: ${res.sources.map((s) => esc(s.name)).join(", ")}</div>` +
    `<div class="add-row"><input id="mg-name" class="dir-input" value="${esc(res.sources[0]?.name ?? "merged")} (merged)" /></div>` +
    `<div class="add-row"><button id="mg-save" class="primary">Save ${del ? "& delete sources" : "as new"}</button></div><p id="mg-status" class="status"></p>` +
    `<div class="rf-head">Proposed</div><pre class="detail-body">${esc(res.proposed)}</pre>`;
  document.getElementById("mg-x")!.addEventListener("click", closeDetail);
  document.getElementById("mg-save")!.addEventListener("click", async () => {
    const name = (document.getElementById("mg-name") as HTMLInputElement).value.trim() || "merged";
    try {
      const newId = await saveMerge(ids, res.proposed, name, mode);
      S.selection.clear();
      await router.load();
      openDetail(newId);
      statusEl.textContent = del
        ? "Merged; sources deleted (restore from the Deleted view)."
        : "Merged into a new item.";
    } catch (e) {
      await router.load(); // reflect any partial progress (e.g. some sources already deleted)
      const st = document.getElementById("mg-status");
      if (st) st.textContent = `Error: ${e}`;
      statusEl.textContent = `Error: ${e}`;
    }
  });
}

export async function archiveSelected() {
  const ids = [...S.selection];
  for (const id of ids) await archiveItem(id, true);
  S.selection.clear();
  await router.load();
  statusEl.textContent = `Archived ${ids.length} item(s).`;
}

export async function exportSelected() {
  const ids = [...S.selection];
  if (!ids.length) return;
  const dest = await save({
    title: "Export selected items",
    defaultPath: "skill-export.tar.gz",
    filters: [{ name: "Gzipped tarball", extensions: ["tar.gz", "tgz"] }],
  });
  if (typeof dest !== "string") return; // cancelled
  statusEl.textContent = "Exporting…";
  try {
    const n = await exportItems(ids, dest);
    statusEl.textContent = `Exported ${n} item(s) → ${dest}`;
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
}

export async function deleteSelected() {
  const ids = [...S.selection];
  if (!ids.length) return;
  try {
    await deleteItems(ids);
    S.selection.clear();
    await router.load();
    statusEl.textContent = `Deleted ${ids.length} item(s) — restore from the Deleted view.`;
  } catch (e) {
    await router.load(); // reflect any partial progress
    statusEl.textContent = `Error: ${e}`;
  }
}

export async function classifySelected() {
  if (!S.aiOk) {
    statusEl.textContent = "Set a valid OPENAI_API_KEY (then restart) to classify.";
    return;
  }
  const ids = [...S.selection];
  if (!ids.length) return;
  statusEl.textContent = `Classifying ${ids.length} selected…`;
  try {
    const s = await classifyAll(ids);
    S.selection.clear();
    await router.load();
    statusEl.textContent = `Classified ${s.classified} selected`;
  } catch (e) {
    statusEl.textContent = `Error: ${e}`;
  }
}

