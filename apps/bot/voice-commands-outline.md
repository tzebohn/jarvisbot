# Voice Commands Implementation Outline

## Goal

Build a scalable, efficient, and safe voice-command system for the
Discord music bot.

The bot should be able to idle in a Discord voice channel, listen for a
wake phrase **"Jarvis"**, identify which Discord user triggered
it, capture only that user's command, convert the command to text, parse
it into a known music command, and pass it into the existing music
engine.

Example:

``` text
"Jarvis, play Numb by Linkin Park"
        │
        ▼
Wake-word detection
        │
        ▼
Capture triggering user's speech
        │
        ▼
Speech-to-Text
        │
        ▼
play Numb by Linkin Park
        │
        ▼
VoiceCommandParser
        │
        ▼
Existing Music Engine
        │
        ▼
TrackResolver → Queue → MusicPlayer
```

The voice subsystem should remain separate from the music subsystem.
Voice recognition is only another input method, alongside slash commands
and prefix commands.

``` text
              INPUT LAYER

       ┌──────────┬──────────┐
       │          │          │
       ▼          ▼          ▼
     /play      !play      Voice
       │          │          │
       ▼          ▼          ▼
     Slash      Prefix      Voice
     Parser     Parser      Parser
       │          │          │
       └──────────┼──────────┘
                  ▼
          Normalized Command
                  │
                  ▼
          Existing Music Engine
                  │
          ┌───────┴────────┐
          ▼                ▼
    TrackResolver      MusicPlayer
          │                │
          ▼                ▼
      Providers           Queue
```

------------------------------------------------------------------------

# Core Voice Pipeline

The long-term voice pipeline should look approximately like this:

``` text
Discord Voice Channel
        │
        ▼
@discordjs/voice Receiver
        │
        ▼
Per-user Opus streams
        │
        ▼
Decode Opus → PCM
        │
        ▼
Voice Activity Detection
        │
        ▼
Optional Noise Processing
        │
        ▼
Wake-word Detection
        │
   Wake word detected?
      /       \
    No         Yes
    │           │
 discard     Open VoiceCommandSession
                 │
                 ▼
        Capture triggering user
                 │
                 ▼
          Speech-to-Text
                 │
                 ▼
         VoiceCommandParser
                 │
                 ▼
          Existing Music Engine
```

A major design goal is to avoid continuously running expensive
speech-to-text processing on every person in a voice channel.

Lightweight processing should determine whether someone is speaking and
whether the wake phrase was detected before speech-to-text is invoked.

------------------------------------------------------------------------

# Group Call Architecture

Discord voice provides an important advantage: incoming voice can be
associated with individual Discord users.

Conceptually:

``` text
VoiceReceiver
│
├── Alice   → audio stream
├── Bob     → audio stream
├── Charlie → audio stream
└── David   → audio stream
```

This means the bot does not need to treat the voice channel as one giant
mixed recording.

If Alice says:

``` text
"Siri, play Numb"
```

the bot can identify Alice as the triggering Discord user and create a
command session specifically for her.

Other users' Discord audio streams do not need to be included in Alice's
command recording.

------------------------------------------------------------------------

# Efficiency Strategy

Do **not** continuously run speech-to-text on every user.

Avoid:

``` text
Alice   ──► STT ──► transcript
Bob     ──► STT ──► transcript
Charlie ──► STT ──► transcript
David   ──► STT ──► transcript
```

Instead:

``` text
Incoming Voice
      │
      ▼
     VAD
      │
      ▼
Wake-word Detector
      │
      │ wake detected
      ▼
Command Capture
      │
      ▼
     STT
```

Speech-to-text should normally remain inactive until a wake phrase has
been detected.

------------------------------------------------------------------------

# Audio and Noise Considerations

There are two different types of noise to consider.

## Separate Discord Speakers

If Alice and Bob are both speaking through their own Discord clients,
Discord can provide their incoming audio separately.

``` text
Alice stream ──► process

Bob stream ────► separate stream
```

Bob's digital Discord stream therefore does not have to be mixed into
Alice's command.

## Physical Microphone Noise

Alice's microphone may still physically capture:

-   another person in the room,
-   keyboard sounds,
-   fans,
-   speakers,
-   background music,
-   microphone hiss,
-   room echo.

That noise becomes part of Alice's own Discord audio stream.

Potential processing pipeline:

``` text
Alice Opus
    │
    ▼
Decode → PCM
    │
    ▼
Optional audio filtering / noise suppression
    │
    ▼
VAD
    │
    ▼
Wake-word detector
```

Do not aggressively preprocess audio until real Discord recordings have
been tested. Discord clients may already apply noise suppression,
automatic gain control, and echo cancellation, and excessive server-side
processing can reduce recognition quality.

