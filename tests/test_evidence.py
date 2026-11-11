import unittest

from orchard_workbench.extraction import Extraction
from orchard_workbench.orchard import apply_turn, evidence_alerts, new_record


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
