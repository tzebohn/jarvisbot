"""Private JSON-lines worker. Audio is received over stdin and never written to disk."""
import argparse
import base64
import io
import json
import os
import sys
import wave


def transcribe(model, request, language):
    wav = base64.b64decode(request["wav"], validate=True)
    if len(wav) > 2_688_044:
        raise ValueError("clip too large")
    with wave.open(io.BytesIO(wav), "rb") as audio:
        if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth(), audio.getcomptype()) != (48000, 2, 2, "NONE"):
            raise ValueError("invalid audio format")
        if not 0 < audio.getnframes() <= 672_000:
            raise ValueError("invalid duration")
    # PyAV handles 48 kHz stereo -> 16 kHz mono. No extra VAD pass clips short commands.
    segments, info = model.transcribe(io.BytesIO(wav), language=None if language == "auto" else language,
                                     beam_size=1, temperature=0, condition_on_previous_text=False,
                                     vad_filter=False)
    segments = list(segments)  # Inference is lazy; finish before replying/releasing the clip.
    return {"type": "result", "id": request["id"], "text": "".join(s.text for s in segments),
            "language": info.language, "language_probability": info.language_probability,
            "segments": [{"start": s.start, "end": s.end, "avg_logprob": s.avg_logprob,
                          "no_speech_prob": s.no_speech_prob, "compression_ratio": s.compression_ratio}
                         for s in segments]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--threads", type=int, default=2)
    parser.add_argument("--language", default="en")
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--download", action="store_true")
    args = parser.parse_args()
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    if not args.download:
        os.environ["HF_HUB_OFFLINE"] = "1"
    # Keep the protocol on the original stdout, including if a dependency prints diagnostics.
    protocol = sys.stdout
    sys.stdout = sys.stderr
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type,
                         cpu_threads=args.threads, num_workers=1, download_root=args.cache_dir,
                         local_files_only=not args.download)
    if args.download:
        print("Local STT model cached and loaded successfully.")
        return
    protocol.write('{"type":"ready"}\n')
    protocol.flush()
    while True:
        line = sys.stdin.readline(3_600_000)
        if not line:
            break
        if not line.endswith("\n"):
            raise ValueError("oversized request")
        request = None
        try:
            request = json.loads(line)
            response = transcribe(model, request, args.language)
        except Exception:
            response = {"type": "error", "id": request.get("id") if isinstance(request, dict) else None}
        finally:
            # The persistent model must not retain the previous request's audio/base64 text.
            request = None
            line = None
        protocol.write(json.dumps(response, ensure_ascii=True, allow_nan=False) + "\n")
        protocol.flush()
        response = None


if __name__ == "__main__":
    main()
