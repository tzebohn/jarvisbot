"""Worker audio/inference contract tests; no model downloads or third-party packages."""
import base64
import importlib.util
import io
from pathlib import Path
from types import SimpleNamespace
import unittest
import wave

spec = importlib.util.spec_from_file_location("stt_worker", Path(__file__).parents[1] / "scripts" / "faster-whisper-worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def request(rate=48000):
    data = io.BytesIO()
    with wave.open(data, "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b"\x00" * 3840)
    return {"id": 12, "wav": base64.b64encode(data.getvalue()).decode("ascii")}


class WorkerTests(unittest.TestCase):
    def test_consumes_lazy_inference_and_returns_quality_with_in_memory_wav(self):
        calls = []
        consumed = []

        class Model:
            def transcribe(self, audio, **options):
                self.assert_audio = isinstance(audio, io.BytesIO)
                calls.append(options)

                def segments():
                    consumed.append(True)
                    yield SimpleNamespace(text=" Jarvis, play Numb.", start=0, end=1, avg_logprob=-0.2,
                                          no_speech_prob=0.01, compression_ratio=1.1)
                return segments(), SimpleNamespace(language="en", language_probability=0.99)

        model = Model()
        result = worker.transcribe(model, request(), "en")
        self.assertTrue(model.assert_audio)
        self.assertEqual(consumed, [True])
        self.assertEqual(result["id"], 12)
        self.assertEqual(result["text"], " Jarvis, play Numb.")
        self.assertEqual(result["segments"][0]["avg_logprob"], -0.2)
        self.assertEqual(calls[0]["condition_on_previous_text"], False)
        self.assertEqual(calls[0]["vad_filter"], False)
        worker.transcribe(model, request(), "auto")
        self.assertIsNone(calls[1]["language"])

    def test_invalid_audio_never_reaches_inference(self):
        for item in [request(16000), {"id": 1, "wav": "invalid%%%"}, {"id": 1, "wav": base64.b64encode(b"bad").decode()}]:
            with self.assertRaises((ValueError, wave.Error, EOFError)):
                worker.transcribe(None, item, "en")


if __name__ == "__main__":
    unittest.main()
