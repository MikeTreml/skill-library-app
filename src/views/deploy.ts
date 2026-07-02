import { deployStatus, listConflicts, pullFromLocation, pushAllToLocation, pushToLocation } from "../api";
import { deployEl, statusEl } from "../dom";
import { load } from "../main";
import { S } from "../state";
import { esc } from "../util";

// ---------- deploy (per-location map view) ----------
export async function renderDeploy() {
  deployEl.innerHTML = `<h2 class="dash-h">Deploy — locations</h2><p class="nav-note">Loading…</p>`;
  try {
    S.deployStatuses = await deployStatus();
  } catch (e) {
    deployEl.innerHTML = `<h2 class="dash-h">Deploy — locations</h2><p class="nav-note">Error: ${esc(String(e))}</p>`;
    return;
  }
  if (!S.deployStatuses.length) {
    deployEl.innerHTML =
      `<h2 class="dash-h">Deploy — locations</h2>` +
      `<p class="empty">No tracked locations yet — run <b>Scan &amp; import</b> first.</p>`;
    return;
  }
  const cards = S.deployStatuses
    .map((l) => {
      const healthy = l.drifted === 0 && l.missing === 0;
      return (
        `<div class="deploy-card${healthy ? "" : " warn"}">` +
        `<div class="deploy-card-head"><b>${esc(l.label)}</b><span class="pal-hint">${esc(l.root_path)}</span></div>` +
        `<div class="deploy-stats">` +
        `<span class="dstat ok">${l.in_sync} in sync</span>` +
        `<span class="dstat warn">${l.drifted} drifted</span>` +
        `<span class="dstat danger">${l.missing} missing</span>` +
        `<span class="dstat">${l.total} total</span>` +
        `</div>` +
        (healthy
          ? ""
          : `<button class="add-btn push-all" data-loc="${l.location_id}" title="Push library versions to every drifted/missing placement here (3-way conflicts are skipped)">Push all →</button>`) +
        `</div>`
      );
    })
    .join("");
  let conflicts: Awaited<ReturnType<typeof listConflicts>> = [];
  try {
    conflicts = await listConflicts();
  } catch {
    conflicts = [];
  }
  const conflictSection = conflicts.length
    ? `<h2 class="dash-h">⚠ Conflict inbox (${conflicts.length})</h2>` +
      `<p class="nav-note">Both the library copy and the deployed copy changed since the last sync. Choose which side wins for each — there's no safe automatic merge.</p>` +
      `<ul class="dash-list">` +
      conflicts
        .map(
          (c) =>
            `<li class="dash-cluster conflict-row"><b>${esc(c.item_name)}</b> ` +
            `<span class="chip warn">${esc(c.location_label)}</span> ` +
            `<span class="pal-hint">${esc(c.abs_path)}</span> ` +
            `<button class="add-btn cf-push" data-pid="${c.placement_id}" title="Overwrite the deployed copy with the library version">Keep library →</button>` +
            `<button class="add-btn cf-pull" data-pid="${c.placement_id}" title="Overwrite the library with the deployed version">← Keep deployed</button></li>`,
        )
        .join("") +
      `</ul>`
    : `<h2 class="dash-h">Conflict inbox</h2><p class="nav-note">No conflicts — every deployed copy can sync cleanly. ✓</p>`;

  deployEl.innerHTML =
    `<h2 class="dash-h">Deploy — locations (${S.deployStatuses.length})</h2>` +
    `<p class="nav-note">Bird's-eye sync status per tracked location. Open an item's detail pane (Browse) for the per-item diff/push/pull actions.</p>` +
    `<div class="deploy-grid">${cards}</div>` +
    conflictSection;
  const resolve = async (pid: number, keepLibrary: boolean) => {
    statusEl.textContent = "Resolving conflict…";
    try {
      if (keepLibrary) await pushToLocation(pid);
      else await pullFromLocation(pid);
      await load();
      renderDeploy();
      statusEl.textContent = keepLibrary ? "Kept library version." : "Kept deployed version.";
    } catch (e) {
      statusEl.textContent = `Error: ${e}`;
    }
  };
  for (const b of deployEl.querySelectorAll<HTMLButtonElement>(".cf-push"))
    b.addEventListener("click", () => resolve(Number(b.dataset.pid), true));
  for (const b of deployEl.querySelectorAll<HTMLButtonElement>(".cf-pull"))
    b.addEventListener("click", () => resolve(Number(b.dataset.pid), false));
  for (const b of deployEl.querySelectorAll<HTMLButtonElement>(".push-all"))
    b.addEventListener("click", async () => {
      b.disabled = true;
      statusEl.textContent = "Pushing all…";
      try {
        const [pushed, conflicts, ok] = await pushAllToLocation(Number(b.dataset.loc));
        await load();
        renderDeploy();
        statusEl.textContent =
          `Pushed ${pushed} item(s)` +
          (conflicts ? `, skipped ${conflicts} conflict(s) — resolve them below` : "") +
          (ok ? ` (${ok} already in sync)` : "") +
          ".";
      } catch (e) {
        b.disabled = false;
        statusEl.textContent = `Error: ${e}`;
      }
    });
}

