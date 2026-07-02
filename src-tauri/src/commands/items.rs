use super::*;

#[tauri::command]
pub fn list_items(state: State<AppState>) -> Result<Vec<Item>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_items(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_locations(state: State<AppState>) -> Result<Vec<Location>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_locations(&conn).map_err(|e| e.to_string())
}

/// The file to read/write for a library path: the file itself, or SKILL.md inside
/// a folder. Inferred from the path SHAPE (a `.md` library_path is a single-file
/// item; anything else is a skill folder) rather than from filesystem existence,
/// so it stays correct even when the target is temporarily missing.
pub(crate) fn library_file(library_path: &str) -> PathBuf {
    let p = Path::new(library_path);
    if p.extension().is_some_and(|e| e.eq_ignore_ascii_case("md")) {
        p.to_path_buf()
    } else {
        p.join("SKILL.md")
    }
}

pub(crate) fn read_library_content(library_path: &str) -> std::io::Result<String> {
    std::fs::read_to_string(library_file(library_path))
}

#[tauri::command]
pub fn get_item_content(state: State<AppState>, id: i64) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let path = db::item_library_path(&conn, id).map_err(|e| e.to_string())?;
    read_library_content(&path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct RefineResult {
    pub original: String,
    pub proposed: String,
}

#[tauri::command]
pub async fn refine_item(
    state: State<'_, AppState>,
    id: i64,
    directives: Vec<String>,
    tools_add: Vec<String>,
    tools_remove: Vec<String>,
) -> Result<RefineResult, String> {
    let api_key = resolve_api_key(&state)
        .ok_or("No API key set (add one in Settings or set OPENAI_API_KEY)")?;
    let path = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::item_library_path(&conn, id).map_err(|e| e.to_string())?
    };
    let original = read_library_content(&path).map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    let proposed = ai::refine(
        &client,
        &api_key,
        &original,
        &directives,
        &tools_add,
        &tools_remove,
    )
    .await?;
    Ok(RefineResult { original, proposed })
}

#[tauri::command]
pub fn apply_refinement(state: State<AppState>, id: i64, content: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let path = db::item_library_path(&conn, id).map_err(|e| e.to_string())?;
    let file = library_file(&path);
    // Back up the current content (outside the item folder, so it doesn't affect the hash).
    let backups = state.library_root.join("_refine_backups");
    std::fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    if let Ok(prev) = std::fs::read(&file) {
        let _ = std::fs::write(backups.join(format!("{id}.bak")), prev);
    }
    std::fs::write(&file, &content).map_err(|e| e.to_string())?;
    let new_hash = crate::hash::hash_path(Path::new(&path)).map_err(|e| e.to_string())?;
    db::set_canonical_hash(&conn, id, &new_hash).map_err(|e| e.to_string())?;
    Ok(())
}

/// True when a refine backup exists for this item (enables the "Revert refine" UI).
#[tauri::command]
pub fn has_refine_backup(state: State<AppState>, id: i64) -> Result<bool, String> {
    Ok(state
        .library_root
        .join("_refine_backups")
        .join(format!("{id}.bak"))
        .exists())
}

/// Undo the last applied refinement: restore the `_refine_backups/{id}.bak` content
/// into the library file. The pre-revert content is written back into the backup slot,
/// so revert is itself revertable (it toggles between the two versions).
#[tauri::command]
pub fn revert_refine(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let path = db::item_library_path(&conn, id).map_err(|e| e.to_string())?;
    let file = library_file(&path);
    let bak = state
        .library_root
        .join("_refine_backups")
        .join(format!("{id}.bak"));
    let backup =
        std::fs::read(&bak).map_err(|_| "No refine backup exists for this item".to_string())?;
    let current = std::fs::read(&file).map_err(|e| e.to_string())?;
    std::fs::write(&file, &backup).map_err(|e| e.to_string())?;
    let _ = std::fs::write(&bak, current); // swap: allows toggling back
    let new_hash = crate::hash::hash_path(Path::new(&path)).map_err(|e| e.to_string())?;
    db::set_canonical_hash(&conn, id, &new_hash).map_err(|e| e.to_string())?;
    let name = db::item_name(&conn, id).map_err(|e| e.to_string())?;
    let _ = db::log_activity(&conn, "refine", &format!("Reverted refine on \"{name}\""));
    Ok(())
}

