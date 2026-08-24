use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_JSON_BYTES: u64 = 1024 * 1024;
const MAX_CONTEXT_BYTES: u64 = 64 * 1024;
const MAX_DIFF_BYTES: usize = 12 * 1024;
const MAX_RECORDS: usize = 1000;
const MAX_CONTEXT_DECISIONS: usize = 20;
const MAX_CONTEXT_FILES: usize = 40;
const FALLBACK_SUMMARY: &str = "Your protected update completed successfully.";

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
    merged_head: String,
    timestamp: String,
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

fn correlated(manifest: &BackupManifest, record: &DecisionRecord) -> bool {
    manifest.verified
        && valid_record(record)
        && manifest.merged_head == record.evidence.merge
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
    let backups = repo_root.join(".gg/local-fixes/backups");
    let Ok(entries) = fs::read_dir(backups) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for entry in entries.flatten().take(MAX_RECORDS) {
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let manifest = read_json::<BackupManifest>(&entry.path().join("manifest.json"));
        let record = read_json::<DecisionRecord>(&entry.path().join("decisions.json"));
        let (Some(manifest), Some(record)) = (manifest, record) else {
            continue;
        };
        if correlated(&manifest, &record) {
            records.push(with_fallback(record));
        }
    }
    records.sort_by(|left, right| right.date.cmp(&left.date).then(left.id.cmp(&right.id)));
    let mut seen = HashSet::new();
    records.retain(|record| seen.insert(record.id.clone()));
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
    let entries = fs::read_dir(&backups).map_err(|_| "summary backup root unavailable".to_string())?;
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
        let mut record = read_json::<DecisionRecord>(&decisions_path)
            .ok_or("summary record unavailable")?;
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
    let cleanup = fs::remove_file(context_path).map_err(|_| "summary context cleanup failed".to_string());
    result.and(cleanup)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "gg-decisions-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
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
        fs::write(dir.join("decisions.json"), serde_json::to_vec(&record).unwrap()).unwrap();
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
    fn loads_v2_with_native_fallback_and_v3_then_sorts_and_deduplicates() {
        let root = root();
        write_backup(&root, "older", fixture("same", "2026-08-20", 'a', 2), true);
        write_backup(&root, "newer", fixture("same", "2026-08-24", 'e', 3), true);
        write_backup(&root, "second", fixture("other", "2026-08-22", 'f', 2), true);
        write_backup(&root, "unverified", fixture("hidden", "2026-08-25", '1', 3), false);
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
            Some("Your update now includes the latest improvements while preserving local behavior."),
        )
        .unwrap();

        let stored: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("decisions.json")).unwrap()).unwrap();
        assert_eq!(stored["summary"]["source"], "agent");
        assert_eq!(stored["summary"]["text"], "Your update now includes the latest improvements while preserving local behavior.");
        assert!(!dir.join("decision-summary-context.json").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_mismatched_context_and_preserves_fallback() {
        let root = root();
        let record = fixture("same", "2026-08-24", 'a', 3);
        let dir = write_backup(&root, "update", record.clone(), true);
        write_context(&dir, &record);
        let mut context: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("decision-summary-context.json")).unwrap()).unwrap();
        context["evidence"]["merge"] = serde_json::json!("f".repeat(40));
        fs::write(dir.join("decision-summary-context.json"), serde_json::to_vec(&context).unwrap()).unwrap();

        assert!(load_pending_decision_summary(&root).is_err());
        let stored: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("decisions.json")).unwrap()).unwrap();
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

        let stored: serde_json::Value = serde_json::from_slice(&fs::read(dir.join("decisions.json")).unwrap()).unwrap();
        assert_eq!(stored["summary"]["source"], "fallback");
        assert!(!dir.join("decision-summary-context.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
