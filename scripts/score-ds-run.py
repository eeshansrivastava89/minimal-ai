#!/usr/bin/env python3
"""Score a data-science benchmark run against the canonical oracle.

Usage:
    python scripts/score-ds-run.py <run-directory> [--oracle <oracle.json>]

Evaluates whether a local model produced a correct, complete agentic data-science
analysis: external data access, statistical correctness, methodology, visualizations,
and decision quality — 12 deterministic checks, 100 points total.
"""

import json
import re
import sys
from pathlib import Path

ORACLE_REF = Path(__file__).parent / "oracle" / "ab-test-analysis-oracle.json"


def check_summary_valid(run_dir: Path) -> dict:
    """summary.json exists, parses, and has all required fields."""
    path = run_dir / "summary.json"
    if not path.is_file():
        return {"pass": False, "detail": "summary.json not found"}
    try:
        data = json.loads(path.read_text("utf8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        return {"pass": False, "detail": f"parse error: {e}"}

    required = ["status", "recommended_variant", "raw_stats"]
    raw_required = [
        "p_value", "cohens_d", "mean_a", "mean_b",
        "completion_rate_a", "completion_rate_b", "srm_p_value"
    ]
    missing = [f for f in required if f not in data]
    if "raw_stats" in data:
        missing += [f"raw_stats.{f}" for f in raw_required if f not in data.get("raw_stats", {})]
    if missing:
        return {"pass": False, "detail": f"missing: {', '.join(missing)}", "data": data}
    return {"pass": True, "detail": f"parsed {len(json.dumps(data))} bytes, all required fields present", "data": data}


def read_notebook_source(run_dir: Path) -> str:
    """Extract all code from the analysis notebook or a .py fallback."""
    nb_path = run_dir / "analysis.ipynb"
    if nb_path.is_file():
        try:
            nb = json.loads(nb_path.read_text("utf8"))
            return "\n".join(
                "".join(c.get("source", []))
                for c in nb.get("cells", [])
                if c.get("cell_type") == "code"
            )
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    # Fallback: if no notebook, try any .py file (some models write scripts instead)
    py_files = sorted(run_dir.glob("*.py"))
    if py_files:
        return py_files[0].read_text("utf8")
    return ""


def check_data_access(source: str) -> dict:
    """Model queried real Supabase data (not hardcoded numbers)."""
    has_api_call = bool(re.search(r"requests\.(get|post)\s*\(", source))
    has_url = bool(re.search(r"SUPABASE_URL|supabase.*rest|nazioidbiydxduonenmb", source, re.IGNORECASE))
    has_key = bool(re.search(r"apikey|api_key|ANON_KEY", source, re.IGNORECASE))
    # Config-file pattern: reads supabase.json then makes API calls using loaded values
    has_config_read = bool(re.search(r"open\(['\"]supabase\.json['\"]\)", source))
    has_config_usage = bool(re.search(r"(cfg|config|supabase_config)\s*\[['\"]", source))

    if has_api_call and has_url:
        return {"pass": True, "detail": "Supabase API calls with inline credentials"}
    if has_api_call and has_key:
        return {"pass": True, "detail": "API calls with auth headers"}
    if has_api_call and has_config_read:
        return {"pass": True, "detail": "API calls using supabase.json config"}
    # Broader: any API call in a file that loaded supabase.json
    if has_api_call and has_config_usage:
        return {"pass": True, "detail": "API calls with config-loaded credentials"}
    return {"pass": False, "detail": "no Supabase API calls detected in source"}


def check_data_quality(source: str) -> dict:
    """Notebook includes data validation: null handling, type conversion, sanity checks."""
    has_null = bool(re.search(
        r"dropna|fillna|isnull|isna|notnull|notna|\.info\(\)|\.describe\(\)|\.dtypes",
        source
    ))
    has_convert = bool(re.search(
        r"pd\.to_numeric|astype\(|pd\.to_datetime",
        source
    ))
    has_validate = bool(re.search(
        r"assert|raise.*[Vv]alue|print\(.*[Vv]alidation|print\(.*[Ss]anity|# [Ss]anity|# [Vv]alidate",
        source
    ))
    found = []
    if has_null: found.append("null handling")
    if has_convert: found.append("type conversion")
    if has_validate: found.append("validation/asserts")
    if len(found) >= 2:
        return {"pass": True, "detail": ", ".join(found)}
    if found:
        return {"pass": False, "detail": f"only found {found[0]} (need 2+)"}
    return {"pass": False, "detail": "no data quality checks detected"}


def check_srm(source: str) -> dict:
    """Sample ratio mismatch test."""
    if re.search(r"SRM|sample.?ratio|mismatch|chi2.*sample|chisquare.*variant", source, re.IGNORECASE):
        return {"pass": True, "detail": "SRM check found"}
    return {"pass": False, "detail": "no SRM check detected"}


def check_hypothesis_tests(source: str) -> dict:
    """Both t-test and chi-square present."""
    has_ttest = bool(re.search(r"ttest_ind|ttest_rel|ttest_1samp|welch", source, re.IGNORECASE))
    has_chi2 = bool(re.search(r"chi2_contingency|chisquare|chi2\b", source))
    found = []
    if has_ttest: found.append("t-test")
    if has_chi2: found.append("chi-square")
    if has_ttest and has_chi2:
        return {"pass": True, "detail": f"found: {', '.join(found)}"}
    if has_ttest:
        return {"pass": False, "detail": f"found t-test, missing chi-square"}
    return {"pass": False, "detail": "no t-test or chi-square found"}


def check_tolerance(actual, expected, tolerance, label: str) -> dict:
    """Generic numeric tolerance check."""
    if actual is None:
        return {"pass": False, "detail": f"{label} missing from run"}
    within = abs(actual - expected) <= tolerance
    return {"pass": within, "detail": f"got {actual:.6g}, oracle {expected:.6g}, tolerance ±{tolerance:.4g}"}


def check_abs_tolerance(actual, expected, tolerance, label: str) -> dict:
    """Numeric tolerance using absolute values (sign convention agnostic)."""
    if actual is None:
        return {"pass": False, "detail": f"{label} missing from run"}
    within = abs(abs(actual) - abs(expected)) <= tolerance
    return {"pass": within, "detail": f"got {actual:.6g}, oracle {expected:.6g}, tolerance ±{tolerance:.4g}"}


def check_charts_exist(run_dir: Path) -> dict:
    charts = ["chart-distribution.png", "chart-treatment-effect.png", "chart-completion-rates.png"]
    found = [c for c in charts if (run_dir / c).is_file()]
    if len(found) == 3:
        return {"pass": True, "detail": "all 3 chart files present"}
    missing = [c for c in charts if c not in found]
    return {"pass": False, "detail": f"found {len(found)}/3, missing: {', '.join(missing)}"}


def check_charts_labeled(source: str) -> dict:
    """Charts have titles and axis labels."""
    has_title = bool(re.search(r"\.set_title\(|plt\.title\(|\.suptitle\(|title\s*=", source))
    has_xlabel = bool(re.search(r"\.set_xlabel\(|plt\.xlabel\(|xlabel\s*=", source))
    has_ylabel = bool(re.search(r"\.set_ylabel\(|plt\.ylabel\(|ylabel\s*=", source))
    found = []
    if has_title: found.append("titles")
    if has_xlabel: found.append("x-labels")
    if has_ylabel: found.append("y-labels")
    if len(found) >= 2:
        return {"pass": True, "detail": ", ".join(found)}
    if found:
        return {"pass": False, "detail": f"only {', '.join(found)} (need titles + labels)"}
    return {"pass": False, "detail": "no chart labels or titles detected"}


def check_recommended_variant(data: dict, oracle: dict) -> dict:
    actual = data.get("recommended_variant")
    expected = oracle.get("recommended_variant")
    match = actual == expected
    return {"pass": match, "detail": f"got '{actual}', expected '{expected}'"}


def check_decision_grounded(data: dict, source: str) -> dict:
    """Decision/recommendation cites specific data, not vague hand-waving."""
    decision = data.get("decision", "")
    refs = []
    # References specific numbers or statistical language
    if re.search(r"\d+\.?\d*\s*%", decision):
        refs.append("specific rates")
    if re.search(r"p\s*[<=>]\s*0\.\d+|p.?value|p value", decision, re.IGNORECASE):
        refs.append("p-value")
    if re.search(r"Cohen|effect size|d\s*[<=>=\-]\s*[\d.]", decision, re.IGNORECASE):
        refs.append("effect size")
    if re.search(r"significant", decision, re.IGNORECASE):
        refs.append("statistical significance")
    # Check notebook conclusion section exists
    if re.search(r"conclusion|recommendation|decision|verdict", source, re.IGNORECASE):
        refs.append("conclusion section")
    # Check for metric names in decision
    metrics = ["completion time", "completion rate", "repeat rate"]
    for m in metrics:
        if m in decision.lower():
            refs.append(m)
            break
    if len(refs) >= 2:
        return {"pass": True, "detail": ", ".join(refs[:3])}
    if refs:
        return {"pass": False, "detail": f"only {refs[0]} (need 2+ references)"}
    return {"pass": False, "detail": "decision does not cite specific data"}


# --- Score computation ---

CHECKS = [
    ("summary_valid",         "summary.json valid",                   5),
    ("data_access",           "Data accessed from Supabase",           15),
    ("data_quality",          "Data quality checks in notebook",      5),
    ("srm_test",              "SRM test performed",                    5),
    ("hypothesis_tests",      "Hypothesis tests (t-test + chi²)",     10),
    ("p_value",               "p_value accuracy",                     10),
    ("cohens_d",              "Cohen's d accuracy",                   10),
    ("completion_rates",      "Completion rates match oracle",        10),
    ("charts_exist",          "3 chart files exist",                  10),
    ("charts_labeled",        "Charts have labels and titles",         5),
    ("recommended_variant",   "recommended_variant correct",          10),
    ("decision_grounded",     "Decision cites specific data",          5),
]


def score_run(run_dir: Path, oracle: dict) -> dict:
    summary_result = check_summary_valid(run_dir)
    data = summary_result.get("data", {})
    source = read_notebook_source(run_dir)
    tol = oracle.get("tolerance", {})

    results = {}
    points = 0
    total = 0

    for check_id, label, max_pts in CHECKS:
        total += max_pts
        if check_id == "summary_valid":
            r = summary_result
        elif check_id == "data_access":
            r = check_data_access(source)
        elif check_id == "data_quality":
            r = check_data_quality(source)
        elif check_id == "srm_test":
            r = check_srm(source)
        elif check_id == "hypothesis_tests":
            r = check_hypothesis_tests(source)
        elif check_id == "p_value":
            actual = data.get("raw_stats", {}).get("p_value")
            expected = oracle.get("raw_stats", {}).get("p_value")
            r = check_tolerance(actual, expected, tol.get("p_value", 0.05), "p_value")
        elif check_id == "cohens_d":
            actual = data.get("raw_stats", {}).get("cohens_d")
            expected = oracle.get("raw_stats", {}).get("cohens_d")
            r = check_abs_tolerance(actual, expected, tol.get("cohens_d", 0.1), "cohens_d")
        elif check_id == "completion_rates":
            # Check both completion rates against oracle
            stats = data.get("raw_stats", {})
            rate_a = stats.get("completion_rate_a")
            rate_b = stats.get("completion_rate_b")
            oracle_rate_a = oracle.get("raw_stats", {}).get("completion_rate_a")
            oracle_rate_b = oracle.get("raw_stats", {}).get("completion_rate_b")
            t = tol.get("rate_pct", 0.05)
            a_ok = rate_a is not None and abs(rate_a - oracle_rate_a) <= t
            b_ok = rate_b is not None and abs(rate_b - oracle_rate_b) <= t
            if a_ok and b_ok:
                r = {"pass": True, "detail": f"A:{rate_a:.4f} B:{rate_b:.4f}, oracle A:{oracle_rate_a:.4f} B:{oracle_rate_b:.4f}"}
            elif not a_ok and not b_ok:
                r = {"pass": False, "detail": f"both rates off: A:{rate_a} B:{rate_b}, oracle A:{oracle_rate_a} B:{oracle_rate_b}"}
            else:
                which = "A" if not a_ok else "B"
                r = {"pass": False, "detail": f"rate {which} off (tolerance ±{t})"}
        elif check_id == "charts_exist":
            r = check_charts_exist(run_dir)
        elif check_id == "charts_labeled":
            r = check_charts_labeled(source)
        elif check_id == "recommended_variant":
            r = check_recommended_variant(data, oracle)
        elif check_id == "decision_grounded":
            r = check_decision_grounded(data, source)
        else:
            r = {"pass": False, "detail": "unknown check"}

        earned = max_pts if r["pass"] else 0
        points += earned
        results[check_id] = {
            "label": label,
            "max": max_pts,
            "earned": earned,
            "pass": r["pass"],
            "detail": r.get("detail", ""),
        }

    return {
        "total": total,
        "earned": points,
        "pct": round(points / total * 100, 1) if total > 0 else 0,
        "checks": results,
    }


def load_oracle(path: Path) -> dict:
    if not path.is_file():
        print(f"Error: oracle file not found: {path}", file=sys.stderr)
        sys.exit(1)
    return json.loads(path.read_text("utf8"))


def main():
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <run-directory> [--oracle <oracle.json>]", file=sys.stderr)
        sys.exit(1)

    run_dir = Path(sys.argv[1])
    if not run_dir.is_dir():
        print(f"Error: {run_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    oracle_path = ORACLE_REF
    for i, arg in enumerate(sys.argv[2:], 2):
        if arg == "--oracle" and i + 1 < len(sys.argv):
            oracle_path = Path(sys.argv[i + 1])

    oracle = load_oracle(oracle_path)
    scorecard = score_run(run_dir, oracle)
    print(json.dumps(scorecard, indent=2))


if __name__ == "__main__":
    main()
