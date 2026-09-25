# Discord Music Platform — Architecture & Product Documentation

## 1. Project Overview

**Discord Music Platform** is a scalable Discord music bot designed around two primary interfaces:

1. **Text commands** — traditional Discord prefix commands such as `!play`, `!skip`, `!pause`, etc.
2. **Voice commands** — users can speak commands using a wake phrase such as:
   - `Siri, play Blinding Lights`
   - `Siri, play Numb by Linkin Park`

The bot must **not react to ordinary conversation**. The wake phrase is required before a spoken command is interpreted.

The project is designed as a **pnpm monorepo** so that the Discord bot and a future web dashboard can share types, utilities, and domain models.

The initial goal is a free-to-build system using free/open-source libraries and APIs where practical.

---

# 2. Core Product Goals

## Primary goals

- Play music through Discord voice channels.
- Support traditional text commands with the `!` prefix.
- Support voice commands using a configurable wake phrase.
- Support multiple music/discovery sources.
- Provide significantly better track selection than a simplistic "first search result" music bot.
- Separate **track identification** from **audio playback**.
- Use multiple providers as fallbacks.
- Score candidate tracks and choose the best match.
- Ask the user to choose when confidence is too low.
- Maintain a scalable architecture that can support a web dashboard later.
- Keep shared types and business concepts independent of Discord-specific implementation details.

## Important design principle

> **"What song does the user mean?" and "Where can we play it?" are separate problems.**

This distinction is central to the architecture.

For example, Spotify may identify a song and provide metadata, while YouTube may provide the actual playable source.

---

# 3. High-Level Architecture

```text
                         ┌─────────────────────┐
                         │        User         │
                         └──────────┬──────────┘
                                    │
                     ┌──────────────┴──────────────┐
                     │                             │
                Text Commands                 Voice Commands
                     │                             │
                  !play                    "Siri, play..."
                     │                             │
                     │                     Wake Phrase Detection
                     │                             │
                     │                     Speech Recognition
                     │                             │
                     └──────────────┬──────────────┘
                                    │
                                    ▼
                             Music Service
                                    │
                                    ▼
                            Track Resolver
                                    │
                 ┌──────────────────┼──────────────────┐
                 │                  │                  │
                 ▼                  ▼                  ▼
             Spotify             YouTube          SoundCloud
             Provider            Provider          Provider
                 │                  │                  │
                 └──────────────────┼──────────────────┘
                                    │
                                    ▼
                            Candidate Tracks
                                    │
                                    ▼
                              Match Scoring
                                    │
                                    ▼
                            Best Track Match
                                    │
                                    ▼
                              Playback Source
                                    │
                                    ▼
                              Music Queue
                                    │
                                    ▼
                              Music Player
                                    │
                                    ▼
                             Discord Voice
                                    │
                                    ▼
                                    🔊
```

---

# 4. Monorepo Structure

The project uses **pnpm workspaces**.

```text
discord-music-platform/
│
├── apps/
│   │
│   ├── bot/
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   ├── music/
│   │   │   │   ├── providers/
│   │   │   │   ├── TrackResolver.ts
│   │   │   │   ├── MusicPlayer.ts
│   │   │   │   └── Queue.ts
│   │   │   ├── voice/
│   │   │   └── index.ts
│   │   ├── assets/
│   │   ├── .env
│   │   └── package.json
│   │
│   └── dashboard/
│       ├── src/
│       ├── public/
│       ├── .env.local
│       └── package.json
│
├── packages/
│   │
│   └── shared/
│       ├── src/
│       │   ├── track.ts
│       │   └── index.ts
│       └── package.json
│
├── pnpm-workspace.yaml
├── package.json
├── pnpm-lock.yaml
└── README.md
```

## Why the monorepo?

The bot and dashboard are separate applications, but they need to understand some of the same concepts.

For example, both applications may eventually need the `Track` type:

```text
                    packages/shared
                          │
                 ┌────────┴────────┐
                 ▼                 ▼
              Bot App         Dashboard App
```

The shared package prevents us from defining the same types independently in multiple applications.

---

# 5. Shared Domain Types

The shared package contains concepts that should be understood by multiple applications.

## MusicSource

```ts
export type MusicSource =
  | "spotify"
  | "youtube"
  | "soundcloud";
```

This represents where a track was discovered or resolved.