------------------------------------------------------------------------

# Voice Command Sessions

Only one voice-command capture session should initially be allowed per
guild.

Conceptual model:

``` ts
interface VoiceCommandSession {
  guildId: string;
  userId: string;

  state:
    | "listening"
    | "processing";

  startedAt: number;
}
```

Sessions can be stored approximately as:

``` ts
Map<GuildId, VoiceCommandSession>
```

Each Discord server remains independent.

A command running in Guild A must not prevent voice commands in Guild B.

------------------------------------------------------------------------

# Rolling Audio Buffer

Wake-word detection happens after some audio has already been spoken.

For example:

``` text
"Siri play Numb by Linkin Park"
 ^^^^
```

By the time the wake detector recognizes `"Siri"`, part of the command
may already have occurred.

Each actively speaking user should therefore eventually have a small
rolling in-memory PCM buffer.

``` text
             rolling buffer
        <---------------------->

... Siri play Numb by Linkin Park ...
        │
        ▼
   wake detected
        │
        ▼
preserve previous buffer
        +
continue capturing
```

Without this buffer, detection latency could cause the beginning of the
command to be lost.

The buffer should normally be discarded unless activation occurs.

------------------------------------------------------------------------

# Command Completion

Voice Activity Detection can also help determine when the user has
stopped speaking.

Example:

``` text
"Siri play Numb by Linkin Park"
                              │
                           silence
                              │
                              ▼
                       end utterance
```

Command capture should use:

-   speech-end detection,
-   a short silence threshold,
-   and a hard maximum command duration.

The hard maximum prevents an accidental session from remaining open
indefinitely.

------------------------------------------------------------------------

# Safe Command Parsing

Speech-to-text output must never directly execute arbitrary application
behavior.

Instead:

``` text
STT Transcript
      │
      ▼
VoiceCommandParser
      │
      ├── play
      ├── pause
      ├── resume
      ├── skip
      ├── queue
      ├── stop
      └── unknown
```

Example:

``` text
"play numb by linkin park"
            │
            ▼

{
  command: "play",
  query: "numb by linkin park"
}
```

Unrecognized speech should produce no music action.

``` text
"bro that song yesterday was crazy"
            │
            ▼
         UNKNOWN
            │
            ▼
        do nothing
```

This creates a strict boundary between speech recognition and
application behavior.

------------------------------------------------------------------------

# Confidence Layers

The voice system can eventually use confidence at several independent
layers:

``` text
Audio
 │
 ▼
Wake-word Detector
 │
 └── wake confidence
        │
        ▼
Speech-to-Text
 │
 └── transcription confidence / quality
        │
        ▼
VoiceCommandParser
 │
 └── command confidence
        │
        ▼
TrackResolver
 │
 └── track-match confidence
```

The existing intelligent TrackResolver can help recover from imperfect
speech recognition.

For example:

``` text
STT:
"play numb by linking park"
```

could still resolve to:

``` text
Numb — Linkin Park
```

when metadata matching produces a strong result.

Track matching automatically selects the highest-scoring valid candidate, even at low
confidence. Scores are retained internally; no valid candidates remains a failure.

------------------------------------------------------------------------

# Concurrency and Edge Cases

## Two Users Trigger at Nearly the Same Time

Example:

``` text
Alice:
"Siri play Numb"

Bob:
"Siri play Starboy"
```

A short wake-word contention/arbitration window can collect activation
events that occur nearly simultaneously.

``` text
First wake detected
       │
       ▼
Open short contention window
       │
       ├── Alice wake event
       └── Bob wake event
       │
       ▼
Multiple contenders
```

For the initial implementation, ambiguous simultaneous activation should
be rejected rather than guessing which user should win.

The bot can ask the users to try again.

Future versions could optionally support configurable priority based on
permissions or DJ roles.

## Another User Triggers During an Active Session

Example:

``` text
Alice:
"Siri..."

Alice now owns the VoiceCommandSession.

Bob:
"Siri skip"
```

While Alice's command is being captured:

``` text
GuildVoiceController

state = LISTENING
owner = Alice
```

Bob's activation should initially be ignored or treated as busy.

Once Alice's command completes:

``` text
LISTENING
    │
    ▼
PROCESSING
    │
    ▼
EXECUTE
    │
    ▼
IDLE
```

the guild becomes available again.

## Same User Says the Wake Word Multiple Times

Example:

``` text
"Siri... Siri play Numb"
```

Once the user owns the active command session, additional wake
detections should not create new sessions.

Repeated leading wake phrases can later be removed during transcript
normalization.

## False Wake-Word Activation

Example:

``` text
"My phone keeps activating Siri."
```

The wake detector may trigger because the activation word was genuinely
spoken.

Additional safeguards should prevent unwanted behavior:

