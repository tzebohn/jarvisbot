# Jarvis — Discord Music & Voice Assistant

Jarvis is a full-stack Discord music and voice assistant built as a TypeScript monorepo. It combines traditional Discord music-bot functionality with a hands-free voice command pipeline that allows users to interact with the bot using the **"Jarvis"** wake phrase.

The project explores real-time Discord voice processing, wake-word detection, speech-to-text transcription, command parsing, music search, queue management, and multi-provider music resolution while maintaining a modular architecture that can be expanded as the project grows.

Alongside the Discord bot, the monorepo contains a Next.js dashboard used to demonstrate a potential web interface for monitoring and managing the bot.

> **Project Status:** Active development / experimental.
> Jarvis is currently intended primarily as a personal and portfolio project rather than a production Discord bot service.

---

## Features

### Discord Music Bot

* Join and leave Discord voice channels
* Search for music using natural queries
* Play and queue tracks
* Pause, resume, skip, and manage playback
* Maintain per-session music queues
* Support both traditional text commands and voice commands
* Provider abstraction for multiple music sources
* Confidence-based music search and automatic candidate selection

### Voice Commands

Jarvis includes an experimental hands-free voice command system.

Instead of requiring users to type commands, the bot can listen for the wake phrase:

```text
Jarvis
```

Once detected, Jarvis can capture the following spoken request and process it as a command.

Example:

```text
"Jarvis, play Blinding Lights by The Weeknd"
```

The voice pipeline includes:

```text
Discord Voice
      ↓
PCM Audio Capture
      ↓
Voice Activity Detection
      ↓
Wake Word Detection
      ↓
Command Audio Capture
      ↓
Speech-to-Text
      ↓
Command Parsing
      ↓
Music / Bot Action
```

The system is designed so each stage can be tested and improved independently.

### Voice Activity Detection

Incoming Discord audio is decoded into PCM and passed through voice activity detection before more expensive voice processing occurs.

VAD allows Jarvis to identify:

* When a user begins speaking
* When speech ends
* How long an utterance lasts
* Whether captured audio contains meaningful speech

This reduces unnecessary wake-word and transcription processing.

### Wake Word Detection

Jarvis uses an offline keyword spotting pipeline to detect the **"Jarvis"** wake phrase.

The wake-word system supports:

* Streaming audio processing
* Rolling audio buffers
* Multiple pronunciation/token variants
* Configurable detection thresholds
* Configurable keyword scores
* Wake-word testing utilities

Wake-word detection runs locally and does not require sending every user's continuously captured audio to a cloud transcription provider.

### Speech-to-Text

After the wake phrase is detected, Jarvis captures the user's command and converts it into text.

The project supports a hybrid speech-to-text architecture:

**Primary STT**

* Groq Whisper API

**Local fallback**

* faster-whisper

This allows cloud transcription to be used when available while retaining the ability to process speech locally. Local STT response times may vary depending your system's hardware.

### Music Engine

Music playback is separated from individual providers through a reusable music engine.

Core concepts include:

* `Track`
* `TrackCandidate`
* `MusicSource`
* `MusicQueue`
* `MusicPlayer`
* `MusicProvider`

This separation allows search, candidate selection, playback resolution, and queue management to evolve without tightly coupling the bot to one music service.

### Music Providers

Jarvis is designed around a provider abstraction rather than a single music platform.

Current integrations and experiments include:

* YouTube

Spotify can be used for metadata and search information while playable audio can be resolved through another supported provider.

---

## Monorepo Architecture

The project uses a monorepo to keep the Discord bot, web dashboard, and shared TypeScript definitions together.

