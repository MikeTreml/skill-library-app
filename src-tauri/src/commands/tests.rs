
use super::*;
use std::fs;

#[test]
fn returns_only_existing_paths() {
    let home = tempfile::tempdir().unwrap();
    fs::create_dir_all(home.path().join(".claude/skills")).unwrap();
    let cands = default_location_candidates(home.path());
    assert_eq!(cands.len(), 1);
    assert_eq!(cands[0].2, LocationKind::ClaudeSkills);
}

#[test]
fn export_archive_bundles_folders_and_skips_missing() {
    use flate2::read::GzDecoder;
    let d = tempfile::tempdir().unwrap();
    // One real skill folder with a SKILL.md, one missing path.
    let skill = d.path().join("my-skill");
    fs::create_dir_all(&skill).unwrap();
    fs::write(skill.join("SKILL.md"), "BODY").unwrap();
    let missing = d.path().join("gone");

    let dest = d.path().join("out.tar.gz");
    let n = write_export_archive(
        &[
            skill.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ],
        &dest,
    )
    .unwrap();
    assert_eq!(n, 1); // missing path skipped

    // The archive round-trips: unpack and confirm the folder+file landed under its basename.
    let unpack = d.path().join("unpacked");
    fs::create_dir_all(&unpack).unwrap();
    let f = fs::File::open(&dest).unwrap();
    tar::Archive::new(GzDecoder::new(f))
        .unpack(&unpack)
        .unwrap();
    assert_eq!(
        fs::read_to_string(unpack.join("my-skill/SKILL.md")).unwrap(),
        "BODY"
    );
}

#[test]
fn read_library_content_handles_file_and_folder() {
    let d = tempfile::tempdir().unwrap();
    let folder = d.path().join("skillfolder");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("SKILL.md"), "FOLDER BODY").unwrap();
    assert_eq!(
        read_library_content(folder.to_str().unwrap()).unwrap(),
        "FOLDER BODY"
    );
    let f = d.path().join("agent.md");
    fs::write(&f, "FILE BODY").unwrap();
    assert_eq!(
        read_library_content(f.to_str().unwrap()).unwrap(),
        "FILE BODY"
    );
}

#[test]
fn three_way_conflict_only_when_both_sides_diverge() {
    // Neither side changed → no conflict.
    assert!(!is_three_way_conflict("base", "base", "base"));
    // Only the library changed → a plain push resolves it, not a conflict.
    assert!(!is_three_way_conflict("base", "lib", "base"));
    // Only the disk changed → a plain pull resolves it, not a conflict.
    assert!(!is_three_way_conflict("base", "base", "disk"));
    // Both changed but landed on the SAME content → already agree, not a conflict.
    assert!(!is_three_way_conflict("base", "same", "same"));
    // Both changed and now disagree → genuine 3-way conflict.
    assert!(is_three_way_conflict("base", "lib", "disk"));
}

#[test]
fn sync_status_detects_states() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("a.md");
    fs::write(&f, "hello").unwrap();
    let h = crate::hash::hash_path(&f).unwrap();
    assert_eq!(sync_status(&h, &f), "in_sync");
    fs::write(&f, "changed").unwrap();
    assert_eq!(sync_status(&h, &f), "drifted");
    assert_eq!(sync_status(&h, &d.path().join("missing.md")), "missing");
}