``` text
Wake-word confidence
        +
valid speech after wake phrase
        +
recognized command vocabulary
        │
        ▼
execute only if valid
```

If STT produces:

``` text
"my Siri is annoying"
```

the command parser should return:

``` text
UNKNOWN
```

and no music action occurs.

------------------------------------------------------------------------

# Privacy and Resource Lifecycle

Voice recordings should not be permanently stored by default.

Normal lifecycle:

``` text
Incoming PCM
    │
    ▼
In-memory rolling buffer
    │
    ├── no activation
    │       │
    │       ▼
    │    discard
    │
    └── activation
            │
            ▼
    temporary command audio
            │
            ▼
           STT
            │
            ▼
        discard audio
```

Permanent recordings should only exist if an explicit
development/debugging mode is intentionally enabled.

Temporary resources, streams, buffers, timers, and subscriptions should
always be cleaned up when:

-   speech ends,
-   a command completes,
-   a command times out,
-   the triggering user leaves,
-   the bot leaves the voice channel,
-   the Discord voice connection is destroyed,
-   or an error occurs.

------------------------------------------------------------------------

# Proposed Voice Subsystem Structure

Long-term structure:

``` text
apps/bot/src/

commands/
├── play.ts
├── skip.ts
├── queue.ts
└── ...

music/
├── MusicPlayer.ts
├── MusicQueue.ts
├── TrackResolver.ts
├── scoring/
└── providers/

voice/
├── VoiceController.ts
│
├── receive/
│   ├── VoiceReceiver.ts
│   └── SpeakerStream.ts
│
├── processing/
│   ├── VoiceActivityDetector.ts
│   └── AudioBuffer.ts
│
├── wake/
│   └── WakeWordDetector.ts
│
├── transcription/
│   └── SpeechToText.ts
│
├── commands/
│   └── VoiceCommandParser.ts
│
└── sessions/
    └── VoiceCommandSession.ts
```

This is a target architecture, not a requirement to create every file
immediately.

Build each layer only when its phase begins.

------------------------------------------------------------------------

# Implementation Phases

## Phase V1 --- Discord Voice Receive

### Goal

Prove that the bot can receive incoming Discord voice and distinguish
individual speakers.

### Tasks

-   [x] Access `VoiceConnection.receiver`
-   [x] Listen for Discord speaking events
-   [x] Detect when a user starts speaking
-   [x] Obtain the speaking user's Discord ID
-   [x] Subscribe to that user's incoming Opus stream
-   [x] Understand the lifecycle of a receiver subscription
-   [x] Decode Opus audio into PCM
-   [x] Capture one complete test utterance (`!voicetest`, optionally `!voicetest wav`)
-   [x] Verify two users produce separate incoming streams (automated encrypted-packet tests)
-   [x] Clean up subscriptions and streams correctly

Implemented in `src/voice` and verified in `tests/voiceReceive.test.mjs` with the
real Discord receiver and native Opus decoder. PCM is **48 kHz, stereo interleaved,
signed 16-bit little-endian**. A test teardown double-destroy was corrected; the
V1 regression run passed 147 tests before V2 work began. The live Alice/Bob check
in the root README remains a deployment check, not an automated-test claim.

### Success Criteria

Given Alice and Bob in the same voice channel, the bot can independently
detect:

``` text
Alice started speaking
Bob started speaking
```

and receive separate audio data for each user.

No wake-word detection or speech-to-text is required yet.

------------------------------------------------------------------------

## Phase V2 --- Speech Segmentation and VAD

### Goal

Determine when incoming audio contains real speech and identify useful
speech boundaries.

### Tasks

-   [x] Select a suitable VAD implementation (WebRTC/libfvad WASM)
-   [x] Feed decoded PCM frames into VAD (20 ms, mono analysis copy)
-   [x] Distinguish speech from silence
-   [x] Detect speech start (100 ms onset)
-   [x] Detect speech end (600 ms non-speech, or receive stream end)
-   [x] Ignore unnecessary silence (no growing utterance history)
-   [x] Add per-user rolling PCM buffers (original stereo PCM)
-   [x] Define buffer duration limits (one second / 192,000 bytes)
-   [x] Add silence thresholds
-   [x] Test with multiple simultaneous speakers (automated interleaved processing)
-   [x] Measure behavior with background noise (synthetic diagnostics)
-   [ ] Validate speech/noise accuracy and thresholds on real Discord microphones

Implemented in `src/voice/processing` using the pinned `@echogarden/fvad-wasm`
dependency. `VOICE_RECEIVE_DEBUG=1` logs per-user speech boundaries, and
`!voicetest` includes VAD statistics. `pnpm --filter bot diagnose:vad 10 8` measures
synthetic silence/noise/voice-like signals and processing time. Loud noise can still
trigger VAD; representative live testing remains necessary. See the root README
for the exact PCM formats, defaults, measurements, and manual verification steps.

