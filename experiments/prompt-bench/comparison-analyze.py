"""Analyze the frozen three-arm study; stdlib only, no model judging or live calls."""
import argparse
import json
import math
import random
import statistics
from pathlib import Path

ARMS = ("current", "proposed", "extreme")
SEED = 20260909


def mean(values):
    return statistics.fmean(values) if values else None


def quantile(values, q):
    if not values:
        return None
    values = sorted(values)
    index = (len(values) - 1) * q
    low = math.floor(index)
    return values[low] + (values[math.ceil(index)] - values[low]) * (index - low)


def clustered_interval(per_fixture, transform=lambda x: x):
    """Resample whole task clusters, retaining their repeated matched observations."""
    if not per_fixture:
        return None
    randomizer = random.Random(SEED)
    means = [mean(values) for values in per_fixture.values() if values]
    if not means:
        return None
    draws = [transform(mean(randomizer.choices(means, k=len(means)))) for _ in range(10000)]
    return [quantile(draws, 0.025), quantile(draws, 0.975)]


def wilson(passed, total):
    if not total:
        return None
    z = 1.959963984540054
    p = passed / total
    center = (p + z * z / (2 * total)) / (1 + z * z / total)
    half = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / (1 + z * z / total)
    return [100 * (center - half), 100 * (center + half)]


