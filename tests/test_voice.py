import base64
import json
import unittest
from unittest import mock

from orchard_workbench.extraction import ModelUnavailable
from orchard_workbench.voice import clean_transcript, parse_audio, transcribe

WAV = "data:audio/wav;base64," + base64.b64encode(b"RIFF" + b"\x00" * 40).decode()


class AudioParsingTests(unittest.TestCase):
    def test_accepts_supported_containers(self):
        mime, payload, audio_format = parse_audio(WAV)
        self.assertEqual((mime, audio_format), ("audio/wav", "wav"))
        self.assertTrue(payload)

    def test_rejects_unsupported_and_malformed_input(self):
        for value in (
            "data:video/mp4;base64,AAAA",
            "data:audio/wav,AAAA",
            "data:audio/wav;base64,!!!!",
            "data:audio/wav;base64,",
            123,
            "",
        ):
            with self.subTest(value=value):
                if value == "":
                    self.assertIsNone(parse_audio(value))
                else:
                    with self.assertRaises(ValueError):
                        parse_audio(value)

    def test_rejects_oversized_audio(self):
        huge = "data:audio/wav;base64," + base64.b64encode(b"\x00" * (8 * 1024 * 1024 + 1)).decode()
        with self.assertRaisesRegex(ValueError, "8 MB"):
            parse_audio(huge)


class TranscriptTests(unittest.TestCase):
    def test_strips_fences_and_collapses_whitespace(self):
        self.assertEqual(clean_transcript("\x60\x60\x60text\n三号点  两只\n\x60\x60\x60"), "三号点 两只")

    def test_rejects_empty_transcript(self):
        for value in ("", "   ", "\x60\x60\x60\n\n\x60\x60\x60"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(ValueError, "没有识别到语音内容"):
                    clean_transcript(value)

    def test_rejects_non_string(self):
        with self.assertRaises(ValueError):
            clean_transcript(None)


class TranscribeTests(unittest.TestCase):
    def test_requires_configured_service(self):
        with mock.patch.dict("os.environ", {"ORCHARD_MODEL_URL": "x", "ORCHARD_MODEL": "qwen3-vl-plus"}, clear=True):
            with self.assertRaises(ModelUnavailable) as caught:
                transcribe(WAV)
        self.assertEqual(caught.exception.status, 503)
        self.assertIn("配置的语音模型", str(caught.exception))

    def test_unreachable_service_reports_network(self):
        environment = {"ORCHARD_MODEL_URL": "http://127.0.0.1:9/v1/chat/completions",
                       "ORCHARD_VOICE_MODEL": "fake"}
        with mock.patch.dict("os.environ", environment, clear=True):
            with self.assertRaises(ModelUnavailable) as caught:
                transcribe(WAV)
        self.assertIn("网络", str(caught.exception))

    def test_requires_audio(self):
        with mock.patch.dict("os.environ", {"ORCHARD_MODEL_URL": "x", "ORCHARD_MODEL": "y"}, clear=True):
            with self.assertRaisesRegex(ValueError, "请先录音"):
                transcribe("")

    @mock.patch("orchard_workbench.voice.urlopen")
    def test_dashscope_asr_uses_its_own_model_and_data_uri(self, open_url):
        open_url.return_value.__enter__.return_value.read.return_value = (
            b'{"choices": [{"message": {"content": "two insects"}}]}'
        )
        config = {"ORCHARD_MODEL_URL": "https://example.test/v1/chat/completions",
                  "ORCHARD_MODEL": "qwen3-vl-plus", "ORCHARD_VOICE_MODEL": "qwen3-asr-flash"}
        with mock.patch.dict("os.environ", config, clear=True):
            transcript, _ = transcribe(WAV, "模拟巡查")
        payload = json.loads(open_url.call_args.args[0].data)
        self.assertEqual(payload["model"], "qwen3-asr-flash")
        self.assertEqual(payload["messages"][0]["content"], [{"type": "text", "text": "模拟巡查"}])
        self.assertEqual(payload["messages"][-1]["content"], [
            {"type": "input_audio", "input_audio": {"data": WAV}},
        ])
        self.assertEqual(transcript, "two insects")


if __name__ == "__main__":
    unittest.main()
