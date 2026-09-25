# Discord Music Platform

## YouTube playback and prefix music commands

This implementation follows **Section 39, Phases 1–4 and 8** of
[`discord-music-platform-architecture.md`](discord-music-platform-architecture.md):

- `packages/shared` exports the Discord-independent `MusicSource`, `Track`, and `TrackCandidate` types.
- `apps/bot/src/music/providers` defines search/playback contracts, provider errors, and common candidate normalization.
- `MusicQueue` provides `add`, `next`, `peek`, `clear`, `size`, and a copied `all` snapshot.
- Each guild owns a `MusicPlayer` with its own queue, current item, audio player, and voice connection.
- `!join` joins the caller's voice channel and waits up to 10 seconds for `VoiceConnectionStatus.Ready`.
- `!leave` destroys the guild's `MusicPlayer`, stops audio, clears its queue, and releases the voice connection.
- The client enables `Guilds`, `GuildVoiceStates`, `GuildMessages`, and `MessageContent`.
- `!playtest` (also `!pluh`) plays `apps/bot/assets/test.mp3` through `MusicPlayer` after the connection is ready.
- `!ping` replies with `Pong!`.
- `!play <query>` automatically joins the caller's voice channel if needed, searches
  YouTube using `YOUTUBE_API_KEY`, scores candidates, and
  plays or queues the best match. It also accepts individual YouTube video URLs.
- `YouTubeClient` uses Data API v3 for search and batched metadata retrieval.
- `YouTubeProvider` maps metadata to shared tracks and resolves audio through `yt-dlp`.
- `MusicService` and the initial `TrackResolver` connect discovery to lazy, asynchronous playback.

The music-source roadmap in Section 30 has its own numbering. Concrete YouTube,
Spotify, and SoundCloud providers belong to Development Phases 4, 5, and 6.
The Phase 8 controls use the same per-guild music engine as YouTube playback.

### Commands

| Command | Behavior |
| --- | --- |
| `!play <song name or YouTube video URL>` | Join your voice channel if disconnected, then play or queue a match. |
| `!join` | Join your channel; reuse the player when already in that channel. Moving to another channel stops and clears old playback. |
| `!leave` | Stop, clear the queue, reset looping, and disconnect. |
| `!pause` / `!resume` | Pause or resume the current track. |
| `!skip` | Discard the current track and start the next; become idle if the queue is empty. |
| `!stop` | Stop, clear the queue, reset looping, and cancel pending play requests while staying in voice. |
| `!queue [page]` | Show the current track, loop mode, and five queued tracks per page. |
| `!nowplaying` | Show title, artist, duration, video link, playback state, and loop mode. |
| `!shuffle` | Randomize pending tracks without changing the current track. Needs at least two queued tracks. |
| `!loop` | Show the current mode and usage. |
| `!loop off` | Disable looping (the default). |
| `!loop song` | Repeat the current track on natural completion. |
| `!loop queue` | Move each naturally completed track to the end of the queue. A lone track repeats. |
| `!commandtest [wav]` | Observe your next activated capture, transcript, parsed command, source, and latency. Supported commands execute normally; music results appear in the voice channel's text chat. `wav` explicitly uploads your captured audio. |

Commands are ordinary text messages beginning with `!`; names are case-insensitive.
The entire remaining message is the play query (1–500 characters), without `query:`
or required quotes. Bot/webhook messages, ordinary chat, and unknown commands are ignored.
Music commands are server-only. `!play` and playback-changing controls require you
to be in the bot's channel. `!queue` and `!nowplaying` can be read outside voice.
Explicit `!join` can move the bot, and `!leave` retains its server-wide disconnect behavior.

Simultaneous play/join requests share one connection and player per guild. Looping
creates a fresh audio resource each time. `!skip` discards the skipped item even in
loop mode; the selected mode remains active for subsequent tracks. `!stop`, `!leave`,
and playback failures disable looping. Enabling song/queue looping requires a current
track (including a loading or paused track). Pausing waits until loading has finished.
State is in memory and is lost on restart. Concurrent searches queue in completion order.

### Voice receive verification (Phase V1)

The receive layer in `apps/bot/src/voice` shares the existing guild connection.
Both explicit joining and automatic joining use `selfDeaf: false`. Per-user Opus
subscriptions are decoded independently using the existing `@discordjs/opus` dependency.

The exact receive/capture format is **48,000 Hz, 2 channels (interleaved left/right),
signed 16-bit little-endian PCM (`s16le`)**: 4 bytes per stereo sample frame,
192,000 bytes per second, typically 3,840 bytes per 20 ms Opus packet. No receive
resampling is performed. Diagnostic WAV headers describe that same format.

- `!voicetest` captures only the caller's next utterance and reports audio statistics.
- `!voicetest wav` explicitly uploads that caller's sample to the command text channel;
  the bot needs **Attach Files** for this option. No local recordings are written.
- Run `!join`, stop speaking for a second, run the diagnostic, then speak after the
  ready reply. Wait time is capped at 15 seconds; captures are capped at 10 seconds
  by both wall time and PCM byte count (1,920,000 bytes). Stay quiet for one second
  to finish. Truncated captures are labelled.
- Set `VOICE_RECEIVE_DEBUG=1` to log speaker IDs and packet/PCM-byte counts. Raw
  audio content is not logged. Normal receiving does not retain entire utterances.
- User departure, bot movement/deafening, connection loss, and stream/decoder errors
  cancel affected tests and release their buffers, streams, and owned timers.

**Automated V1 verification:** tests route interleaved encrypted RTP packets through
the real `VoiceReceiver`, its SSRC mapping and speaking events, and the real Opus
decoder. Each user's PCM is compared independently, unknown SSRCs are ignored,
and real `ClientDisconnect` payloads are tested while another user continues.
Tests also check subscription removal, repeated utterances, guild isolation, PCM
format, bounded capture, cancellation, and WAV playback through FFmpeg.

**Live two-person check (requires Discord):**

1. Enable `VOICE_RECEIVE_DEBUG=1`, start the bot, and run `!join` in a normal voice channel.
2. Alice and Bob each run `!voicetest wav` from their own account, then speak different
   phrases, first separately and then overlapping. Compare the logged IDs with each
   account's **Copy User ID** in Discord Developer Mode.
3. Listen to both samples: each must contain only its owning user's digital audio.
   A user's physical microphone can still pick up another person in the room.
4. After a one-second pause, check the `utterance ended` logs; repeat both tests to
   confirm subscriptions can be recreated cleanly.
5. Have Alice disconnect while speaking and Bob continue. Alice's pending test should
   cancel, Bob's sample should complete, and `!ping`/music playback should keep working.

Automated tests do not establish live microphone quality or Discord transport behavior;
the two-person check above is still required on the deployed bot.

### Speech segmentation and VAD (Phase V2)

The receive pipeline now feeds a separate `VoiceActivityDetector` for each active
speaker into WebRTC VAD via **`@echogarden/fvad-wasm` 0.2.0** (BSD-3-Clause). This
small, bundled WASM dependency runs locally on Node/Windows/Linux without native
build scripts, a model download, or a transcription service. Its module loads once;
each speaker gets independent VAD state and sample memory, explicitly freed on cleanup.

```text
Per-user Opus → 48 kHz stereo s16le PCM → 20 ms frame assembler
                                       ├─ original stereo → bounded rolling buffer
                                       └─ average L/R → 48 kHz mono int16 → WebRTC VAD
                                                                           ↓
                                                      speech-start / speech-active / speech-end
```

- Input chunks are reassembled into **20 ms** frames; at most one partial frame is
  held. Less than 20 ms remaining at stream end is excluded from VAD, not from raw capture.
- VAD uses a **48 kHz, mono, signed 16-bit** analysis copy (960 samples per frame).
  Original stereo PCM and diagnostic WAVs keep the verified Phase V1 format.
- Speech starts after **100 ms of consecutive VAD-positive frames**. Brief detections
  do not immediately open a segment; short pauses within speech are tolerated.
- Speech ends after **600 ms of consecutive VAD-negative PCM**. If Discord stops
  sending packets, the receive stream's one-second silence/inactivity end also closes
  the segment. Packet gaps are not fabricated into PCM samples.
- Each active user's rolling buffer keeps the latest **one second of stereo PCM**:
  at most **192,000 bytes**. It preserves recent context including short pauses;
  it does not grow with a long conversation. Snapshots are independent copies.
- Stream end, disconnect, replacement, and errors clear rolling buffers and partial
  frames. Cleanup is idempotent. A VAD error disables processing for that utterance
  while the raw receive diagnostic remains usable.
- `VOICE_RECEIVE_DEBUG=1` logs speech start/active/end events with guild/user IDs.
  `!voicetest` additionally reports analyzed duration, VAD-positive duration, segment
  count, and processing time. These are audio classifications, not transcripts.

Set `VOICE_VAD_MODE=2` in `apps/bot/.env` (the default). Modes `0`–`3` trade sensitivity
for stricter rejection; higher modes can also miss quiet speech. Restart after changing
the mode. The initial onset/end/buffer defaults live in `VoiceActivityDetector.ts`.

#### Phase V2 verification

```sh
pnpm --filter bot exec node --import tsx --experimental-test-module-mocks --test tests/voiceActivity.test.mjs tests/voiceReceive.test.mjs
pnpm --filter bot diagnose:vad 10 8
```

The diagnostic interleaves eight independent speaker processors for ten seconds of
synthetic audio each. On the development machine in mode 2, silence and quiet noise
produced **0 ms** classified voice; voice-like harmonics produced **10,000 ms**.
Loud broadband noise produced **2,520 ms** classified voice, demonstrating false positives.
Measured VAD/framing/buffer processing was approximately **0.45–0.59 ms per audio second**,
with every rolling buffer capped at **192,000 bytes**. These figures exclude Opus
decoding, networking, WASM startup, and test-signal generation and vary by machine.

For microphone validation, repeat the two-person test with `VOICE_RECEIVE_DEBUG=1`:
try short pauses, a long pause, overlapping speakers, quiet speech, keyboard noise,
and a fan. Use `!voicetest wav` to compare the sample with the VAD statistics. Actual
speech/noise accuracy and thresholds require this live check; synthetic tests are not
a calibrated accuracy benchmark. VAD can classify music, loud noise, or room echo as
speech. Phase V2 provides speech boundaries and bounded pre-roll; Phase V3 below adds
wake detection. Phase V4 adds owner-only command sessions; transcription and spoken music
actions follow in later phases.

### Wake detection (Phase V3)

The activation phrase is **Jarvis**. The existing local backend is
`sherpa-onnx-node` 1.13.8 with the int8
`sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` keyword model. It performs streaming
**phoneme keyword spotting**, not general speech-to-text. The canonical path is
`JH AA1 R V AH0 S`; one additional path covers a natural U.S. English difference in
the unstressed second vowel (see below). The application accepts only their exact native keyword
IDs and emits the same **Jarvis** activation for all of them. Text casing, punctuation,
spelling normalization, and transcript fuzzy matching do not apply. Accepted activations
start the Phase V4 capture lifecycle below.

```text
Discord speaking.start → synchronous per-user Opus subscription
  → 48 kHz stereo s16le decode → 20 ms frames + bounded original PCM ring
  → WebRTC VAD on a mono int16 copy
  → first VAD-positive frame opens keyword input, with up to 1 second of onset context
  → continuous mono float32 input, including subsequent VAD-negative frames
  → worker-thread resampling 48 kHz → 16 kHz → sherpa keyword model
  → keyword result → per-user cooldown → typed wake event + current PCM snapshot
```