### Success Criteria

The bot can determine approximately:

``` text
Alice started speaking
Alice is still speaking
Alice stopped speaking
```

without performing speech-to-text.

------------------------------------------------------------------------

## Phase V3 --- Wake-Word Detection

### Goal

Detect a chosen activation phrase such as `"Siri"` without continuously
transcribing the entire voice channel.

### Tasks

-   [x] Evaluate current local wake-word technologies (see root README)
-   [x] Select a wake-word implementation (sherpa-onnx local keyword spotting)
-   [x] Choose initial trigger phrase (**Jarvis**)
-   [x] Feed appropriate PCM frames into the detector (worker-thread 48 → 16 kHz mono resampling)
-   [x] Process active speakers independently
-   [x] Detect wake-word events
-   [x] Check wake-word confidence support (native backend does not expose it; never fabricated)
-   [ ] Tune activation threshold on representative live Discord recordings
-   [x] Measure synthetic false positives (live measurements still required)
-   [x] Measure synthetic false negatives (live measurements still required)
-   [ ] Test different microphones
-   [ ] Test different accents and speaking volumes
-   [x] Preserve rolling audio when activation occurs (4-second bounded buffer, snapshot at delivery)

Phase V3 implementation and integration contract are documented in the root README's
**Wake detection (Phase V3)** section. Wake admission uses the first WebRTC-positive
frame plus one second of onset context, independently from V2's 100 ms segment rule.
`VOICE_WAKE_DEBUG=1` explains gate/inference/results/cooldown/lifecycle decisions;
`diagnose:wake --compare-vad` compares admission paths on labelled recordings.
Wake recognition does not perform continuous transcription or fuzzy text matching.
Phase V4 now consumes these activation events for command capture.

The typed `wake` event includes owner/stream identity, current original PCM pre-roll,
audio clock boundaries, and optional acoustic keyword timestamps. `VoiceController`
also exposes timestamped `pcm`, `speech`, and lifecycle events plus
`setWakeListening(false/true)` for the session owner. Pausing cancels keyword work
while receive/VAD continue; resuming excludes old command audio. These are Phase V3
interfaces used by the Phase V4 implementation below.

Automated regression and synthetic Opus-round-trip checks validate the pipeline;
real microphone/noise/accent accuracy remains a deployment acceptance check.

### Success Criteria

Normal conversation is ignored while:

``` text
"Jarvis"
```

reliably produces an activation event associated with the correct
Discord user.

------------------------------------------------------------------------

## Phase V4 --- Voice Command Sessions

### Goal

Create a safe command-capture lifecycle after a wake word is detected.

### Tasks

-   [x] Implement `VoiceCommandSession`
-   [x] Maintain sessions per guild
-   [x] Lock an active session to the triggering user
-   [x] Preserve pre-wake rolling audio
-   [x] Continue recording the triggering user
-   [x] Ignore unrelated users during command capture
-   [x] Use VAD to determine command completion
-   [x] Add silence timeout
-   [x] Add hard maximum command duration
-   [x] Handle user disconnect during capture
-   [x] Handle bot disconnect during capture
-   [x] Handle repeated wake phrases
-   [x] Add simultaneous-activation contention window
-   [x] Reject ambiguous simultaneous activations
-   [x] Clean up every session resource after completion/error

Implemented in `src/voice/sessions` and attached per guild by `VoiceReceiveManager`.
The lifecycle is `idle → contention → listening → processing → idle`. A 300 ms
delivery-time contention window rejects distinct users; repeated owner wakes do not
restart capture. Owner PCM is retained immediately, including during arbitration,
with stream-clock deduplication and catch-up snapshots for delayed wake results.

Capture ends on VAD speech-end, 1.5 seconds without owner voice, or a 10-second
wall/audio limit after activation, plus up to 4 seconds of preserved pre-roll.
Natural receive-stream end permits same-owner continuation within the silence limit.
Disconnects, receive/VAD errors, replacement, and shutdown cancel capture. Keyword
inference stays paused through the asynchronous processing hook, with abort and a
15-second default processing watchdog; the V5 application hook extends it to 55 seconds.
Without that hook the V4 default discards the clip after diagnostics.

`!commandtest` reports the requesting user's next activated capture;
`!commandtest wav` explicitly uploads it. `VOICE_SESSION_DEBUG=1` logs state and
capture metadata. No recordings are written to disk automatically. Tests in
`tests/voiceSessions.test.mjs` cover ownership, contention, late wake handoff, stream
continuations, bounds, cancellation, processing failures, and real Opus receive.
Live two-person verification is documented in the root README and remains a
deployment acceptance check. Transcription and repeated-wake text normalization
belong to Phase V5.