#[test]
fn push_all_pushes_missing_and_clean_drift_but_skips_conflicts_and_in_sync() {
    let lib = tempfile::tempdir().unwrap();
    let loc = tempfile::tempdir().unwrap();
    let conn = db::open_in_memory().unwrap();
    let loc_id = db::upsert_location(
        &conn,
        "Test loc",
        loc.path().to_str().unwrap(),
        LocationKind::ClaudeSkills,
    )
    .unwrap();

    // A library skill folder with SKILL.md content → (item_id, canonical_hash).
    let mk_item = |slug: &str, content: &str| -> (i64, String) {
        let folder = lib.path().join(slug);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), content).unwrap();
        let hash = crate::hash::hash_path(&folder).unwrap();
        let (id, _) = db::insert_item_if_absent(
            &conn,
            ItemType::Skill,
            slug,
            slug,
            "d",
            &hash,
            folder.to_str().unwrap(),
        )
        .unwrap();
        (id, hash)
    };

    // 1) Missing target: library copy exists, nothing deployed yet → push.
    let (missing_id, missing_hash) = mk_item("missing-item", "LIB MISSING");
    db::upsert_placement(
        &conn,
        missing_id,
        loc_id,
        "missing-item",
        &missing_hash,
        "missing",
    )
    .unwrap();

    // 2) Stale with clean baseline: disk still matches the recorded baseline,
    //    only the library moved on → safe to push.
    let (stale_id, _) = mk_item("stale-item", "LIB NEW");
    let stale_disk = loc.path().join("stale-item");
    fs::create_dir_all(&stale_disk).unwrap();
    fs::write(stale_disk.join("SKILL.md"), "OLD DEPLOYED").unwrap();
    let old_baseline = crate::hash::hash_path(&stale_disk).unwrap();
    db::upsert_placement(
        &conn,
        stale_id,
        loc_id,
        "stale-item",
        &old_baseline,
        "drifted",
    )
    .unwrap();

    // 3) Genuine 3-way conflict: baseline differs from BOTH library and disk → skip.
    let (conflict_id, _) = mk_item("conflict-item", "LIB SIDE");
    let conflict_disk = loc.path().join("conflict-item");
    fs::create_dir_all(&conflict_disk).unwrap();
    fs::write(conflict_disk.join("SKILL.md"), "DISK SIDE").unwrap();
    db::upsert_placement(
        &conn,
        conflict_id,
        loc_id,
        "conflict-item",
        "stale-baseline",
        "drifted",
    )
    .unwrap();

    // 4) Already in sync → skipped_ok.
    let (ok_id, ok_hash) = mk_item("ok-item", "SAME");
    importer::copy_tree(&lib.path().join("ok-item"), &loc.path().join("ok-item")).unwrap();
    db::upsert_placement(&conn, ok_id, loc_id, "ok-item", &ok_hash, "in_sync").unwrap();

    let (pushed, skipped_conflicts, skipped_ok) =
        push_all_placements(&conn, lib.path(), loc_id).unwrap();
    assert_eq!((pushed, skipped_conflicts, skipped_ok), (2, 1, 1));

    // Pushed targets now match the library content…
    assert_eq!(
        fs::read_to_string(loc.path().join("missing-item/SKILL.md")).unwrap(),
        "LIB MISSING"
    );
    assert_eq!(
        fs::read_to_string(loc.path().join("stale-item/SKILL.md")).unwrap(),
        "LIB NEW"
    );
    // …but the conflicted copy was NOT overwritten.
    assert_eq!(
        fs::read_to_string(conflict_disk.join("SKILL.md")).unwrap(),
        "DISK SIDE"
    );
    // The batch landed in the activity log with the summary counts.
    assert!(db::recent_activity(&conn, 5)
        .unwrap()
        .iter()
        .any(|(_, kind, summary, _)| kind == "deploy"
            && summary == "Pushed 2 item(s) to Test loc (1 conflicts skipped)"));
}

#[test]
fn import_all_includes_custom_scan_dirs() {
    let home = tempfile::tempdir().unwrap(); // empty: no default/project locations
    let lib = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    // folder skill (frontmatter name should be ignored in favour of folder name)
    let folder = custom.path().join("my-skill-folder");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("SKILL.md"), "---\nname: Ignored FM\n---\nbody").unwrap();
    // single-file skill titled by its heading
    fs::write(custom.path().join("loose.md"), "# Loose One\nbody").unwrap();

    let conn = db::open_in_memory().unwrap();
    db::add_scan_dir(&conn, custom.path().to_str().unwrap(), ItemType::Skill).unwrap();

    let summary = import_all(&conn, lib.path(), home.path(), None, &|_| {}, &|| false).unwrap();

    let names: Vec<_> = db::list_items(&conn)
        .unwrap()
        .into_iter()
        .map(|i| i.name)
        .collect();
    assert!(
        names.contains(&"my-skill-folder".to_string()),
        "got {names:?}"
    );
    assert!(names.contains(&"Loose One".to_string()), "got {names:?}");
    assert!(summary.items_new >= 2);
}

#[test]
fn import_all_short_circuits_when_cancelled() {
    let home = tempfile::tempdir().unwrap(); // empty: no default/project locations
    let lib = tempfile::tempdir().unwrap();
    let custom = tempfile::tempdir().unwrap();
    let folder = custom.path().join("would-import");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("SKILL.md"), "---\nname: x\n---\nbody").unwrap();

    let conn = db::open_in_memory().unwrap();
    db::add_scan_dir(&conn, custom.path().to_str().unwrap(), ItemType::Skill).unwrap();

    // Already cancelled → returns Ok with an empty, valid catalog.
    let summary = import_all(&conn, lib.path(), home.path(), None, &|_| {}, &|| true).unwrap();

    assert_eq!(summary.items_new, 0);
    assert!(summary.cancelled, "summary flags the cancellation");
    assert_eq!(db::list_items(&conn).unwrap().len(), 0);
}

