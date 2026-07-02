import { type ItemType, addScanDir, addSynonym, listScanDirs, listVerbMap, removeScanDir, removeSynonym, renormalizeVerbs } from "../api";
import { filtersEl, sourcesEl, statusEl, verbmapEl } from "../dom";
import { goToView, load, renderMain } from "../main";
import { S, type TypeFilter } from "../state";
import { esc } from "../util";
import { open } from "@tauri-apps/plugin-dialog";

// ---------- sidebar ----------
export function renderFilters() {
  const typeCount = (t: TypeFilter) =>
    t === "all" ? S.allItems.length : S.allItems.filter((i) => i.item_type === t).length;
  const typeBtn = (t: TypeFilter, label: string) =>
    `<button class="nav${S.typeFilter === t ? " active" : ""}" data-type="${t}"><span>${label}</span><span class="count">${typeCount(t)}</span></button>`;

  const objects = new Map<string, number>();
  let untriaged = 0;
  for (const it of S.allItems) {
    if (it.object) objects.set(it.object, (objects.get(it.object) ?? 0) + 1);
    else untriaged++;
  }
  const objBtn = (key: string | null, label: string, n: number) =>
    `<button class="nav sub${S.objectFilter === key && S.view === "library" ? " active" : ""}" data-object="${esc(key ?? "")}"><span>${esc(label)}</span><span class="count">${n}</span></button>`;
  let tree: string;
  if (objects.size || untriaged) {
    tree =
      `<details class="nav-tree" id="obj-tree"${S.objectsTreeOpen ? " open" : ""}>` +
      `<summary class="nav-head">Objects</summary>` +
      objBtn(null, "All objects", S.allItems.length) +
      [...objects.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => objBtn(o, o, n)).join("") +
      (untriaged ? objBtn("__none__", "Untriaged", untriaged) : "") +
      `</details>`;
  } else {
    tree = `<div class="nav-note">Run <b>Classify</b> to group by Object.</div>`;
  }

  const tagBtn = (key: string | null, label: string, n: number) =>
    `<button class="nav sub${S.tagFilter === key ? " active" : ""}" data-tag="${esc(key ?? "")}"><span>${esc(label)}</span><span class="count">${n}</span></button>`;
  const tagBlock = S.allTags.length
    ? `<details class="nav-tree" open><summary class="nav-head">Tags</summary>` +
      tagBtn(null, "All (clear tag)", S.allItems.length) +
      S.allTags.map(([t, n]) => tagBtn(t, `#${t}`, n)).join("") +
      `</details>`
    : "";

  filtersEl.innerHTML =
    `<div class="nav-group">${typeBtn("all", "All")}${typeBtn("skill", "Skills")}${typeBtn("agent", "Agents")}</div>` +
    `<div class="nav-group">${tree}</div>` +
    (tagBlock ? `<div class="nav-group">${tagBlock}</div>` : "");

  for (const b of filtersEl.querySelectorAll<HTMLButtonElement>("[data-type]"))
    b.addEventListener("click", () => {
      S.typeFilter = b.dataset.type as TypeFilter;
      S.cursorIdx = 0;
      renderFilters();
      renderMain();
    });
  for (const b of filtersEl.querySelectorAll<HTMLButtonElement>("[data-object]"))
    b.addEventListener("click", () => {
      S.objectFilter = b.dataset.object === "" ? null : b.dataset.object!;
      S.cursorIdx = 0;
      goToView("library");
    });
  for (const b of filtersEl.querySelectorAll<HTMLButtonElement>("[data-tag]"))
    b.addEventListener("click", () => {
      S.tagFilter = b.dataset.tag === "" ? null : b.dataset.tag!;
      S.cursorIdx = 0;
      goToView("library");
    });
  const objTree = document.getElementById("obj-tree") as HTMLDetailsElement | null;
  if (objTree) objTree.addEventListener("toggle", () => (S.objectsTreeOpen = objTree.open));
}

