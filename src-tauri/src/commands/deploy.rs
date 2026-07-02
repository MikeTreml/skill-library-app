use super::*;

// ---- Milestone 5: sync & deploy ----

pub(crate) fn placement_abs(root_path: &str, rel_path: &str) -> PathBuf {
    Path::new(root_path).join(rel_path)
}

/// Compare a location target's current content to the library's canonical hash.
pub(crate) fn sync_status(canonical_hash: &str, abs: &Path) -> String {
    if !abs.exists() {
        return "missing".to_string();
    }
    match crate::hash::hash_path(abs) {
        Ok(h) if h == canonical_hash => "in_sync".to_string(),
        Ok(_) => "drifted".to_string(),
        Err(_) => "error".to_string(),
    }
}

/// Replace `dst` (file or dir) with a copy of `src`.
pub(crate) fn copy_over(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.is_dir() {
        std::fs::remove_dir_all(dst).map_err(|e| e.to_string())?;
    } else if dst.exists() {
        std::fs::remove_file(dst).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    importer::copy_tree(src, dst).map_err(|e| e.to_string())
}

/// Back up whatever is at `target` into the library's `_sync_backups` (one slot per placement).
pub(crate) fn backup_before_overwrite(
    library_root: &Path,
    placement_id: i64,
    target: &Path,
) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    let dir = library_root
        .join("_sync_backups")
        .join(placement_id.to_string());
    if dir.exists() {
        std::fs::remove_dir_all(&dir).ok();
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "backup".to_string());
    importer::copy_tree(target, &dir.join(name)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn item_sync(
    state: State<AppState>,
    id: i64,
) -> Result<Vec<crate::model::PlacementInfo>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let canonical = db::item_canonical_hash(&conn, id).map_err(|e| e.to_string())?;
    let places = db::placements_for_item(&conn, id).map_err(|e| e.to_string())?;
    Ok(places
        .into_iter()
        .map(|(pid, label, root, rel)| {
            let abs = placement_abs(&root, &rel);
            crate::model::PlacementInfo {
                id: pid,
                location_label: label,
                status: sync_status(&canonical, &abs),
                abs_path: abs.to_string_lossy().to_string(),
            }
        })
        .collect())
}

/// Deploy mode "map view": one row per location with counts of in_sync / drifted /
/// missing placements, computed fresh (recomputes each placement's status against
/// its item's current canonical hash — same status derivation `item_sync` uses,
/// just aggregated instead of per-item).
#[tauri::command]
pub fn deploy_status(
    state: State<AppState>,
) -> Result<Vec<crate::model::LocationDeployStatus>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let rows = db::all_placements_with_hash(&conn).map_err(|e| e.to_string())?;

    let mut by_location: std::collections::BTreeMap<i64, (String, String, u32, u32, u32)> =
        std::collections::BTreeMap::new();
    for (_pid, loc_id, label, root, rel, canonical_hash) in rows {
        let abs = placement_abs(&root, &rel);
        let status = sync_status(&canonical_hash, &abs);
        let entry = by_location
            .entry(loc_id)
            .or_insert_with(|| (label.clone(), root.clone(), 0, 0, 0));
        match status.as_str() {
            "in_sync" => entry.2 += 1,
            "missing" => entry.4 += 1,
            _ => entry.3 += 1, // drifted or error
        }
    }

    Ok(by_location
        .into_iter()
        .map(
            |(location_id, (label, root_path, in_sync, drifted, missing))| {
                crate::model::LocationDeployStatus {
                    location_id,
                    label,
                    root_path,
                    in_sync,
                    drifted,
                    missing,
                    total: in_sync + drifted + missing,
                }
            },
        )
        .collect())
}

/// The Deploy-mode "conflict inbox": placements where BOTH the library copy and the
/// on-disk deployed copy diverged from the last-common-sync baseline (`location_hash`),
/// and now differ from each other — so neither a plain push nor pull is safe. The user
/// resolves each by explicitly choosing a side (push_to_location / pull_from_location).
#[tauri::command]
pub fn list_conflicts(state: State<AppState>) -> Result<Vec<crate::model::Conflict>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let rows = db::placements_for_conflict_check(&conn).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (pid, label, root, rel, canonical, baseline) in rows {
        let abs = placement_abs(&root, &rel);
        if !abs.exists() {
            continue; // missing target isn't a 3-way conflict (handled by normal sync)
        }
        let disk = match crate::hash::hash_path(&abs) {
            Ok(h) => h,
            Err(_) => continue,
        };
        // 3-way conflict: disk changed from baseline, library changed from baseline,
        // and the two now disagree. If either side still matches the baseline, a plain
        // pull or push resolves it cleanly — not a conflict.
        if is_three_way_conflict(&baseline, &canonical, &disk) {
            let (item_id, _, _) = db::placement_paths(&conn, pid).map_err(|e| e.to_string())?;
            let item_name = db::item_name(&conn, item_id).map_err(|e| e.to_string())?;
            out.push(crate::model::Conflict {
                placement_id: pid,
                item_name,
                location_label: label,
                abs_path: abs.to_string_lossy().to_string(),
            });
        }
    }
    Ok(out)
}