---

## Track

```ts
export interface Track {
  id: string;

  title: string;
  artist: string;

  album?: string;
  duration?: number;
  thumbnail?: string;

  source: MusicSource;
  url: string;
}
```

A `Track` represents a normalized music item that the rest of the application can understand without caring how it was discovered.

Example:

```ts
{
  id: "123",
  title: "Blinding Lights",
  artist: "The Weeknd",
  album: "After Hours",
  duration: 200,
  thumbnail: "...",
  source: "spotify",
  url: "https://..."
}
```

---

# 6. Track Candidates

A search result should not immediately become the selected track.

Instead, providers return candidates.

```ts
export interface TrackCandidate {
  track: Track;

  confidence: number;

  provider: MusicSource;
}
```

Example:

```text
Spotify
  Blinding Lights — The Weeknd
  confidence: 0.96

YouTube
  The Weeknd - Blinding Lights (Official Audio)
  confidence: 0.98

YouTube
  Blinding Lights Remix
  confidence: 0.71

SoundCloud
  Blinding Lights - The Weeknd
  confidence: 0.84
```

The resolver compares these candidates rather than blindly selecting the first result.

---

# 7. Search vs Playback

A provider does not necessarily need to perform every job.

## Spotify

Spotify is primarily useful for:

- Track metadata
- Artist information
- Album information
- Artwork
- Track IDs
- Search
- Playlist/album information
- User music-library information where applicable

Spotify should **not** be treated as the Discord audio streaming source.

The user's Spotify Premium membership does not turn Spotify's protected catalog audio into a stream that our bot can simply pipe into Discord.

Instead:

```text
Spotify
   │
   ▼
Track metadata
   │
   ▼
Track Resolver
   │
   ▼
Find playable source
```

---

## YouTube

YouTube can potentially serve two roles:

- Search/discovery
- Playable audio source

```text
YouTube
   │
   ├── Search candidates
   │
   └── Resolve playable audio
```

---

## SoundCloud

SoundCloud can similarly provide:

- Search/discovery
- Playback where a suitable playable source is available

---

# 8. Provider Interface

Providers should eventually implement a common abstraction.

Conceptually:

```ts
export interface MusicProvider {
  search(query: string): Promise<TrackCandidate[]>;
}
```

A playback-capable provider may expose additional functionality:

```ts
export interface PlaybackProvider extends MusicProvider {
  getAudio(track: Track): Promise<unknown>;
}
```

The exact return type will depend on the audio implementation we select.

The important architectural rule is:

> The music player should not contain YouTube-, Spotify-, or SoundCloud-specific search logic.

---

# 9. Track Resolution System

The `TrackResolver` is the brain responsible for deciding what song the user intended.

## Basic flow

```text
User Query
    │
    ▼
Normalize Query
    │
    ▼
Search Providers
    │
    ├── Spotify
    ├── YouTube
    └── SoundCloud
    │
    ▼
Normalize Results
    │
    ▼
Generate Candidates
    │
    ▼
Score Candidates
    │
    ▼
Select Best Match
```

---

# 10. Fallback Strategy

Spotify should not be a required dependency for every search.

A song might:

- Not exist on Spotify.
- Have a different title.
- Be regionally unavailable.
- Be a remix/upload that Spotify does not have.
- Be an obscure recording.
- Be identified incorrectly by the user's query.

Therefore, the resolver should gracefully fall back.

Example:

```text
!play obscure song
       │
       ▼
   Spotify Search
       │
       X No useful match
       │
       ▼
   YouTube Search
       │
       ▼
 Candidate Results
       │
       ▼
 Score Candidates
       │
       ▼
 Good Match?
    │       │
   Yes      No
    │       │
    ▼       ▼
 Play    SoundCloud
             │
             ▼
          Search
```

Google/web search should be considered a **last-resort discovery mechanism**, not the default search path.

---

# 11. Match Scoring

The resolver should not simply use:

```ts
results[0]
```

Instead, candidates should be scored.

Possible signals include:

```text
Title similarity        → high weight
Artist similarity       → high weight
Album similarity        → medium weight
Duration similarity     → medium weight
Version/remix match     → important
Explicit/clean version  → optional preference
Official source         → positive signal
Source quality          → positive signal
```

A conceptual scoring model:

