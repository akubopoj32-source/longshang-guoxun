import unittest
from unittest.mock import patch

from orchard_workbench.extraction import ModelUnavailable
from orchard_workbench.knowledge import answer_question, retrieve, source_url


class KnowledgeTests(unittest.TestCase):
    def test_weather_aliases_find_relevant_passages_before_generic_record_help(self):
        cases = (
            ("冰雹", "冰雹后巡查", "national-summer-storm"),
            ("冰雹过后怎么记录果园异常？", "冰雹后巡查", "national-summer-storm"),
            ("果园灾后巡查怎么做？", "灾后巡查", "national-summer-storm"),
            ("霜冻过后怎么检查果树？", "霜冻后记录", "baoji-frost-survey"),
            ("照片拍糊了应该怎么处理？", "照片模糊", "workbench-photo-review"),
        )
        for question, hit, expected in cases:
            with self.subTest(question=question):
                first = retrieve(question)[0]
                self.assertEqual(first["id"], expected)
                self.assertIn(hit, first["matched_terms"])

    @patch("orchard_workbench.knowledge.model_enabled", return_value=True)
    @patch("orchard_workbench.knowledge.request_model_json")
    def test_retrieval_count_is_preserved_when_model_cites_one_passage(self, model, enabled):
        model.return_value = {"answer": "记录雹伤部位。", "citations": ["national-summer-storm"]}
        with patch.dict("os.environ", {"ORCHARD_MODEL": "test-vision"}):
            result = answer_question("冰雹过后怎么记录果园异常？")
        self.assertEqual(result["status"], "answered")
        self.assertEqual(len(result["sources"]), 1)
        self.assertGreater(result["retrieved_count"], 1)
        self.assertEqual(result["model_name"], "test-vision")

    def test_standard_queries_rank_the_requested_standard_before_related_material(self):
        cases = (
            ("甘肃苹果蠹蛾监测技术规范 DB62/T 2145-2011 还有效吗？", "codling-gansu-standard-history", "废止"),
            ("现行苹果蠹蛾监测技术规范是什么？", "codling-ny-standard", "现行"),
            ("海关苹果蠹蛾性诱监测技术指南 SN/T 5396-2022", "codling-sn-standard", "海关总署"),
        )
        for question, expected_id, expected_status in cases:
            with self.subTest(question=question):
                first = retrieve(question)[0]
                self.assertEqual(first["id"], expected_id)
                self.assertIn(expected_status, first["text"])

    @patch("orchard_workbench.knowledge.request_model_json")
    def test_unrelated_question_skips_the_model(self, model):
        result = answer_question("如何打印身份证？")
        self.assertEqual(result["status"], "no_match")
        self.assertEqual(result["sources"], [])
        model.assert_not_called()

    @patch("orchard_workbench.knowledge.model_enabled", return_value=True)
    @patch("orchard_workbench.knowledge.request_model_json")
    def test_model_citations_must_match_the_retrieved_passages(self, model, enabled):
        question = "2024年预算计划布设多少苹果蠹蛾监测点？"
        model.return_value = {"answer": "2024 年预算计划约 150 个。", "citations": ["qingyang-trap-2024"]}
        result = answer_question(question)
        self.assertEqual(result["status"], "answered")
        source, = result["sources"]
        self.assertIn("绩效目标", source["text"])
        self.assertEqual(source_url(source["id"]), source["url"])
        self.assertIsNone(source_url("https://example.com/"))

        model.return_value["citations"] = ["workbench-orchard-fields"]
        result = answer_question(question)
        self.assertEqual(result["status"], "sources_only")
        self.assertNotEqual(result["answer"], model.return_value["answer"])

    @patch("orchard_workbench.knowledge.model_enabled", return_value=True)
    @patch("orchard_workbench.knowledge.request_model_json", side_effect=ModelUnavailable("timeout"))
    def test_related_sources_remain_available_when_model_fails(self, model, enabled):
        result = answer_question("照片模糊时需要补拍吗？")
        self.assertEqual(result["status"], "sources_only")
        self.assertEqual(result["sources"][0]["id"], "workbench-photo-review")