#[derive(serde::Serialize)]
pub struct MergeSource {
    pub id: i64,
    pub name: String,
}

#[derive(serde::Serialize)]
pub struct MergeResult {
    pub proposed: String,
    pub sources: Vec<MergeSource>,
}

#[tauri::command]
pub async fn merge_items(state: State<'_, AppState>, ids: Vec<i64>) -> Result<MergeResult, String> {
    let api_key = resolve_api_key(&state)
        .ok_or("No API key set (add one in Settings or set OPENAI_API_KEY)")?;
    let metas: Vec<(i64, String, String)> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let items = db::list_items(&conn).map_err(|e| e.to_string())?;
        ids.iter()
            .filter_map(|id| {
                items
                    .iter()
                    .find(|i| i.id == *id)
                    .map(|i| (i.id, i.name.clone(), i.library_path.clone()))
            })
            .collect()
    };
    if metas.len() < 2 {
        return Err("Select at least two items to merge.".into());
    }
    let mut pairs = Vec::new();
    let mut sources = Vec::new();
    for (id, name, path) in &metas {
        let content = read_library_content(path).map_err(|e| e.to_string())?;
        pairs.push((name.clone(), content));
        sources.push(MergeSource {
            id: *id,
            name: name.clone(),
        });
    }
    let proposed = ai::merge(&reqwest::Client::new(), &api_key, &pairs).await?;
    Ok(MergeResult { proposed, sources })
}

/// Create a brand-new library item from markdown content; returns its id.
pub(crate) fn create_item_from_content(
    conn: &rusqlite::Connection,
    library_root: &Path,
    item_type: ItemType,
    name: &str,
    content: &str,
) -> Result<i64, String> {
    let base_slug = {
        let s = crate::slug::slugify(name);
        if s.is_empty() {
            "item".to_string()
        } else {
            s
        }
    };
    // CRITICAL: never reuse an existing slug. The slug maps 1:1 to a library path,
    // so writing to a taken slug would overwrite another item's library copy (and
    // insert_item_if_absent would return that item's id). Pick a fresh slug first.
    let slug = db::unique_slug(conn, item_type, &base_slug).map_err(|e| e.to_string())?;
    let base = library_root
        .join("_uncategorized")
        .join(item_type.as_str())
        .join(&slug);
    let (file, library_path) = if item_type == ItemType::Agent {
        (
            base.join(format!("{slug}.md")),
            base.join(format!("{slug}.md")),
        )
    } else {
        (base.join("SKILL.md"), base.clone())
    };
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&file, content).map_err(|e| e.to_string())?;
    let hash = crate::hash::hash_path(&library_path).map_err(|e| e.to_string())?;
    let desc = crate::meta::parse_meta(content).description;
    let (id, was_new) = db::insert_item_if_absent(
        conn,
        item_type,
        name,
        &slug,
        &desc,
        &hash,
        &library_path.to_string_lossy(),
    )
    .map_err(|e| e.to_string())?;
    // unique_slug guarantees this; assert so a future regression can't silently
    // return (and then delete) an existing item's id.
    if !was_new {
        return Err("internal error: merged/new item slug was not unique".into());
    }
    Ok(id)
}

pub(crate) fn deleted_backup_dir(library_root: &Path, id: i64) -> PathBuf {
    library_root.join("_deleted_backups").join(id.to_string())
}