```text
Title similarity        +40
Artist similarity       +30
Duration similarity     +15
Album similarity        +10
Official source         +5
                        ----
                        100
```

This is only an initial conceptual model. The actual scoring algorithm should be developed and tested against real-world queries.

---

# 12. Query Normalization

Before searching, the resolver should normalize the user's request.

Potential normalization steps:

- Trim whitespace.
- Normalize casing.
- Remove unnecessary punctuation.
- Normalize common separators.
- Identify likely artist/title relationships.
- Recognize phrases such as:
  - "by"
  - "from"
  - "official"
  - "audio"
  - "music video"
- Preserve meaningful version information:
  - remix
  - live
  - acoustic
  - instrumental
  - sped up
  - slowed
  - extended

The system should avoid aggressively removing words that change the intended recording.

For example:

```text
"Blinding Lights Remix"
```

should not become:

```text
"Blinding Lights"
```

if the user explicitly requested the remix.

---

# 13. Confidence Thresholds

The resolver should eventually use confidence thresholds.

Example:

```text
0.90 - 1.00
Very strong match
→ Automatically play

0.75 - 0.89
Good match
→ Usually play automatically

0.50 - 0.74
Uncertain
→ Consider asking user

Below 0.50
Poor match
→ Do not automatically play
```

These numbers are examples and should be tuned using real usage data.

---

# 14. Poor Confidence User Interaction

One of the most important UX features is avoiding bad automatic selections.

If the resolver cannot confidently determine what the user means, it should ask.

Example:

```text
I found a few possible matches for "Numb":

1. Numb — Linkin Park
2. Numb (Live) — Linkin Park
3. Numb/Encore — Linkin Park & Jay-Z
4. Numb — Marshmello

Which one do you want?
```

The user could then select:

```text
[1] [2] [3] [4]
```

The selected result becomes the final `Track`.

## Voice version

If the user says:

```text
"Siri, play Numb"
```

and confidence is low, the bot could respond through Discord audio:

> "I found several versions of Numb. Say the number of the one you want."

The system can then listen for a response within a limited interaction window.

---

# 15. Resolver State

A future resolver interaction may look like:

```text
Resolver
   │
   ▼
Search
   │
   ▼
Candidates
   │
   ▼
Score
   │
   ├── High confidence
   │       │
   │       ▼
   │     Resolve
   │
   └── Low confidence
           │
           ▼
     Ask user to choose
           │
           ▼
       User choice
           │
           ▼
        Resolve
```

This prevents the bot from making low-quality assumptions.

---

# 16. Music Queue

The queue represents songs waiting to play.

Example:

```text
Queue
├── Blinding Lights
├── Numb
├── Starboy
└── After Hours
```

The first track is currently playing:

```text
Current:
Blinding Lights

Up Next:
1. Numb
2. Starboy
3. After Hours
```

Basic queue operations:

```ts
add(track)
next()
peek()
clear()
size
all
```

The queue should eventually support:

- Add
- Remove
- Move
- Clear
- Shuffle
- View queue
- Repeat track
- Repeat queue

---

# 17. Music Player

The `MusicPlayer` manages actual playback.

Conceptually:

```text
MusicPlayer
│
├── VoiceConnection
├── AudioPlayer
├── MusicQueue
├── Current Track
│
├── play()
├── pause()
├── resume()
├── skip()
├── stop()
└── destroy()
```

The player should not know how a track was discovered.

It should receive a normalized track/playback resource.

---

# 18. Discord Voice Architecture

The working voice pipeline is:

```text
Discord Interaction
        │
        ▼
VoiceConnection
        │
        ▼
AudioPlayer
        │
        ▼
AudioResource
        │
        ▼
Opus
        │
        ▼
Discord Voice
        │
        ▼
        🔊
```

The bot currently uses `@discordjs/voice` and an Opus implementation.

The voice connection must reach:

```text
VoiceConnectionStatus.Ready
```

before playback should be considered safe.

`entersState()` is used to wait for the required state:

```ts
await entersState(
  connection,
  VoiceConnectionStatus.Ready,
  10_000
);
```

Important distinction:

> `entersState()` does not make a connection ready. It waits for the connection to reach the requested state and rejects if that does not happen within the timeout.

---

# 19. Voice Intents

The Discord client requires the voice-state gateway intent:

```ts
GatewayIntentBits.GuildVoiceStates
```

