"""Replay inspection development cases without calling a model service."""

import argparse
import base64
import hashlib
import json
from copy import deepcopy
from pathlib import Path

from orchard_workbench.extraction import Extraction
from orchard_workbench.orchard import apply_turn, evidence_alerts, new_record, pending_items, review, rule_candidates


DEFAULT_SUITE = Path(__file__).with_name("cases.json")
IMAGE_TYPES = {".jpg": "jpeg", ".jpeg": "jpeg", ".png": "png", ".webp": "webp"}


def load_image(directory, name):
    path = (directory / name).resolve()
    if not path.is_relative_to(directory) or path.suffix.lower() not in IMAGE_TYPES:
        raise ValueError(f"图片应位于案例目录下，格式为 JPG、PNG 或 WebP：{name}")
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError(f"图片超过 4 MB：{name}")
    data = path.read_bytes()
    image_type = IMAGE_TYPES[path.suffix.lower()]
    return f"data:image/{image_type};base64,{base64.b64encode(data).decode()}", hashlib.sha256(data).hexdigest()


def fixture_extractor(fixture):
    def extract(record, message, image):
        updates = rule_candidates(record, message).updates + fixture.get("extra_updates", [])
        if not image:
            return Extraction(updates)
        return Extraction(updates, fixture.get("visual", ""), fixture.get("photo_quality", "unassessed"),
                          fixture.get("visible_count"), fixture.get("count_scope", "unknown"))
    return extract


def snapshot(record):
    alerts = evidence_alerts(record)
    last = record["turns"][-1]
    return {
        "fields": record["fields"],
        "questions": record["questions"],
        "pending": pending_items(record),
        "alerts": [{key: alert[key] for key in ("reported", "visible", "turn")} for alert in alerts],
        "photo_quality": last["photo_quality"],
        "visual": last["visual"],
        "revisions": record["revisions"],
        "status": record["status"],
    }


def compare_expectations(actual, expected):
    checks = []
    for path, wanted in expected.items():
        found = actual
        present = True
        for key in path.split("."):
            if not isinstance(found, dict) or key not in found:
                found, present = None, False
                break
            found = found[key]
        checks.append({"path": path, "expected": wanted, "actual": found,
                       "present": present, "passed": present and found == wanted})
    return checks


def run_case(case, directory, mode, inputs):
    record = new_record(case["task"])
    steps = []
    variant = f"{mode}-{inputs}"
    for step in case["steps"]:
        image, digest = ("", None)
        if inputs == "multimodal" and "image" in step:
            image, digest = load_image(directory, step["image"])
        if "review" in step:
            review(record, step["review"])
        else:
            extractor = fixture_extractor(step.get("fixture", {})) if mode == "fixture" else None
            apply_turn(record, step["message"], image, extractor=extractor, rules_only=mode == "rules")
        actual = snapshot(record)
        expected = step.get("expect", {}) | step.get("expect_by_variant", {}).get(variant, {})
        steps.append({
            "input": {key: step[key] for key in ("message", "review") if key in step},
            "image": step.get("image") if image else None,
            "image_sha256": digest,
            "result": deepcopy(actual),
            "checks": compare_expectations(actual, expected),
        })
    checks = [check for step in steps for check in step["checks"]]
    if not checks:
        raise ValueError(f"案例缺少验收项：{case['id']}")
    return {"id": case["id"], "task": case["task"], "steps": steps,
            "passed": all(check["passed"] for check in checks)}


def main():
    parser = argparse.ArgumentParser(description="离线回放巡查开发案例，生成逐项验收结果。")
    parser.add_argument("--suite", type=Path, default=DEFAULT_SUITE)
    parser.add_argument("--mode", choices=("fixture", "rules"), default="fixture")
    parser.add_argument("--input", choices=("multimodal", "text"), default="multimodal")
    parser.add_argument("--output", type=Path, help="保存逐项验收结果的 JSON 路径")
    args = parser.parse_args()
    try:
        suite = args.suite.resolve()
        raw = suite.read_bytes()
        cases = json.loads(raw)["cases"]
        if not cases or len({case["id"] for case in cases}) != len(cases):
            raise ValueError("案例列表为空或编号重复。")
        results = [run_case(case, suite.parent, args.mode, args.input) for case in cases]
        checks = [check for case in results for step in case["steps"] for check in step["checks"]]
        passed = sum(check["passed"] for check in checks)
        report = {"kind": "offline_development_checks", "mode": args.mode, "input": args.input,
                  "suite_sha256": hashlib.sha256(raw).hexdigest(), "cases_passed": sum(case["passed"] for case in results),
                  "cases_total": len(results), "checks_passed": passed, "checks_total": len(checks), "cases": results}
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
        parser.exit(2, f"评测执行失败：{error}\n")
    print(f"离线开发检查（{args.mode} / {args.input}）：{report['cases_passed']}/{len(results)} 个案例，"
          f"{passed}/{len(checks)} 项断言通过。")
    for case in results:
        for index, step in enumerate(case["steps"], start=1):
            for check in step["checks"]:
                if not check["passed"]:
                    observed = repr(check["actual"]) if check["present"] else "缺失"
                    print(f"  {case['id']} 第 {index} 步 {check['path']}："
                          f"预期 {check['expected']!r}，实际 {observed}")
    if args.output:
        print(f"结果文件：{args.output}")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