def analyze(directory):
    root = Path(directory)
    protocol = json.loads((root / "protocol.json").read_text())
    samples = []
    for job in protocol["jobs"]:
        for arm in job["arms"]:
            artifact = (root / f"{job['fixture']}-{job['round']}-{arm}.json").resolve()
            if not artifact.is_relative_to(root.resolve()):
                raise ValueError("Artifact path outside study directory")
            if not artifact.exists():
                raise ValueError("Study incomplete; no comparative headline")
            samples.append(json.loads(artifact.read_text()))
    expected = sum(len(job["arms"]) for job in protocol["jobs"])
    keys = [(r["fixture"], r["round"], r["arm"]) for r in samples]
    if len(set(keys)) != len(keys):
        raise ValueError("Duplicate trial IDs; refusing to count a rerun twice")
    expected_keys = {(j["fixture"], j["round"], a) for j in protocol["jobs"] for a in j["arms"]}
    if set(keys) != expected_keys:
        raise ValueError(f"Study incomplete: {len(samples)}/{expected}; no comparative headline")
    fixtures = sorted({r["fixture"] for r in samples})
    pairs = {(r["fixture"], r["round"], r["arm"]): r for r in samples}
    shared_success = {(r["fixture"], r["round"]) for r in samples if all(pairs[(r["fixture"], r["round"], a)]["passed"] for a in ARMS)}
    summary = []
    for arm in ARMS:
        rows = [r for r in samples if r["arm"] == arm]
        total_inputs = [r["inputTokens"] + r["cacheRead"] + r["cacheWrite"] for r in rows]
        total_tokens = [n + r["outputTokens"] for n, r in zip(total_inputs, rows)]
        success = sum(r["passed"] for r in rows)
        values = {
            "arm": arm, "n": len(rows), "strictPasses": success,
            "strictPassPercent": success / len(rows) * 100,
            "strictPassWilson95": wilson(success, len(rows)),
            "reliabilityScore": mean([r["score"] for r in rows]),
            "reliabilityCluster95": clustered_interval({f: [r["score"] for r in rows if r["fixture"] == f] for f in fixtures}),
            "medianSeconds": statistics.median(r["wallMs"] for r in rows) / 1000,
            "meanSeconds": mean([r["wallMs"] for r in rows]) / 1000,
            "p90Seconds": quantile([r["wallMs"] / 1000 for r in rows], 0.9),
            "meanInputTokensIncludingCache": mean(total_inputs),
            "meanUncachedInputTokens": mean([r["inputTokens"] for r in rows]),
            "meanOutputTokensIncludingReasoning": mean([r["outputTokens"] for r in rows]),
            "meanTotalTokens": mean(total_tokens),
            "cacheReadFraction": sum(r["cacheRead"] for r in rows) / sum(total_inputs) if sum(total_inputs) else None,
            "meanReasoningTokens": mean([r["reasoningTokens"] for r in rows if r["reasoningTokens"] is not None]),
            "meanModelTurns": mean([r["modelTurns"] for r in rows]),
            "meanToolCalls": mean([len(r["calls"]) for r in rows]),
            "meanResearchCalls": mean([r["researchCalls"] for r in rows]),
            "meanChecks": mean([r["checkCalls"] for r in rows]),
            "meanRedundantChecks": mean([r["redundantChecks"] for r in rows]),
            "meanUnnecessaryQuestions": mean([r["unnecessaryQuestions"] for r in rows]),
            "meanHooks": mean([r["hookCalls"] for r in rows]),
            "retries": sum(r["retries"] for r in rows),
            "statuses": {s: sum(r["status"] == s for r in rows) for s in sorted({r["status"] for r in rows})},
            "meanProviderSeconds": mean([r["providerMs"] for r in rows]) / 1000,
            "medianFirstResponseSeconds": quantile([r["firstResponseMs"] / 1000 for r in rows if r["firstResponseMs"] is not None], 0.5),
            "meanToolSeconds": mean([r["toolMs"] for r in rows]) / 1000,
            "criteria": {k: sum(r["checks"][k] for r in rows) for k in rows[0]["checks"]},
            "failures": [{"fixture": r["fixture"], "round": r["round"], "status": r["status"], "criteria": [k for k,v in r["checks"].items() if not v], "violations": r["safetyViolations"]} for r in rows if not r["passed"]],
        }
        if arm != "current":
            for label, matching in [("allMatched", {(r["fixture"], r["round"]) for r in rows}), ("allArmsSucceeded", shared_success)]:
                per_fixture = {}
                token_per_fixture = {}
                for f, round_ in sorted(matching):
                    current = pairs[(f, round_, "current")]
                    candidate = pairs[(f, round_, arm)]
                    per_fixture.setdefault(f, []).append(math.log(candidate["wallMs"] / current["wallMs"]))
                    current_tokens = sum(current[k] for k in ("inputTokens", "cacheRead", "cacheWrite", "outputTokens"))
                    candidate_tokens = sum(candidate[k] for k in ("inputTokens", "cacheRead", "cacheWrite", "outputTokens"))
                    if current_tokens > 0 and candidate_tokens > 0:
                        token_per_fixture.setdefault(f, []).append(math.log(candidate_tokens / current_tokens))
                faster = lambda x: 100 * (1 - math.exp(x))
                values[label] = {
                    "matchedBlocks": len(matching), "taskClusters": len(per_fixture),
                    "fasterPercent": faster(mean([mean(x) for x in per_fixture.values()])) if per_fixture else None,
                    "fasterCluster95": clustered_interval(per_fixture, faster),
                    "fewerTokensPercent": faster(mean([mean(x) for x in token_per_fixture.values()])) if token_per_fixture else None,
                    "fewerTokensCluster95": clustered_interval(token_per_fixture, faster),
                }
        values["byFixture"] = {f: {"n": len([r for r in rows if r["fixture"] == f]), "passes": sum(r["passed"] for r in rows if r["fixture"] == f), "medianSeconds": quantile([r["wallMs"] / 1000 for r in rows if r["fixture"] == f], 0.5), "score": mean([r["score"] for r in rows if r["fixture"] == f])} for f in fixtures}
        summary.append(values)
    result = {"model": protocol["model"], "thinking": protocol["thinking"], "trials": len(samples), "sharedSuccessfulBlocks": len(shared_success), "summary": summary,
              "interpretation": "Observed simulator results, not production-app latency or a universal reliability guarantee. Speed CIs resample task clusters, retaining paired repetitions. Wilson intervals are descriptive within-suite binomial intervals; repeats are not new task types. Tokens are provider-reported, including cache and reasoning; absent fields are not estimated."}
    (root / "summary.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    args = parser.parse_args()
    analyze(args.directory)