### Suggested State Machine

``` text
                  wake detected
IDLE ─────────────────────────────► LISTENING
                                      │
                                      │ speech ends
                                      ▼
                                  PROCESSING
                                      │
                                      │ complete/error
                                      ▼
                                     IDLE
```

### Success Criteria

When Alice triggers the bot, only Alice owns the active command session
until that session completes or times out.

------------------------------------------------------------------------

## Phase V5 --- Speech-to-Text

### Goal

Convert only activated command audio into text.

### Tasks

-   [x] Evaluate current local Whisper/STT implementations (faster-whisper, openai-whisper, whisper.cpp)
-   [x] Select an STT implementation suitable for Node.js architecture (Groq + private Python faster-whisper worker)
-   [x] Define the PCM/audio format expected by STT
-   [x] Convert captured command audio when necessary (in-memory WAV; provider-side 16 kHz mono conversion)
-   [x] Send only activated command audio to STT
-   [x] Receive transcript
-   [x] Normalize whitespace and punctuation
-   [x] Remove wake phrase (**Jarvis**, leading exact matches)
-   [x] Handle repeated wake phrases
-   [x] Handle empty transcripts
-   [x] Handle STT failures (rate limits, transient fallback, fatal errors, cancellation)
-   [x] Define transcription timeout (8 s Groq + 40 s local, 55 s session watchdog)
-   [x] Capture useful quality/confidence signals when available (raw segment signals, not fabricated confidence)
-   [x] Discard command audio after processing
-   [x] Benchmark latency (real providers on synthetic speech; reproducible diagnostic)
-   [ ] Validate accuracy and latency on representative live microphones and concurrent guild load

Implemented in `src/voice/transcription` and `scripts/faster-whisper-worker.py`, using
the existing `processCapture(audio, signal)` hook. Primary STT is Groq's
`whisper-large-v3-turbo` with `GROQ_API_KEY` and no SDK retries. HTTP 429/408/5xx,
connection failures, and cloud timeouts fall back to local faster-whisper. Shared
20/minute and 2,000/rolling-day request budgets plus provider cooldown headers avoid
hammering free-tier limits. Invalid requests/authentication errors fail explicitly.

Local defaults are cached `small.en`, CPU int8, two threads, one inference and at most
four queued clips. Model setup is explicit; runtime is offline and keeps audio in
memory. Cancellation kills active native inference, and queued requests can restart.
Typed `transcript` events preserve owner IDs without retaining audio; diagnostics
display normalized text, provider, fallback reason, and timings through `!commandtest`.
`!commandtest wav` also uploads the original capture. Transcripts feed V6 parsing and
the V7 music execution implemented below.

See the root README's **Speech-to-text (Phase V5)** section for setup, policy,
quality signals, tests, and `diagnose:stt`. Real synthetic smoke timings: Groq 606 ms;
local 2,749 ms cold and 1,599–1,680 ms warm on a 3.26-second clip. Both returned
"Num" for the synthetic "Numb"; microphone accuracy remains a live acceptance check.

### Success Criteria

Input:

``` text
"Jarvis, play Numb by Linkin Park"
```

produces approximately:

``` text
play Numb by Linkin Park
```

without continuously transcribing the rest of the Discord call.

------------------------------------------------------------------------

## Phase V6 --- Voice Command Parsing

### Goal

Convert STT transcripts into a small, strict set of supported music
commands.

### Initial Commands

-   [x] `play`
-   [x] `pause`
-   [x] `resume`
-   [x] `skip`
-   [x] `queue`
-   [x] `stop`
-   [x] `leave`    

Additional commands can be added later.

### Tasks

-   [x] Implement `VoiceCommandParser`
-   [x] Define normalized command types
-   [x] Parse `play` query arguments
-   [x] Normalize common STT variations
-   [x] Reject unsupported commands
-   [x] Reject empty commands
-   [x] Handle malformed transcripts
-   [x] Add parser unit tests
-   [x] Ensure arbitrary transcript text cannot directly execute
     behavior
-   [x] Use local rules first and Groq only for uncertain normalization
-   [x] Validate structured LLM output, ground play queries, and reject low confidence
-   [x] Bound/cache cloud calls and honor session cancellation

Implemented in `src/voice/commands`, with shared `MusicCommand` domain types in
`packages/shared`. Whole-request local rules handle common commands and definite
rejections without a parsing API call. Uncertain text can use the existing `GROQ_API_KEY`
with `openai/gpt-oss-20b` (Groq free plan, strict JSON schema). Only validated supported
results with model confidence at least 0.9 are accepted; otherwise the result is `unknown`.
Play queries are copied from the transcript, not generated track metadata.

