# Delayed Jarvis acknowledgement

Set `VOICE_WAKE_ACK_DELAY_MS=700` in `apps/bot/.env` (700 ms is the default).
The delay must be greater than the session's 300 ms contention window and less
than its 1500 ms silence timeout. Restart the bot after changing it.

The asset is `apps/bot/assets/voice/wake-acknowledgement.wav`. Startup loads this
existing file once and validates its 48 kHz stereo signed-16-bit PCM format. The
supplied clip is approximately 917 ms, padded to 920 ms of Discord audio frames.
An unavailable asset disables audio acknowledgement and logs the cause.

## Session behavior

- Capture and `🎙️ Listening...` begin immediately on the first accepted wake.
- The existing per-user VAD supplies speech evidence; there is no second VAD.
  Receive-side last-voiced timestamps also cover inference lag and closed-stream
  wake flushes. Command speech in a newer receive stream is considered too.
- The wake model reports a final-token timestamp. Session code allows the existing
  100 ms VAD onset interval after it before attributing historical voice to the
  command. Missing keyword timestamps fall back to the wake's received-audio
  boundary. This is acoustic timing, not semantic recognition of command words.
- Any subsequent command-voice frame suppresses the one-shot acknowledgement,
  including voice that has not yet reached the VAD's 100 ms segment confirmation.
- A wake-only VAD segment ending does not finish command capture.
- After the configured delay, a deferred callback yields to pending receive I/O.
  Playback checks the same session's eligibility again immediately before each
  outgoing audio frame. Speech cancels both pending and remaining cue audio.
- The first actual cue frame re-arms the existing silence timer for the cue's
  duration plus the normal 1500 ms listening allowance. With default settings,
  total silence ends capture around 3120 ms after activation. Further command
  voice uses the ordinary speech-end/silence rules. The 10-second hard maximum
  remains in force throughout.
- Processing, timeout, contention rejection, cancellation, owner departure,
  reset, replacement, disconnect, and destruction invalidate the original cue.
  Session identity and abort signals prevent stale work from playing later.

## Playback ownership

Discord supports one subscribed `AudioPlayer` per voice connection. Calling
`play(cueResource)` over a song destroys the song resource; a second subscription
would replace the first instead of mixing audio.

`MusicPlayer` therefore opts into `AudioCueResource` when the acknowledgement
asset is available. It is an output adapter around the existing song resource:

```text
provider's existing song resource ──┐
                                   ├─ frame mixer → existing AudioPlayer → existing subscription
preloaded acknowledgement PCM ──────┘
```

The adapter uses Discord's existing 20 ms pull clock, retaining the source stream,
position, backpressure, error ownership, and queue/loop lifecycle. Mixing uses a
continuous Opus decoder/encoder, which adds codec work and an encoding generation
while this feature is enabled. No music-provider contract changes are required.
It uses `AudioResource.read()` as the frame-level integration point; the tests
exercise that adapter against the installed real Discord audio player.

An idle/loading player may temporarily output a standalone cue. A song becoming
ready takes precedence. A paused song is not consumed while the transport sends
the cue; the transport returns to paused afterward. Natural song completion takes
precedence over the cue so queue progression is not delayed.

Already-prepared/transmitted packets cannot be recalled. Cancellation prevents
future cue frames; the receive/output boundary remains subject to Discord and
network latency. Outbound bot audio is not directly connected to a user's receive
stream. Physical speaker-to-microphone echo has no reference-aware canceller in
this receive architecture and may still be classified as voice. Receive audio is
kept live so real command speech during the cue is captured and takes priority.

## Verification

Focused regression tests:

```sh
pnpm --filter bot exec node --import tsx --experimental-test-module-mocks --test tests/wakeAcknowledgement.test.mjs tests/audioCueResource.test.mjs
```

Live checks in Discord:

1. Say “Jarvis play Numb by Linkin Park”, then repeat with a short pause after
   Jarvis. Both should capture normally without a cue.
2. Say only “Jarvis”, wait for the cue to finish, pause briefly, then give the
   command. Repeat with continued silence and confirm the session becomes idle.
3. Repeat during playing and paused music. Check current track, queue, looping,
   and pause state; the cue should not replace or restart a track.
4. Begin a command near the cue deadline and during playback. Also disconnect or
   leave before the delay expires; no stale cue should start in a later session.
5. Use speakers as well as headphones to assess physical microphone echo on the
   deployed Discord clients.

## Complete implementation files

- [Session-scoped acknowledgement controller](src/voice/feedback/WakeAcknowledgement.ts)
- [WAV asset loader](src/voice/feedback/wakeAcknowledgementAudio.ts)
- [Command-session state](src/voice/sessions/VoiceCommandSession.ts)
- [Guild session lifecycle](src/voice/sessions/GuildVoiceSessions.ts)
- [Receive controller and VAD history](src/voice/VoiceController.ts)
- [Receive event contracts](src/voice/VoiceEvents.ts)
- [Existing VAD onset constant](src/voice/processing/VoiceActivityDetector.ts)
- [Frame-level audio mixer](src/music/AudioCueResource.ts)
- [Music player](src/music/MusicPlayer.ts)
- [Guild player ownership](src/music/GuildMusicPlayers.ts)
- [Application wiring](src/index.ts)
- [Environment example](.env.example)
- [Acknowledgement/session tests](tests/wakeAcknowledgement.test.mjs)
- [Audio/mixer/player tests](tests/audioCueResource.test.mjs)
- [Concurrency regression fixtures](tests/voiceConcurrency.test.mjs)