The gate previously required 100 ms of consecutive VAD-positive frames and recovered
only 500 ms of context. That could exclude a short/fragmented utterance from keyword
inference or clip "Hey" at a late onset. The wake gate now uses the first positive
frame; **speech segmentation still requires 100 ms**, and keyword thresholds are
unchanged. Opening a model stream is not activation. Silence never opens the production
gate, and native inference remains on a worker, independently per speaker.

The rolling wake buffer is now **4 seconds / 768,000 bytes per receiving speaker**,
covering phrase context and the bounded inference backlog. Activation snapshots are
taken **when the result is delivered**, so they include audio received during inference.
There is no full-buffer allocation on each inference request. An ended receive stream
holds its final snapshot only until pending inference finishes or is cancelled.

#### Configuration and limits

Run `pnpm --filter bot setup:wake` once to download the model (uses `tar`); the existing
model files can be reused. Configure `apps/bot/.env` and restart:

```dotenv
VOICE_WAKE_ENABLED=1
VOICE_WAKE_DEBUG=1
VOICE_VAD_MODE=2
VOICE_WAKE_THRESHOLD=0.25
VOICE_WAKE_SCORE=1.5
```

| Setting / limit | Meaning |
| --- | --- |
| `VOICE_WAKE_DEBUG=0` (new) | Opt-in gate, inference, candidate, rejection, buffer, signal-level, and state diagnostics. Set `1` during development. |
| `VOICE_RECEIVE_DEBUG=0` | Existing receive counts and VAD segment events; independently configurable. |
| `VOICE_WAKE_ENABLED=1` | `0` disables the keyword engine. |
| `VOICE_WAKE_MODEL_DIR` | Optional model directory override; defaults to `apps/bot/models/wake`. |
| `VOICE_WAKE_THRESHOLD=0.25` | Native keyword probability threshold, `(0, 1]`; higher is stricter. Not a returned detection confidence. |
| `VOICE_WAKE_SCORE=1.5` | Native keyword search boost, `(0, 5]`; higher favours keyword paths. Not a confidence score. |
| `VOICE_VAD_MODE=2` | Existing WebRTC aggressiveness, `0`–`3`; higher rejects more noise and potentially more speech. |
| Receive inactivity | 1,000 ms of no packets/Opus silence closes that user's subscription. Discord's short speaking-end event is not used to truncate it. |
| VAD segments | 100 ms consecutive voice to start; 600 ms non-speech PCM to end. Packet gaps are not fabricated into PCM. |
| Model finalization | 400 ms analysis-only zero padding flushes look-ahead at natural stream end. Preserved PCM never includes this padding. |
| Native trailing blanks | `1`; the existing keyword completion rule. |
| Cooldown | 3,000 ms per user per guild from the last accepted wake, including across session completion/contention rejection; ignored repeats do not extend it. Rejected matches report remaining time. |
| Resource bounds | 2 s queued audio per detector; 32 active native streams across the shared worker; one CPU inference thread. |
| Worker lifecycle | 30 s model startup limit, 5 s request timeout; failure disables the worker until restart. |
| Long utterances | Native stream rolls over after 15 s, replaying 2 s context and suppressing replayed detections. |

No extra denoising/automatic gain processing is added: Discord clients already often
apply these. Opus decode, downmix, sample scaling, and stateful resampling retain the
verified input formats. Keyword state persists across arbitrary decoder chunks and
brief VAD-negative frames, but not across separate receive subscriptions.

#### Jarvis pronunciation coverage

`apps/bot/src/voice/wake/wakeModel.ts` is the single source of pronunciation tokens,
native keyword labels, and explanations. The installed model's `tokens.txt` contains
the required `JH`, `AA1`, `R`, `V`, `AH0`, `IH0`, and `S` tokens. Both setup and
startup validate **every path** against that actual vocabulary; an arbitrary ARPAbet
spelling is not assumed to work with another model.

| Diagnostic ID | Phoneme tokens | Intended variation |
| --- | --- | --- |
| `canonical` | `JH AA1 R V AH0 S` | Primary American pronunciation, with a pronounced `r` and reduced second vowel. |
| `rhotic-ih` | `JH AA1 R V IH0 S` | Clearer unstressed “ih” in “vis” instead of schwa. |

These are **two hand-selected U.S. English paths**, with the original canonical path
first. Both retain `JH AA1 R V … S` and both syllables; only `AH0` / `IH0` differs.
The previous non-rhotic and `AE1` fronted-first-vowel approximations have been removed.
“Jervis”-like paths, consonant substitutions, shortened words, fuzzy text matching,
and per-path lower thresholds are excluded. Native beam search selects the acoustic
match; listing the canonical path first does not override the model's choice.

The actual generated keyword file is **`apps/bot/models/wake/jarvis.txt`**, passed as
sherpa's `keywordsFile` (there is no separate production `keywords.txt`). Native labels
such as `JARVIS_RHOTIC_IH` identify the winning path. They are not extra phrases
users must say. Cooldown, speaker ownership, and capture behavior are shared by all paths.

For an existing model installation, regenerate the file offline and restart the bot:

```powershell
pnpm --filter bot setup:wake --keywords-only
pnpm dev:bot
```

This checks the installed vocabulary/model files before writing and requires no download.
Normal `setup:wake` downloads the model and generates the same file. Both commands honor
`VOICE_WAKE_MODEL_DIR` from `apps/bot/.env`. Startup rejects old single-/five-path files or
unreviewed extra keywords/inline tuning and tells you how to regenerate them.

**Tuning:** defaults remain `VOICE_WAKE_THRESHOLD=0.25`, `VOICE_WAKE_SCORE=1.5`.
Lower threshold relaxes acoustic acceptance; **higher** score boosts the keyword during
search. Lowering score does not increase sensitivity and can lose fast/coarticulated
speech paths. Start live evaluation at `0.25 / 1.5`, then compare any tuning on the
same labelled positive and negative recordings. New paths can change native beam-search
competition even when a hit still reports the canonical path.

**Diagnostics:** with `VOICE_WAKE_DEBUG=1`, `candidate` logs include the native keyword,
`pronunciationId`, configured tokens, and returned tokens; `accepted` logs also include
`pronunciationId`. Offline replay prints that ID in each hit even without `--debug`.
The ID describes the path selected by KWS, not a speaker's accent or confidence score.
The optional greedy phoneme probe lists all configured paths for comparison.

```powershell
pnpm --filter bot diagnose:wake --synthetic --opus
pnpm --filter bot diagnose:wake --compare-vad --phonemes --debug --positive "C:/samples/jarvis-natural.wav" --negative "C:/samples/ordinary-chat.wav"
```

Synthetic mode tests **Jarvis** using installed **en-US** Windows voices. With
David/Zira it generates 20 positives (normal, continuous command, “Hey Jarvis,”
faster/slower, quieter/louder, emphasis, and prescribed rhotic schwa/ih IPA samples)
plus 28 negatives, including ordinary sentences, “jar of jam,” “service,”
“Harvest,” “Travis,” “Jervis,” “Jar,” and “vis.” Samples stay in memory. Windows TTS may
merge phones/allophones: prescribed IPA is not a guarantee of the acoustic model's output.

Measured using the real native KWS, production VAD, and an Opus encode/decode round trip:

| Configuration | Positive detections | Negative activations |
| --- | --- | --- |
| Two U.S. English paths, `0.25 / 1.5`, VAD mode 2 | 18 / 20 | 0 / 28 |

The remaining misses were David's strong-emphasis sample and Zira's quieter sample.
Normal and continuous-command samples passed for both voices. The diagnostic exits
nonzero for remaining misses. This revised U.S. English corpus is different from the
earlier five-path accent experiment; its totals are not a direct before/after accuracy
comparison. The Phase V8 section below describes paired noise/preprocessing evaluation.

These are synthetic smoke results, not a measured real-world accent recall or false-wake
rate. For live evaluation, run `!waketest` and repeat each pronunciation/style naturally
at least five times with different speakers/microphones. Include quiet/loud, fast/slow,
first/second-syllable emphasis, normal U.S. regional variation, and “Jarvis play …” without a
pause. Allow the command session to finish before the next attempt. Run ordinary
conversation and near-misses between attempts and check for unwanted listening statuses.
Use `!waketest sample` to save explicit diagnostic recordings of misses or false wakes,
then replay them with `--phonemes --compare-vad --debug`; don't infer rejected hypotheses
from a missing hit or loosen the whole detector solely to pass a synthetic sample.

#### Local testing and diagnosis

1. Start `pnpm dev:bot`, join a voice channel, and run `!join`.
2. Run `!waketest`, then say **Jarvis** naturally. Also test
   **Jarvis play Numb** without a pause. This diagnostic reports activation only;
   normal Phase V4 sessions also run. Wait for the session to finish before another test.
3. Test ordinary chat and similar-sounding words. Repeat with two speakers overlapping;
   a wake must belong to the correct user.
4. `!waketest wav` explicitly uploads the successful activation's preserved audio.
   For a **miss**, run **`!waketest sample`** before saying one test sentence, then stop
   speaking. It uploads the complete next utterance (up to 10 seconds) as `wake-attempt.wav`
   and a `wake-attempt.json` report, even when no keyword is detected. It waits for final
   inference on naturally ended audio; truncated/error results are marked incomplete.
   With sessions enabled, a successful wake can pause/cancel keyword inference before
   that raw sample ends; its keyword summary may therefore be marked incomplete.
   `!voicetest wav` remains available as a raw receive diagnostic. No audio is stored automatically.
5. Replay labelled clips, including failed attempts and negative conversation:

```powershell
pnpm --filter bot diagnose:wake --compare-vad --phonemes --debug --positive "C:/samples/missed-wake.wav" --negative "C:/samples/chat.wav"
pnpm --filter bot diagnose:wake --synthetic --opus
pnpm --filter bot exec node --import tsx --experimental-test-module-mocks --test tests/wakeWord.test.mjs tests/wakeReceive.test.mjs tests/wakeEngine.test.mjs
```

Replay requires FFmpeg. `--compare-vad` runs the same clip through production admission
(`voice`), the stricter segmentation gate (`segment`), and diagnostic-only ungated input
(`off`). If only `off` detects it, investigate VAD and the onset audio. If all three miss,
the failure is in the acoustic keyword path, not VAD admission. Compare keyword tuning
on the **same positive and negative recordings**, one setting at a time. `--opus` adds
a native Opus round trip to synthetic/local samples; omit it for actual Discord WAVs,
which have already passed through Opus. `--synthetic` uses installed Windows TTS voices.
Exit status is based on full-clip production-gate false positives/negatives; comparison failures
are reported separately. WAV replay is faster than real time and does not simulate
Discord packet loss or real-time CPU contention.

Expected diagnostic sequence (fields abbreviated):

```text
[wake] state          { state: 'listening', reason: 'receiver-attached' }
[wake] audio-arriving { userId, streamId, pcmBytes: 3840, format: ... }
[wake] gate-open      { gate: 'voice', audioTimeMs, inputStartMs, prefixMs }
[wake] speech-start   { userId, audioTimeMs, ... }
[wake] inference      { result: 'keyword-returned', elapsedMs, queuedMs, ... }
[wake] candidate      { keyword: 'JARVIS_RHOTIC_IH', pronunciationId: 'rhotic-ih', tokens: [...], configuredTokens: [...], accepted: true, confidence: null }
[wake] accepted       { userId, pronunciationId, processedAudioTimeMs, audioTimeMs, preRollBytes, ... }
[voice] wake detected { phrase: 'Jarvis', guildId, userId, ... }
[wake] summary       { outcome: 'keyword-detected', voicedMs, rmsDbfs, maxInferenceMs, ... }
```