/// True when both the library copy and the deployed copy diverged from the last-common
/// baseline AND now differ from each other — the only case where neither a plain push
/// nor pull is safe. Pure decision (no I/O), so it's unit-testable in isolation.
pub(crate) fn is_three_way_conflict(baseline: &str, library: &str, disk: &str) -> bool {
    library != baseline && disk != baseline && library != disk
}

#[tauri::command]
pub fn read_placement(state: State<AppState>, placement_id: i64) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let (_item, root, rel) = db::placement_paths(&conn, placement_id).map_err(|e| e.to_string())?;
    read_library_content(&placement_abs(&root, &rel).to_string_lossy()).map_err(|e| e.to_string())
}

/// Per-placement push mechanics shared by `push_to_location` and
/// `push_all_to_location`: back up whatever is at the target, copy the library
/// copy over it, and record the placement as in_sync at the item's canonical hash.
pub(crate) fn push_placement(
    conn: &rusqlite::Connection,
    library_root: &Path,
    placement_id: i64,
    item_id: i64,
    abs: &Path,
) -> Result<(), String> {
    let lib_path = db::item_library_path(conn, item_id).map_err(|e| e.to_string())?;
    backup_before_overwrite(library_root, placement_id, abs)?;
    copy_over(Path::new(&lib_path), abs)?;
    let canonical = db::item_canonical_hash(conn, item_id).map_err(|e| e.to_string())?;
    db::update_placement_sync(conn, placement_id, &canonical, "in_sync").map_err(|e| e.to_string())
}

/// Push the library copy OUT to the location (location := library); backs up the location first.
#[tauri::command]
pub fn push_to_location(state: State<AppState>, placement_id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let (item_id, root, rel) =
        db::placement_paths(&conn, placement_id).map_err(|e| e.to_string())?;
    let abs = placement_abs(&root, &rel);
    push_placement(&conn, &state.library_root, placement_id, item_id, &abs)
}

/// Deploy-mode batch push: push the library copy out to EVERY placement of one
/// location, except placements that are already in sync (skipped_ok) or in a
/// genuine 3-way conflict (skipped_conflicts — never overwritten; the conflict
/// inbox resolves those explicitly). Returns (pushed, skipped_conflicts, skipped_ok).
#[tauri::command]
pub fn push_all_to_location(
    state: State<AppState>,
    location_id: i64,
) -> Result<(u32, u32, u32), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    push_all_placements(&conn, &state.library_root, location_id)
}

/// Testable core of `push_all_to_location` (no Tauri runtime needed).
pub(crate) fn push_all_placements(
    conn: &rusqlite::Connection,
    library_root: &Path,
    location_id: i64,
) -> Result<(u32, u32, u32), String> {
    let rows = db::placements_for_conflict_check_by_location(conn, location_id)
        .map_err(|e| e.to_string())?;
    let (mut pushed, mut skipped_conflicts, mut skipped_ok) = (0u32, 0u32, 0u32);
    for (pid, _label, root, rel, canonical, baseline) in rows {
        let abs = placement_abs(&root, &rel);
        match sync_status(&canonical, &abs).as_str() {
            "in_sync" => {
                skipped_ok += 1;
                continue;
            }
            "missing" => {} // no disk copy to conflict with — push fills the gap
            _ => {
                // Drifted (or unreadable): only push if it is NOT a 3-way conflict,
                // i.e. the deployed copy is still clean relative to the baseline.
                let disk = match crate::hash::hash_path(&abs) {
                    Ok(h) => h,
                    Err(e) => return Err(e.to_string()),
                };
                if is_three_way_conflict(&baseline, &canonical, &disk) {
                    skipped_conflicts += 1;
                    continue;
                }
            }
        }
        let (item_id, _, _) = db::placement_paths(conn, pid).map_err(|e| e.to_string())?;
        push_placement(conn, library_root, pid, item_id, &abs)?;
        pushed += 1;
    }
    let label = db::location_label(conn, location_id).map_err(|e| e.to_string())?;
    let _ = db::log_activity(
        conn,
        "deploy",
        &format!("Pushed {pushed} item(s) to {label} ({skipped_conflicts} conflicts skipped)"),
    );
    Ok((pushed, skipped_conflicts, skipped_ok))
}

/// Pull the location copy INTO the library (library := location); backs up the library first.
#[tauri::command]
pub fn pull_from_location(state: State<AppState>, placement_id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let (item_id, root, rel) =
        db::placement_paths(&conn, placement_id).map_err(|e| e.to_string())?;
    let abs = placement_abs(&root, &rel);
    if !abs.exists() {
        return Err("location copy is missing".into());
    }
    let lib_path = db::item_library_path(&conn, item_id).map_err(|e| e.to_string())?;
    backup_before_overwrite(&state.library_root, placement_id, Path::new(&lib_path))?;
    copy_over(&abs, Path::new(&lib_path))?;
    let new_hash = crate::hash::hash_path(Path::new(&lib_path)).map_err(|e| e.to_string())?;
    db::set_canonical_hash(&conn, item_id, &new_hash).map_err(|e| e.to_string())?;
    db::update_placement_sync(&conn, placement_id, &new_hash, "in_sync").map_err(|e| e.to_string())
}
