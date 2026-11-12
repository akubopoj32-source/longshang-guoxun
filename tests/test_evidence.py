import unittest

from orchard_workbench.extraction import Extraction
from orchard_workbench.orchard import apply_turn, evidence_alerts, new_record, pending_items, review, review_field


PHOTO = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/N5kAAAAASUVORK5CYII="
)


def count_extraction(scope):
    def extract(_record, _message, _image):
        return Extraction(
            [{"field": "quantity", "value": "两只", "quote": "看到两只疑似虫体",
              "status": "recorded"}],
            "模型估计照片中可见三只",
            "usable",
            3,
            scope,
        )
    return extract


class EvidenceTests(unittest.TestCase):
    def test_quantity_difference_survives_repeat_but_not_correction(self):
        record = new_record("trap")
        apply_turn(record, "看到两只疑似虫体", PHOTO, count_extraction("complete"))
        apply_turn(record, "看到两只疑似虫体", rules_only=True)
        self.assertEqual(record["fields"]["quantity"]["value"], "两只")
        alert, = evidence_alerts(record)
        self.assertEqual((alert["reported"], alert["visible"], alert["turn"]), (2, 3, 1))

        apply_turn(record, "更正为三只", rules_only=True)
        self.assertEqual(evidence_alerts(record), [])
        self.assertEqual(record["turns"][0]["visible_count"], 3)

    def test_partial_photo_is_not_used_to_check_reported_count(self):
        record = new_record("trap")
        apply_turn(record, "看到两只疑似虫体", PHOTO, count_extraction("partial"))
        self.assertEqual(evidence_alerts(record), [])

    def test_manual_review_keeps_previous_quantity_and_photo_discrepancy(self):
        record = new_record("trap")
        apply_turn(record, "看到两只疑似虫体", PHOTO, count_extraction("complete"))
        review(record, "submit")
        review_field(record, "quantity", "mark_unknown", note="待现场清点")

        self.assertEqual(record["version"], 2)
        self.assertEqual(record["fields"]["quantity"]["status"], "unknown")
        self.assertIn("观察数量", pending_items(record))
        entry, = record["field_reviews"]
        self.assertEqual(entry["before"]["value"], "两只")
        self.assertEqual(entry["alerts"][0]["visible"], 3)
        self.assertEqual(record["turns"][0]["image"], PHOTO)
        review(record, "confirm")
        self.assertEqual(record["reviews"][-1]["version"], 2)

    def test_correction_requires_evidence_and_preserves_version_on_failure(self):
        record = new_record("trap")
        apply_turn(record, "三号点看到两只疑似虫体", rules_only=True)
        review(record, "submit")
        with self.assertRaises(ValueError):
            review_field(record, "location", "correct", "五号点")
        self.assertEqual(record["version"], 1)
        review_field(record, "location", "correct", "五号点", "与现场点位标识核对")
        self.assertEqual(record["fields"]["location"]["value"], "五号点")
        self.assertEqual(record["field_reviews"][0]["note"], "与现场点位标识核对")