export function renderSources() {
  const rows = S.scanDirs
    .map(
      (d) =>
        `<li class="src-item"><span class="badge ${d.item_type}">${d.item_type}</span><span class="src-path" title="${esc(d.path)}">${esc(d.path)}</span><button class="src-rm" data-id="${d.id}" title="Remove">✕</button></li>`,
    )
    .join("");
  sourcesEl.innerHTML =
    `<h3>Custom sources</h3><input id="dir-input" class="dir-input" placeholder="C:\\path\\to\\folder" />` +
    `<div class="add-row"><button id="dir-browse" class="add-btn">📁 Browse…</button></div>` +
    `<div class="add-row"><button id="add-agents" class="add-btn">+ Agents dir</button><button id="add-skills" class="add-btn">+ Skills dir</button></div>` +
    `<ul class="src-list">${rows}</ul>`;
  const input = document.getElementById("dir-input") as HTMLInputElement;
  document.getElementById("dir-browse")!.addEventListener("click", async () => {
    const picked = await open({ directory: true, title: "Pick a skills or agents folder" });
    if (typeof picked === "string") input.value = picked;
  });
  const add = async (t: ItemType) => {
    const path = input.value.trim();
    if (!path) return;
    try {
      await addScanDir(path, t);
      input.value = "";
      S.scanDirs = await listScanDirs();
      renderSources();
      statusEl.textContent = `Added ${t} source — click Scan & import`;
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  };
  document.getElementById("add-agents")!.addEventListener("click", () => add("agent"));
  document.getElementById("add-skills")!.addEventListener("click", () => add("skill"));
  for (const b of sourcesEl.querySelectorAll<HTMLButtonElement>(".src-rm"))
    b.addEventListener("click", async () => {
      await removeScanDir(Number(b.dataset.id));
      S.scanDirs = await listScanDirs();
      renderSources();
    });
}

export function renderVerbMap() {
  const byCanon = new Map<string, string[]>();
  for (const [canon, syn] of S.verbMap) {
    if (!byCanon.has(canon)) byCanon.set(canon, []);
    byCanon.get(canon)!.push(syn);
  }
  const rows = [...byCanon.entries()]
    .sort()
    .map(
      ([canon, syns]) =>
        `<div class="verb-row"><b>${esc(canon)}</b> ` +
        syns.map((s) => `<span class="vchip">${esc(s)}<button class="vrm" data-syn="${esc(s)}">✕</button></span>`).join(" ") +
        `</div>`,
    )
    .join("");
  const promoteOptions = S.canonVerbList.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const govRows = S.uncanonicalVerbs.length
    ? S.uncanonicalVerbs
        .map(
          ([v, n]) =>
            `<div class="verb-row gov-row"><span class="chip warn">${esc(v)}</span> <span class="count">${n}</span> ` +
            `<select class="gov-sel dir-input" data-verb="${esc(v)}"><option value="">promote to…</option>${promoteOptions}<option value="__self__">＋ adopt as canonical</option></select></div>`,
        )
        .join("")
    : `<div class="nav-note">No uncanonical verbs — all classified verbs are canonical. ✓</div>`;
  const govBlock =
    `<details class="gov-details"><summary>Uncanonical verbs (${S.uncanonicalVerbs.length})</summary>` +
    `<div class="nav-note">Verbs on items outside the 13 canonical set. Promote maps the verb (as a synonym) then re-normalizes matching items.</div>` +
    `<div class="verb-list">${govRows}</div></details>`;

  verbmapEl.innerHTML =
    `<details><summary>Verb map (${S.verbMap.length})</summary><div class="verb-list">${rows}</div>` +
    `<div class="add-row"><input id="vc" class="dir-input" placeholder="Canonical" /><input id="vs" class="dir-input" placeholder="synonym" /></div>` +
    `<div class="add-row"><button id="vadd" class="add-btn">+ Add synonym</button>` +
    `<button id="vrenorm" class="add-btn" title="Re-map existing items through this verb map">Re-normalize items</button></div>` +
    govBlock +
    `</details>`;
  document.getElementById("vadd")!.addEventListener("click", async () => {
    const c = (document.getElementById("vc") as HTMLInputElement).value.trim();
    const s = (document.getElementById("vs") as HTMLInputElement).value.trim();
    if (!c || !s) return;
    await addSynonym(c, s);
    S.verbMap = await listVerbMap();
    renderVerbMap();
  });
  document.getElementById("vrenorm")!.addEventListener("click", async () => {
    try {
      const n = await renormalizeVerbs();
      await load();
      statusEl.textContent = `Re-normalized ${n} item verb(s) through the verb map.`;
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  });
  for (const b of verbmapEl.querySelectorAll<HTMLButtonElement>(".vrm"))
    b.addEventListener("click", async () => {
      await removeSynonym(b.dataset.syn!);
      S.verbMap = await listVerbMap();
      renderVerbMap();
    });
  // Promote an uncanonical verb: map it (as a synonym) to a canonical verb, or
  // adopt it as its own canonical, then re-normalize matching items.
  for (const sel of verbmapEl.querySelectorAll<HTMLSelectElement>(".gov-sel"))
    sel.addEventListener("change", async () => {
      const verb = sel.dataset.verb!;
      const choice = sel.value;
      if (!choice) return;
      const canonical = choice === "__self__" ? verb : choice;
      try {
        await addSynonym(canonical, verb);
        const n = await renormalizeVerbs();
        await load();
        statusEl.textContent = `Promoted "${verb}" → ${canonical}; re-normalized ${n} item verb(s).`;
      } catch (e) {
        statusEl.textContent = `Error: ${e}`;
      }
    });
}