Example:

```ts
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
```

This allows the voice connection process to receive the necessary Discord voice-state information.
Guild messages and Message Content Intent allow the bot to read prefix commands.
Message Content Intent must also be enabled in the Discord Developer Portal.

---

# 20. Prefix Command Layer

Commands should remain thin.

Examples:

```text
!ping
!join
!leave
!play <query>
!pause
!resume
!skip
!stop
!queue [page]
!nowplaying
!shuffle
!loop [off|song|queue]
```

A command should primarily:

1. Validate the request.
2. Retrieve the relevant service.
3. Call the service.
4. Return the result to Discord.

Avoid placing provider-specific logic directly inside command handlers.

`messageCreate` routes user messages beginning with `!`; bot/webhook messages are
ignored. Commands need no registration. `!play` shares the guild's connection setup
with `!join` and automatically joins the caller's channel if disconnected. Existing
connections and pending joins are reused per guild. See `README.md` for command
semantics, required intents, and one-time removal of remotely stored slash commands.

Bad:

```text
!play
 ├── Spotify search
 ├── YouTube search
 ├── SoundCloud search
 ├── scoring
 ├── queue management
 └── audio playback
```

Better:

```text
!play
  │
  ▼
MusicService
  │
  ▼
TrackResolver
  │
  ▼
MusicPlayer
```

---

# 21. Future Voice Command Architecture

The voice system should be separate from the music system.

Eventually:

```text
Discord Voice Audio
        │
        ▼
Voice Capture
        │
        ▼
Wake Phrase Detection
        │
        │ "Siri"
        ▼
Speech Recognition
        │
        ▼
Command Parser
        │
        ▼
Music Command
        │
        ▼
MusicService
```

The bot should ignore normal speech:

```text
User:
"Hey everyone, what are we doing tonight?"

Bot:
No response.
```

But:

```text
User:
"Siri, play Blinding Lights."

Bot:
Recognize command → Resolve → Play
```

---

# 22. Wake Phrase Design

Initial wake phrase:

```text
"Siri"
```

Example:

```text
"Siri, play Numb by Linkin Park"
```

The wake phrase should be configurable in the future.

Possible configuration:

```text
Wake phrase:
"Siri"

Alternative:
"Hey Music"

Alternative:
"Computer"
```

The system should distinguish between:

```text
Wake phrase + command
```

and:

```text
ordinary speech
```

---

# 23. Voice Recognition Considerations

The voice-command system will likely require multiple components:

```text
Discord voice receive
        │
        ▼
Audio decoding
        │
        ▼
Voice activity detection
        │
        ▼
Wake phrase detection
        │
        ▼
Speech-to-text
        │
        ▼
Command parsing
```

Because the project budget is intended to remain free, prioritize:

- Local/open-source speech recognition.
- Local wake-word detection where practical.
- CPU-efficient implementations.
- Avoid paid speech APIs unless explicitly added later.

Potential future evaluation areas:

- Whisper-based local speech recognition
- Lightweight wake-word detection
- WebRTC/VAD-style voice activity detection
- Local inference models

The exact libraries should be selected when implementation begins rather than prematurely locking the architecture to one solution.

---

# 24. Dashboard Architecture

The dashboard is a separate Next.js application:

```text
apps/dashboard/
```

It will eventually communicate with the bot/backend through an API.

Potential future architecture:

```text
                    Dashboard
                        │
                        ▼
                     API
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
        Music Services        Bot Services
              │                   │
              └─────────┬─────────┘
                        ▼
                     Database
```

Potential dashboard features:

- Login
- Discord server selection
- Bot status
- Current track
- Queue management
- Playback controls
- Server settings
- Volume settings
- Wake phrase settings
- Default music source preferences
- Search history
- User preferences
- Premium/future feature controls

---

# 25. Future Shared Packages

The shared package may eventually grow into:

```text
packages/
├── shared/
│   ├── src/
│   │   ├── track.ts
│   │   ├── queue.ts
│   │   ├── commands.ts
│   │   └── index.ts
│
├── config/
│   └── ...
│
└── utils/
    └── ...
```

Do not move code into shared packages merely because it can be shared.

A good rule:

> Share domain types and truly reusable logic. Keep application-specific behavior inside the application that owns it.

---

# 26. Per-Guild Music Sessions