Inference progress is throttled to approximately once per audio second plus results
and finalization, not every 20 ms. `vad-gate-never-opened` means no model input;
`no-keyword-returned` means it ran but did not return a completed keyword. A
`rejected { reason: 'cooldown', remainingMs }` explains suppression after recognition.
Native KWS exposes **neither a transcript, partial/rejected hypotheses, nor a confidence
score**. Token diagnostics describe an accepted keyword, not everything the user said;
the code does not invent explanations for internal native rejections. `rmsDbfs`/`peak`
describe the mono signal supplied to analysis, and can help identify unexpectedly low
or clipped audio. Debug off leaves startup/activation/error logs only.

#### Investigating an acoustic miss without guessing at thresholds

A trace with `gate-open { audioTimeMs: 100, inputStartMs: 0, prefixMs: 100 }`,
`analyzedMs: 3000`, `voicedMs: 2540`, and a final `no-keyword-returned` identifies an
**acoustic keyword recognition miss**, not a failed text comparison. The first 100 ms
of received PCM were replayed into the same model stream as the later frames. The
100 ms speech-segment onset does not clip model input. A deterministic regression
reproduces those exact timings and verifies all 144,000 mono samples are submitted in
order, once each, across 147 requests including finalization.

The request count is not the number of neural-network decode steps: most 20 ms calls
just add data until the model has enough look-ahead. Diagnostics now also include:

- `submittedAudioMs` and `completedAudioMs`: original audio sent to and acknowledged
  by the backend, excluding analysis padding.
- `native.inputSamples48k`, `native.resampledSamples16k`: actual worker input and
  resampler output. A complete 3-second input starting at zero gives 144,000 and
  48,000 respectively after the resampler flush.
- `native.paddingSamples16k`: 6,400 analysis-only zero samples at normal finalization.
- `native.decodedChunks`: actual native decode calls, distinguishing buffering from
  inference; `native.rollovers` identifies long-stream resets.
- Sub-millisecond `elapsedMs`, avoiding the impression that rounded `0 ms` means no work.