```text
discord-music-platform/
│
├── apps/
│   ├── bot/
│   │   ├── src/
│   │   └── package.json
│   │
│   └── dashboard/
│       ├── app/
│       ├── components/
│       └── package.json
│
├── packages/
│   └── shared/
│       └── ...
│
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

### `apps/bot`

Contains the Discord bot and voice-processing pipeline.

Responsibilities include:

* Discord gateway communication
* Voice channel connections
* Audio receiving
* PCM processing
* Voice activity detection
* Wake-word detection
* Speech-to-text
* Command parsing
* Music searching
* Queue management
* Audio playback

### `apps/dashboard`

Next.js web application representing the dashboard portion of the project.

The current dashboard is primarily a demonstration UI and does not yet expose production analytics from the Discord bot.

### `packages/shared`

Contains types and other code that can be shared between applications in the monorepo.

---

## Technology Stack

### Core

* **TypeScript**
* **Node.js**
* **pnpm Workspaces**

### Discord

* **discord.js**
* **@discordjs/voice**
* Discord Voice Gateway
* Opus audio

### Voice Processing

* PCM audio processing
* WebRTC-style Voice Activity Detection
* `@echogarden/fvad-wasm`
* Sherpa-ONNX keyword spotting
* Rolling audio buffers

### Speech-to-Text

* **Groq Whisper**
* **faster-whisper (local)**

### Music

* YouTube
* Custom provider abstraction
* Custom music queue and playback engine

### Dashboard

* **Next.js**
* **React**
* **TypeScript**
* **Tailwind CSS**

---

## Requirements

Before running Jarvis, make sure you have:

* Node.js
* pnpm
* A Discord application and bot
* FFmpeg where required by the audio pipeline
* yt-dlp for YouTube
* Required voice/wake-word model files
* API credentials for any cloud providers you enable

Some voice-processing features may also require additional native or Python dependencies depending on the STT configuration being used.

---

## Quick Start

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd <your-repository-name>
```

### 2. Install Dependencies

Because this project uses pnpm workspaces, dependencies can be installed from the monorepo root:

```bash
pnpm install
```

### 3. Configure Environment Variables

Create the required environment file for the bot.

For example:

```text
apps/bot/.env
```

Configure the environment variables required by your installation.

Example:

```env
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_application_id

GROQ_API_KEY=your_groq_api_key

VOICE_WAKE_THRESHOLD=0.10
VOICE_WAKE_SCORE=1.0
```

Never commit API keys, Discord tokens, cookies, credentials, or other secrets to source control.

### 4. Configure Discord

Create a bot through the Discord Developer Portal and invite it to your test server.

The bot requires the appropriate permissions to:

* View channels
* Send messages
* Connect to voice channels
* Speak in voice channels

Enable any Discord gateway intents required by the current bot configuration.

### 5. Start the Discord Bot

From the monorepo root:

```bash
pnpm --filter bot dev
```

Once successfully connected, the terminal should indicate that Jarvis has logged into Discord.

### 6. Start the Dashboard

Open another terminal and run:

```bash
pnpm --filter dashboard dev
```

The Next.js development server will start locally.

By default, Next.js typically exposes the application at:

```text
http://localhost:3000
```

---

## Commands

Jarvis supports text-based commands alongside the experimental voice interface.

Examples include:

```text
!join
!leave
!play <query>
!pause
!skip
!queue
```

Development and diagnostic commands may also be available for testing individual parts of the voice pipeline.

Examples include:

```text
!voicetest
!command
!commandtest
```

These commands are particularly useful while developing wake-word detection, audio capture, and speech recognition.

---

## Voice Command Pipeline

One of the primary goals of Jarvis is to make interacting with a Discord music bot feel more natural.

Rather than continuously sending audio to an external speech recognition API, processing can be divided into stages.

```text
User speaks
   │
   ▼
Discord receives Opus packets
   │
   ▼
Decode audio
   │
   ▼
PCM stream
   │
   ▼
Voice Activity Detection
   │
   ├── No speech ──► Ignore
   │
   ▼
Wake Word Detection
   │
   ├── No "Jarvis" ──► Ignore
   │
   ▼
Wake phrase detected
   │
   ▼
Capture command audio
   │
   ▼
Speech-to-Text
   │
   ▼
Command Parser
   │
   ▼
Execute Action
   │
   ├── Play
   ├── Pause
   ├── Skip
   ├── Queue
   └── Other Commands
```

