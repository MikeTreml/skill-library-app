use super::*;

#[tauri::command]
pub fn list_scan_dirs(state: State<AppState>) -> Result<Vec<ScanDir>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_scan_dirs(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_scan_dir(
    state: State<AppState>,
    path: String,
    item_type: ItemType,
) -> Result<(), String> {
    if !Path::new(&path).is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::add_scan_dir(&conn, &path, item_type).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_scan_dir(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::remove_scan_dir(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_duplicates(state: State<AppState>) -> Result<Vec<crate::dedup::DupGroup>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let items = db::list_items(&conn).map_err(|e| e.to_string())?;
    let dismissed = db::list_dismissed_clusters(&conn).map_err(|e| e.to_string())?;
    Ok(crate::dedup::group_duplicates(&items)
        .into_iter()
        .filter(|g| !dismissed.contains(&g.key))
        .collect())
}

/// Persistently dismiss a Triage cluster ("not actually a duplicate") so it survives
/// app restarts — the durable follow-up to the session-only client-side dismiss.
#[tauri::command]
pub fn dismiss_cluster(state: State<AppState>, cluster_key: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::dismiss_cluster(&conn, &cluster_key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn undismiss_cluster(state: State<AppState>, cluster_key: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::undismiss_cluster(&conn, &cluster_key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_dismissed_clusters(state: State<AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db::list_dismissed_clusters(&conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect())
}

// ---- user-defined tags ----

#[tauri::command]
pub fn add_item_tag(state: State<AppState>, id: i64, tag: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::add_item_tag(&conn, id, &tag).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_item_tag(state: State<AppState>, id: i64, tag: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::remove_item_tag(&conn, id, &tag).map_err(|e| e.to_string())
}

/// (item_id, tag) pairs for building an id→tags map on the frontend.
#[tauri::command]
pub fn list_item_tags(state: State<AppState>) -> Result<Vec<(i64, String)>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_item_tags(&conn).map_err(|e| e.to_string())
}

/// Distinct tag names with item counts, for the sidebar tag filter.
#[tauri::command]
pub fn list_all_tags(state: State<AppState>) -> Result<Vec<(String, i64)>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_all_tags(&conn).map_err(|e| e.to_string())
}

/// Verbs currently on items that are NOT one of the 13 canonical verbs — the
/// verb-governance UI lists these (with counts) so the user can promote one by
/// mapping it to a canonical verb (add_synonym) or adopting it as a new
/// canonical (add_synonym with itself as canonical). Case-insensitive check.
#[tauri::command]
pub fn list_uncanonical_verbs(state: State<AppState>) -> Result<Vec<(String, i64)>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let all = db::distinct_verbs_with_counts(&conn).map_err(|e| e.to_string())?;
    Ok(all
        .into_iter()
        .filter(|(v, _)| {
            !crate::taxonomy::CANONICAL_VERBS
                .iter()
                .any(|c| c.eq_ignore_ascii_case(v))
        })
        .collect())
}

/// The 13 canonical verbs, for the "promote to" dropdown in the governance UI.
#[tauri::command]
pub fn canonical_verbs() -> Vec<&'static str> {
    crate::taxonomy::CANONICAL_VERBS.to_vec()
}

/// Recent activity-log entries for the Dashboard feed: (id, kind, summary, created_at).
#[tauri::command]
pub fn recent_activity(
    state: State<AppState>,
) -> Result<Vec<(i64, String, String, String)>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::recent_activity(&conn, 30).map_err(|e| e.to_string())
}

/// Export the selected items' library folders into a single `.tar.gz` at `dest_path`,
/// each under a top-level directory named by the item's slug (a shareable bundle
/// that another machine can drop into a scan dir and re-import). Read-only on the
/// library; never mutates source or library files. Returns the number of items written.
#[tauri::command]
pub fn export_items(
    state: State<AppState>,
    ids: Vec<i64>,
    dest_path: String,
) -> Result<usize, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if ids.is_empty() {
        return Err("No items selected to export.".into());
    }
    let mut paths = Vec::new();
    for id in &ids {
        paths.push(db::item_library_path(&conn, *id).map_err(|e| e.to_string())?);
    }
    let written = write_export_archive(&paths, Path::new(&dest_path))?;
    let _ = db::log_activity(
        &conn,
        "export",
        &format!("Exported {written} item(s) to {dest_path}"),
    );
    Ok(written)
}

/// Testable core of `export_items`: write each existing library path (file or folder)
/// into a gzipped tar at `dest`, under a top-level entry named by the path's own
/// basename. Returns how many existing paths were written (missing paths skipped).
pub(crate) fn write_export_archive(lib_paths: &[String], dest: &Path) -> Result<usize, String> {
    use flate2::{write::GzEncoder, Compression};
    let file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut tar = tar::Builder::new(GzEncoder::new(file, Compression::default()));
    let mut written = 0usize;
    for p in lib_paths {
        let src = Path::new(p);
        if !src.exists() {
            continue;
        }
        let base = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "item".to_string());
        if src.is_dir() {
            tar.append_dir_all(&base, src).map_err(|e| e.to_string())?;
        } else {
            let mut f = std::fs::File::open(src).map_err(|e| e.to_string())?;
            tar.append_file(&base, &mut f).map_err(|e| e.to_string())?;
        }
        written += 1;
    }
    tar.into_inner()
        .map_err(|e| e.to_string())?
        .finish()
        .map_err(|e| e.to_string())?;
    Ok(written)
}

/// Record a manual "mark as used" for an item (usage/staleness tracking).
#[tauri::command]
pub fn mark_used(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::mark_item_used(&conn, id).map_err(|e| e.to_string())
}

/// Live items never marked used — the "candidates for deletion" review queue.
#[tauri::command]
pub fn deletion_candidates(state: State<AppState>) -> Result<Vec<Item>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::never_used_items(&conn).map_err(|e| e.to_string())
}

/// Whether the first-run onboarding wizard has been completed (settings flag).
#[tauri::command]
pub fn is_onboarded(state: State<AppState>) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    Ok(db::get_setting(&conn, "onboarded")
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some("1"))
}

/// Mark the onboarding wizard as completed so it won't show again.
#[tauri::command]
pub fn set_onboarded(state: State<AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::set_setting(&conn, "onboarded", "1").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_verb_map(state: State<AppState>) -> Result<Vec<(String, String)>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_verb_map(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn add_synonym(
    state: State<AppState>,
    canonical: String,
    synonym: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::add_synonym(&conn, &canonical, &synonym).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_synonym(state: State<AppState>, synonym: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::remove_synonym(&conn, &synonym).map_err(|e| e.to_string())
}

/// Re-map every classified item's verb through the current verb map; returns how many changed.
#[tauri::command]
pub fn renormalize_verbs(state: State<AppState>) -> Result<u32, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let map = db::verb_lookup(&conn).map_err(|e| e.to_string())?;
    let mut changed = 0u32;
    for it in db::list_items(&conn).map_err(|e| e.to_string())? {
        if let Some(v) = &it.verb {
            if let Some(canon) = map.get(&v.to_ascii_lowercase()) {
                if canon != v {
                    db::set_verb(&conn, it.id, canon).map_err(|e| e.to_string())?;
                    changed += 1;
                }
            }
        }
    }
    Ok(changed)
}
