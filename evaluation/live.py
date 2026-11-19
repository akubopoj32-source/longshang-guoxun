"""Compare real model candidates with the inspection workflow on synthetic cases."""

import argparse
import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path
from time import monotonic

from evaluation.run import compare_expectations, load_image
from orchard_workbench.extraction import ModelUnavailable, extract_with_model, model_enabled
from orchard_workbench.orchard import TASKS, apply_turn, evidence_alerts, new_record


DEFAULT_SUITE = Path(__file__).with_name("live_cases.json")
GROUPS = ("text", "image_candidates", "image_constrained")


def evaluate_step(record, step, image, use_image):
    message = step["message"]
    expected = step["expect"]
    started = monotonic()
    extraction = None

    def capture_candidates(current_record, current_message, current_image):
        nonlocal extraction
        extraction = extract_with_model(current_record, TASKS[current_record["task"]]["fields"],
                                        current_message, current_image)
        return extraction

    apply_turn(record, message, image, extractor=capture_candidates)
    turn = record["turns"][-1]
    fields = {key: field["value"] for key, field in record["fields"].items()}
    written = {key for key, field in record["fields"].items()
               if field["status"] in ("recorded", "conflict")}
    alerts = evidence_alerts(record)
    count_conflict = any(alert["turn"] == turn["id"] for alert in alerts)
    checks = {
        "fields": compare_expectations(fields, expected["fields"]),
        "unsupported": compare_expectations(
            {key: key in written for key in expected.get("omit", [])},
            dict.fromkeys(expected.get("omit", []), False),
        ),
        "corrections": compare_expectations(fields, expected.get("corrections", {})),
    }
    if "visible_count" in expected:
        checks["visual"] = compare_expectations(
            {"visible_count": turn["visible_count"], "count_conflict": count_conflict},
            {"visible_count": expected["visible_count"] if use_image else None,
             "count_conflict": expected.get("count_conflict", False) and use_image},
        )
    history = [key for key, field in record["fields"].items()
               if any(source.get("superseded") for source in field["evidence"])]
    details = {"fields": record["fields"].copy(), "questions": record["questions"],
               "correction_history": history, "photo_quality": turn["photo_quality"],
               "visual": turn["visual"], "visible_count": turn["visible_count"],
               "count_conflict": count_conflict, "alerts": alerts, "checks": checks,
               "elapsed_seconds": round(monotonic() - started, 3)}
    if retained := expected.get("retained"):
        checks["retention"] = compare_expectations(fields, retained)
    if corrections := expected.get("corrections"):
        checks["traceability"] = compare_expectations(
            {key: key in history for key in corrections}, dict.fromkeys(corrections, True))

    candidates = {item["field"]: item.get("value") for item in extraction.updates
                  if isinstance(item, dict) and isinstance(item.get("field"), str)
                  and item.get("status") in ("recorded", "conflict")}
    unsupported = {key: key in candidates for key in expected.get("omit", [])}
    claimed = {item["field"]: item.get("value") for item in extraction.updates
               if isinstance(item, dict) and isinstance(item.get("field"), str)
               and item.get("correction") is True and item.get("status") in ("recorded", "conflict")}
    candidate_checks = {
        "fields": compare_expectations(candidates, expected["fields"]),
        "unsupported": compare_expectations(unsupported, dict.fromkeys(unsupported, False)),
        "corrections": compare_expectations(claimed, expected.get("corrections", {})),
    }
    if use_image and "visible_count" in expected:
        candidate_checks["visual"] = compare_expectations(
            {"visible_count": extraction.visible_count}, {"visible_count": expected["visible_count"]})
    return details, {"extraction": asdict(extraction), "checks": candidate_checks}


def run_case(case, directory):
    text_record = new_record(case["task"])
    image_record = new_record(case["task"])
    steps = []
    for step in case["steps"]:
        image, digest = load_image(directory, step["image"]) if "image" in step else ("", None)
        result = {}
        for group, record, photo in (("text", text_record, ""), ("image_constrained", image_record, image)):
            try:
                result[group], candidates = evaluate_step(record, step, photo, bool(photo))
                if group == "image_constrained":
                    result["image_candidates"] = candidates
            except ModelUnavailable as error:
                result[group] = {"error": str(error)}
                if group == "image_constrained":
                    result["image_candidates"] = {"error": str(error)}
        steps.append({"message": step["message"], "image": step.get("image"),
                      "image_sha256": digest, "expect": step["expect"], "groups": result})
        if any("error" in output for output in result.values()):
            break
    return {"id": case["id"], "steps_total": len(case["steps"]), "steps": steps}


def summarize(cases, group):
    metrics = {key: {"passed": 0, "total": 0} for key in
               ("fields", "unsupported", "corrections", "visual", "retention", "traceability")}
    errors = 0
    for case in cases:
        for step in case["steps"]:
            result = step["groups"][group]
            errors += "error" in result
            for category, checks in result.get("checks", {}).items():
                metrics[category]["total"] += len(checks)
                metrics[category]["passed"] += sum(check["passed"] for check in checks)
    return {"errors": errors, "metrics": metrics}


def main():
    parser = argparse.ArgumentParser(description="对模拟巡查案例运行真实模型对照评测。")
    parser.add_argument("--suite", type=Path, default=DEFAULT_SUITE)
    parser.add_argument("--output", type=Path, required=True, help="保存逐步输出和断言的 JSON 路径")
    args = parser.parse_args()
    if not model_enabled():
        parser.error("请先在本机配置 ORCHARD_MODEL_URL 和 ORCHARD_MODEL。")
    try:
        suite = args.suite.resolve()
        raw = suite.read_bytes()
        cases = json.loads(raw)["cases"]
        if not cases or len({case["id"] for case in cases}) != len(cases):
            raise ValueError("案例列表为空或编号重复。")
        results = [run_case(case, suite.parent) for case in cases]
        groups = {group: summarize(results, group) for group in GROUPS}
        report = {"kind": "live_model_synthetic_comparison", "model": os.environ["ORCHARD_MODEL"],
                  "suite_sha256": hashlib.sha256(raw).hexdigest(), "groups": groups, "cases": results}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f"评测执行失败：{error}\n")
    for group, summary in groups.items():
        fields = summary["metrics"]["fields"]
        unsupported = summary["metrics"]["unsupported"]
        correction = summary["metrics"]["corrections"]
        visual = summary["metrics"]["visual"]
        print(f"{group} 字段 {fields['passed']}/{fields['total']}，"
              f"无依据填报 {unsupported['total'] - unsupported['passed']}/{unsupported['total']}，"
              f"更正 {correction['passed']}/{correction['total']}，"
              f"照片数量与差异检查 {visual['passed']}/{visual['total']}，服务异常 {summary['errors']}")
    print(f"结果文件：{args.output}")
    if any(summary["errors"] for summary in groups.values()):
        return 2
    return 1 if any(m["passed"] < m["total"] for s in groups.values() for m in s["metrics"].values()) else 0


if __name__ == "__main__":
    raise SystemExit(main())
