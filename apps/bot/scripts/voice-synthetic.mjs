import { spawnSync } from "node:child_process";
import { decodeWav } from "./voice-audio.mjs";

export function windowsVoices() {
    if (process.platform !== "win32") throw new Error("Synthetic speech uses Windows System.Speech. Use a labelled WAV manifest on other platforms.");
    const voices = spawnSync("powershell", ["-NoProfile", "-Command",
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; @($s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'en-US' } | ForEach-Object { $_.VoiceInfo.Name }) | ConvertTo-Json; $s.Dispose()"],
    { encoding: "utf8", timeout: 15_000 });
    if (voices.error || voices.status !== 0 || !voices.stdout.trim()) throw new Error("Install an en-US Windows System.Speech voice, or supply recorded WAVs.");
    return [JSON.parse(voices.stdout)].flat();
}

export function synthesizePcm(voice, sample) {
    const { text, rate = 0, volume = 70 } = sample;
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const ssml = sample.phoneme || sample.emphasis
        ? `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">${sample.phoneme
            ? `<phoneme alphabet="ipa" ph="${sample.phoneme}">${text}</phoneme>`
            : `<emphasis level="strong">${text}</emphasis>`}</speak>` : undefined;
    const speech = spawnSync("powershell", ["-NoProfile", "-Command",
        `$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice(${quote(voice)}); $s.Rate = ${rate}; $s.Volume = ${volume}; $m = New-Object IO.MemoryStream; $s.SetOutputToWaveStream($m); $s.${ssml ? "SpeakSsml" : "Speak"}(${quote(ssml ?? text)}); $s.Dispose(); [Convert]::ToBase64String($m.ToArray())`],
    { encoding: "utf8", maxBuffer: 10_000_000, timeout: 15_000 });
    if (speech.error || speech.status !== 0 || !speech.stdout.trim()) throw new Error(`Could not synthesize ${sample.name} for ${voice}.`);
    return decodeWav(Buffer.from(speech.stdout.trim(), "base64"));
}

export function syntheticWakeCases(styles) {
    const positives = [
        { name: "normal", text: "Jarvis" },
        { name: "continuous-command", text: "Jarvis play Numb by Linkin Park", referenceText: "play Numb by Linkin Park" },
        { name: "hey-command", text: "Hey Jarvis play Numb" },
        { name: "faster", text: "Jarvis play Numb", rate: 3 },
        { name: "slower", text: "Jarvis", rate: -3 },
        { name: "quieter", text: "Jarvis", volume: 25 },
        { name: "louder", text: "Jarvis", volume: 100 },
        { name: "emphasis", text: "Jarvis", emphasis: true },
        { name: "rhotic-schwa-IPA", text: "Jarvis", phoneme: "ˈdʒɑɹvəs" },
        { name: "rhotic-ih-IPA", text: "Jarvis", phoneme: "ˈdʒɑɹvɪs" },
    ].map((sample) => ({ ...sample, expected: true }));
    const negatives = ["Please play another song after this one", "Turn the music down a little",
        "Are you joining the voice channel", "We can start after dinner", "That was a very good song",
        "I bought a jar of jam", "The service is ready", "Just this one please", "Harvest", "Travis",
        "Jervis", "Jar", "vis", "Hey Siri"].map((text) => ({ name: text, text, expected: false }));
    const cases = [];
    for (const voice of windowsVoices()) {
        for (const sample of [...positives, ...negatives].filter((sample) => !styles || styles.includes(sample.name))) {
            cases.push({ ...sample, style: sample.name, voice, name: `${voice}: ${sample.name}`, pcm: synthesizePcm(voice, sample) });
        }
    }
    return cases;
}

/** Repeatable noise proxies, never presented as recordings of real keyboards/fans/microphones. */
export function noisePcm(kind, frames, seed = 42) {
    const pcm = Buffer.alloc(frames * 4);
    let smooth = 0;
    for (let i = 0; i < frames; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const white = seed / 0x100000000 * 2 - 1;
        smooth = 0.98 * smooth + 0.02 * white;
        const seconds = i / 48_000;
        const noise = kind === "hiss" ? white : kind === "fan"
            ? 3 * smooth + 0.2 * Math.sin(2 * Math.PI * 60 * seconds)
            : kind === "keyboard" ? white * Math.exp(-(i % 10560) / 160) : NaN;
        if (!Number.isFinite(noise)) throw new Error("Unknown noise proxy.");
        const value = Math.max(-32768, Math.min(32767, Math.round(noise * 6000)));
        pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2);
    }
    return pcm;
}

export function mixAtSnr(pcm, noise, snrDb = 15) {
    const energy = (buffer) => {
        let sum = 0;
        for (let i = 0; i < buffer.length; i += 2) sum += buffer.readInt16LE(i) ** 2;
        return sum / (buffer.length / 2);
    };
    const repeated = Buffer.alloc(pcm.length);
    for (let i = 0; i < repeated.length; i++) repeated[i] = noise[i % noise.length];
    const gain = Math.sqrt(energy(pcm) / (energy(repeated) || 1)) / 10 ** (snrDb / 20);
    const mixed = Buffer.alloc(pcm.length);
    for (let i = 0; i < mixed.length; i += 2) {
        mixed.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) + repeated.readInt16LE(i) * gain))), i);
    }
    return mixed;
}

export function syntheticVoiceCorpus() {
    const base = syntheticWakeCases(["normal", "continuous-command", "The service is ready", "Travis"]);
    const voices = [...new Set(base.map((sample) => sample.voice))];
    const backgrounds = new Map(voices.map((voice, index) => [voice, synthesizePcm(voices[(index + 1) % voices.length],
        { name: "background-conversation", text: "We can start after dinner" })]));
    const cases = [];
    for (const sample of base) {
        const background = backgrounds.get(sample.voice);
        const echo = Buffer.alloc(sample.pcm.length);
        sample.pcm.copy(echo, Math.min(120 * 192, echo.length), 0, Math.max(0, echo.length - 120 * 192));
        const variants = { quiet: sample.pcm,
            keyboard: mixAtSnr(sample.pcm, noisePcm("keyboard", sample.pcm.length / 4)),
            fan: mixAtSnr(sample.pcm, noisePcm("fan", sample.pcm.length / 4)),
            hiss: mixAtSnr(sample.pcm, noisePcm("hiss", sample.pcm.length / 4)),
            "speaker-echo": mixAtSnr(sample.pcm, echo, 12),
            "background-speech": mixAtSnr(sample.pcm, background, 12) };
        for (const [condition, pcm] of Object.entries(variants)) {
            cases.push({ id: `${sample.name}/${condition}`, source: "synthetic", conditions: [condition],
                expectedWake: sample.expected, referenceText: sample.referenceText, pcm });
        }
    }
    for (const kind of ["keyboard", "fan", "hiss"]) {
        cases.push({ id: `${kind}-only`, source: "synthetic", conditions: [kind], expectedWake: false,
            pcm: noisePcm(kind, 3 * 48_000) });
    }
    return cases;
}