The fallback has a 5-second deadline, no retries, a 5-minute/128-entry cache, shared
10/minute and 250/rolling-day request budgets, and provider-error cooldowns. The existing
55-second session watchdog covers STT plus parsing. `parseTranscript` runs under the
owner lock; typed `command` events preserve guild/user/session identity and exclude audio.
`!commandtest` reports the normalized command, source, reason, and timing. V6 provides
command data to the V7 execution hook below. See the root README's **Voice command
parsing (Phase V6)** section for configuration, tests, and `diagnose:commands`.

### Example

``` text
STT:

"play numb by linkin park"

        ↓

VoiceCommandParser

        ↓

{
  type: "play",
  query: "numb by linkin park"
}
```

### Success Criteria

Only explicitly supported voice commands can reach the application/music
layer.

------------------------------------------------------------------------

## Phase V7 --- Existing Music Engine Integration

### Goal

Connect normalized voice commands to the music system that already
powers `!` commands, using input-independent handlers for future adapters.

### Desired Flow

``` text
"Jarvis play Numb"
       │
       ▼
VoiceController
       │
       ▼
Wake-word Detector
       │
       ▼
VoiceCommandSession
       │
       ▼
Speech-to-Text
       │
       ▼
VoiceCommandParser
       │
       ▼
Existing Music Service
       │
       ▼
TrackResolver
       │
       ▼
MusicQueue
       │
       ▼
MusicPlayer
       │
       ▼
Discord 🔊
```

### Tasks

-   [x] Route `play` into existing play logic
-   [x] Route `pause` into existing pause logic
-   [x] Route `resume` into existing resume logic
-   [x] Route `skip` into existing skip logic
-   [x] Route `queue` into existing queue logic
-   [x] Route `stop` into existing stop logic
-   [x] Preserve triggering Discord user ID
-   [x] Preserve guild ID
-   [x] Apply existing permissions/authorization
-   [x] Reuse TrackResolver
-   [x] Reuse track confidence system
-   [x] Handle low-confidence track matches
-   [x] Avoid duplicating prefix command business logic

Implemented in `src/voice/commands/VoiceMusicCommands.ts`, sharing the existing
play/control handlers through `MusicCommandContext` and the per-guild connection/player
registry in `GuildMusicPlayers`. The adapter binds requests to their captured channel,
fetches the triggering member, checks same-channel authorization, and rechecks play
membership after search. Queue items retain requester guild/user IDs; parsed events
carry guild/user/session/channel IDs. Low-confidence matches automatically play or queue
the highest-scoring valid candidate. Voice results are posted in the voice channel's text
chat with mentions disabled.

`executeCommand(command, signal)` is awaited under the existing owner lock, with a
separate 60-second execution deadline after STT/parsing. Disconnect/reset/timeout/shutdown
cancels pending discovery/startup and suppresses stale results. Startup cancellation owns
only its resource and preserves other queued requests. Accepted playback outlives its
completed session. The `!commandtest` diagnostic now observes normal music execution.

`tests/voiceMusicCommands.test.mjs` verifies the full session-to-music boundary with
mocked Discord/providers and the real player/resolver. See the root README's **Voice
music execution (Phase V7)** section for lifecycle details and live acceptance steps.

### Success Criteria

These inputs use the same underlying application logic (a future slash adapter can
use the same handlers):

``` text
!play Numb by Linkin Park

"Jarvis, play Numb by Linkin Park"
```

------------------------------------------------------------------------

## Phase V8 --- Noise Robustness and Audio Quality

### Goal

Improve wake-word and STT reliability after the basic pipeline works.

This phase should be driven by actual testing rather than premature
audio processing.

### Tasks

-   [x] Add labelled development-corpus replay and explicit sample-collection workflow
-   [x] Limit Jarvis to canonical American pronunciation plus the natural unstressed-ih variant
-   [x] Measure keyboard/fan/hiss, echo, and competing-speech proxies (synthetic, Opus round trip)
-   [x] Compare raw/high-pass/mild denoising using identical clips and independent VAD/KWS state
-   [x] Compare VAD modes and acoustic wake thresholds without changing production configuration
-   [x] Measure clipping, levels, DC offset, VAD time, wake misses/false positives, and optional local STT word errors
-   [x] Identify regressions as well as improvements; preserve original sample audio
-   [x] Evaluate initial filtering/noise-suppression tradeoffs (retain raw audio pending live evidence)
-   [ ] Record/test representative development samples from real Discord microphones
-   [ ] Validate real keyboard noise, fans/background noise, and microphone hiss
-   [ ] Validate users using speakers and users using headphones
-   [ ] Validate physical background speakers and audible bot playback
-   [ ] Select VAD/wake tuning on live samples and verify on held-out speakers
-   [ ] Confirm any proposed preprocessing preserves intelligibility on real recordings