The native [keyword decoder](https://github.com/k2-fsa/sherpa-onnx/blob/v1.13.8/sherpa-onnx/csrc/transducer-keyword-decoder.cc)
requires a completed keyword path, its acoustic threshold, and **more than**
`numTrailingBlanks` decoder blank frames. With the current value `1`, it needs at least
two. Decoder blanks are not equivalent to a user intentionally pausing or to VAD
silence. Coarticulation or subsequent command phones can affect path/completion
behaviour. A missing keyword alone cannot identify which native condition failed;
the binding does not expose the rejected search paths or their scores. Adding a fuzzy
string matcher after an empty result cannot recover them.

For actual acoustic evidence, opt into **`--phonemes`** during offline WAV replay. It
uses the same installed model through sherpa's greedy recognizer and prints:

```text
type: diagnostic-greedy-phonemes
expectedWakeTokens: [JH, AA1, R, V, AH0, S]
configuredPronunciations: [{ id: 'canonical', ... }, ...]
tokens: [...]                 # the separate greedy hypothesis
tokenTimesMs: [...]
tokenLogProbabilities: [...]   # raw per-token greedy log probabilities
```

This is **not an English transcript, the KWS beam-search path, or a wake confidence**.
Do not compare those log probabilities to `VOICE_WAKE_THRESHOLD` or treat a token
difference as proof of the KWS rejection cause. In synthetic tests, a greedy hypothesis
can omit `HH EY1` while keyword spotting still succeeds. The probe is useful for
locating clipped/uncertain phones and comparing samples; it never activates the bot.
It runs only in the offline diagnostic process, adds no live-bot CPU load, and requires
no new model or dependency. Its output can include phones from the rest of the sentence.

To test whether following speech affects detection, compare the **same recording**
with a prefix ending just after the wake phrase. For example, if that boundary is at
1,200 ms in your WAV:

```powershell
pnpm --filter bot diagnose:wake --phonemes --compare-vad --prefix-ms 1200 --positive "C:/samples/wake-attempt.wav"
```

The tool reports `full` and `prefix-1200ms` separately. Choose the boundary by listening
to the WAV, not by assuming all wake phrases take 1,200 ms. Prefixes are finalized with
the existing analysis padding, so a prefix-only hit indicates a context/completion
difference worth investigating, not a proven production fix. It also cannot help if
you cut off part of the wake phrase. No live threshold, blank setting, or keyword list
is altered by the comparison.

**Live acceptance matrix:** keep `VOICE_WAKE_DEBUG=1`, the same configuration for every
case, and at least three seconds between attempts. Run `!waketest` for each positive
test; use `!waketest sample` to obtain a useful artifact for every miss or negative test.

| Say | Expected result and logs |
| --- | --- |
| Jarvis | `candidate` with a configured Jarvis keyword and `pronunciationId`, then `accepted`, then `keyword-detected` summary. |
| Jarvis, play Numb by Linkin Park | Same activation; the existing command session captures and processes the request. |
| Jarvis play Numb | Same activation without requiring an intentional pause. |
| Please play another song after this one | Speech/gate/inference logs, final `no-keyword-returned`, no `accepted`. Plain `!waketest` eventually times out; sample mode returns the negative recording promptly. |
| American Jarvis; reduced/clear “vis” | Same acoustic target through the canonical or unstressed-ih path. Written spelling never enters the recognizer. |
| Harvest / Travis / Jervis / jar of jam | Negative near-matches: no activation. These are not aliases for the wake phrase. |

Repeat positives five times naturally rather than speaking unnaturally slowly. A
positive that ends with `no-keyword-returned` is still a failed acceptance test even
if the synthetic suite passes. Preserve its WAV/JSON and the startup configuration.
If ungated replay also misses, compare the phoneme hypothesis and full/prefix results
before selecting acoustic model, pronunciation, or completion-rule changes. If the
WAV itself lacks "Hey", investigate the Discord client/transport input boundary; a
zero input offset only proves the bot kept everything **it received**.

#### Receive-to-session integration contract

Use `VoiceReceiveManager.on("wake", ...)` for activations, and obtain the per-guild
`VoiceController` with `manager.get(event.guildId)`. `VoiceEvents.ts` defines its typed
`wake`, `wakeError`, `pcm`, `speech`, `streamStart`, `streamEnd`, `streamError`, `userStopped`, `reset`, and
`wakeState` events. PCM events also carry per-frame `isVoice` and `isSpeaking` flags;
session inactivity uses `isVoice`, so non-speech packets cannot keep a capture open.

- A `WakeActivation` carries `guildId`, `userId`, unique `streamId`, `streamEnded`,
  `phrase`, `detectedAt` (wall clock), owned `preRoll`, PCM `format`, `preRollStartMs`,
  `audioTimeMs` (exclusive buffer end), `processedAudioTimeMs` (inference submission
  watermark), and optional acoustic `keywordStartMs` / `keywordEndMs`. Native keyword
  timestamps are approximate phoneme locations, **not exact command trimming points**.
- Register PCM/lifecycle listeners synchronously before awaiting anything. Seed
  command capture with `preRoll`, then append only that user's subsequent `pcm` events
  beyond `audioTimeMs` on the same `streamId`. PCM events own their buffers. This avoids
  both duplicate samples and losing audio received during inference. New receive
  streams get new IDs and restart their audio clock; keep the session owner across
  those streams. Audio clocks exclude Discord packet gaps and are not wall clocks.
- `streamEnd` may precede a flush-only wake; `streamEnded` reports that case. Phase V4
  retains owner audio arriving during contention and handles the next owner stream,
  rather than wait for a new VAD speech-start event that may already have occurred.
  `controller.getAudioSnapshot(userId)` returns an owned snapshot with its stream ID,
  start/end audio offsets, format, and current VAD state for an already-open stream.
  Call it synchronously after installing listeners to catch up if an older stream's
  delayed wake arrives after the owner has started a new stream. Use the returned end
  watermark to avoid appending duplicate PCM. It is bounded recent context, not an
  archive of ended streams; Phase V4 retains its own candidate/session audio.
- After Phase V4's contention policy selects an owner, call
  `controller.setWakeListening(false, "command-listening")`. Keep it paused during
  command **listening and processing**. This cancels pending keyword work and prevents
  repeated/other-user wakes; PCM and VAD events continue. Other guilds are unaffected.
- On completion, timeout, cancellation, or processing error, release session resources
  and call `setWakeListening(true, "command-complete")` in a `finally` path. Fresh
  detectors exclude paused-session audio from inference/pre-roll. Phase V9 preserves
  unexpired user cooldowns across resume; connection resets clear cooldowns and an abandoned pause. Handle `userStopped`
  and `reset` to cancel the session immediately on departure/interruption.
- `controller.wakeState` is `listening`, `paused`, or `unavailable`. `wakeState` events
  log transitions. They describe **wake listening**, not a Phase V4 command session.
  `GuildVoiceSessions.state` separately reports the command session's lifecycle.

#### Validation status and technology choice

Regression coverage includes fragmented VAD, late onset, asynchronous handoff,
pause/resume and stale-result cancellation, separate users/guilds, stream-end flush,
cooldowns, diagnostics, and the real native worker/resampler. The earlier synthetic
suite had 22 samples for the previous wake phrase (David/Zira, three positive forms
and negative near-matches); these historical figures are not a Jarvis accuracy claim.
With an Opus round trip and the default `0.25 / 1.5` tuning, it produced **0 false
positives and 0 false negatives**, also with the same clips cut to one-second prefixes.
In the earlier 20-sample run at `0.1 / 1.0`, Zira's "Hey Gucci" falsely activated under
all three gates. These smoke results are not live microphone accuracy measurements;
the reported real-voice acoustic miss still requires its recording for calibration.

The current approach fits the outline: small local keyword inference, no continuous
full transcription, and an existing backend abstraction. A custom-trained detector
(for example openWakeWord) would need training/deployment work; a Porcupine custom
keyword would introduce its model/access-key/runtime requirements. Replacing the
working backend without real failed recordings is not justified. If labelled live
samples still miss in ungated replay, evaluate an English-focused/larger sherpa model
or a dedicated trained keyword through `WakeBackend`, measuring both misses and false
activations before selecting it.

Live checks remain necessary for different microphones/volumes, room music/noise,
accent variation, Discord client suppression and transport loss, and concurrent load.
A pause exceeding the receive inactivity boundary splits the phrase across detectors;
delays can also reach roughly a second when Discord sends no trailing audio and the
model must flush at stream end. Physically audible playback/another person in the same
microphone cannot be separated by Discord user ID. Actual mentions of the full wake
phrase can activate; only later valid-command parsing can distinguish useful actions.

### Voice command sessions (Phase V4)

`VoiceReceiveManager` now attaches one `GuildVoiceSessions` coordinator per guild.
An accepted wake automatically creates an in-memory `VoiceCommandSession`:

```text
idle → contention (300 ms) → listening → processing → idle
            │                              │
       multiple users                complete/error/timeout
            └────────── reject ────────────→ idle
```

- Capture begins immediately at the first wake, including its original PCM pre-roll
  and owner audio arriving during contention. Only that Discord user's frames are
  retained; repeated wakes never replace the owner or extend the hard deadline.
- The contention window uses **wake-event delivery time**, not acoustic timestamps.
  Distinct users arriving within 300 ms cause rejection, audio disposal, and a retry
  message in the voice channel's text chat when the bot can send there. Later
  activations are treated as busy while the owner listens/processes. Independently
  delayed detections outside that window are not retroactively arbitrated.
- Once ownership is selected, keyword work pauses for that guild while receive/VAD
  continue. Fresh wake detectors resume after success, failure, or cancellation,
  excluding paused command audio. Other guilds remain independent.
- The session keeps the same owner across natural receive-stream endings. A delayed
  flush-only wake can catch up the owner's already-open next stream. Per-stream audio
  watermarks prevent duplicated pre-roll/snapshot frames. Packet gaps are not filled
  with synthetic silence. Already-ended intervening streams are not archived.

| Boundary | Default |
| --- | --- |
| Contention | 300 ms; retain the first candidate, reject if distinct users contend. |
| VAD completion | Existing speech-end event after 600 ms of non-speech PCM. |
| Wall silence fallback | 1,500 ms since activation or the latest owner VAD-positive frame; covers absent packets, unconfirmed segments, and flush-only wakes. |
| Hard capture bound | 10 seconds after activation by wall time **and** retained post-snapshot PCM bytes. |
| Preserved pre-roll | Up to 4 additional seconds; maximum total clip 14 seconds / 2,688,000 PCM bytes. |
| Processing watchdog | 15 seconds for capture-only/custom hooks; the Phase V5 application sets 55 seconds, with an `AbortSignal` on timeout/cancellation. |
| Music execution watchdog | Phase V7 gives a recognized command a separate 60-second execution deadline after parsing, while keeping the same owner lock. |
| Explicit capture-test wait | 45 seconds; this only observes the caller's next successful capture. |

Owner departure, bot move/deafen/disconnect, connection replacement, current-capture
receive/decode/VAD failure, and shutdown release session timers, audio references, and ownership. Capture
completion frees the accumulation buffers; processing gets one owned `CommandAudio`
buffer in **48 kHz stereo s16le**, plus guild/user/session IDs, wake timing metadata,
stream IDs, pre-roll duration, completion reason, and a truncation flag. A hard-limit
clip is explicitly `truncated: true`.

**Phase V5 integration:** supply `VoiceSessionOptions.processCapture(audio, signal)`
as the manager's fifth constructor argument. Await transcription inside that callback,
honor cancellation, and release audio when done. The session owns the promise and
holds the guild lock through processing; late results cannot unlock a newer session.
Without a hook, processing finishes immediately and discards the clip. The application
now supplies the Phase V5 STT service described below. `state`, `capture`, `transcript`,
and `end` events are synchronous notifications, not async processing hooks.

#### Live capture verification

1. Optionally add `VOICE_SESSION_DEBUG=1` to `apps/bot/.env` and restart with
   `pnpm dev:bot`. Logs contain state, IDs, byte counts, durations, and reasons only.
2. Run `!join`, then `!commandtest`. After the ready reply, say
   **"Jarvis, play Numb by Linkin Park"** and stop. The reply should report your ID,
   duration, pre-roll, and `speech-end` or `silence-timeout`; the guild returns to idle.
3. Run `!commandtest wav` to listen to the complete captured command and verify the
   beginning is present. This explicitly uploads audio to the command channel and
    needs **Attach Files**. Ordinary capture never writes files or posts recordings to
    Discord; Phase V5 auto mode submits activated clips to Groq for transcription.
4. Have Bob talk while Alice captures. Alice's WAV should contain only her digital
   stream. Then try both wake words together: expect rejection and a one-at-a-time
   retry message. Repeat sequential commands and owner wake repetitions.
5. Try a short pause after Jarvis, continuous speech beyond ten seconds, owner departure,
   and `!leave` during capture. Check bounded completion/cancellation, then reconnect
   and repeat. Music playback should continue during ordinary capture.

`tests/voiceSessions.test.mjs` covers ownership, arbitration, deduplication, delayed
handoff, silence/wall/byte bounds, guild isolation, cleanup, aborted/failed/late
processing, diagnostic commands, and real Opus receive. Live microphone behavior,
contention timing under actual inference load, and pause thresholds still need the
two-person check above.

### Speech-to-text (Phase V5)

Completed owner-only captures now flow through `src/voice/transcription`:

```text
Jarvis → V4 command capture → in-memory WAV → Groq whisper-large-v3-turbo
                                                │ transient failure / quota
                                                ▼
                                      local faster-whisper worker
                                                │
                          normalized transcript + quality + timing + owner IDs
```

**Scope:** this phase produces text. Phase V6 below parses it; Phase V7 executes
recognized music commands. STT is invoked only through the completed session's `processCapture` hook;
ordinary conversation, other speakers, and rejected contention never reach it.

#### Backend selection and fallback policy

- Primary: the existing `groq-sdk`, `whisper-large-v3-turbo`, `verbose_json`, temperature
  `0`, segment metadata, and **zero SDK retries**. Reads `GROQ_API_KEY` from the environment.
- Fallback: **faster-whisper 1.2.1 / CTranslate2**, through a private persistent Python
  subprocess. Default `small.en`, CPU `int8`, two inference threads, beam size `1`.
  The model loads lazily on first local use and is reused. `openai-whisper` would add
  the PyTorch stack; `whisper.cpp` is a viable native alternative but needs its own
  binding/binary integration. Faster-whisper fits the requested CPU/GPU fallback,
  runs outside Node's event loop, and uses PyAV's bundled decoding libraries.
- HTTP **429**, **408**, **5xx**, network failures, and the cloud deadline fall back
  once. Authentication/permissions, bad requests, invalid responses, and user/session
  cancellation are reported or cancelled directly. No fallback loop or cloud retry.
- One shared service reserves at most **20 requests per rolling minute** and **2,000
  per rolling 24 hours** across guilds. Over-budget requests go directly to local STT.
  Counters are in-memory and reset on restart; other processes/clients are not counted.
  Groq remains authoritative: its organization-wide limits also include audio seconds
  (currently 7,200/hour and 28,800/day on the documented free tier).
- A 429 opens a shared cooldown using `Retry-After` (seconds or HTTP date) and an
  exhausted `x-ratelimit-reset-requests` duration. That requests-reset header is **RPD**,
  not RPM. Without useful headers the cooldown is 60 seconds. Transient outages use
  15 seconds. During cooldown, requests use local STT; Groq is eligible again afterward.

#### Local setup

Windows, from the repository root (Python 3.12 is tested):

```powershell
python -m venv apps/bot/.venv-stt
apps/bot/.venv-stt/Scripts/python.exe -m pip install -r apps/bot/scripts/requirements-stt.txt
pnpm --filter bot setup:stt
```

Linux uses `python3 -m venv apps/bot/.venv-stt` and
`apps/bot/.venv-stt/bin/python -m pip install -r apps/bot/scripts/requirements-stt.txt`.
The setup command downloads/caches and loads the configured model. Runtime loads
**cached/local files only**: losing the internet does not require a model download.
The project `.venv-stt` is discovered automatically; otherwise the bot uses Python on
PATH. Both `.venv-stt/` and `models/` are git-ignored. When deploying compiled code,
keep `scripts/faster-whisper-worker.py`, the Python environment, and model cache beside
`dist/`, or configure the executable/cache paths explicitly.

Settings in `apps/bot/.env` (restart after changing):

| Setting | Default / behavior |
| --- | --- |
| `GROQ_API_KEY` | Required in `auto` mode. The existing environment variable is reused. |
| `VOICE_STT_MODE` | `auto`: Groq then fallback; `local`: offline only; `off`: capture-only diagnostics. |
| `VOICE_STT_LANGUAGE` | `en`; use `auto` for language detection, or another supported language code. |
| `VOICE_STT_PYTHON` | Optional executable path with no arguments; overrides `.venv-stt`/PATH discovery. |
| `VOICE_STT_LOCAL_MODEL` | `small.en`; choose a multilingual model such as `small` for other languages. Can be a local CTranslate2 model directory. Rerun `setup:stt` after changing. |
| `VOICE_STT_DEVICE` | `cpu`; optional `cuda` requires compatible CUDA/cuDNN libraries. |
| `VOICE_STT_COMPUTE_TYPE` | `int8` for CPU; `float16` if CUDA and unset. Change the explicit `.env.example` value when switching to CUDA. |
| `VOICE_STT_THREADS` | `2`, valid `1`–`16`. |
| `VOICE_STT_CACHE_DIR` | `apps/bot/models/stt`, resolved relative to the app module. |
| `VOICE_STT_DEBUG` | `0`; `1` logs IDs, provider, model, status, fallback reason, and timings, without transcript content. |

#### Audio, results, and lifecycle

- Input is the existing **48 kHz stereo signed 16-bit LE PCM**, wrapped losslessly in
  WAV in memory; maximum **14 seconds / 2,688,044 WAV bytes**. Groq and faster-whisper's
  PyAV decoder downmix/resample to Whisper's 16 kHz mono input. No new client-side
  filtering or second VAD pass is applied. No recording/temp audio files are created.
- The processing deadline is **8 seconds for Groq**, then **40 seconds for local STT**
  including queue/model startup; the session watchdog is **55 seconds**, also covering
  the subsequent Phase V6 parser's maximum 5-second fallback. Local execution
  has one active inference and at most four waiting clips. Overload fails with `BUSY`.
  Cancelling an active local job terminates that Python worker; other guilds' queued
  jobs restart on a fresh worker. Cancelling a queued job does not interrupt its neighbor.
- Whitespace and typographic punctuation are normalized; exact leading `Jarvis`
  (optionally `Hey Jarvis`) and repeated leading wakes are removed case-insensitively.
  Interior wake mentions and artist/title punctuation are preserved. Empty text and
  wake-only text yield `status: "empty"`; they do not trigger more STT attempts.
- `VoiceReceiveManager` emits `transcript` only after a still-current session succeeds.
  The result carries guild/user/session IDs, normalized `text`, `rawText`, provider/model,
  status, truncation, audio duration, total/cloud/local timings, fallback reason, language,
  and available segment `avgLogprob`, `noSpeechProb`, `compressionRatio`, and timestamps
  (seconds). These signals are **not calibrated command confidence**; missing values
  remain absent. Local `languageProbability` is language detection, not text confidence.
- No audio is attached to transcript events or retained in the STT service. Session
  ownership remains locked until processing settles. Disconnect/timeout/shutdown cancels
  work, and stale results cannot publish or release a newer session. Service errors are
  sanitized; raw provider bodies and transcripts are not logged by default.

#### Verification and latency

1. Run `!join`, then `!commandtest` or `!commandtest wav`, and say **Jarvis, play Numb by
   Linkin Park**. The command reports capture statistics followed by normalized text,
   provider, and timing. WAV mode still explicitly posts your recording to Discord.
2. Repeat with `VOICE_STT_MODE=local` to verify offline inference; switch back to `auto`
   for normal operation. Try repeated Jarvis, wake-only speech, overlapping speakers,
   and leaving during transcription. The guild should always return to listening.
3. Benchmark a saved explicit diagnostic clip (auto mode uploads it to Groq):

```powershell
pnpm --filter bot diagnose:stt "C:/samples/command-test.wav" 3
pnpm --filter bot diagnose:stt --local "C:/samples/command-test.wav" 3
# Windows-only in-memory TTS smoke sample:
pnpm --filter bot diagnose:stt --local --synthetic 3
```

The diagnostic prints text, quality metadata, individual timings, first-run latency,
median, and p95. On this development machine, a **3.26-second synthetic** command took
**606 ms** through real Groq (one request), and **2,749 ms cold / 1,599–1,680 ms warm**
through real local `small.en` CPU int8 (three requests). Both transcribed the synthetic
title as **"Num"** instead of "Numb"; these are integration/latency smoke measurements,
not a claim of real-microphone accuracy or statistically representative percentiles.
Live microphone and loaded multi-guild benchmarks remain deployment checks.

Automated tests cover real SDK multipart construction with mocked HTTP responses,
429/daily resets, no retries, timeout/cancellation, shared budgets, transcript
normalization, session-only submission, owner/result correlation, diagnostic replies,
and real subprocess IPC/kill/restart using a protocol fixture. Python contract tests
verify WAV validation and lazy segment consumption without needing a model:

```powershell
pnpm --filter bot test
python -B -m unittest discover -s apps/bot/tests -p test_stt_worker.py
```

References: [Groq STT](https://console.groq.com/docs/speech-to-text),
[Groq limits](https://console.groq.com/docs/rate-limits),
[faster-whisper](https://github.com/SYSTRAN/faster-whisper).

### Voice command parsing (Phase V6)

Activated transcripts now pass through `apps/bot/src/voice/commands/VoiceCommandParser.ts`:

```text
Jarvis → owner capture → STT → local whole-command rules
                                  ├─ recognized / definite rejection → result
                                  └─ uncertain → Groq JSON schema → validation → result
```

`packages/shared` exports the input-independent `MusicCommand` union:

```ts
type MusicCommand =
  | { type: "play"; query: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "skip" }
  | { type: "queue" }
  | { type: "stop" };
```

The parser returns `{ command, source, reason, elapsedMs }`, with
`command: { type: "unknown" }` when it cannot establish a supported request. Groq
results also identify the model, whether the result was cached, and its self-reported
confidence when available. **Phase V6 produces normalized command data. The application
now routes recognized commands through Phase V7's authorized music execution below.**

#### Local-first policy

| Transcript after Jarvis | Result |
| --- | --- |
| `play Numb by Linkin Park` | Local `{ type: "play", query: "Numb by Linkin Park" }` |
| `put on Blinding Lights (Remix)` | Local `play`, retaining the version |
| `could you please pause the music` / `paws the music` | Local `pause` |
| `unpause` / `continue playing` | Local `resume` |
| `next track` / `skip this one` | Local `skip` |
| `show me the queue` / `what's in the cue` | Local `queue` |
| `stop the music` | Local `stop` |
| `don't skip`, `shuffle`, `play Numb and then stop`, bare `play` | Local `unknown`; no LLM call |
| `move on from this track` | Groq fallback can normalize to `skip` |

- Rules match the whole request, tolerate casing, punctuation, polite prefixes, and
  selected STT variants. They do not search arbitrary conversation for command words.
- Queries keep artist names, versions, and meaningful internal punctuation; the parser
  does not correct `Num` to `Numb` or otherwise resolve tracks. Explicitly quoted titles
  are supported. Ambiguous trailing words such as `please` can go to Groq rather than
  accidentally shortening a title such as **Say Please**.
- Empty/wake-only text, non-string/malformed input, input over 1,000 characters, missing
  queries, obvious unsupported/negated/multiple requests, and truncated captures are
  rejected locally. Play queries are limited to 500 characters, matching `!play`.
- Only uncertain text uses the existing `groq-sdk` and `GROQ_API_KEY`. The default is
  **`openai/gpt-oss-20b`**, listed in Groq's free-plan limits and supporting strict JSON
  schema. Requests use temperature 0, low reasoning effort, a 1,024-token output cap,
  no tools, no conversation history, and zero SDK retries. Only transcript text is sent
  by this stage, with no audio or Discord/session IDs.
- Responses must contain exactly `type`, `query`, and finite `confidence` in `[0, 1]`.
  A supported command needs confidence **at least 0.9**; other commands require a null
  query, and play queries must occur verbatim on word boundaries in the transcript.
  Unsupported types, extra fields, invalid JSON, partial completions, and ungrounded
  queries become `unknown`. Schema checks and model confidence cannot guarantee semantic
  accuracy; confidence is not a calibrated probability or a replacement for track scoring.

#### API savings, failure handling, and lifecycle

One parser instance is shared across guilds. Valid fallback decisions (including
`unknown`) are cached for **5 minutes**, keyed by the exact normalized text, with a
**128-entry** cap. Cache hits and local decisions make no parsing API call. There is no
permanent transcript cache and no default query/transcript logging.

The fallback reserves at most **10 requests per rolling minute** and **250 per rolling
24 hours** per bot process. These conservative request budgets are separate from STT's
budgets; organization-wide token/request quotas remain authoritative. HTTP 429 honors
`Retry-After`/exhausted request reset headers, transient failures impose a 15-second
cooldown, and configuration/authentication failures impose a 5-minute cooldown. Failed
requests are not cached or retried. Missing keys, budgets, outages, invalid output, or
the **5-second timeout** leave the result `unknown`; local rules remain usable.

`VoiceSessionOptions.parseTranscript(transcript, signal)` is awaited inside the existing
owner lock, after STT. The original PCM reference is released before parsing. Sessions
and `VoiceReceiveManager` emit a typed **`command`** event with the parse result and
`guildId`, `userId`, `sessionId`, and the captured `voiceChannelId`, without transcript/audio fields. Diagnostic callers
can use `waitForCommand(userId)`. Disconnects, resets, timeouts, and shutdown abort
parsing, release the lock, and prevent late results from publishing into newer sessions.

#### Configuration and verification

No additional dependencies or model download are required. Restart the bot after
changing `apps/bot/.env`; existing installations default to hybrid parsing:

```dotenv
# Reuses your existing GROQ_API_KEY
VOICE_COMMAND_MODE=hybrid
VOICE_COMMAND_MODEL=openai/gpt-oss-20b
VOICE_COMMAND_DEBUG=0
```

- `VOICE_COMMAND_MODE=local` disables the parsing LLM. For fully offline voice, also
  set `VOICE_STT_MODE=local`; these control separate stages.
- `VOICE_COMMAND_MODEL` overrides must support Groq strict JSON schema and low reasoning
  effort. Free-tier availability/limits depend on the model and your Groq account.
- `VOICE_COMMAND_DEBUG=1` logs type/source/reason/latency/IDs, without queries or transcripts.
- With `VOICE_STT_MODE=off`, capture diagnostics run without transcription/parsing.

Run `!join`, then `!commandtest`, and say **Jarvis, play Numb by Linkin Park**. The
diagnostic now reports capture, STT, and the parsed command/source. Try `Jarvis, next
track`, `Jarvis, move on from this track`, `Jarvis, don't skip`, and an unsupported
request. Repeat a fallback phrase to observe a cache hit. `!commandtest wav` retains
its explicit audio-upload behavior. Check leaving during processing and then starting
a new command. Live microphone/STT accuracy still needs this Discord check.

You can also verify parsing directly (hybrid mode may submit the supplied text to Groq):

```powershell
pnpm --filter bot diagnose:commands --local "Jarvis, play Numb by Linkin Park"
pnpm --filter bot diagnose:commands "move on from this track"
pnpm --filter bot test
pnpm --filter bot typecheck
```

A live synthetic-text smoke check returned `skip` through Groq in **405 ms**; the
local `play Numb by Linkin Park` path took **2.4 ms**. These are individual integration
checks, not accuracy/latency benchmarks. Automated coverage checks local API bypass,
query preservation, strict response validation, caching/budgets, real SDK HTTP shape,
timeouts/cancellation, session correlation, and diagnostic output while playback continues.

References: [Groq supported models](https://console.groq.com/docs/models),
[strict structured outputs](https://console.groq.com/docs/structured-outputs),
[free-plan limits](https://console.groq.com/docs/rate-limits).

### Voice music execution (Phase V7)

Recognized Jarvis commands now control the existing music engine:

```text
Jarvis → owner capture → STT → local/Groq parser → authorized voice adapter
                                                         │
!play / !pause / … → text adapter ─────────────────────────┤
                                                         ▼
                                       shared play/control handlers
                                                         │
                                    MusicService → TrackResolver → MusicPlayer
```

| Say | Behavior |
| --- | --- |
| **Jarvis, play Numb by Linkin Park** | Select the highest-scoring valid result using the same resolver as `!play`, then play or queue. |
| **Jarvis, pause** | Pause the current track. |
| **Jarvis, resume** | Resume paused playback. |
| **Jarvis, skip** | Discard the current track and start the next queued track. |
| **Jarvis, queue** | Post the current track and first queue page in the voice channel's text chat. |
| **Jarvis, stop** | Stop playback, clear pending tracks, disable looping, and invalidate pending play requests while staying connected. |

#### Shared execution and authorization

- `music/GuildMusicPlayers.ts` owns the per-guild connection/player registry used by
  both input methods. `commands/MusicCommandContext.ts` provides the requesting user,
  guild, response callbacks, and optional cancellation/current-session checks.
- `voice/commands/VoiceMusicCommands.ts` adapts validated commands into the existing
  `handlePlay` / `handleMusicControl` handlers. Voice uses the same resolver, provider,
  confidence ranking, queue, and loop behavior as text. Structured outcomes feed the
  centralized voice status renderer; prefix commands retain their existing replies.
- The voice adapter binds each request to its captured channel and current connection.
  It fetches the **triggering member**, rejects bot members, and requires that member to
  still be in the bot's channel for every voice command, including `queue`. Play requests
  recheck membership after discovery, immediately before adding the track. Prefix
  `!queue`/`!nowplaying` retain their existing outside-voice read access.
- Voice `play` uses an already established session/connection. Join with `!join` or
  `!play` first. Per-guild state and ownership stay independent across servers.
- Playback items retain `requestedBy: { guildId, userId }` through queueing. Voice command
  events also retain the session ID. `unknown`, unsupported, and malformed commands cause
  no music action. Observing/emitting a `command` event does not invoke execution.

#### Feedback and low-confidence tracks

Each accepted **Jarvis** activation immediately opens one status message in the
**activation voice channel's text chat**, before the 300 ms contention window finishes.
Only actual session activation produces this feedback; VAD, normal conversation, repeated
owner wakes, and busy-session detections do not create extra messages.

```text
GuildVoiceSessions → typed feedback event → VoiceReceiveManager
                                               ↓
                                  DiscordVoiceCommandFeedback
                                               ↓
🎙️ Listening... → ⏳ Processing your command... → 🔎 Searching for **song by artist**...
                                               ├─ ▶️ Playing **song — artist** / ➕ Queued
                                               └─ Short failure / cancellation / timeout message
```

`src/voice/feedback/VoiceCommandFeedback.ts` defines the UI-independent state contract.
The session coordinator reports listening/processing and lifecycle failures;
`VoiceMusicCommands` forwards structured shared-handler music outcomes through the
session's `report` callback. `DiscordVoiceCommandFeedback.ts` alone sends/edits the
voice status. STT, wake detection, parsing, providers, and the player don't depend on it.
`!commandtest` observes this same pipeline; no diagnostic command is needed to get feedback.

- Updates edit the original message, serialize writes, and coalesce intermediate states
  while Discord is slow. The first listening message and final outcome are retained.
  Mentions are disabled and user/provider titles are Markdown-escaped.
- Discord I/O is **not awaited by the session**. Each send/edit has a five-second local
  wait limit; a failed or stalled write cannot hold ownership, replay an action, or
  overwrite a newer session. Discord requests already in flight cannot be recalled.
  Deleted status messages get one replacement; other failures are logged without retries.
- Wake-only recognition says no command was heard; a truly empty STT result says no words
  could be made out. Empty audio, STT failure, unknown/unsupported requests, truncated
  commands, capture errors, timeouts, cancellations, and simultaneous speakers all get
  concise retry guidance. Raw errors and internal IDs aren't included in normal statuses.
  A wake-only request still uses STT: pre-roll may already contain the entire spoken command,
  so lack of later VAD frames is **not** grounds for discarding it.
- Track matching automatically selects the **highest-scoring valid candidate**, even
  below the former 0.75 threshold or at zero confidence. No suggestion list or manual
  selection interrupts playback. No valid candidates still means “no suitable track.”
- Ranked candidates retain their original confidence scores internally; `MUSIC_DEBUG=1`
  logs the selected track ID, provider, confidence, and candidate count. Parser confidence
  and track-match confidence remain separate, uncalibrated heuristics.
- Accepted/queued playback may fail later. That produces a separate sanitized notification
  in its original voice chat, without editing another command's status.

The bot needs **View Channel** and **Send Messages** in the voice channel's text chat;
existing Connect/Speak permissions are still needed for joining/playback. Feedback is text.

#### Execution lifetime

`VoiceSessionOptions.executeCommand(command, signal)` is an **awaited hook**, not an async
event listener. It runs after parsing under the same guild/user lock. Wake listening stays
paused until execution settles; repeated/other-user activations cannot duplicate dispatch.
The existing 55-second STT/parsing watchdog is replaced with a separate **60-second**
execution watchdog for discovery, extraction, and startup. Feedback delivery is independent. Normal commands
usually finish much sooner. Text controls remain usable while a voice command processes.

Owner departure, bot movement/disconnection/deafening, session reset, execution timeout,
or shutdown abort pending execution. Cancellation promptly stops waiting for a member
lookup or discovery request, and any late response is discarded. Discovery APIs without
an abort parameter may still finish their bounded HTTP request; its result cannot enqueue
music. `!stop` also invalidates in-flight play searches through the player's existing
request generation check.

Cancellation during audio startup releases that startup's resource/subscription, aborts
extraction, and disposes late audio. Other queued requests remain intact and can advance;
a stale request cannot stop a newer player/track. Once a track has been acknowledged as
playing or queued, it belongs to the music engine and survives normal session completion
or the requester's later departure. Already-applied controls, such as a skip, are not undone.

#### Live check

No new key, dependency, or feature flag is needed. Restart with `pnpm dev:bot`, then:

1. Join a normal voice channel and run `!join`.
2. Say **Jarvis, play Numb by Linkin Park**. Check the voice channel's text chat and audio.
3. Add another song with `!play`, then try **Jarvis, queue**, **pause**, **resume**, and
   **skip** (include Jarvis before each command). Both interfaces should share one queue.
4. Say **Jarvis, stop**. Playback/queue/looping should clear while the bot remains connected.
5. Say just **Jarvis**, then try an ambiguous song, an unsupported command, two overlapping
   wakes, and leaving during a pending play request. Check that one status changes from
   listening to a useful outcome, and the next Jarvis request works without resetting voice.
6. Use `!commandtest` or `!commandtest wav` for capture/parser diagnostics. These observe
   the live execution pipeline: **supported commands execute normally**, and their music
   responses appear in the voice chat. `diagnose:commands` remains a text parser diagnostic.

Automated coverage in `tests/voiceMusicCommands.test.mjs` exercises the complete
wake-session → transcript → parser → dispatch → real music-engine path with mocked
Discord transport/providers, including six-command behavior, shared prefix state, owner
authorization, low confidence, channel/guild isolation, cancellation at async boundaries,
late resources, feedback failures, and diagnostics. Existing receive tests cover real
Opus/VAD boundaries. Live microphone, Discord transport, and provider playback still need
the above deployment check.

### Noise robustness and audio quality (Phase V8)

`pnpm --filter bot diagnose:voice` provides a **paired, sample-driven evaluation** of
the existing voice pipeline. It replays each clip through production framing, WebRTC
VAD, onset pre-roll, native keyword inference, and finalization, with fresh per-sample
state. The wake pronunciation list is now the two U.S. English paths documented above.

#### Capture a representative corpus

1. Run `!join`, then `!waketest sample` for a complete wake attempt, including misses
   and negative phrases. Save the WAV and its JSON. Use `!commandtest wav` for an actual
   session's completed command clip and transcript. These commands explicitly upload
   the caller's audio; normal receiving does not save recordings.
2. Create `apps/bot/voice-samples/` locally (git-ignored), and save uniquely named samples
   there. Use `apps/bot/scripts/voice-corpus.example.json` as the manifest template;
   replace its placeholder filenames with your recordings. File paths resolve relative
   to the manifest, not the shell. If you move the manifest, adjust its relative paths.
3. Include quiet speech, keyboard typing, a fan, microphone hiss, headphones, speakers
   playing music, and a physical background speaker. Record **both positives and
   negatives under each condition**, across several U.S. English speakers/microphones,
   quiet/normal/loud levels, fast/normal speech, and Discord suppression settings.
4. Positive phrases should include natural **Jarvis**, **Jarvis play …** without a
   pause, and a short pause before the command. Negatives should include ordinary
   conversation, noise alone, **Travis**, **Harvest**, **Jervis**, **service**, and **jar
   of jam**. Label by what was actually said, rather than by the detector's result.
   Someone physically saying the actual word Jarvis into the same microphone is an
   acoustic positive, even if they weren't addressing the bot; keyword spotting alone
   cannot distinguish that intent.
5. For clips to transcribe, add `referenceText` containing the intended command. An
   empty reference can test wake-only hallucinations. Keep these clips within 14 seconds;
   other samples may be 20 ms–60 seconds and at most 50 MB. Overlong clips are rejected,
   not silently trimmed. A run accepts 2–200 samples, capped at 128 MiB decoded PCM.

```powershell
# After replacing the template's placeholder WAV paths:
pnpm --filter bot diagnose:voice --manifest scripts/voice-corpus.example.json
# Add local STT accuracy and write a new report in your existing sample directory:
pnpm --filter bot diagnose:voice --manifest scripts/voice-corpus.example.json --stt local --output voice-samples/report.json
# Windows-only reproducible synthetic smoke experiment:
pnpm --filter bot diagnose:voice --synthetic --opus --stt local
```

FFmpeg and the installed wake model are required. `--stt local` uses the previously
cached faster-whisper model from Phase V5; no cloud requests are made by this diagnostic,
regardless of `VOICE_STT_MODE` in `.env`. Transcription is otherwise off. `--opus` is
for synthetic/original non-Discord samples; Discord recordings already passed through
Opus. Synthetic audio, mixes, and filtered variants stay in memory. `--output` writes
only the JSON report and requires a new filename in an existing directory.

#### Comparisons and measurements

The default experiment changes one setting at a time:

| Configuration | Settings |
| --- | --- |
| `baseline` | Raw PCM, VAD mode 2, threshold 0.25, score 1.5. |
| `vad-1` / `vad-3` | More permissive / restrictive WebRTC modes. |
| `threshold-0.20` / `threshold-0.30` | Less / more strict acoustic acceptance. |
| `highpass` | FFmpeg `highpass=f=80`. |
| `denoise` | `highpass=f=80,afftdn=nr=6:nf=-50:tn=1`: mild FFT noise reduction with noise-floor tracking. |

These are explicit experiment settings, independent of your `.env` VAD/wake tuning.
To compare your current settings, add a `configurations` array to the manifest. Each
entry must specify `id`, `vadMode` (0–3), `threshold` (0–1, exclusive of 0), `score`
(0–5, exclusive of 0), and `preprocessing` (`raw`, `highpass`, or `denoise`). Put the
raw reference first. Up to 16 configurations are supported. For example:

```json
"configurations": [
  { "id": "baseline", "vadMode": 2, "threshold": 0.25, "score": 1.5, "preprocessing": "raw" },
  { "id": "candidate", "vadMode": 2, "threshold": 0.20, "score": 1.5, "preprocessing": "raw" }
]
```

Reports contain:

- Exact configuration, pronunciation tokens, filter definitions, model-file hashes,
  and decoded-input hashes to identify paired samples.
- Original and processed left/right/mono RMS dBFS, peak, DC offset, and rail-clipped
  sample fraction. Silence has `rmsDbfs: null`. These are signal statistics, not SNR or
  intelligibility estimates; opposing stereo channels can cancel during mono downmix.
- Wake hits/misses, selected pronunciation, VAD-positive time, gate outcome, native
  diagnostics, processing cost, and recovered/regressed sample IDs versus the baseline.
- False-positive **clips** and native keyword hits per hour of analyzed negative audio.
  This excludes incomplete final VAD frames and the live session/cooldown policy; it
  is not a deployment false-activation rate. Small negative exposure proves very little.
- Optional transcripts, exact matches, and corpus-weighted word error rate (WER).
  Leading wake phrases/case/punctuation are normalized; song/artist word errors count.
  Labelled full clips are transcribed even when wake detection misses, to isolate STT
  quality. They do not simulate command capture timing or execute music commands.
  Identical sample/preprocessing STT results are reused for VAD/threshold-only comparisons.
- Results grouped by `recording`/`synthetic` and condition, errors kept visible, and
  `missingLiveConditions`. Presence of a condition is a coverage aid, not certification.

Every native stream/worker is closed after its evaluation. Preprocessing uses bounded
FFmpeg subprocesses in the offline tool; it adds no work to the bot's receive callback.
The tool exits **1** for any evaluated configuration with a miss, false wake, STT word
mismatch, or error, while still producing the report. An unsuccessful experiment should
not look like a passing acceptance test.

#### Measured experiment and tuning decision

With David/Zira en-US TTS, the synthetic suite has **51 cases**: 24 positives and 27
negatives (49.44 seconds of analyzed negative audio). Each voice says Jarvis, a continuous
command, “The service is ready,” and “Travis,” with quiet, seeded keyboard/fan/hiss,
120 ms echo, and competing speech variants, plus three noise-only clips. Noise mixes
use 15 dB clip-level SNR; echo/background speech use 12 dB. These are proxies for
real conditions, not recordings of devices/rooms. Noise is mixed **before** the Opus
round trip; candidate preprocessing runs **after** it, matching the receive boundary.

Real native KWS and local `small.en` CPU/int8 on the same clips produced:

| Experiment | Positive detections | False-wake clips | STT word edits / 60 reference words |
| --- | --- | --- | --- |
| Raw baseline | 22 / 24 | 0 / 27 | 21 (35.0%) |
| VAD 1 or 3 | 22 / 24 | 0 / 27 | Same raw-audio STT result |
| Threshold 0.20 | 23 / 24 | 0 / 27 | Same raw-audio STT result |
| Threshold 0.30 | 21 / 24 | 0 / 27 | Same raw-audio STT result |
| 80 Hz high-pass | 21 / 24 | 0 / 27 | 19 (31.7%) |
| High-pass + mild denoising | 24 / 24 | 0 / 27 | 21 (35.0%) |

The baseline misses were Zira's two keyboard-noise positives. Denoising recovered
both, but worsened David's fan-noise transcript while improving his background-speech
transcript. High-pass alone introduced a wake miss on Zira's echo command. STT commonly
returned “Num” / “Lincoln Park”; all 12 labelled commands had at least one word error.
The experiment therefore correctly exited nonzero.

**Decision:** retain raw production audio and use VAD 2 / threshold 0.25 / score 1.5 as
the calibration baseline. Filtering and the more sensitive 0.20 threshold need paired
live evidence before adoption. Select on one set of recordings, then verify with
held-out speakers/phrases, checking clean speech as well as noise. Listen to samples
and compare command/title accuracy, not just lower noise energy. Representative Discord
microphone samples were not available in the repository; their acceptance items remain
open in `apps/bot/voice-commands-outline.md`.

Automated `tests/voiceEvaluation.test.mjs` covers corpus validation, real FFmpeg format
and signal preservation, repeatable noise/SNR, error-rate accounting, STT isolation,
resource cleanup, and the manifest CLI with the real installed wake model. Existing
wake/receive/session tests retain speaker ownership, cooldown, and cancellation coverage.

### Concurrency and advanced edge cases (Phase V9)

The receive/session boundary now preserves cooldowns and correlates failures to the
owning stream. `tests/voiceConcurrency.test.mjs` exercises real per-user Opus decoding,
session capture, STT orchestration, normalization, parsing, dispatch, and music state
together, with controlled Discord transport, VAD/KWS results, and external providers.

| Situation | Policy |
| --- | --- |
| Overlapping speech | Capture only the triggering Discord user's original PCM. Playback continues during capture. |
| Distinct users wake within 300 ms of first delivery | Reject all contenders, discard their capture, and give one one-at-a-time retry status. Identical audio from different users still counts as contention. |
| Wake during listening, STT, parsing, or execution | Treat the guild as busy; keep the owner. Pending keyword results are cancelled and paused audio is excluded from new detectors/pre-roll. |
| Repeated wake / rapid commands | Keep the existing **3-second per-user, per-guild wake cooldown** across completion and contention rejection. It runs from accepted activation, not completion. Ignored repeats never extend it. Repeated leading Jarvis words still normalize to one command. |
| Another user / another guild | A different user may activate as soon as their guild is idle. The same user in another guild has independent ownership and cooldown. |
| Delayed stream cleanup | Check guild, user, and current stream identity. Old stream errors cannot cancel a newer capture. `streamStart` identifies owner continuations even if initialization fails before the first PCM frame. |
| Receive error after capture | The immutable STT clip no longer depends on receiving. An unrelated/later receive error does not cancel processing; owner departure and connection loss still abort every stage. |
| Wake backend error | `wakeError` immediately rejects affected command diagnostics and cancels an affected owner's contention. Raw receiving and other users/guilds remain usable when their backends are healthy. |
| Owner leaves / connection interrupted / STT times out | Abort affected work, free the guild lock, and suppress late transcript/command/execution results. A late completion cannot release a replacement owner. Reconnection starts fresh receiving. |

The rapid-command and contention regressions justify preserving the user debounce;
they do not justify an additional per-guild cooldown beyond the existing owner lock.
Expired user entries are pruned on wake delivery; departure/reset clears their state.
DJ/role priority remains a future policy decision: ambiguous activations are rejected.

Session isolation is independent of backend capacity. Cloud request budgets/cooldowns
and the local inference worker are shared. Cancelling active local STT kills that
worker and restarts queued jobs without cancelling their sessions; cancelling a queued
job leaves the active job alone. A fatal shared wake-worker failure still requires a
bot restart, as documented in V3; per-stream failures can recover on a new utterance.

#### Automated verification

```powershell
pnpm --filter bot test:voice-concurrency
pnpm --filter bot typecheck
```

The focused suite includes the existing session, wake receive, music execution, and
local subprocess tests. New regressions cover overlapping Opus input during playback,
simultaneous and delayed wakes, repeated words, cooldown expiry across receive streams,
same-user cross-guild commands, STT timeout with a healthy neighboring guild, wake
startup/inference failures, and departure/connection loss during capture, STT, and
execution. It also checks stale/foreign stream events and initialization failures before PCM.

**Echo coverage:** controlled keyword hits on identical two-user PCM test ambiguous
echo activation, and a delayed/busy echo tests cancellation and fresh-audio boundaries.
These are policy tests, not acoustic echo-cancellation measurements. If physical bot
playback enters a user's microphone while idle and contains Jarvis plus a supported
command, it can still execute. Discord user IDs separate digital streams, not sounds
inside one microphone. The existing V8 evaluator and the live check below measure
that acoustic behavior; the bot does not infer intent from identical PCM or mute
all wake detection while music plays.

#### Live multi-user acceptance

Enable `VOICE_SESSION_DEBUG=1` and `VOICE_WAKE_DEBUG=1`, run `!join`, and test with two
accounts; repeat in a second guild. Wait until the session is idle and at least three
seconds after your previous accepted wake before a normal retry.

| Check | Verify |
| --- | --- |
| Alice uses `!commandtest wav`; Bob talks over her command | Only Alice's digital stream is in the capture; exactly one command executes. |
| Both say Jarvis together, then one retries | One contention failure, no music action from the rejected capture, then a successful solo retry. Repeat near the window boundary; arbitration uses delivery time. |
| Bob says Jarvis while Alice is listening/processing | Alice remains owner; Bob must issue a fresh command after idle. |
| Say “Jarvis, Jarvis, pause” during music; then attempt a quick repeat | One pause; no duplicate session during the user cooldown; normal next command after cooldown. |
| Repeat with headphones, then speakers at normal/loud playback levels | Record intentional commands and playback-only negatives with `!waketest sample`; include playback containing Jarvis with/without command words. Compare wakes and actions against the labelled audio. |
| Alice leaves mid-command; interrupt/reconnect the bot | The pending command cancels, stale results do not execute, and a fresh command works after reconnecting. |
| Issue commands in both guilds, then interrupt one | The other guild retains its owner, captures its own audio, and completes to its own channel. |

Live microphone echo, recognition accuracy, and real Discord/inference timing remain
acceptance items in `apps/bot/voice-commands-outline.md`.

### YouTube pipeline

```text
!play → MusicService → TrackResolver → YouTubeProvider → YouTube Data API
                    → MusicPlayer queue → yt-dlp stdout → FFmpeg → Discord Opus
```

- Text queries retrieve up to 10 video results, then fetch duration, artwork,
  channel, and availability in one `videos.list` request. Duplicate IDs are removed.
- Watch, short, Shorts, embed, and mobile/music YouTube video links bypass search.
  Playlist-only and non-YouTube URLs are rejected. A video link containing a playlist
  plays just that video; timestamp parameters are ignored.
- Metadata decodes HTML entities and converts ISO 8601 durations into seconds.
  Artist/title splitting uses upload titles and channel names as heuristics;
  YouTube does not provide reliable structured recording-artist metadata.
- Scoring compares title/artist tokens, understands `song by artist` and
  `artist - song`, slightly prefers official-labelled titles, and penalizes
  unintended live/remix/cover/acoustic/etc. versions. The highest-scoring valid result
  is automatically selected regardless of confidence; an explicit video URL scores `1`.
- Low-confidence matches proceed directly to playback or queueing. Scores and ranked
  candidates remain available internally for debugging. Live/upcoming, private, and
  unprocessed videos are excluded; no valid candidates is still a failure. Region/age
  restrictions may still prevent extraction.
- The Data API provides **metadata, not audio streams**. `yt-dlp` resolves fresh
  audio when a track reaches the front of its guild's queue. FFmpeg transcodes it
  into Discord audio. No downloaded media files or expiring audio URLs are cached.
- API calls have 10-second timeouts; extraction must produce audio within 30 seconds.
  Missing keys, quota exhaustion, unavailable videos, and missing executables return
  actionable errors. Stopping/leaving cancels extraction and releases streams/processes.
- Audio downloads use 256 KiB HTTP byte ranges and up to three retries. This keeps
  YouTube's default multi-megabyte responses from remaining open for most of a song
  while Discord's real-time consumption applies backpressure. The startup deadline
  is cleared when audio arrives; it does not limit track duration.
- Results are currently uncached: each text search consumes API quota for
  `search.list` plus `videos.list`; direct video links use only `videos.list`.

The scoring is an initial heuristic, not a calibrated probability. Multi-provider
matching and alternate-candidate playback fallback remain
Phase 7 work. Playback failure currently clears the queue and notifies the requester
(through the text channel for already accepted/queued requests).

### Provider contracts

The bot-local provider layer is exported from `apps/bot/src/music/providers/index.ts`.
The shared package continues to contain domain types rather than Discord audio types.

```ts
interface MusicProvider {
    readonly source: MusicSource;
    search(query: string): Promise<TrackCandidate[]>;
}

interface PlaybackProvider extends MusicProvider {
    getAudio(track: Track, signal?: AbortSignal): Promise<AudioResource>;
}
```

- A successful search returns normalized candidates; no matches returns `[]`.
- `isPlaybackProvider(provider)` narrows the capability without performing a search
  or resolving audio. Metadata-only providers need only implement `MusicProvider`.
- `getAudio` returns a fresh `@discordjs/voice` resource. The discovery `Track.url`
  is not assumed to be an audio URL, and the track's discovery source may differ
  from the playback provider.
- The caller owns the returned resource until passing it to the music player, and
  must destroy its `playStream` if it is not used. Audio retrieval should occur
  just before playback.

The engine accepts synchronous or asynchronous resource factories. The optional
abort signal lets a provider cancel extraction when playback is stopped or replaced.
Providers must also release owned processes/streams when `playStream` is destroyed.

#### Candidate normalization

`normalizeCandidate(source, metadata)` accepts flat metadata that an adapter has
already mapped to `id`, `title`, `artist`, `url`, and optional `album`, `duration`,
`thumbnail`, and `confidence` fields. `normalizeCandidates(source, metadataArray)`
applies the same rules to a batch.

- IDs, titles, artists, and discovery URLs must be non-empty strings. Adapters
  convert provider-specific IDs and artist lists into this shape.
- IDs are trimmed; title, artist, and album whitespace is also collapsed. Case,
  punctuation, Unicode, and meaningful version words such as “live” and “remix”
  are preserved.
- Durations are finite, non-negative **seconds**; the adapter is responsible for
  converting its source's units. Fractional seconds and zero are retained.
- Discovery and thumbnail URLs are normalized absolute HTTP(S) URLs without
  embedded credentials. Provider-specific URL/ID validation belongs to adapters.
- Missing/null duration and missing/null/blank album or thumbnail are omitted.
- Missing/null confidence becomes `0` (unscored). Supplied confidence must be a
  finite number in `[0, 1]`; normalization does not calculate or clamp scores.
- The explicit source argument sets both `track.source` and `candidate.provider`.
  Other input fields are ignored, and the input is never mutated.
- Batches preserve ordering and duplicate candidates. Malformed metadata fails
  with `ProviderError` instead of silently dropping a result or inventing metadata.

This common normalization is separate from YouTube-specific field mapping and
from query-normalization, scoring, and selection algorithms.

#### Provider errors

Provider methods reject with `ProviderError`, carrying `provider`, `operation`
(`search`, `normalize`, or `getAudio`), `code`, a message, and an optional `cause`.

The error codes are `INVALID_INPUT`, `INVALID_RESPONSE`, `UNAVAILABLE`,
`UNAUTHORIZED`, `RATE_LIMITED`, `NOT_PLAYABLE`, and `UNKNOWN`. Common normalization
uses `INVALID_RESPONSE`. Providers classify known API failures themselves;
`toProviderError(error, source, operation)` wraps remaining failures as `UNKNOWN`
with a generic message and preserves the original cause. Existing `ProviderError`s
retain their identity and classification, including normalization failures caught
by a search implementation. These errors describe failures; retry and fallback
policies belong to later phases.

### Music engine API

`MusicPlayer` in `apps/bot/src/music/MusicPlayer.ts` owns an existing voice connection:

- `play(item)` starts an idle player or appends to the FIFO queue. It resolves to
  `"playing"` after playback starts, or `"queued"` when added behind an active item.
- `pause()` / `resume()` return whether the underlying audio player changed state.
- `skip()` discards the current item and starts the next one, returning `false` if idle.
- `stop()` cancels pending startup, stops audio, and clears the queue while keeping voice connected.
- `requestVersion` invalidates pending discovery requests when stopped or destroyed.
- `shuffle()` reorders pending items only; `setLoopMode("off" | "song" | "queue")`
  configures natural completion. Stop/failure/destruction resets the mode to off.
- `playbackState` distinguishes idle, loading, playing, and paused states for commands.
- `destroy()` also disconnects voice, is safe to repeat, and prevents subsequent playback.
- `current`, `currentTrack`, and `queue` expose the active item, its optional metadata,
  and a snapshot of pending items. The current item is not counted in the queue.

A bot-local `PlaybackItem` supplies a `createResource(signal)` function returning
an `AudioResource` or `Promise<AudioResource>`,
optional shared `Track` metadata, and an optional `onError(error)` callback. The
factory runs only when its item starts, avoiding open audio streams for waiting
items. The player does not search for tracks or interpret provider URLs.

The local test clip supplies only a resource: the architecture's `MusicSource`
union remains `"spotify" | "youtube" | "soundcloud"`. `MusicQueue<T = Track>` lets
the player associate track metadata with its audio resource factory while keeping
the default queue type as the shared `Track`.

Natural completion advances the queue. A playback failure stops and clears it,
calls the failed item's `onError`, and rejects `play()`/`skip()` if that call was
waiting for startup. Stopping, skipping, or destroying during startup cancels that
pending call without reporting a playback error. Provider fallback is a later phase.

`!playtest` / `!pluh` remains a restartable diagnostic: repeating it replaces current
playback and clears the queue/loop mode. Use `!join` first for this local-audio test.

### Requirements

- Node.js **22.12.0 or newer** (required by the installed `@discordjs/voice`).
- pnpm (the workspace uses pnpm 12's `allowBuilds` setting).
- FFmpeg installed and available on `PATH` to decode local and YouTube audio.
- A current `yt-dlp` installation for YouTube audio extraction. Official standalone
  binaries include its EJS components; Python installations should use
  `python -m pip install -U "yt-dlp[default]"`. The bot explicitly enables its running
  Node executable as yt-dlp's JavaScript runtime.
- A Google API key with **YouTube Data API v3** enabled for search and metadata.
- A Discord application/bot invited to a test server with the `bot` scope.
  Prefix commands do not require `applications.commands`. Give the bot **View Channel**,
  **Send Messages**, and **Read Message History** in the command text channel
  (and **Send Messages in Threads** if used there), plus **View Channel**, **Connect**,
  and **Speak** in the voice channel.
- In **Discord Developer Portal → your application → Bot → Privileged Gateway Intents**,
  enable **Message Content Intent**. Approved access is required for verified apps
  where Discord requires it. The code also requests this intent; without portal access
  the bot cannot read prefix messages and Discord may reject its gateway connection.

### Setup and run

From the repository root:

```sh
pnpm install --frozen-lockfile
```

The workspace permits the existing native `@discordjs/opus` dependency's install
script. If it was previously installed with scripts disabled, run
`pnpm --filter bot rebuild @discordjs/opus`.

Copy `apps/bot/.env.example` to `apps/bot/.env` and set:

```dotenv
DISCORD_TOKEN=your_bot_token
YOUTUBE_API_KEY=your_youtube_data_api_key
# Optional if yt-dlp is not on PATH:
YT_DLP_PATH=C:/Tools/yt-dlp.exe
```

The token is required at startup. `YOUTUBE_API_KEY` is read from the bot's environment
and is required when using `!play`. Keep the `.env` file local. No new dependencies
are needed for the prefix commands or controls.

On Windows, install yt-dlp with:

```powershell
winget install --id yt-dlp.yt-dlp --exact
```

Alternatively, download the official executable from
[yt-dlp releases](https://github.com/yt-dlp/yt-dlp/releases/latest) and set
`YT_DLP_PATH` to its full path (no command-line arguments). Restart your terminal
after changing `PATH`. Check prerequisites:

```sh
yt-dlp --version
ffmpeg -version
```

Keep yt-dlp up to date as YouTube changes. Standalone installs can use `yt-dlp -U`;
package-manager installs should be updated through their package manager.

Start the bot; prefix commands require no registration or synchronization:

```sh
pnpm dev:bot
```

#### Remove previously registered slash commands (one-time migration)

The old interaction handler, slash builders, and `register` script have been replaced.
Discord stores already registered commands remotely, so removing local code alone does
not remove their menu entries. Set these additional values in `apps/bot/.env`:

```dotenv
DISCORD_CLIENT_ID=your_application_id
DISCORD_GUILD_ID=your_previously_registered_server_id
```

Then run:

```sh
pnpm --filter bot remove-legacy-commands
```

This removes only the old chat-input commands `play`, `join`, `leave`, `ping`,
`playtest`, and `pluh` from the application's global scope and the specified guild.
Unrelated commands/context menus are preserved. Repeat with each previously registered
guild ID; omit `DISCORD_GUILD_ID` for global-only cleanup. These IDs are not needed for
normal bot startup. The cleanup is not run automatically and there is no slash-command
listener alongside the prefix handler.

Or run the compiled bot:

```sh
pnpm --filter bot build
pnpm --filter bot start
```

The bot's build and type-check scripts first build `@discord-music-platform/shared`
so its exported declarations are available on a fresh checkout.

These pnpm commands run from `apps/bot`, where dotenv loads the application's
`.env`. The MP3 path is resolved relative to the source/compiled module and does
not depend on the process working directory. Keep `assets/` alongside `dist/`
when running the compiled bot.

### Validation

```sh
pnpm --filter bot test
pnpm --filter @discord-music-platform/shared typecheck
pnpm --filter bot typecheck
pnpm --filter bot build
```

Tests use Node's test runner, the existing `tsx` dependency, and Node's experimental
module-mocking flag. They cover FIFO order, automatic queue advancement, player
controls, cancellation during startup, voice readiness, failed joins/playback,
resource cleanup, repeated commands, guild isolation, provider normalization/error
contracts, Data API error handling, YouTube normalization/scoring, async extraction
cancellation, prefix parsing, automatic joining, simultaneous requests, all music
controls, loop resource renewal, legacy-command cleanup, and real subprocess-stream-to-Opus decoding. They do not
require a Discord token, YouTube key, network access, or installed yt-dlp; extraction
is mocked and the decoding tests require FFmpeg and Opus.

The bot has no lint script. Type checking covers all bot source files and the
compile-time provider contract tests in `apps/bot/tests/types`. Those fixtures test
valid and invalid implementations and are not emitted into the production build.
The shared package has its own build and type-check scripts.

### Discord smoke test

1. Enable Message Content Intent, start the bot, and check that `!ping` returns `Pong!`.
2. Run `!join` and `!play song` without being in voice; expect helpful rejections.
3. Join a normal voice channel, then run `!join`; expect confirmation after the
   connection becomes ready.
4. Run `!playtest`; expect “Playing test audio.” and hear the supplied local clip.
5. Run `!pluh` during playback; the old audio should stop and the clip restart.
6. Run `!leave` during playback; audio should stop and the bot should disconnect.
7. Run `!playtest` after leaving; expect instructions to use `!join` first.
8. If testing in multiple servers, verify that joining/leaving one does not
   interrupt the other's test audio.
9. Let the clip finish, then run `!playtest` again to check that the guild's player is reusable.

### YouTube smoke test

1. Set `YOUTUBE_API_KEY`, install yt-dlp, enable Message Content Intent, and start the bot.
2. Join a normal voice channel while the bot is disconnected. Run `!play Numb by Linkin Park`;
   expect automatic joining, the selected title, and audible music.
3. Queue two more songs. Check `!queue`, `!nowplaying`, `!pause`, and `!resume`.
4. Run `!shuffle`, inspect the queue, then `!skip`; expect the next queued track.
5. Try `!loop song`, `!loop queue`, and `!loop off`, allowing natural completion in each mode.
   Verify `!skip` still advances and `!stop` clears playback, queue, and loop mode without disconnecting.
6. Run `!play` again without `!join`. Repeat `!join` in the same channel during playback;
   it should preserve the current audio. Try simultaneous requests from two users in that channel.
7. Try a direct YouTube video URL, an invalid URL, an unavailable video, and a low-confidence
   query. Expect useful errors for invalid/unavailable videos and automatic play/queue
   for valid low-confidence matches, without suggestions. Verify that later requests work.
8. Run `!stop` during search/extraction and `!leave` during connection/extraction/playback;
   late results must not restart audio. Test voice permission failures and retrying after fixing them.
9. From another voice channel, verify that `!play` and playback controls are rejected.
   Run commands in two servers and confirm their queues, loops, and connections stay isolated.
10. After legacy cleanup, verify that old slash commands no longer appear in Discord.

Live YouTube extraction and Discord connectivity/audible output require this manual check.

### Playback diagnostics

Failures log the video ID, elapsed time, yt-dlp exit code, a bounded/sanitized stderr
tail, and nested error causes. Player failures also include audio/voice state and
playback duration. Signed media URLs and credentials are redacted. To trace normal
process exits, cleanup, and Discord state transitions too, set in `apps/bot/.env`:

```dotenv
MUSIC_DEBUG=1
```

Test the complete extraction/decoding pipeline **at real-time playback speed**,
without logging the bot into Discord or using Data API quota:

```powershell
pnpm --filter bot diagnose:youtube "https://www.youtube.com/watch?v=NKSCHuxEC2g" 180
```

The final argument is the maximum run time in seconds (default: 90). This video
should finish with approximately `audioSeconds: 147.68` and `ended: true`. A normal
yt-dlp exit with code `0` can precede playback completion while FFmpeg/Opus buffers
drain. Nonzero exits and real stream errors still fail playback and clear the queue;
intentional cancellation does not emit a playback failure.

For this video's previously reproducible truncation, yt-dlp reported
`458752 bytes read, 1211397 more expected. Giving up after 1 retries` under slow
consumption, while unrestricted decoding completed successfully. Small range
requests fixed the real-time download with the installed yt-dlp 2026.08.19 and
FFmpeg 7.0.2; replacing the FFmpeg codec configuration was unnecessary.

After the diagnostic passes, run `!play` for the same link in Discord and queue
another track. Verify the first finishes and the second starts, and that `!leave`
still stops playback cleanly.