#[test]
fn tombstone_then_restore_round_trip() {
    let lib = tempfile::tempdir().unwrap();
    let conn = db::open_in_memory().unwrap();
    let folder = lib.path().join("_uncategorized/skill/foo");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("SKILL.md"), "body").unwrap();
    let (id, _) = db::insert_item_if_absent(
        &conn,
        ItemType::Skill,
        "foo",
        "foo",
        "d",
        "h",
        folder.to_str().unwrap(),
    )
    .unwrap();

    tombstone_item(&conn, lib.path(), id).unwrap();
    assert!(!folder.exists(), "library copy moved into _deleted_backups");
    assert!(
        db::list_items(&conn).unwrap().is_empty(),
        "hidden from library"
    );
    assert_eq!(
        db::list_deleted(&conn).unwrap().len(),
        1,
        "shown in Deleted"
    );

    restore_item(&conn, lib.path(), id).unwrap();
    assert!(folder.join("SKILL.md").exists(), "library copy restored");
    assert_eq!(db::list_items(&conn).unwrap().len(), 1, "back in library");
    assert!(db::list_deleted(&conn).unwrap().is_empty());
}

#[test]
fn create_item_never_overwrites_a_colliding_slug() {
    let lib = tempfile::tempdir().unwrap();
    let conn = db::open_in_memory().unwrap();
    // An existing source "foo" with real library content.
    let foo_dir = lib.path().join("_uncategorized/skill/foo");
    fs::create_dir_all(&foo_dir).unwrap();
    fs::write(foo_dir.join("SKILL.md"), "ORIGINAL FOO").unwrap();
    let (foo_id, _) = db::insert_item_if_absent(
        &conn,
        ItemType::Skill,
        "foo",
        "foo",
        "d",
        "h",
        foo_dir.to_str().unwrap(),
    )
    .unwrap();

    // Create a new item NAMED "Foo" — slugifies to the taken "foo".
    let new_id =
        create_item_from_content(&conn, lib.path(), ItemType::Skill, "Foo", "MERGED").unwrap();

    assert_ne!(
        new_id, foo_id,
        "must be a brand-new item, not the source's id"
    );
    assert_eq!(
        fs::read_to_string(foo_dir.join("SKILL.md")).unwrap(),
        "ORIGINAL FOO",
        "the source's library copy must be untouched"
    );
    let merged_path = db::item_library_path(&conn, new_id).unwrap();
    assert!(
        merged_path.contains("foo-2"),
        "fresh slug, got {merged_path}"
    );
    assert_eq!(db::list_items(&conn).unwrap().len(), 2);
}

#[test]
fn discovers_project_claude_dirs_and_skips_junk() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("repoA/.claude/agents")).unwrap();
    fs::create_dir_all(root.path().join("repoA/.claude/skills")).unwrap();
    // junk that must be pruned:
    fs::create_dir_all(root.path().join("repoB/node_modules/pkg/.claude/agents")).unwrap();
    fs::create_dir_all(root.path().join("repoC/fixtures/proj/.claude/agents")).unwrap();

    let found = discover_project_locations(root.path());

    assert!(found
        .iter()
        .any(|(l, _, k)| *k == LocationKind::Agents && l.contains("repoA")));
    assert!(found
        .iter()
        .any(|(l, _, k)| *k == LocationKind::Project && l.contains("repoA")));
    assert!(!found
        .iter()
        .any(|(_, p, _)| p.to_string_lossy().contains("node_modules")));
    assert!(!found
        .iter()
        .any(|(_, p, _)| p.to_string_lossy().contains("fixtures")));
    assert_eq!(found.len(), 2);
}

/// Opt-in end-to-end check against the real machine. Live-scans this user's
/// actual skill/agent locations into a throwaway library and asserts that
/// at least one item was imported. Run with:
///   cargo test imports_from_real_machine -- --ignored --nocapture
#[test]
#[ignore]
fn imports_from_real_machine() {
    let home = dirs::home_dir().expect("home dir");
    let lib = tempfile::tempdir().unwrap();
    let conn = db::open_in_memory().unwrap();
    let summary = import_all(&conn, lib.path(), &home, None, &|_| {}, &|| false).unwrap();
    let items = db::list_items(&conn).unwrap();
    let agents = items
        .iter()
        .filter(|i| i.item_type == crate::model::ItemType::Agent)
        .count();
    let skills = items
        .iter()
        .filter(|i| i.item_type == crate::model::ItemType::Skill)
        .count();
    println!("real import summary: {summary:?}");
    println!("unique items: {skills} skills, {agents} agents");
    assert!(
        agents > 2,
        "expected >2 agents after project discovery, got {agents}"
    );
}
