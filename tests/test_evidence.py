import unittest
from unittest.mock import patch

from orchard_workbench.extraction import Extraction, ModelUnavailable
from orchard_workbench.orchard import apply_turn, evidence_alerts, new_record, pending_items, review, review_field


PHOTO = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/N5kAAAAASUVORK5CYII="
)
FULL_BOARD = {"single_board": True, "top": True, "right": True, "bottom": True,
              "left": True, "countable": True, "visible_count": 3}


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
    def test_model_quantity_omission_recovers_spoken_count_and_image_alert(self):
        record = new_record("trap")
        message = "三号点看到两只疑似虫体"
        with patch("orchard_workbench.extraction.request_model_json", return_value=FULL_BOARD):
            apply_turn(record, message, PHOTO, lambda *_: Extraction([], "图中有三个标记", "usable", 3, "complete"))

        quantity = record["fields"]["quantity"]
        self.assertEqual(quantity["value"], "两只")
        self.assertEqual(quantity["evidence"], [{"turn": 1, "quote": message, "source": "text"}])
        alert, = evidence_alerts(record)
        self.assertEqual((alert["reported"], alert["visible"], alert["turn"]), (2, 3, 1))

    def test_quantity_recovery_requires_an_unambiguous_spoken_count(self):
        for message in ("看到约两只虫体", "看到两三只虫体", "看到两只虫体以上",
                        "看到两只虫体，后来又看到三只虫体", "没有看见两只虫体", "更正：可能看到两只虫体",
                        "上传两只诱捕器的照片", "看到两只虫体的照片", "如果看到两只虫体就通知我",
                        "观察数量记不清", "只上传图片"):
            with self.subTest(message=message):
                record = new_record("trap")
                apply_turn(record, message, PHOTO, lambda *_: Extraction([], "图中有三个标记", "usable", 3, "complete"),
                           photo_verifier=lambda image, *, timeout: 3)
                self.assertNotIn("quantity", record["fields"])
                self.assertEqual(evidence_alerts(record), [])

    def test_quantity_recovery_preserves_model_uncertainty(self):
        record = new_record("trap")
        message = "看到两只疑似虫体"
        result = Extraction([{"field": "quantity", "value": "未知", "quote": message, "status": "unknown"}])
        apply_turn(record, message, extractor=lambda *_: result)
        self.assertEqual(record["fields"]["quantity"]["status"], "unknown")

    def test_quantity_difference_survives_repeat_but_not_correction(self):
        record = new_record("trap")
        with patch("orchard_workbench.extraction.request_model_json", return_value=FULL_BOARD):
            apply_turn(record, "看到两只疑似虫体", PHOTO, count_extraction("complete"))
        apply_turn(record, "看到两只疑似虫体", rules_only=True)
        self.assertEqual(record["fields"]["quantity"]["value"], "两只")
        alert, = evidence_alerts(record)
        self.assertEqual((alert["reported"], alert["visible"], alert["turn"]), (2, 3, 1))

        apply_turn(record, "更正为四只", rules_only=True)
        self.assertEqual(record["fields"]["quantity"]["value"], "四只")
        self.assertTrue(record["fields"]["quantity"]["evidence"][1]["superseded"])
        self.assertEqual(evidence_alerts(record), [])
        self.assertEqual(record["turns"][0]["visible_count"], 3)

    def test_partial_photo_is_not_used_to_check_reported_count(self):
        record = new_record("trap")
        apply_turn(record, "看到两只疑似虫体", PHOTO, count_extraction("partial"))
        self.assertEqual(evidence_alerts(record), [])

    def test_quantity_phrase_keeps_the_quote_and_compares_its_number(self):
        for phrase, number in (("三只疑似虫体", 3), ("二十一只虫体", 21), ("0只虫体", 0)):
            with self.subTest(phrase=phrase):
                record = new_record("trap")
                message = "今天上午，三号监测点看到" + phrase + "。"
                candidate = {"field": "quantity", "value": phrase, "quote": message, "status": "recorded"}
                with patch("orchard_workbench.extraction.request_model_json", return_value={**FULL_BOARD, "visible_count": 2}):
                    apply_turn(record, message, PHOTO, lambda *_: Extraction([candidate], "", "usable", 2, "complete"))
                quantity = record["fields"]["quantity"]
                self.assertEqual(quantity["value"], phrase.split("只")[0] + "只")
                self.assertEqual(quantity["evidence"][0]["quote"], message)
                alert, = evidence_alerts(record)
                self.assertEqual(alert["reported"], number)
                # A record written before the normalization stores the entire phrase.
                quantity["value"] = phrase
                self.assertEqual(evidence_alerts(record)[0]["reported"], number)

    def test_unqualified_model_quote_cannot_hide_uncertain_spoken_count(self):
        for message in ("看到大约三只疑似虫体", "看到两三只疑似虫体", "看到2-三只疑似虫体", "没有看到三只疑似虫体"):
            with self.subTest(message=message):
                record = new_record("trap")
                candidate = {"field": "quantity", "value": "三只", "quote": "三只", "status": "recorded"}
                apply_turn(record, message, PHOTO, lambda *_: Extraction([candidate], "", "usable", 2, "complete"),
                           photo_verifier=lambda image, *, timeout: 2)
                self.assertEqual(evidence_alerts(record), [])

    def test_unverified_full_board_preserves_input_without_count_alert(self):
        message = "三号点今天上午看到两只疑似虫体"
        transcript = [{"field": "observation", "value": message, "quote": message, "status": "recorded"},
                      {"field": "location", "value": "三号点", "quote": message, "status": "recorded"},
                      {"field": "time", "value": "今天上午", "quote": message, "status": "recorded"}]
        denied = ({**FULL_BOARD, "right": False, "bottom": False, "visible_count": 1}, FULL_BOARD, {})
        for response in (*denied, ModelUnavailable("复核超时")):
            with self.subTest(response=response):
                record = new_record("trap")
                options = {"side_effect": response} if isinstance(response, Exception) else {"return_value": response}
                with patch("orchard_workbench.extraction.request_model_json", **options) as request:
                    apply_turn(record, message, PHOTO,
                               lambda *_: Extraction(transcript, "局部可见一只", "usable", 1, "complete"))
                prompt, content = request.call_args.args
                self.assertEqual(content, [{"type": "image_url", "image_url": {"url": PHOTO}}])
                self.assertLessEqual(request.call_args.kwargs["timeout"], 8)
                self.assertEqual(evidence_alerts(record), [])
                self.assertEqual(record["fields"]["quantity"]["value"], "两只")
                self.assertEqual(record["turns"][0]["image"], PHOTO)
                self.assertIn("局部可见一只", record["turns"][0]["visual"])
                self.assertIsNone(record["turns"][0]["visible_count"])
                self.assertEqual(record["questions"], ["photo_detail"])

    def test_manual_review_keeps_previous_quantity_and_photo_discrepancy(self):
        record = new_record("trap")
        with patch("orchard_workbench.extraction.request_model_json", return_value=FULL_BOARD):
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

    def test_correction_keeps_earlier_quotation_in_evidence(self):
        record = new_record("trap")
        apply_turn(record, "三号点看到两只疑似虫体", rules_only=True)
        apply_turn(record, "今天上午，刚才说错了，是五号点", rules_only=True)

        location = record["fields"]["location"]
        self.assertEqual(location["value"], "五号点")
        self.assertEqual(location["status"], "recorded")
        # Newest statement first, original utterance still retrievable.
        self.assertEqual([source["turn"] for source in location["evidence"]], [2, 1])
        self.assertEqual(location["evidence"][1]["quote"], "三号点看到两只疑似虫体")
        self.assertTrue(location["evidence"][1]["superseded"])
        self.assertNotIn("superseded", location["evidence"][0])
        # The correction is still recorded as a value change with both sides.
        change, = [item for item in record["revisions"] if item["field"] == "location"][-1:]
        self.assertEqual(change["before"]["value"], "三号点")
        self.assertEqual(change["after"]["value"], "五号点")

    def test_repeated_correction_does_not_duplicate_evidence(self):
        record = new_record("trap")
        apply_turn(record, "三号点看到两只疑似虫体", rules_only=True)
        apply_turn(record, "更正为五号点", rules_only=True)
        apply_turn(record, "更正为五号点", rules_only=True)

        sources = record["fields"]["location"]["evidence"]
        self.assertEqual(len(sources), len({(s["turn"], s["quote"]) for s in sources}))
        self.assertEqual(record["fields"]["location"]["value"], "五号点")