Implemented in `scripts/diagnose-voice.mjs` with a template in
`scripts/voice-corpus.example.json`. Existing `!waketest sample` and `!commandtest wav`
provide explicit owner-only recording. Local samples/reports can live in git-ignored
`voice-samples/`. The evaluator reports per-condition outcomes, model/input hashes,
paired regressions, negative exposure, and optional `--stt local` word errors. It
uses production wake replay and does not change the live audio pipeline or execute
commands. Only explicitly labelled diagnostic clips are submitted to local STT.

Real native synthetic results with 24 positives / 27 negatives: raw 22 detections,
threshold 0.20 23, high-pass 21, mild denoising 24; all had zero negative keyword hits.
Denoising worsened one transcript; its aggregate local STT WER was the same 35% as raw.
This supports further paired live evaluation rather than automatic filter enablement.
The broader U.S. pronunciation smoke suite detected 18/20 positives with 0/28 false
wakes. Synthetic misses/word errors intentionally cause a nonzero diagnostic exit.
See the root README's **Noise robustness and audio quality (Phase V8)** section for
commands, measurements, calibration decisions, and the live recording matrix.

### Success Criteria

The voice system performs reliably in realistic Discord calls without
excessive false activations.

------------------------------------------------------------------------

## Phase V9 --- Concurrency and Advanced Edge Cases

### Goal

Harden the system for real multi-user servers.

### Tasks

-   [x] Test two users speaking simultaneously (real per-user Opus, controlled VAD/KWS)
-   [x] Test two users triggering simultaneously (reject ambiguity before STT)
-   [x] Test activation during an existing command session (including late keyword results)
-   [x] Test repeated trigger words (one owner, normalized command, one execution)
-   [x] Test activation while music is playing (capture preserves playback, command controls it)
-   [x] Test echo activation policy with identical two-user audio and delayed/busy echo proxies
-   [ ] Test physical microphone echo from bot playback on real Discord speakers/headphones
-   [x] Test triggering user leaving mid-command (capture, transcription, execution)
-   [x] Test voice connection loss and recovery (late results cannot affect a replacement)
-   [x] Test STT timeout (abort request, release ownership, preserve another guild)
-   [x] Test wake detector failure (startup, inference, and owner contention)
-   [x] Test rapid consecutive commands (cooldown expiry, no duplicate execution)
-   [x] Retain per-user cooldown across session completion/rejection (3 seconds from accepted wake)
-   [x] Evaluate per-guild cooldown (existing owner lock suffices for tested cases; no extra delay)
-   [x] Consider configurable DJ/role priority later (deferred; reject ambiguous activation)
-   [x] Ensure cancellation/failure in one guild cannot change another guild's session ownership/results
-   [x] Ignore stale/foreign stream failures while still handling continuations failing before PCM
-   [ ] Complete the live multi-user/multi-guild acceptance matrix in the root README

Implemented at the `VoiceController` / `GuildVoiceSessions` boundary. Session resume
now preserves the existing per-user wake cooldown instead of allowing fast commands
or contention rejection to clear it. Rejected detections do not extend the cooldown;
another user or the same user in another guild remains independent.

Typed `streamStart` and `wakeError` events identify early initialization failures and
report keyword errors to command diagnostics promptly. Capture errors are correlated
with guild/user/current-stream identity. Delayed old-stream cleanup cannot cancel a
new session, and completed STT audio no longer depends on subsequent receive health.
Departure/reset still abort every processing stage and suppress stale results.

`tests/voiceConcurrency.test.mjs` adds end-to-end boundary regressions with real Opus
decoding, STT orchestration/normalization, parsing, and music dispatch. Discord transport,
VAD/KWS classifications, and external provider results are controlled. The focused
`pnpm --filter bot test:voice-concurrency` also runs existing session, wake receive,
music execution, and local-worker cancellation tests. Shared provider quotas and worker
capacity remain shared; session isolation does not imply dedicated inference resources.

The root README's **Concurrency and advanced edge cases (Phase V9)** section documents
the policy, tests, recovery behavior, and live matrix. Echo proxies verify ownership
and duplicate suppression, not physical echo rejection. Playback containing a real
wake phrase and valid command inside one microphone can still execute while idle;
live acoustic validation remains open alongside the V8 calibration checks.

### Initial Concurrency Policy

Prefer predictable behavior over guessing:

``` text
One active voice command per guild.

If multiple users activate within the contention window:
    reject ambiguous activation and ask them to retry.

If another user activates while a session is active:
    ignore/treat the guild as busy.

When the current session finishes:
    return to IDLE.
```

------------------------------------------------------------------------

## Phase V10 --- Observability, Performance, and Cleanup

### Goal

Make the voice subsystem measurable and stable for long-running bot
sessions.

