use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_JSON_BYTES: u64 = 1024 * 1024;
const MAX_CONTEXT_BYTES: u64 = 64 * 1024;
const MAX_DIFF_BYTES: usize = 12 * 1024;
const MAX_RECORDS: usize = 1000;
const MAX_CONTEXT_DECISIONS: usize = 20;
const MAX_CONTEXT_FILES: usize = 40;
const FALLBACK_SUMMARY: &str = "Your protected update completed successfully.";
const BACKUPS_PATH: &str = ".gg/local-fixes/backups";
const BACKFILL_DIRECTORY: &str = "decision-backfill-89af62bb";
const LEGACY_DIRECTORY: &str = "2026-08-27T03-41-51-878Z";
const BACKFILL_MERGE: &str = "89af62bbd76e227d38cb408ca591bafdb054a4e6";
const BACKFILL_ID: &str = "decision-89af62bbd76e";
const LEGACY_SOURCE_OID: &str = "ee688721dd7d726916cf86ae3b349bea933ebc0a";
const LEGACY_TIMESTAMP: &str = "2026-08-27T03:41:51.878Z";
const LEGACY_LOCAL_BRANCH: &str = "custom/local-customizations";
const LEGACY_SOURCE: &str = "upstream/main";
const BACKFILL_DECISIONS: &[u8] = include_bytes!("../decision-backfills/89af62bb/decisions.json");
const BACKFILL_MANIFEST: &[u8] = include_bytes!("../decision-backfills/89af62bb/manifest.json");
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DecisionRecord {
    schema_version: u8,
    id: String,
    date: String,
    label: String,
    evidence: DecisionEvidence,
    verification: DecisionVerification,
    decisions: Vec<Decision>,
    #[serde(default)]
    summary: Option<DecisionSummary>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecisionEvidence {
    merge: String,
    base: String,
    local_parent: String,
    upstream_parent: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DecisionVerification {
    workflow_verified: bool,
    recorded_at: String,
    #[serde(default)]
    checks: CheckDisposition,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CheckDisposition {
    #[default]
    NotRecorded,
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
}

fn explicit_checks<'de, D>(deserializer: D) -> Result<Option<CheckDisposition>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    CheckDisposition::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    area: String,
    outcome: DecisionOutcome,
    files: Vec<DecisionFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum DecisionOutcome {
    KeptLocal,
    AdoptedUpstream,
    Combined,
    Unresolved,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DecisionFile {
    path: String,
    role: DecisionFileRole,
    outcome: DecisionOutcome,
    blobs: DecisionBlobs,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum DecisionFileRole {
    Implementation,
    Test,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DecisionBlobs {
    base: Option<String>,
    local: Option<String>,
    upstream: Option<String>,
    merged: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecisionSummary {
    text: String,
    source: DecisionSummarySource,
    generated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum DecisionSummarySource {
    Agent,
    Fallback,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupManifest {
    verified: bool,
    #[serde(default, deserialize_with = "explicit_checks")]
    checks: Option<CheckDisposition>,
    merged_head: String,
    #[serde(default)]
    decision_merge: Option<String>,
    timestamp: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyBackfillManifest {
    timestamp: String,
    local_branch: String,
    source: String,
    starting_head: String,
    source_oid: String,
    merged_head: String,
    verified: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecisionSummaryContext {
    version: u8,
    recorded_at: String,
    evidence: DecisionEvidence,
    truncated: bool,
    decisions: Vec<ContextDecision>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextDecision {
    area: String,
    outcome: DecisionOutcome,
    files: Vec<ContextFile>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextFile {
    path: String,
    role: DecisionFileRole,
    diffs: ContextDiffs,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContextDiffs {
    base_to_local: ContextDiff,
    base_to_upstream: ContextDiff,
    base_to_merged: ContextDiff,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextDiff {
    status: ContextDiffStatus,
    text: String,
    truncated: bool,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum ContextDiffStatus {
    Available,
    Binary,
    Unavailable,
}

pub struct PendingDecisionSummary {
    backup_dir: PathBuf,
    pub context_json: String,
    evidence: DecisionEvidence,
    recorded_at: String,
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max
}

fn oid(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn timestamp(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok()
}

fn valid_summary(summary: &DecisionSummary) -> bool {
    let length = summary.text.chars().count();
    (40..=500).contains(&length)
        && summary.text.trim() == summary.text
        && !summary.text.chars().any(char::is_control)
        && !summary.text.contains("```")
        && timestamp(&summary.generated_at)
}

fn valid_record(record: &DecisionRecord) -> bool {
    let schema_valid = match record.schema_version {
        2 => record.summary.is_none(),
        3 => record.summary.as_ref().is_some_and(valid_summary),
        _ => false,
    };
    schema_valid
        && bounded(&record.id, 256)
        && NaiveDate::parse_from_str(&record.date, "%Y-%m-%d").is_ok()
        && bounded(&record.label, 4096)
        && [
            &record.evidence.merge,
            &record.evidence.base,
            &record.evidence.local_parent,
            &record.evidence.upstream_parent,
        ]
        .into_iter()
        .all(|value| oid(value))
        && record.verification.workflow_verified
        && matches!(
            record.verification.checks,
            CheckDisposition::Passed | CheckDisposition::NotRecorded
        )
        && timestamp(&record.verification.recorded_at)
        && !record.decisions.is_empty()
        && record.decisions.len() <= MAX_RECORDS
        && record.decisions.iter().all(|decision| {
            bounded(&decision.area, 4096)
                && !decision.files.is_empty()
                && decision.files.len() <= MAX_RECORDS
                && decision.files.iter().all(|file| {
                    bounded(&file.path, 4096)
                        && [
                            file.blobs.base.as_deref(),
                            file.blobs.local.as_deref(),
                            file.blobs.upstream.as_deref(),
                            file.blobs.merged.as_deref(),
                        ]
                        .into_iter()
                        .flatten()
                        .all(oid)
                })
        })
}

fn read_bytes(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.file_type().is_file() || metadata.len() > max_bytes {
        return None;
    }
    fs::read(path).ok()
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&read_bytes(path, MAX_JSON_BYTES)?).ok()
}

fn regular_directory(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_dir())
}

fn eligible_for_89af62bb_backfill(repo_root: &Path) -> bool {
    let gg_dir = repo_root.join(".gg");
    let local_fixes_dir = gg_dir.join("local-fixes");
    let backups_dir = local_fixes_dir.join("backups");
    let marker_dir = backups_dir.join(LEGACY_DIRECTORY);
    if !regular_directory(&gg_dir)
        || !regular_directory(&local_fixes_dir)
        || !regular_directory(&backups_dir)
        || !regular_directory(&marker_dir)
    {
        return false;
    }
    let Some(manifest) = read_json::<LegacyBackfillManifest>(&marker_dir.join("manifest.json"))
    else {
        return false;
    };
    !manifest.verified
        && manifest.timestamp == LEGACY_TIMESTAMP
        && manifest.local_branch == LEGACY_LOCAL_BRANCH
        && manifest.source == LEGACY_SOURCE
        && manifest.starting_head == BACKFILL_MERGE
        && manifest.source_oid == LEGACY_SOURCE_OID
        && manifest.merged_head == BACKFILL_MERGE
}

fn ensure_repair_directory(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            if regular_directory(path) {
                Ok(())
            } else {
                Err("decision backfill directory conflicts with an existing path".to_string())
            }
        }
        Err(_) => Err("decision backfill directory unavailable".to_string()),
    }
}

fn publish_exact_from_temp(path: &Path, temp: &Path, bytes: &[u8]) -> Result<bool, String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)
        .map_err(|_| "decision backfill temporary file unavailable")?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "decision backfill temporary write failed")?;
        match fs::hard_link(temp, path) {
            Ok(()) => Ok(true),
            Err(_)
                if read_bytes(path, MAX_JSON_BYTES).is_some_and(|existing| existing == bytes) =>
            {
                Ok(false)
            }
            Err(_) => Err("decision backfill destination conflicts with existing data".to_string()),
        }
    })();
    drop(file);
    let _ = fs::remove_file(temp);
    result
}

fn publish_exact(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    if read_bytes(path, MAX_JSON_BYTES).is_some_and(|existing| existing == bytes) {
        return Ok(false);
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("decision backfill destination invalid")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "decision backfill clock unavailable")?
        .as_nanos();
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_file_name(format!(
        ".{name}.{}.{}.{sequence}.tmp",
        std::process::id(),
        nonce
    ));
    publish_exact_from_temp(path, &temp, bytes)
}

fn install_89af62bb_backfill(repo_root: &Path) -> Result<bool, String> {
    if !eligible_for_89af62bb_backfill(repo_root) {
        return Ok(false);
    }
    if load_verified_decisions(repo_root)
        .iter()
        .any(|record| record.id == BACKFILL_ID || record.evidence.merge == BACKFILL_MERGE)
    {
        return Ok(false);
    }
    let repair_dir = repo_root.join(BACKUPS_PATH).join(BACKFILL_DIRECTORY);
    ensure_repair_directory(&repair_dir)?;
    let decisions_changed = publish_exact(&repair_dir.join("decisions.json"), BACKFILL_DECISIONS)?;
    let manifest_changed = publish_exact(&repair_dir.join("manifest.json"), BACKFILL_MANIFEST)?;
    Ok(decisions_changed || manifest_changed)
}

pub fn initialize_project_decisions(repo_root: &Path) {
    if let Err(error) = install_89af62bb_backfill(repo_root) {
        eprintln!("warning: Decisions startup backfill failed: {error}");
    }
}

fn correlated(manifest: &BackupManifest, record: &DecisionRecord) -> bool {
    manifest.verified
        && match manifest.checks {
            Some(CheckDisposition::Passed) => {
                record.verification.checks == CheckDisposition::Passed
            }
            None => record.verification.checks == CheckDisposition::NotRecorded,
            _ => false,
        }
        && valid_record(record)
        && manifest
            .decision_merge
            .as_deref()
            .unwrap_or(&manifest.merged_head)
            == record.evidence.merge
        && manifest.timestamp == record.verification.recorded_at
}

fn with_fallback(mut record: DecisionRecord) -> DecisionRecord {
    if record.schema_version == 2 {
        record.summary = Some(DecisionSummary {
            text: FALLBACK_SUMMARY.to_string(),
            source: DecisionSummarySource::Fallback,
            generated_at: record.verification.recorded_at.clone(),
        });
    }
    record
}

pub fn load_verified_decisions(repo_root: &Path) -> Vec<DecisionRecord> {
    let backups = repo_root.join(BACKUPS_PATH);
    let Ok(entries) = fs::read_dir(backups) else {
        return Vec::new();
    };
    let mut directories: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .map(|entry| entry.path())
        .collect();
    directories.sort();
    let mut records = Vec::new();
    for directory in directories {
        let manifest = read_json::<BackupManifest>(&directory.join("manifest.json"));
        let record = read_json::<DecisionRecord>(&directory.join("decisions.json"));
        let (Some(manifest), Some(record)) = (manifest, record) else {
            continue;
        };
        if correlated(&manifest, &record) {
            records.push(with_fallback(record));
        }
    }
    // Stable sorting preserves directory order when timestamp, date, and ID all tie.
    records.sort_by_cached_key(|record| {
        (
            std::cmp::Reverse(
                DateTime::parse_from_rfc3339(&record.verification.recorded_at)
                    .expect("correlated records have validated timestamps"),
            ),
            std::cmp::Reverse(record.date.clone()),
            record.id.clone(),
        )
    });
    let mut seen_ids = HashSet::new();
    let mut seen_merges = HashSet::new();
    records.retain(|record| {
        if seen_ids.contains(&record.id) || seen_merges.contains(&record.evidence.merge) {
            return false;
        }
        seen_ids.insert(record.id.clone());
        seen_merges.insert(record.evidence.merge.clone());
        true
    });
    records
}

fn valid_context(context: &DecisionSummaryContext) -> bool {
    let mut file_count = 0;
    context.version == 1
        && timestamp(&context.recorded_at)
        && [
            &context.evidence.merge,
            &context.evidence.base,
            &context.evidence.local_parent,
            &context.evidence.upstream_parent,
        ]
        .into_iter()
        .all(|value| oid(value))
        && !context.decisions.is_empty()
        && context.decisions.len() <= MAX_CONTEXT_DECISIONS
        && context.decisions.iter().all(|decision| {
            bounded(&decision.area, 500)
                && !decision.files.is_empty()
                && decision.files.iter().all(|file| {
                    file_count += 1;
                    file_count <= MAX_CONTEXT_FILES
                        && bounded(&file.path, 1000)
                        && [
                            &file.diffs.base_to_local,
                            &file.diffs.base_to_upstream,
                            &file.diffs.base_to_merged,
                        ]
                        .into_iter()
                        .all(|diff| {
                            diff.text.len() <= MAX_DIFF_BYTES
                                && (diff.status == ContextDiffStatus::Available
                                    || diff.text.is_empty())
                        })
                })
        })
}

pub fn load_pending_decision_summary(
    repo_root: &Path,
) -> Result<Option<PendingDecisionSummary>, String> {
    let backups = repo_root.join(".gg/local-fixes/backups");
    let entries =
        fs::read_dir(&backups).map_err(|_| "summary backup root unavailable".to_string())?;
    let mut candidates = Vec::new();
    for entry in entries.flatten().take(MAX_RECORDS) {
        if entry.file_type().is_ok_and(|kind| kind.is_dir())
            && entry.path().join("decision-summary-context.json").exists()
        {
            candidates.push(entry.path());
        }
    }
    candidates.sort();
    let Some(backup_dir) = candidates.pop() else {
        return Ok(None);
    };
    let context_path = backup_dir.join("decision-summary-context.json");
    let invalid = || {
        let _ = fs::remove_file(&context_path);
        Err("decision summary context was rejected".to_string())
    };
    let Some(bytes) = read_bytes(&context_path, MAX_CONTEXT_BYTES) else {
        return invalid();
    };
    let Ok(context) = serde_json::from_slice::<DecisionSummaryContext>(&bytes) else {
        return invalid();
    };
    let Some(manifest) = read_json::<BackupManifest>(&backup_dir.join("manifest.json")) else {
        return invalid();
    };
    let Some(record) = read_json::<DecisionRecord>(&backup_dir.join("decisions.json")) else {
        return invalid();
    };
    if !valid_context(&context)
        || !correlated(&manifest, &record)
        || context.evidence != record.evidence
        || context.recorded_at != record.verification.recorded_at
    {
        return invalid();
    }
    let context_json = String::from_utf8(bytes).map_err(|_| {
        let _ = fs::remove_file(&context_path);
        "decision summary context was rejected".to_string()
    })?;
    Ok(Some(PendingDecisionSummary {
        backup_dir,
        context_json,
        evidence: context.evidence,
        recorded_at: context.recorded_at,
    }))
}

fn atomic_write_record(path: &Path, record: &DecisionRecord) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(record)
        .map_err(|_| "summary record encoding failed".to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "summary clock unavailable".to_string())?
        .as_nanos();
    let temp = path.with_file_name(format!("decisions.json.{nonce}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "summary temporary file unavailable".to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "summary temporary write failed".to_string())?;
        fs::rename(&temp, path).map_err(|_| "summary atomic replacement failed".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

pub fn complete_pending_decision_summary(
    pending: PendingDecisionSummary,
    summary: Option<&str>,
) -> Result<(), String> {
    let context_path = pending.backup_dir.join("decision-summary-context.json");
    let result = (|| {
        let Some(text) = summary else {
            return Ok(());
        };
        let decisions_path = pending.backup_dir.join("decisions.json");
        let manifest = read_json::<BackupManifest>(&pending.backup_dir.join("manifest.json"))
            .ok_or("summary manifest unavailable")?;
        let mut record =
            read_json::<DecisionRecord>(&decisions_path).ok_or("summary record unavailable")?;
        if !correlated(&manifest, &record)
            || record.evidence != pending.evidence
            || record.verification.recorded_at != pending.recorded_at
        {
            return Err("summary correlation changed".to_string());
        }
        let generated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let replacement = DecisionSummary {
            text: text.to_string(),
            source: DecisionSummarySource::Agent,
            generated_at,
        };
        if !valid_summary(&replacement) {
            return Err("summary response was rejected".to_string());
        }
        record.schema_version = 3;
        record.summary = Some(replacement);
        atomic_write_record(&decisions_path, &record)
    })();
    let cleanup =
        fs::remove_file(context_path).map_err(|_| "summary context cleanup failed".to_string());
    result.and(cleanup)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "gg-decisions-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn fixture(id: &str, date: &str, merge: char, schema: u8) -> serde_json::Value {
        let merge = merge.to_string().repeat(40);
        let mut value = serde_json::json!({
            "schemaVersion": schema,
            "id": id,
            "date": date,
            "label": "Merge upstream",
            "evidence": {
                "merge": merge,
                "base": "b".repeat(40),
                "localParent": "c".repeat(40),
                "upstreamParent": "d".repeat(40)
            },
            "verification": {
                "workflowVerified": true,
                "recordedAt": "2026-08-24T00:00:00Z",
                "phase": "complete",
                "checks": "not-recorded",
                "installer": null
            },
            "decisions": [{
                "area": "gg-app/src/WhatsNewWindow",
                "outcome": "combined",
                "files": [{
                    "path": "gg-app/src/WhatsNewWindow.tsx",
                    "role": "implementation",
                    "outcome": "combined",
                    "blobs": { "base": null, "local": null, "upstream": null, "merged": merge }
                }]
            }]
        });
        if schema == 3 {
            value["summary"] = serde_json::json!({
                "text": FALLBACK_SUMMARY,
                "source": "fallback",
                "generatedAt": "2026-08-24T00:00:00Z"
            });
        }
        value
    }

    fn write_backup(root: &Path, name: &str, record: serde_json::Value, verified: bool) -> PathBuf {
        let dir = root.join(".gg/local-fixes/backups").join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("decisions.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "verified": verified,
                "mergedHead": record["evidence"]["merge"],
                "timestamp": record["verification"]["recordedAt"]
            }))
            .unwrap(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn decisions_and_summary_context_require_correlated_check_dispositions() {
        let dispositions = [
            None,
            Some(serde_json::json!("not-recorded")),
            Some(serde_json::json!("passed")),
            Some(serde_json::json!("skipped")),
            Some(serde_json::json!("failed")),
            Some(serde_json::json!("pending")),
            Some(serde_json::json!("running")),
            Some(serde_json::json!("unknown")),
            Some(serde_json::Value::Null),
            Some(serde_json::json!(true)),
        ];
        for manifest_checks in &dispositions {
            for record_checks in &dispositions {
                let root = root();
                let mut record = fixture("provenance", "2026-08-24", 'a', 3);
                record["verification"]
                    .as_object_mut()
                    .unwrap()
                    .remove("checks");
                if let Some(checks) = record_checks {
                    record["verification"]["checks"] = checks.clone();
                }
                let dir = write_backup(&root, "update", record.clone(), true);
                let manifest_path = dir.join("manifest.json");
                let mut manifest: serde_json::Value = read_json(&manifest_path).unwrap();
                if let Some(checks) = manifest_checks {
                    manifest["checks"] = checks.clone();
                }
                let original_manifest = serde_json::to_vec(&manifest).unwrap();
                fs::write(&manifest_path, &original_manifest).unwrap();
                let original_record = fs::read(dir.join("decisions.json")).unwrap();
                let passed = Some(serde_json::json!("passed"));
                let legacy = Some(serde_json::json!("not-recorded"));
                let expected = (manifest_checks == &passed && record_checks == &passed)
                    || (manifest_checks.is_none()
                        && (record_checks.is_none() || record_checks == &legacy));
                assert_eq!(
                    load_verified_decisions(&root).len(),
                    usize::from(expected),
                    "manifest={manifest_checks:?}, record={record_checks:?}"
                );
                write_context(&dir, &record);
                let pending = load_pending_decision_summary(&root);
                assert_eq!(
                    pending.is_ok(),
                    expected,
                    "summary manifest={manifest_checks:?}, record={record_checks:?}"
                );
                if expected {
                    assert!(pending.unwrap().is_some());
                }
                assert_eq!(fs::read(&manifest_path).unwrap(), original_manifest);
                assert_eq!(
                    fs::read(dir.join("decisions.json")).unwrap(),
                    original_record
                );
                fs::remove_dir_all(root).unwrap();
            }
        }
    }

    #[test]
    fn summary_completion_rechecks_checks_and_preserves_checked_provenance() {
        for skip_before_completion in [false, true] {
            let root = root();
            let mut record = fixture("checked", "2026-08-24", 'a', 3);
            record["verification"]["checks"] = serde_json::json!("passed");
            let dir = write_backup(&root, "update", record.clone(), true);
            let path = dir.join("manifest.json");
            let mut manifest: serde_json::Value = read_json(&path).unwrap();
            manifest["checks"] = serde_json::json!("passed");
            fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            write_context(&dir, &record);
            let pending = load_pending_decision_summary(&root).unwrap().unwrap();
            if skip_before_completion {
                manifest["checks"] = serde_json::json!("skipped");
                fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
            }
            let original = fs::read(dir.join("decisions.json")).unwrap();
            let result = complete_pending_decision_summary(pending, Some(FALLBACK_SUMMARY));
            assert_eq!(result.is_ok(), !skip_before_completion);
            if skip_before_completion {
                assert_eq!(fs::read(dir.join("decisions.json")).unwrap(), original);
            } else {
                let saved: serde_json::Value = read_json(&dir.join("decisions.json")).unwrap();
                assert_eq!(saved["verification"]["checks"], "passed");
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn verified_remediation_manifest_correlates_to_its_decision_merge() {
        let root = root();
        let record = fixture("remediated", "2026-09-03", 'a', 3);
        let directory = root.join(BACKUPS_PATH).join("remediated");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("decisions.json"),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "verified": true,
                "mergedHead": "e".repeat(40),
                "decisionMerge": record["evidence"]["merge"],
                "timestamp": record["verification"]["recordedAt"]
            }))
            .unwrap(),
        )
        .unwrap();

        let records = load_verified_decisions(&root);

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "remediated");
        fs::remove_dir_all(root).unwrap();
    }

    fn legacy_manifest() -> serde_json::Value {
        serde_json::json!({
            "timestamp": LEGACY_TIMESTAMP,
            "localBranch": LEGACY_LOCAL_BRANCH,
            "source": LEGACY_SOURCE,
            "startingHead": BACKFILL_MERGE,
            "sourceOid": LEGACY_SOURCE_OID,
            "mergedHead": BACKFILL_MERGE,
            "verified": false
        })
    }

    fn write_legacy_marker(root: &Path, manifest: &serde_json::Value) -> PathBuf {
        let dir = root.join(BACKUPS_PATH).join(LEGACY_DIRECTORY);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.json"),
            serde_json::to_vec(manifest).unwrap(),
        )
        .unwrap();
        dir
    }

    fn repair_dir(root: &Path) -> PathBuf {
        root.join(BACKUPS_PATH).join(BACKFILL_DIRECTORY)
    }

    fn write_context(dir: &Path, record: &serde_json::Value) {
        fs::write(
            dir.join("decision-summary-context.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "recordedAt": record["verification"]["recordedAt"],
                "evidence": record["evidence"],
                "truncated": false,
                "decisions": [{
                    "area": "update",
                    "outcome": "combined",
                    "files": [{
                        "path": "update.ts",
                        "role": "implementation",
                        "diffs": {
                            "baseToLocal": { "status": "available", "text": "local", "truncated": false },
                            "baseToUpstream": { "status": "available", "text": "upstream", "truncated": false },
                            "baseToMerged": { "status": "available", "text": "merged", "truncated": false }
                        }
                    }]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn shipped_backfill_contains_exact_verified_merge_evidence() {
        let manifest: BackupManifest = serde_json::from_slice(BACKFILL_MANIFEST).unwrap();
        let record: DecisionRecord = serde_json::from_slice(BACKFILL_DECISIONS).unwrap();
        assert!(correlated(&manifest, &record));
        assert_eq!(record.schema_version, 3);
        assert_eq!(record.id, BACKFILL_ID);
        assert_eq!(record.date, "2026-08-26");
        assert_eq!(
            record.label,
            "Merge upstream/main into custom/local-customizations"
        );
        assert_eq!(record.evidence.merge, BACKFILL_MERGE);
        assert_eq!(
            record.evidence.base,
            "be069760762ed648606442c0595be6e14ccd9c0a"
        );
        assert_eq!(
            record.evidence.local_parent,
            "3fdc4d572e7fa6746e6c77fe3a61413f31f648aa"
        );
        assert_eq!(record.evidence.upstream_parent, LEGACY_SOURCE_OID);
        let payload: serde_json::Value = serde_json::from_slice(BACKFILL_DECISIONS).unwrap();
        let expected_areas = [
            ("gg-app/src/App", "kept-local"),
            ("gg-app/src/SettingsModal", "combined"),
            ("packages/gg-agent/src/agent-loop", "combined"),
            ("packages/ggcoder/src/core/agent-session", "combined"),
            (
                "packages/ggcoder/src/core/agent-session-verification-gate",
                "combined",
            ),
            ("packages/ggcoder/src/core/session-manager", "combined"),
            ("packages/ggcoder/src/tools/bash", "combined"),
            ("packages/ggcoder/src/tools/operations", "combined"),
        ];
        let areas = payload["decisions"].as_array().unwrap();
        assert_eq!(areas.len(), expected_areas.len());
        for (area, (expected_name, expected_outcome)) in areas.iter().zip(expected_areas) {
            assert_eq!(area["area"], expected_name);
            assert_eq!(area["outcome"], expected_outcome);
        }
        let expected_files = [
            (
                "gg-app/src/App.tsx",
                "implementation",
                "kept-local",
                [
                    "c56b091a10758411424b36e0cd8d56f35de2ec05",
                    "6791cd36c3de235496c97791f04901e669713d20",
                    "fcc4b4fad5ccd8efaad695f784bf1d016932b98a",
                    "6791cd36c3de235496c97791f04901e669713d20",
                ],
            ),
            (
                "gg-app/src/SettingsModal.tsx",
                "implementation",
                "combined",
                [
                    "36135fca8a8c753984360f7100a4f4d70d244b08",
                    "47e0e858d2d12d45f8ba18d24447cef5d7392a30",
                    "7b93b706107bad6c90954f15830dee7be23bff18",
                    "725621f4305b63dff3585a9cf3693575553c08dd",
                ],
            ),
            (
                "packages/gg-agent/src/agent-loop.ts",
                "implementation",
                "combined",
                [
                    "9a6f0e00f8a0c7d82a5f5de279f956f9f024aeb3",
                    "fbd5f41ca30936f98bf0663fbdc5520717eaf690",
                    "c91d038b199d2879657c8052e7af9c214d1b85e6",
                    "8f5524a51bb0e751f40b31a395589489ccf41c1e",
                ],
            ),
            (
                "packages/gg-agent/src/agent-loop.test.ts",
                "test",
                "combined",
                [
                    "58f2a17acc82d385ad0bfabbfb9e5fcb25ce9725",
                    "e6d04c35a8e6e6a8d6b7bf5302e9699d6349459a",
                    "7763e9a7c4111f56f8e71ae7856770f6073bd42d",
                    "a44229143000c65c6d4cf10be9fbba3073f68dc4",
                ],
            ),
            (
                "packages/ggcoder/src/core/agent-session.ts",
                "implementation",
                "combined",
                [
                    "a98d3a70c060e319b340d3e1850df32a20a1c49d",
                    "debb82e96ab80c6ce48f8628d78f01bd02876078",
                    "7f50119542b1ab48f0e5afa2a347fd900d1e7ec2",
                    "b73253564c2126304b9cf2baa9fef075c365dfbc",
                ],
            ),
            (
                "packages/ggcoder/src/core/agent-session-verification-gate.test.ts",
                "test",
                "combined",
                [
                    "464301fb1ccf8f32ddd5ad7701893d3dfd177601",
                    "20e3e25e61a9b5c6d2fade1e52c20b766ca81973",
                    "ace552deb7d952724143ae886cc9b478f687f2bf",
                    "bac9f0f4307d048db38467e7e9040a18381b24d3",
                ],
            ),
            (
                "packages/ggcoder/src/core/session-manager.ts",
                "implementation",
                "combined",
                [
                    "77c0914193d49b65cf3bda3f336eebb37164e430",
                    "9311b92929fd4a030ba37a69c48a7ecc81a09f2d",
                    "74390e3d02b5594daba355a0b53cd7e71d041795",
                    "11c65e7b0f0f98a0843ed1b555ade677225bb42d",
                ],
            ),
            (
                "packages/ggcoder/src/core/session-manager.test.ts",
                "test",
                "combined",
                [
                    "5eafcfc08c318bf9647c2d3b0a3c0caf6895c80a",
                    "845d51d257b75e3a08dd7ec00753a10e6ee0f289",
                    "d30397f446113dd076bb5326c78d5c2ec45b6819",
                    "4c6c2530364227d8a11ab22f0f65e7706ed707dc",
                ],
            ),
            (
                "packages/ggcoder/src/tools/bash.test.ts",
                "test",
                "combined",
                [
                    "9db62a52b47bf8cc61e7c1e48b4f31e707bbf047",
                    "d08d7f061a238bd663378f9d2f434b3076d7e964",
                    "cbbad9800f83f674b0167e2d3916dcc34a439e47",
                    "fc406aef34e1ba3af6768b1d559892150df7a856",
                ],
            ),
            (
                "packages/ggcoder/src/tools/operations.ts",
                "implementation",
                "combined",
                [
                    "b81014e7bbc97962031b7faeb1b60e0dbfbd14f3",
                    "8a450c3820af8c53acac72bb9d8d71ddccf20059",
                    "bdbc45e455e7b51cfde2a3f3233ec134b7eef5b1",
                    "0549c1ef6ff01982267c12be521ec99577720cfe",
                ],
            ),
        ];
        let files: Vec<&serde_json::Value> = areas
            .iter()
            .flat_map(|area| area["files"].as_array().unwrap())
            .collect();
        assert_eq!(files.len(), expected_files.len());
        for (file, (path, role, outcome, blobs)) in files.iter().zip(expected_files) {
            assert_eq!(file["path"], path);
            assert_eq!(file["role"], role);
            assert_eq!(file["outcome"], outcome);
            for (key, expected) in ["base", "local", "upstream", "merged"]
                .into_iter()
                .zip(blobs)
            {
                assert_eq!(file["blobs"][key], expected);
            }
        }
        assert_eq!(
            payload["summary"]["text"],
            "Your protected update is ready. It held onto your local work in one area because the finished update uses your version there. It blended your work with upstream in 7 areas, keeping changes from both sides."
        );
        assert_eq!(payload["summary"]["source"], "fallback");
        assert_eq!(payload["summary"]["generatedAt"], LEGACY_TIMESTAMP);
    }

    #[test]
    fn temporary_collision_preserves_file_owned_by_another_writer() {
        let root = root();
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("decisions.json");
        let temp = root.join(".decisions.collision.tmp");
        let owner_bytes = b"another writer's temporary data";
        fs::write(&temp, owner_bytes).unwrap();

        assert!(publish_exact_from_temp(&destination, &temp, BACKFILL_DECISIONS).is_err());
        assert_eq!(fs::read(&temp).unwrap(), owner_bytes);
        assert!(!destination.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_decisions_scan_past_display_limit_and_deduplicate() {
        let root = root();
        write_legacy_marker(&root, &legacy_manifest());
        for index in 0..MAX_RECORDS {
            let merge = format!("{index:040x}");
            let mut record = fixture(&format!("filler-{index}"), "2026-08-26", 'a', 3);
            record["evidence"]["merge"] = serde_json::Value::String(merge.clone());
            record["decisions"][0]["files"][0]["blobs"]["merged"] =
                serde_json::Value::String(merge);
            write_backup(&root, &format!("a-{index:04}"), record, true);
        }
        let mut duplicate = fixture("duplicate", "2026-08-24", 'a', 3);
        duplicate["evidence"]["merge"] = serde_json::json!(BACKFILL_MERGE);
        duplicate["decisions"][0]["files"][0]["blobs"]["merged"] =
            serde_json::json!(BACKFILL_MERGE);
        write_backup(&root, "z-first", duplicate.clone(), true);
        write_backup(&root, "z-second", duplicate, true);

        let records = load_verified_decisions(&root);
        assert_eq!(records.len(), MAX_RECORDS + 1);
        assert_eq!(
            records
                .iter()
                .filter(|record| record.evidence.merge == BACKFILL_MERGE)
                .count(),
            1
        );
        initialize_project_decisions(&root);
        assert!(!repair_dir(&root).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_initialization_installs_without_whats_new_and_retry_is_byte_stable() {
        let root = root();
        write_legacy_marker(&root, &legacy_manifest());
        initialize_project_decisions(&root);
        let repair = repair_dir(&root);
        let first_decisions = fs::read(repair.join("decisions.json")).unwrap();
        let first_manifest = fs::read(repair.join("manifest.json")).unwrap();
        let first_directories = fs::read_dir(root.join(BACKUPS_PATH)).unwrap().count();
        assert_eq!(first_decisions, BACKFILL_DECISIONS);
        assert_eq!(first_manifest, BACKFILL_MANIFEST);
        assert_eq!(load_verified_decisions(&root).len(), 1);

        initialize_project_decisions(&root);

        assert_eq!(
            fs::read(repair.join("decisions.json")).unwrap(),
            first_decisions
        );
        assert_eq!(
            fs::read(repair.join("manifest.json")).unwrap(),
            first_manifest
        );
        assert_eq!(
            fs::read_dir(root.join(BACKUPS_PATH)).unwrap().count(),
            first_directories
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_startup_initializations_converge_on_one_complete_pair() {
        let root = root();
        write_legacy_marker(&root, &legacy_manifest());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    initialize_project_decisions(&root);
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let repair = repair_dir(&root);
        assert_eq!(
            fs::read(repair.join("decisions.json")).unwrap(),
            BACKFILL_DECISIONS
        );
        assert_eq!(
            fs::read(repair.join("manifest.json")).unwrap(),
            BACKFILL_MANIFEST
        );
        assert_eq!(load_verified_decisions(&root).len(), 1);
        assert_eq!(fs::read_dir(root.join(BACKUPS_PATH)).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn existing_id_or_merge_suppresses_installation_and_display_duplicates() {
        for same_id in [true, false] {
            let root = root();
            write_legacy_marker(&root, &legacy_manifest());
            let mut existing = fixture(
                if same_id { BACKFILL_ID } else { "another-id" },
                "2026-08-24",
                'a',
                3,
            );
            if !same_id {
                existing["evidence"]["merge"] = serde_json::json!(BACKFILL_MERGE);
                existing["decisions"][0]["files"][0]["blobs"]["merged"] =
                    serde_json::json!(BACKFILL_MERGE);
            }
            write_backup(&root, "existing", existing, true);
            assert!(!install_89af62bb_backfill(&root).unwrap());
            assert!(!repair_dir(&root).exists());
            fs::remove_dir_all(root).unwrap();
        }

        let same_id_root = root();
        write_backup(
            &same_id_root,
            "a-first",
            fixture("same", "2026-08-24", '1', 3),
            true,
        );
        write_backup(
            &same_id_root,
            "b-same-id",
            fixture("same", "2026-08-24", '2', 3),
            true,
        );
        let records = load_verified_decisions(&same_id_root);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].evidence.merge, "1".repeat(40));
        fs::remove_dir_all(same_id_root).unwrap();

        let same_merge_root = root();
        write_backup(
            &same_merge_root,
            "a-first",
            fixture("first", "2026-08-24", '1', 3),
            true,
        );
        write_backup(
            &same_merge_root,
            "b-same-merge",
            fixture("second", "2026-08-24", '1', 3),
            true,
        );
        let records = load_verified_decisions(&same_merge_root);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "first");
        fs::remove_dir_all(same_merge_root).unwrap();
    }

    #[test]
    fn invalid_or_symlinked_legacy_evidence_is_a_noop() {
        let missing_root = root();
        assert!(!install_89af62bb_backfill(&missing_root).unwrap());
        assert!(!repair_dir(&missing_root).exists());

        let marker = write_legacy_marker(&missing_root, &legacy_manifest());
        fs::write(marker.join("manifest.json"), b"{").unwrap();
        assert!(!install_89af62bb_backfill(&missing_root).unwrap());
        fs::write(
            marker.join("manifest.json"),
            vec![b' '; MAX_JSON_BYTES as usize + 1],
        )
        .unwrap();
        assert!(!install_89af62bb_backfill(&missing_root).unwrap());
        fs::remove_dir_all(&missing_root).unwrap();

        for (field, value) in [
            ("timestamp", serde_json::json!("2026-08-27T00:00:00Z")),
            ("localBranch", serde_json::json!("main")),
            ("source", serde_json::json!("origin/main")),
            ("startingHead", serde_json::json!("0".repeat(40))),
            ("sourceOid", serde_json::json!("0".repeat(40))),
            ("mergedHead", serde_json::json!("0".repeat(40))),
            ("verified", serde_json::json!(true)),
        ] {
            let root = root();
            let mut manifest = legacy_manifest();
            manifest[field] = value;
            write_legacy_marker(&root, &manifest);
            assert!(!install_89af62bb_backfill(&root).unwrap());
            assert!(!repair_dir(&root).exists());
            fs::remove_dir_all(root).unwrap();
        }

        let root = root();
        let marker = root.join(BACKUPS_PATH).join(LEGACY_DIRECTORY);
        fs::create_dir_all(&marker).unwrap();
        let target = root.join("legacy-manifest.json");
        fs::write(&target, serde_json::to_vec(&legacy_manifest()).unwrap()).unwrap();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&target, marker.join("manifest.json")).is_ok();
        #[cfg(windows)]
        let linked =
            std::os::windows::fs::symlink_file(&target, marker.join("manifest.json")).is_ok();
        if linked {
            assert!(!install_89af62bb_backfill(&root).unwrap());
            assert!(!repair_dir(&root).exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_conflict_is_nonfatal_and_preserves_every_existing_byte() {
        let root = root();
        write_legacy_marker(&root, &legacy_manifest());
        write_backup(
            &root,
            "unrelated",
            fixture("unrelated", "2026-08-23", 'a', 3),
            true,
        );
        let repair = repair_dir(&root);
        fs::create_dir_all(&repair).unwrap();
        let user_bytes = b"user-created decisions";
        fs::write(repair.join("decisions.json"), user_bytes).unwrap();
        assert!(install_89af62bb_backfill(&root).is_err());
        assert_eq!(fs::read(repair.join("decisions.json")).unwrap(), user_bytes);
        assert!(!repair.join("manifest.json").exists());

        initialize_project_decisions(&root);

        assert_eq!(fs::read(repair.join("decisions.json")).unwrap(), user_bytes);
        assert_eq!(load_verified_decisions(&root).len(), 1);
        assert_eq!(load_verified_decisions(&root)[0].id, "unrelated");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_decisions_only_state_resumes_with_manifest_last() {
        let root = root();
        write_legacy_marker(&root, &legacy_manifest());
        let repair = repair_dir(&root);
        fs::create_dir_all(&repair).unwrap();
        fs::write(repair.join("decisions.json"), BACKFILL_DECISIONS).unwrap();
        assert!(install_89af62bb_backfill(&root).unwrap());
        assert_eq!(
            fs::read(repair.join("decisions.json")).unwrap(),
            BACKFILL_DECISIONS
        );
        assert_eq!(
            fs::read(repair.join("manifest.json")).unwrap(),
            BACKFILL_MANIFEST
        );
        assert_eq!(load_verified_decisions(&root).len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_decisions_order_by_instant_before_date_and_id() {
        let root = root();
        for (id, date, merge, schema, recorded_at) in [
            (
                "decision-a",
                "2026-08-24",
                'a',
                3,
                "2026-08-24T12:00:00+02:00",
            ),
            ("decision-f", "2026-08-24", 'f', 3, "2026-08-24T11:00:00Z"),
            (
                "decision-b",
                "2026-08-20",
                'b',
                2,
                "2026-08-24T11:00:00.001Z",
            ),
        ] {
            let mut record = fixture(id, date, merge, schema);
            record["verification"]["recordedAt"] = serde_json::json!(recorded_at);
            write_backup(&root, id, record, true);
        }
        let records = load_verified_decisions(&root);
        assert_eq!(
            records.iter().map(|record| record.id.as_str()).collect::<Vec<_>>(),
            ["decision-b", "decision-f", "decision-a"]
        );
        assert_eq!(records[0].date, "2026-08-20");
        assert_eq!(records[0].summary.as_ref().unwrap().text, FALLBACK_SUMMARY);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_decisions_equal_instants_preserve_id_and_directory_ties() {
        let root = root();
        let mut first = fixture("decision-a", "2026-08-24", 'a', 3);
        first["verification"]["recordedAt"] = serde_json::json!("2026-08-24T10:00:00Z");
        let mut second = first.clone();
        second["verification"]["recordedAt"] = serde_json::json!("2026-08-24T12:00:00+02:00");
        second["summary"]["text"] = serde_json::json!(
            "Your later directory must not replace the first record at the same instant."
        );
        write_backup(&root, "a-first", first, true);
        write_backup(&root, "b-second", second.clone(), true);
        second["id"] = serde_json::json!("decision-f");
        second["evidence"]["merge"] = serde_json::json!("f".repeat(40));
        write_backup(&root, "0-other-merge", second, true);

        let records = load_verified_decisions(&root);
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "decision-a");
        assert_eq!(records[0].summary.as_ref().unwrap().text, FALLBACK_SUMMARY);
        assert_eq!(records[1].id, "decision-f");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verified_decisions_keep_freshest_duplicate_without_changing_evidence() {
        for (new_id, new_merge) in
            [("decision-a", 'a'), ("decision-f", 'a'), ("decision-a", 'f')]
        {
            let root = root();
            let mut old = fixture("decision-a", "2026-08-24", 'a', 3);
            old["verification"]["recordedAt"] = serde_json::json!("2026-08-24T12:00:00+02:00");
            let mut new = fixture(new_id, "2026-08-24", new_merge, 3);
            new["verification"]["recordedAt"] = serde_json::json!("2026-08-24T11:00:00Z");
            let summary = "Your latest protected update keeps your settings and includes the newest improvements.";
            new["summary"]["text"] = serde_json::json!(summary);
            let old_dir = write_backup(&root, "2026-08-24T10-00-00Z", old, true);
            let new_dir = write_backup(&root, "2026-08-24T11-00-00Z", new, true);
            let evidence: Vec<_> = [old_dir, new_dir]
                .into_iter()
                .flat_map(|dir| [dir.join("manifest.json"), dir.join("decisions.json")])
                .map(|path| {
                    let bytes = fs::read(&path).unwrap();
                    (path, bytes)
                })
                .collect();

            let records = load_verified_decisions(&root);
            assert_eq!(records.len(), 1);
            assert_eq!(records[0].id, new_id);
            assert_eq!(records[0].date, "2026-08-24");
            assert_eq!(records[0].verification.recorded_at, "2026-08-24T11:00:00Z");
            assert_eq!(records[0].summary.as_ref().unwrap().text, summary);
            for (path, bytes) in evidence {
                assert_eq!(fs::read(path).unwrap(), bytes);
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn loads_v2_with_native_fallback_and_v3_then_sorts_and_deduplicates() {
        let root = root();
        write_backup(&root, "older", fixture("same", "2026-08-20", 'a', 2), true);
        write_backup(&root, "newer", fixture("same", "2026-08-24", 'e', 3), true);
        write_backup(
            &root,
            "second",
            fixture("other", "2026-08-22", 'f', 2),
            true,
        );
        write_backup(
            &root,
            "unverified",
            fixture("hidden", "2026-08-25", '1', 3),
            false,
        );
        let mut malformed = fixture("bad", "2026-08-26", '2', 3);
        malformed["summary"]["text"] = serde_json::json!("short");
        write_backup(&root, "malformed", malformed, true);

        let records = load_verified_decisions(&root);

        assert_eq!(records.len(), 2);
        assert_eq!(records[0].id, "same");
        assert_eq!(records[0].summary.as_ref().unwrap().text, FALLBACK_SUMMARY);
        assert_eq!(records[1].id, "other");
        assert_eq!(records[1].summary.as_ref().unwrap().text, FALLBACK_SUMMARY);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn enriches_only_correlated_context_and_removes_the_evidence() {
        let root = root();
        let record = fixture("same", "2026-08-24", 'a', 3);
        let dir = write_backup(&root, "update", record.clone(), true);
        write_context(&dir, &record);
        let pending = load_pending_decision_summary(&root).unwrap().unwrap();
        assert!(pending.context_json.contains("baseToMerged"));

        complete_pending_decision_summary(
            pending,
            Some(
                "Your update now includes the latest improvements while preserving local behavior.",
            ),
        )
        .unwrap();

        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("decisions.json")).unwrap()).unwrap();
        assert_eq!(stored["summary"]["source"], "agent");
        assert_eq!(
            stored["summary"]["text"],
            "Your update now includes the latest improvements while preserving local behavior."
        );
        assert!(!dir.join("decision-summary-context.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_mismatched_context_and_preserves_fallback() {
        let root = root();
        let record = fixture("same", "2026-08-24", 'a', 3);
        let dir = write_backup(&root, "update", record.clone(), true);
        write_context(&dir, &record);
        let mut context: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("decision-summary-context.json")).unwrap())
                .unwrap();
        context["evidence"]["merge"] = serde_json::json!("f".repeat(40));
        fs::write(
            dir.join("decision-summary-context.json"),
            serde_json::to_vec(&context).unwrap(),
        )
        .unwrap();

        assert!(load_pending_decision_summary(&root).is_err());
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("decisions.json")).unwrap()).unwrap();
        assert_eq!(stored["summary"]["source"], "fallback");
        assert!(!dir.join("decision-summary-context.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn summary_failure_keeps_fallback_and_cleans_context() {
        let root = root();
        let record = fixture("same", "2026-08-24", 'a', 3);
        let dir = write_backup(&root, "update", record.clone(), true);
        write_context(&dir, &record);
        let pending = load_pending_decision_summary(&root).unwrap().unwrap();

        complete_pending_decision_summary(pending, None).unwrap();

        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join("decisions.json")).unwrap()).unwrap();
        assert_eq!(stored["summary"]["source"], "fallback");
        assert!(!dir.join("decision-summary-context.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