The bot should eventually maintain independent music sessions per Discord server.

Example:

```text
Guild A
├── Voice Connection
├── Music Player
├── Queue
└── Current Track

Guild B
├── Voice Connection
├── Music Player
├── Queue
└── Current Track
```

A single global queue would be incorrect.

Conceptually:

```ts
Map<GuildId, MusicPlayer>
```

This allows the same bot to serve multiple servers simultaneously.

---

# 27. Resource Lifecycle

The bot needs clear ownership and cleanup rules.

When joining:

```text
Create VoiceConnection
Create MusicPlayer
Create Queue
```

When leaving:

```text
Stop AudioPlayer
Clear/handle Queue
Destroy VoiceConnection
Remove Guild MusicPlayer
```

When a track finishes:

```text
AudioPlayer → Idle
       │
       ▼
Queue.next()
       │
       ▼
Play next Track
```

---

# 28. Playback Lifecycle

Normal playback should eventually work like this:

```text
!play <query>
       │
       ▼
TrackResolver
       │
       ▼
Best Track
       │
       ▼
MusicQueue.add()
       │
       ▼
Is player idle?
    │          │
   Yes         No
    │           │
    ▼           ▼
  Play       Wait in queue
    │
    ▼
AudioPlayer
    │
    ▼
Track finishes
    │
    ▼
Queue.next()
    │
    ▼
Play next
```

---

# 29. Commands Roadmap

## Currently completed

```text
!ping       ✅
!join       ✅
!leave      ✅
!playtest   ✅ (also !pluh; uses MusicPlayer)
Local audio playback ✅
```

## Core music commands — completed

```text
!play
!pause
!resume
!skip
!stop
!queue
!nowplaying
```

## Queue management

```text
!shuffle    ✅
!loop       ✅ (off, song, queue)
!remove     (future)
!move       (future)
!clear      (future; !stop currently clears and stops)
```

## Future discovery commands

```text
!search
!lyrics
```

These should only be added if they fit the final product architecture.

---

# 30. Music Source Roadmap

## Phase 1 — YouTube

Responsibilities:

- Search
- Candidate generation
- Track metadata
- Playback resolution where technically and legally appropriate

## Phase 2 — Spotify

Responsibilities:

- Search
- Metadata
- Artist/album information
- Playlist/album discovery
- Track identification

Spotify is primarily a metadata/discovery source, not the audio transport.

## Phase 3 — SoundCloud

Responsibilities:

- Search
- Candidate generation
- Metadata
- Playback where available

## Phase 4 — Additional fallback/discovery

Potential future sources can be added without rewriting the player.

---

# 31. Provider Independence

Adding a new source should look conceptually like:

```text
NewProvider
     │
     ├── implements MusicProvider
     │
     ▼
TrackCandidate[]
     │
     ▼
TrackResolver
```

The queue and player should not need to change.

This is one of the major scalability goals.

---

# 32. Error Handling

Every stage should have clear failure behavior.

## Search failure

```text
Spotify unavailable
        │
        ▼
Try YouTube
```

## Poor result

```text
No high-confidence candidate
        │
        ▼
Ask user
```

## No results

```text
No providers found a useful match
        │
        ▼
Tell user
```

Example:

```text
I couldn't find a reliable match for that song.
Try including the artist name or a little more information.
```

## Playback failure

```text
Track resolved
      │
      ▼
Playback fails
      │
      ▼
Try alternate playable candidate
      │
      ▼
If none work → notify user
```

This is another reason candidates should remain available after resolution.

---

# 33. Candidate Fallback During Playback

The resolver should ideally retain more than one viable candidate.

Example:

```text
Best candidate
   │
   X Playback failed
   │
   ▼
Second-best candidate
   │
   X Failed
   │
   ▼
Third candidate
   │
   ▼
Play
```

This can make the system much more resilient than selecting one URL and giving up.

---

# 34. Caching

Caching should eventually be introduced for expensive or repeated operations.

Potential cache targets:

- Search results
- Track metadata
- Resolved provider IDs
- Artwork
- Provider lookup results

Example:

```text
User A:
"Blinding Lights"

       ↓

TrackResolver
       ↓
Cache miss
       ↓
Search providers
       ↓
Store result


User B:
"Blinding Lights"

       ↓

TrackResolver
       ↓
Cache hit
       ↓
Reuse result
```

