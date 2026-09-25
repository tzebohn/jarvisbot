import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { createMessageHandler } from "./handleMessage.js";
import { MusicService } from "./music/MusicService.js";
import { YouTubeClient, YouTubeProvider, YtDlpAudio } from "./music/providers/index.js";
import { VoiceReceiveManager } from "./voice/VoiceReceiveManager.js";
import { createWebRtcVadFactory, type VoiceFrameDetectorFactory } from "./voice/processing/WebRtcVad.js";
import { WakeEngine } from "./voice/wake/WakeEngine.js";
import { DEFAULT_WAKE_SCORE, DEFAULT_WAKE_THRESHOLD, WAKE_PHRASE } from "./voice/wake/wakeModel.js";
import { createSpeechToText } from "./voice/transcription/config.js";
import { STT_PROCESSING_TIMEOUT_MS } from "./voice/transcription/SpeechToText.js";
import { SttError } from "./voice/transcription/types.js";
import { createVoiceCommandParser } from "./voice/commands/config.js";
import { GuildMusicPlayers } from "./music/GuildMusicPlayers.js";
import { VoiceMusicCommands } from "./voice/commands/VoiceMusicCommands.js";
import { DiscordVoiceCommandFeedback } from "./voice/feedback/DiscordVoiceCommandFeedback.js";
import { wakeAcknowledgementDelay } from "./voice/feedback/WakeAcknowledgement.js";
import { loadWakeAcknowledgement } from "./voice/feedback/wakeAcknowledgementAudio.js";

const token = process.env.DISCORD_TOKEN;

if (!token) {
  throw new Error("DISCORD_TOKEN is not defined");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", (client) => {
  console.log(`Logged in as ${client.user.tag}`);
});

const youtube = new YouTubeProvider(
  new YouTubeClient(process.env.YOUTUBE_API_KEY ?? ""),
  new YtDlpAudio(process.env.YT_DLP_PATH?.trim() || "yt-dlp"),
);
let createVad: VoiceFrameDetectorFactory | undefined;
try {
  createVad = await createWebRtcVadFactory(Number(process.env.VOICE_VAD_MODE?.trim() || "2"));
} catch (error) {
  console.error("Could not initialize voice activity detection; check VOICE_VAD_MODE and the WASM installation.", error);
}
let wakeEngine: WakeEngine | undefined;
if (process.env.VOICE_WAKE_ENABLED !== "0" && createVad) {
  try {
    wakeEngine = await WakeEngine.create(process.env.VOICE_WAKE_MODEL_DIR?.trim() || undefined,
      Number(process.env.VOICE_WAKE_THRESHOLD?.trim() || DEFAULT_WAKE_THRESHOLD), Number(process.env.VOICE_WAKE_SCORE?.trim() || DEFAULT_WAKE_SCORE));
    console.log(`Wake detection ready: "${WAKE_PHRASE}".`, { threshold: wakeEngine.threshold,
      score: Number(process.env.VOICE_WAKE_SCORE?.trim() || DEFAULT_WAKE_SCORE), vadMode: Number(process.env.VOICE_VAD_MODE?.trim() || "2"),
      input: "48000 Hz stereo s16le", modelInput: "16000 Hz mono float32", confidenceAvailable: false });
  } catch (error) {
    console.error("Wake detection unavailable. Run pnpm --filter bot setup:wake and check VOICE_WAKE_* configuration.", error);
  }
}
const stt = createSpeechToText();
const commandParser = createVoiceCommandParser();
const wakeAckDelayMs = wakeAcknowledgementDelay();
let wakeAcknowledgementPcm: Buffer | undefined;
if (wakeEngine) {
  try { wakeAcknowledgementPcm = await loadWakeAcknowledgement(); }
  catch (error) { console.error("Wake acknowledgement unavailable; check assets/voice/wake-acknowledgement.wav.", error); }
}
const voiceReceivers = new VoiceReceiveManager(process.env.VOICE_RECEIVE_DEBUG === "1", createVad,
  wakeEngine?.createBackend, process.env.VOICE_WAKE_DEBUG === "1", {
    debug: process.env.VOICE_SESSION_DEBUG === "1",
    wakeAckDelayMs,
    playWakeAcknowledgement: wakeAcknowledgementPcm ? (request) => {
      // Resolve only this session's still-owned connection; never join or move voice for a cue.
      const controller = voiceReceivers.get(request.guildId);
      if (controller?.connection === musicPlayers.getConnection(request.guildId) && request.canPlay()) {
        musicPlayers.get(request.guildId)?.playCue(wakeAcknowledgementPcm!, request);
      }
    } : undefined,
    processingTimeoutMs: stt ? STT_PROCESSING_TIMEOUT_MS : undefined,
    processCapture: stt ? async (audio, signal) => {
      try { return await stt.transcribe(audio, signal); }
      catch (error) {
        if (!signal.aborted) console.error("[voice-stt] failed", { guildId: audio.guildId, sessionId: audio.sessionId,
          code: error instanceof SttError ? error.code : "UNKNOWN",
          message: error instanceof SttError ? error.message : "Transcription failed." });
        throw error;
      }
    } : undefined,
    parseTranscript: stt ? (transcript, signal) => commandParser.parse(transcript.text, signal, { truncated: transcript.truncated }) : undefined,
    executeCommand: (command, signal, report) => voiceMusicCommands.execute(command, signal, report),
  });
const music = new MusicService(youtube);
const musicPlayers = new GuildMusicPlayers(voiceReceivers, !!wakeAcknowledgementPcm);
const voiceFeedback = new DiscordVoiceCommandFeedback(client);
voiceReceivers.on("feedback", voiceFeedback.update);
const voiceMusicCommands = new VoiceMusicCommands(client, musicPlayers, voiceReceivers, music, voiceFeedback);
voiceReceivers.on("command", ({ guildId, userId, sessionId, command, source, reason, elapsedMs, model, confidence, cached }) => {
  if (process.env.VOICE_COMMAND_DEBUG === "1") console.log("[voice-command] result",
    { guildId, userId, sessionId, type: command.type, source, reason, elapsedMs, model, confidence, cached });
});
voiceReceivers.on("transcript", ({ guildId, userId, sessionId, status, provider, model, fallbackReason, elapsedMs, groqMs, localMs }) => {
  if (process.env.VOICE_STT_DEBUG === "1") console.log("[voice-stt] result",
    { guildId, userId, sessionId, status, provider, model, fallbackReason, elapsedMs, groqMs, localMs });
});
voiceReceivers.on("wake", ({ phrase, guildId, userId, detectedAt, preRoll }) => {
  console.log("[voice] wake detected", { phrase, guildId, userId, detectedAt, preRollBytes: preRoll.length });
});
client.on("voiceStateUpdate", voiceReceivers.handleVoiceStateUpdate);
client.on("messageCreate", createMessageHandler(music, voiceReceivers, musicPlayers));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { voiceReceivers.destroy(); musicPlayers.destroy(); stt?.close(); void wakeEngine?.close(); void client.destroy(); });
}

try {
  await client.login(token);
} catch (error) {
  voiceReceivers.destroy();
  musicPlayers.destroy();
  stt?.close();
  await wakeEngine?.close();
  throw error;
}
