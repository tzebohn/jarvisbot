import { fileURLToPath } from "node:url";
import { createAudioResource } from "@discordjs/voice";

const testAudioPath = fileURLToPath(new URL("../../assets/test.mp3", import.meta.url));

export function createTestAudioResource() {
    return createAudioResource(testAudioPath);
}