Caching should have sensible expiration because provider results can change.

---

# 35. Observability

As the project grows, logging should make it possible to understand why the resolver selected a track.

Example:

```text
Query:
"numb linkin park"

Candidates:
Spotify → 0.96
YouTube → 0.98
YouTube → 0.72
SoundCloud → 0.84

Selected:
YouTube candidate
Score: 0.98
```

This will be extremely useful when tuning the matching algorithm.

Avoid logging secrets, tokens, or unnecessary user-private information.

---

# 36. Testing Strategy

The resolver should be heavily tested because it is a core differentiating feature.

## Unit tests

Test:

- Query normalization
- Title matching
- Artist matching
- Duration comparison
- Candidate scoring
- Confidence thresholds
- Fallback behavior

Example test cases:

```text
"Blinding Lights"
"Blinding Lights The Weeknd"
"The Weeknd - Blinding Lights"
"numb linkin park"
"numb live"
"numb remix"
```

## Integration tests

Test:

```text
Provider → Candidate → Resolver
```

and:

```text
Resolver → MusicPlayer
```

## Discord tests

Test:

```text
!join
!play
!pause
!resume
!skip
!stop
!queue
!nowplaying
!shuffle
!loop
!leave
```

---

# 37. Security

The bot should never trust raw user input.

Important areas:

- Validate prefix command input.
- Validate URLs.
- Avoid arbitrary command execution.
- Keep API keys in environment variables.
- Never expose bot tokens to the dashboard client.
- Keep provider credentials server-side.
- Rate-limit expensive searches where appropriate.
- Prevent command abuse.
- Validate Discord permissions for administrative controls.

Environment variables belong in the application that needs them.

For example:

```text
apps/bot/.env
```

may contain:

```text
DISCORD_TOKEN=
# Only required for one-time legacy slash-command cleanup:
DISCORD_CLIENT_ID=
YOUTUBE_API_KEY=
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
```

The dashboard should have its own environment configuration.

---

# 38. Free/Budget Philosophy

The project should prioritize free and open-source components.

The architecture should avoid requiring paid services for core functionality.

However, "free" does not guarantee unlimited usage.

Potential constraints include:

- API rate limits
- Hosting limits
- Compute requirements for local speech recognition
- Provider availability
- Provider terms of service
- Bandwidth
- Storage

The system should therefore be designed so individual providers can be replaced.

---

# 39. Development Phases

## Phase 0 — Foundation

Completed:

```text
✅ pnpm monorepo
✅ apps/bot
✅ apps/dashboard
✅ packages/shared
✅ Discord application
✅ Bot authentication
```

---

## Phase 1 — Discord Voice

Completed:

```text
✅ !join
✅ !leave
✅ GuildVoiceStates intent
✅ VoiceConnection Ready handling
✅ AudioPlayer
✅ Local test audio
```

---

## Phase 2 — Music Engine

Completed:

```text
✅ Shared Track
✅ TrackCandidate
✅ MusicSource
✅ MusicQueue
✅ MusicPlayer
✅ Refactor local playback through MusicPlayer
```

---

## Phase 3 — Provider Abstraction

Completed:

```text
✅ MusicProvider interface
✅ Provider error model
✅ Candidate normalization
✅ Playback-provider abstraction
```

---

## Phase 4 — YouTube

Implemented:

```text
✅ YouTube search
✅ Candidate normalization
✅ Match scoring
✅ Audio resolution
✅ Playback integration
```

The initial implementation uses YouTube Data API v3 (`YOUTUBE_API_KEY`) for search
and metadata, and yt-dlp + FFmpeg for lazy audio extraction. `!play <query or video
URL>` connects the provider through `TrackResolver` and `MusicService` to each guild's
asynchronous player. Searches automatically select the highest-scoring valid candidate,
including low-confidence matches, and retain confidence scores internally. See
`README.md` for runtime dependencies and the live Discord/YouTube smoke test.

---

## Phase 5 — Spotify

```text
⬜ Spotify authentication
⬜ Track search
⬜ Metadata normalization
⬜ Spotify URL parsing
⬜ Spotify → playable-source resolution
```

---

## Phase 6 — SoundCloud

```text
⬜ SoundCloud search
⬜ Candidate normalization
⬜ Playback integration
```

---

## Phase 7 — Intelligent Resolver