/// Move `src` (file or dir) to `dst`, replacing `dst`. Falls back to copy+remove
/// if a plain rename fails (e.g. across volumes).
pub(crate) fn move_path(src: &Path, dst: &Path) -> Result<(), String> {
    if dst.is_dir() {
        std::fs::remove_dir_all(dst).ok();
    } else if dst.is_file() {
        std::fs::remove_file(dst).ok();
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    crate::importer::copy_tree(src, dst).map_err(|e| e.to_string())?;
    if src.is_dir() {
        std::fs::remove_dir_all(src).ok();
    } else {
        std::fs::remove_file(src).ok();
    }
    Ok(())
}

/// Soft-delete (tombstone) an item: move its library copy into `_deleted_backups`
/// (recoverable) and mark the DB record deleted so re-import won't resurrect it.
pub(crate) fn tombstone_item(
    conn: &rusqlite::Connection,
    library_root: &Path,
    id: i64,
) -> Result<(), String> {
    let lib_path = db::item_library_path(conn, id).map_err(|e| e.to_string())?;
    let src = Path::new(&lib_path);
    if src.exists() {
        let backup = deleted_backup_dir(library_root, id);
        std::fs::remove_dir_all(&backup).ok();
        std::fs::create_dir_all(&backup).map_err(|e| e.to_string())?;
        let base = src.file_name().ok_or("bad library path")?;
        move_path(src, &backup.join(base))?;
    }
    db::set_deleted(conn, id, true).map_err(|e| e.to_string())?;
    Ok(())
}

/// Undo a tombstone: move the library copy back and clear the deleted flag.
pub(crate) fn restore_item(
    conn: &rusqlite::Connection,
    library_root: &Path,
    id: i64,
) -> Result<(), String> {
    let lib_path = db::item_library_path(conn, id).map_err(|e| e.to_string())?;
    let dst = Path::new(&lib_path);
    let base = dst.file_name().ok_or("bad library path")?;
    let backup = deleted_backup_dir(library_root, id).join(base);
    if backup.exists() {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        move_path(&backup, dst)?;
        std::fs::remove_dir_all(deleted_backup_dir(library_root, id)).ok();
    }
    db::set_deleted(conn, id, false).map_err(|e| e.to_string())?;
    Ok(())
}

/// Save a merged file as a NEW library item. mode "replace" archives the sources;
/// mode "delete" tombstones them (recoverable, kept out of re-import).
#[tauri::command]
pub fn save_merge(
    state: State<AppState>,
    ids: Vec<i64>,
    content: String,
    name: String,
    mode: String,
) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let type_str =
        db::item_type(&conn, *ids.first().ok_or("no sources")?).map_err(|e| e.to_string())?;
    let item_type = ItemType::parse(&type_str).unwrap_or(ItemType::Skill);
    let id = create_item_from_content(&conn, &state.library_root, item_type, &name, &content)?;
    // Never touch the freshly-created merged item, even if it somehow shares an id.
    let sources = ids.iter().copied().filter(|sid| *sid != id);
    match mode.as_str() {
        "replace" => {
            for sid in sources {
                db::set_archived(&conn, sid, true).map_err(|e| e.to_string())?;
            }
        }
        "delete" => {
            for sid in sources {
                tombstone_item(&conn, &state.library_root, sid)?;
            }
        }
        _ => {}
    }
    let _ = db::log_activity(
        &conn,
        "merge",
        &format!(
            "Merged {} source(s) into \"{}\" ({})",
            ids.len(),
            name,
            mode
        ),
    );
    Ok(id)
}

/// Save a refinement as a NEW item (keeps the original intact).
#[tauri::command]
pub fn apply_refinement_as_new(
    state: State<AppState>,
    id: i64,
    content: String,
    name: String,
) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let type_str = db::item_type(&conn, id).map_err(|e| e.to_string())?;
    let item_type = ItemType::parse(&type_str).unwrap_or(ItemType::Skill);
    create_item_from_content(&conn, &state.library_root, item_type, &name, &content)
}

#[tauri::command]
pub fn archive_item(state: State<AppState>, id: i64, archived: bool) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::set_archived(&conn, id, archived).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_archived(state: State<AppState>) -> Result<Vec<Item>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_archived(&conn).map_err(|e| e.to_string())
}

/// Soft-delete (tombstone) items: library copies move to `_deleted_backups`
/// (recoverable via the Deleted view) and re-import will skip them.
#[tauri::command]
pub fn delete_items(state: State<AppState>, ids: Vec<i64>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    for id in &ids {
        tombstone_item(&conn, &state.library_root, *id)?;
    }
    if !ids.is_empty() {
        let _ = db::log_activity(&conn, "delete", &format!("Deleted {} item(s)", ids.len()));
    }
    Ok(())
}

#[tauri::command]
pub fn restore_deleted(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    restore_item(&conn, &state.library_root, id)
}

#[tauri::command]
pub fn list_deleted(state: State<AppState>) -> Result<Vec<Item>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::list_deleted(&conn).map_err(|e| e.to_string())
}
