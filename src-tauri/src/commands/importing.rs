use super::*;

pub(crate) fn scan_and_import_location(
    conn: &rusqlite::Connection,
    library_root: &Path,
    label: &str,
    path: &Path,
    kind: LocationKind,
    summary: &mut crate::model::ImportSummary,
) -> Result<(), String> {
    let loc_id = db::upsert_location(conn, label, &path.to_string_lossy(), kind)
        .map_err(|e| e.to_string())?;
    let scanned = crate::scanner::scan_location(path, kind).map_err(|e| e.to_string())?;
    summary.locations_scanned += 1;
    for item in &scanned {
        importer::import_scanned(conn, library_root, loc_id, path, item, summary)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Pure import pipeline (no Tauri runtime needed): scan the default locations
/// under `home`, discover project-level `.claude/{agents,skills}` under `~/Repo`,
/// then optionally import the tarball.
pub fn import_all(
    conn: &rusqlite::Connection,
    library_root: &Path,
    home: &Path,
    tarball_path: Option<&Path>,
    report: &dyn Fn(String),
    is_cancelled: &dyn Fn() -> bool,
) -> Result<crate::model::ImportSummary, String> {
    let mut summary = crate::model::ImportSummary::default();

    let mut locations = default_location_candidates(home);
    locations.extend(discover_project_locations(&home.join("Repo")));
    for (label, path, kind) in locations {
        if is_cancelled() {
            summary.cancelled = true;
            return Ok(summary);
        }
        report(format!("Scanning {label}…"));
        scan_and_import_location(conn, library_root, &label, &path, kind, &mut summary)?;
    }

    // User-added scan directories, with type-aware custom detection + titling.
    for sd in db::list_scan_dirs(conn).map_err(|e| e.to_string())? {
        if is_cancelled() {
            summary.cancelled = true;
            return Ok(summary);
        }
        if !sd.enabled {
            continue;
        }
        let path = PathBuf::from(&sd.path);
        if !path.exists() {
            continue;
        }
        let label = format!(
            "{} ({})",
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("custom"),
            sd.item_type.as_str()
        );
        // Location kind is just for bookkeeping; scan_custom drives detection.
        let kind = if sd.item_type == ItemType::Agent {
            LocationKind::Agents
        } else {
            LocationKind::Project
        };
        let loc_id =
            db::upsert_location(conn, &label, &sd.path, kind).map_err(|e| e.to_string())?;
        let scanned =
            crate::scanner::scan_custom(&path, sd.item_type).map_err(|e| e.to_string())?;
        summary.locations_scanned += 1;
        for item in &scanned {
            importer::import_scanned(conn, library_root, loc_id, &path, item, &mut summary)
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(tarball) = tarball_path {
        if tarball.exists() {
            let loc_id = db::upsert_location(
                conn,
                "Inventory tarball",
                &tarball.to_string_lossy(),
                LocationKind::Tarball,
            )
            .map_err(|e| e.to_string())?;
            let staging = library_root.join("_staging");
            importer::import_tarball(
                conn,
                library_root,
                loc_id,
                tarball,
                &staging,
                &mut summary,
                &importer::ImportHooks {
                    report,
                    is_cancelled,
                },
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(summary)
}

/// Run the import on a blocking thread so the UI/event loop stays free and a
/// concurrent `cancel_import` can be honored. The `MutexGuard<Connection>` is
/// created and dropped entirely inside the synchronous `spawn_blocking` closure
/// (no `.await` inside it), so the connection never crosses an await point.
#[tauri::command]
pub async fn run_import(app: tauri::AppHandle) -> Result<crate::model::ImportSummary, String> {
    use std::sync::atomic::Ordering;
    use tauri::{Emitter, Manager};

    // Reject a second import while one is already running; reset the cancel flag.
    {
        let state = app.state::<AppState>();
        if state
            .import_running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err("An import is already running.".into());
        }
        state.import_cancel.store(false, Ordering::SeqCst);
    }

    let app2 = app.clone();
    let join = tauri::async_runtime::spawn_blocking(move || {
        // Re-fetch managed state ON this blocking thread (AppState is
        // Send + Sync + 'static — the only bound state::<T>() requires — so no
        // Arc<Mutex<…>> is needed; the `db` field stays a plain Mutex).
        let state = app2.state::<AppState>();
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let report = |msg: String| {
            let _ = app2.emit("import-progress", msg);
        };
        let is_cancelled = || state.import_cancel.load(Ordering::SeqCst);
        import_all(
            &conn,
            &state.library_root,
            &state.home,
            state.tarball_path.as_deref(),
            &report,
            &is_cancelled,
        )
        // `conn` (the guard) drops here, at the end of the closure.
    });

    // JoinHandle's Output is tauri::Result<T>; map the JoinError (e.g. a panic in
    // the blocking task) to a String. Whether the run was cancelled now travels in
    // ImportSummary.cancelled (set by import_all), so the awaited return value alone
    // tells the UI what happened — no terminal event, no event/return-order race.
    let result = join.await.map_err(|e| e.to_string());

    // Always clear the running flag (success, cancel, error, or panic).
    app.state::<AppState>()
        .import_running
        .store(false, Ordering::SeqCst);

    match result {
        Ok(inner) => inner,
        Err(join_err) => Err(join_err),
    }
}

/// Request cancellation of a running import. Flips an atomic only — never touches
/// the DB lock — so it returns instantly even while the import holds the connection.
#[tauri::command]
pub fn cancel_import(state: State<AppState>) {
    state
        .import_cancel
        .store(true, std::sync::atomic::Ordering::SeqCst);
}