```text
⬜ Query normalization
⬜ Multi-provider search
⬜ Candidate scoring
⬜ Confidence thresholds
⬜ Alternate candidates
⬜ Poor-confidence interaction
⬜ Playback fallback
```

---

## Phase 8 — Music Commands

```text
✅ !play (auto-joins the caller's voice channel when disconnected)
✅ !pause
✅ !resume
✅ !skip
✅ !stop
✅ !queue [page]
✅ !nowplaying
✅ !shuffle
✅ !loop [off|song|queue]
```

---

## Phase 9 — Voice Commands

```text
⬜ Discord voice receive
⬜ Voice activity detection
⬜ Wake phrase detection
⬜ Speech-to-text
⬜ Command parsing
⬜ "Siri, play..."
⬜ Voice confirmation
⬜ Voice-based candidate selection
```

---

## Phase 10 — Dashboard

```text
⬜ Dashboard authentication
⬜ Discord server management
⬜ Current playback
⬜ Queue UI
⬜ Playback controls
⬜ Server configuration
⬜ Wake phrase settings
⬜ Music source preferences
```

---

# 40. Long-Term Product Architecture

The final system should resemble:

```text
                         ┌──────────────────┐
                         │     Discord      │
                         └────────┬─────────┘
                                  │
                   ┌──────────────┴──────────────┐
                   │                             │
              Prefix Commands                Voice Input
                   │                             │
                   │                       Wake Detection
                   │                             │
                   │                       Speech-to-Text
                   │                             │
                   └──────────────┬──────────────┘
                                  │
                                  ▼
                           Command Service
                                  │
                                  ▼
                           Music Service
                                  │
                                  ▼
                          Track Resolver
                                  │
               ┌──────────────────┼──────────────────┐
               │                  │                  │
               ▼                  ▼                  ▼
           Spotify             YouTube          SoundCloud
               │                  │                  │
               └──────────────────┼──────────────────┘
                                  │
                                  ▼
                            Match Engine
                                  │
                     ┌────────────┴────────────┐
                     │                         │
               High Confidence           Low Confidence
                     │                         │
                     ▼                         ▼
                 Auto-play              Ask User
                     │                         │
                     └────────────┬────────────┘
                                  ▼
                              Track
                                  │
                                  ▼
                              Queue
                                  │
                                  ▼
                            MusicPlayer
                                  │
                                  ▼
                           Discord Voice


                         Future Dashboard
                                │
                                ▼
                               API
                                │
                                ▼
                         Music Services
```

---

# 41. Core Architectural Principles

The following principles should guide future development.

## 1. Separate identification from playback

Do not assume the service that identifies a song is the service that plays it.

## 2. Never blindly play the first search result

Search quality is a core feature.

## 3. Prefer confidence-based decisions

High confidence → play.

Low confidence → ask.

## 4. Keep fallback candidates

A failed playback attempt should not necessarily mean the song cannot be played.

## 5. Keep providers isolated

YouTube code should not leak into Spotify code or the music player.

## 6. Keep commands thin

Commands should orchestrate services rather than contain business logic.

## 7. Keep shared packages focused

Share domain concepts, not everything.

## 8. Design per Discord guild

Each server needs its own voice connection, queue, and player state.

## 9. Make provider replacement possible

The system should continue functioning if one provider becomes unavailable.

## 10. Optimize for user trust

If the bot is uncertain, it should say so rather than confidently playing the wrong song.

---

# 42. Immediate Development Roadmap

The next implementation steps should be:

```text
1. Create shared MusicSource type
2. Create shared Track type
3. Create shared TrackCandidate type
4. Create MusicQueue
5. Create MusicPlayer
6. Move local MP3 playback into MusicPlayer
7. Add !playtest through MusicPlayer (completed)
8. Define MusicProvider interface
9. Implement YouTube provider
10. Build first version of TrackResolver
11. Add candidate scoring
12. Add !play (completed)
13. Add playback fallback
14. Add Spotify provider
15. Add SoundCloud provider
16. Improve resolver accuracy
17. Add low-confidence user selection
18. Add queue commands (core controls completed)
19. Add voice input
20. Add dashboard controls
```

The **Track Resolver** should be treated as one of the most important pieces of the project. The goal is not merely to make the bot play music; it is to make the bot **play the music the user actually intended**.