### Useful Metrics

Track information such as:

-   wake-word detections,
-   rejected wake events,
-   false activations during testing,
-   VAD speech durations,
-   command capture durations,
-   STT latency,
-   STT failures,
-   parsed commands,
-   unknown commands,
-   simultaneous activation conflicts,
-   session timeouts,
-   average end-to-end voice command latency.

Do not log raw private voice content by default.

### Tasks

-   [ ] Add structured voice subsystem logging
-   [ ] Measure CPU usage
-   [ ] Measure memory usage
-   [ ] Measure per-speaker processing cost
-   [ ] Measure wake-word latency
-   [ ] Measure STT latency
-   [ ] Ensure rolling buffers remain bounded
-   [ ] Ensure finished streams are destroyed
-   [ ] Ensure timers are cleared
-   [ ] Ensure receiver subscriptions are removed
-   [ ] Ensure failed sessions return to IDLE
-   [ ] Stress-test long voice-channel sessions
-   [ ] Stress-test several guilds independently

------------------------------------------------------------------------

# Long-Term Voice State Model

The voice controller should eventually behave approximately like:

``` text
                         ┌─────────────┐
                         │    IDLE     │
                         │             │
                         │ VAD + Wake  │
                         │ Detection   │
                         └──────┬──────┘
                                │
                         wake detected
                                │
                                ▼
                         ┌─────────────┐
                         │ CONTENTION  │
                         │             │
                         │ resolve     │
                         │ activator   │
                         └──────┬──────┘
                                │
                         one valid user
                                │
                                ▼
                         ┌─────────────┐
                         │  LISTENING  │
                         │             │
                         │ capture     │
                         │ command     │
                         └──────┬──────┘
                                │
                           speech ends
                                │
                                ▼
                         ┌─────────────┐
                         │ PROCESSING  │
                         │             │
                         │ STT + parse │
                         └──────┬──────┘
                                │
                                ▼
                            EXECUTE
                                │
                                ▼
                              IDLE
```

Failures and timeouts at any stage should safely return the guild voice
controller to `IDLE`.

------------------------------------------------------------------------

# Technology Selection Strategy

Do not install the entire future voice stack at once.

Evaluate technologies immediately before implementing their phase.

Current known requirement:

``` text
@discordjs/voice
```

is already part of the bot and provides the bridge into Discord voice
receiving.

Additional categories to evaluate later:

``` text
Opus decoding
    ↓
VAD
    ↓
Wake-word detection
    ↓
Speech-to-Text
    ↓
Optional noise suppression
```

When choosing libraries, evaluate:

-   current maintenance status,
-   Node.js support,
-   TypeScript integration,
-   Windows development support,
-   Linux deployment support,
-   native binary requirements,
-   CPU usage,
-   memory usage,
-   model size,
-   latency,
-   offline/local processing capability,
-   licensing,
-   Discord audio-format compatibility.

Avoid tightly coupling the architecture to one VAD, wake-word, or STT
implementation.

Prefer interfaces that allow implementations to be replaced later.

------------------------------------------------------------------------

# Development Principle

Build the voice feature from the bottom upward.

Do not begin by trying to make:

``` text
"Siri, play Numb"
```

work end-to-end.

Instead prove each boundary independently:

``` text
1. Can Discord audio be received?
               ↓
2. Can speakers be separated?
               ↓
3. Can Opus be decoded?
               ↓
4. Can speech boundaries be detected?
               ↓
5. Can the wake word be detected?
               ↓
6. Can one user's command be captured?
               ↓
7. Can that clip be transcribed?
               ↓
8. Can the transcript be safely parsed?
               ↓
9. Can the parsed command use the existing music engine?
```

This keeps bugs isolated and makes each technology understandable before
another layer is introduced.

------------------------------------------------------------------------

# Immediate Next Step

Phases V1–V7, the V8 evaluation tools, and V9 concurrency hardening now have implementations. Verify owner-only capture, transcription,
normalized commands, and real music controls with `!commandtest` or `!commandtest wav`.
These diagnostics now observe normal execution. Complete **Phase V8 live calibration**
with representative microphone recordings and `diagnose:voice`, using held-out samples
before adopting a new threshold or preprocessing option.

The original bottom-up first milestone was:

``` text
Discord VoiceConnection
        │
        ▼
VoiceConnection.receiver
        │
        ▼
receiver.speaking
        │
        ▼
Discord User ID
        │
        ▼
receiver.subscribe(userId)
        │
        ▼
User Opus Stream
        │
        ▼
Decode → PCM
```

Continue proving each boundary independently while validating real music execution.
Complete Phase V8's live calibration and Phase V9's live multi-user/echo acceptance
checks before treating microphone accuracy and deployed concurrency behavior as verified.