This architecture helps reduce unnecessary transcription requests while keeping the voice system modular.

---

## Development Philosophy

Jarvis is intentionally divided into independent systems rather than implementing the entire bot as one large Discord event handler.

For example:

```text
Discord
   ↓
Voice Layer
   ↓
Speech Processing
   ↓
Command Layer
   ↓
Music Engine
   ↓
Provider Layer
```

Keeping these responsibilities separate makes individual components easier to debug, test, replace, and extend.

A provider can change without requiring the queue implementation to be rewritten, while the speech-to-text implementation can change without modifying the music engine.

---

## Current Limitations

The voice system is experimental and real-world Discord audio varies significantly between users.

Wake-word accuracy can be affected by:

* Microphone quality
* Microphone gain
* Discord noise suppression
* Discord echo cancellation
* Automatic gain control
* Background noise
* User pronunciation
* Speaking volume
* Network conditions
* Audio compression
* Different accents and speech patterns

As a result, wake-word performance observed during development may not represent performance across every Discord user or audio configuration.

Music providers can also change their websites, APIs, playback restrictions, or anti-automation systems over time. Provider implementations should therefore be treated as replaceable components rather than permanent dependencies.

---

## Future Improvements

### Better Wake Detection

Improve wake-word reliability across different microphones, Discord configurations, accents, speaking styles, and environments.

Potential improvements include:

* Additional Jarvis pronunciation variants
* Better adaptive detection thresholds
* Dynamic microphone normalization
* Improved noise handling
* Automatic gain normalization
* More robust rolling-buffer logic
* Improved false-positive rejection
* Testing across larger sets of recorded voices
* Detection tuning for Discord's audio processing
* Better handling of echo cancellation and noise suppression

### Improved Voice Command UX

Make voice interactions feel more conversational and provide clearer feedback during each stage.

Future improvements could include:

* Audible wake acknowledgement
* Listening indicators
* Processing indicators
* Success and failure audio cues
* Better handling of incomplete commands
* Command confirmation when confidence is low
* Natural follow-up commands without repeating the wake phrase

### Continuous Listening

Expand the voice system from development/testing commands into a reliable continuous listening pipeline.

This includes:

* Multiple simultaneous speakers
* Per-user voice state
* Independent rolling audio buffers
* Wake windows
* Command timeouts
* Speaker concurrency management
* Resource cleanup when users leave
* Efficient idle processing

### Better Music Matching

Improve confidence scoring when resolving user requests against music search results.

Potential improvements include:

* Artist-name matching
* Track-title weighting
* Duration comparison
* Official-upload prioritization
* Remix/live/version detection
* Duplicate filtering
* Provider fallback
* Better confidence thresholds

### Provider Reliability

Continue improving the provider abstraction so unavailable or failing music sources can automatically fall back to another provider (SoundCloud, Spotify, etc).

```text
Music Request
      ↓
Provider Search
      ↓
Candidate Scoring
      ↓
Playback Resolution
      │
      ├── Success → Play
      │
      └── Failure
              ↓
       Fallback Provider
```

### Dashboard Integration

The current dashboard is primarily a demonstration interface.

A future version could communicate with the bot through a dedicated backend API and provide real statistics such as:

* Connected servers
* Active voice sessions
* Songs played
* Queue information
* Command usage
* Wake-word detections
* STT latency
* Music provider health
* Bot uptime
* Error monitoring

### Testing

Add automated tests around the parts of the application that do not require a live Discord connection.

Potential targets include:

* Queue behavior
* Command parsing
* Search candidate scoring
* Track normalization
* Provider fallback
* Wake-word configuration
* Audio state transitions

---

## Disclaimer

This project is intended for educational, experimental, and portfolio purposes.

Third-party platforms and media providers have their own terms of service, API policies, copyright requirements, and usage restrictions. Anyone modifying or deploying this project is responsible for ensuring their usage complies with the requirements of the services they interact with.

Jarvis is not affiliated with Discord, YouTube, Spotify, SoundCloud, Groq, or any other third-party service referenced by the project.
