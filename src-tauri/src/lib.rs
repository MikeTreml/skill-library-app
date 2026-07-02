mod ai;
mod commands;
pub mod db;
pub mod dedup;
mod hash;
mod importer;
mod meta;
mod model;
mod scanner;
mod slug;
pub mod taxonomy;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let home = dirs::home_dir().expect("home dir");
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app data dir")
                .join("skill-library");
            let library_root = data_dir.join("library");
            std::fs::create_dir_all(&library_root).expect("create library dir");
            let conn = db::open(&data_dir.join("catalog.db")).expect("open db");

            // The bundled inventory tarball, if present in the repo.
            let tarball_path = home.join("Repo/skills/skills-inventory/skills-deduped.tar.gz");
            let tarball_path = if tarball_path.exists() {
                Some(tarball_path)
            } else {
                None
            };

            app.manage(commands::AppState {
                db: std::sync::Mutex::new(conn),
                library_root,
                home,
                tarball_path,
                import_cancel: std::sync::atomic::AtomicBool::new(false),
                import_running: std::sync::atomic::AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::items::list_items,
            commands::items::list_locations,
            commands::importing::run_import,
            commands::importing::cancel_import,
            commands::items::get_item_content,
            commands::catalog::list_scan_dirs,
            commands::catalog::add_scan_dir,
            commands::catalog::remove_scan_dir,
            commands::ai_cmds::ai_available,
            commands::ai_cmds::classify_all,
            commands::catalog::list_duplicates,
            commands::catalog::dismiss_cluster,
            commands::catalog::undismiss_cluster,
            commands::catalog::list_dismissed_clusters,
            commands::catalog::add_item_tag,
            commands::catalog::remove_item_tag,
            commands::catalog::list_item_tags,
            commands::catalog::list_all_tags,
            commands::catalog::list_uncanonical_verbs,
            commands::catalog::canonical_verbs,
            commands::catalog::recent_activity,
            commands::catalog::export_items,
            commands::ai_cmds::set_api_key,
            commands::ai_cmds::api_key_status,
            commands::catalog::mark_used,
            commands::catalog::deletion_candidates,
            commands::catalog::is_onboarded,
            commands::catalog::set_onboarded,
            commands::deploy::list_conflicts,
            commands::catalog::list_verb_map,
            commands::catalog::add_synonym,
            commands::catalog::remove_synonym,
            commands::catalog::renormalize_verbs,
            commands::items::refine_item,
            commands::items::apply_refinement,
            commands::items::apply_refinement_as_new,
            commands::items::merge_items,
            commands::items::save_merge,
            commands::items::archive_item,
            commands::items::list_archived,
            commands::items::delete_items,
            commands::items::restore_deleted,
            commands::items::list_deleted,
            commands::deploy::item_sync,
            commands::deploy::deploy_status,
            commands::deploy::read_placement,
            commands::deploy::push_to_location,
            commands::deploy::push_all_to_location,
            commands::deploy::pull_from_location,
            commands::items::has_refine_backup,
            commands::items::revert_refine,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
