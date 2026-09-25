import "dotenv/config";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, copyFile, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { MODEL_NAME, MODEL_URL, MODEL_FILES, DEFAULT_MODEL_DIRECTORY, buildWakeKeywords, wakeModelPaths } from "../src/voice/wake/wakeModel.ts";

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== "--keywords-only")) throw new Error("Usage: setup:wake [--keywords-only]");
const directory = process.env.VOICE_WAKE_MODEL_DIR?.trim() || DEFAULT_MODEL_DIRECTORY;
if (args.includes("--keywords-only")) {
    // Existing installs can update the small keyword file offline, without downloading the model again.
    const paths = wakeModelPaths(directory);
    const keywords = buildWakeKeywords(await readFile(paths.tokens, "utf8"));
    for (const file of Object.values(MODEL_FILES)) {
        if (!(await stat(join(directory, file))).isFile() || (await stat(join(directory, file))).size === 0) throw new Error(`Missing/empty model file: ${file}. Run setup:wake first.`);
    }
    await writeFile(paths.keywords, keywords, "utf8");
    console.log(`Validated Jarvis pronunciations written to ${paths.keywords}`);
} else {
    await mkdir(directory, { recursive: true });
    const temporary = await mkdtemp(join(directory, ".download-"));
    try {
        console.log(`Downloading the local wake model from ${MODEL_URL}`);
        const response = await fetch(MODEL_URL, { signal: AbortSignal.timeout(120_000) });
        if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
        const archive = join(temporary, "model.tar.bz2");
        await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: "wx" }));
        // Extract only named model files from this fixed upstream archive.
        await new Promise((resolve, reject) => {
            const child = spawn("tar", ["-xf", archive, "-C", temporary,
                ...Object.values(MODEL_FILES).map((file) => `${MODEL_NAME}/${file}`)], { shell: false, stdio: "inherit" });
            child.once("error", () => reject(new Error("Model setup needs tar on PATH (included with modern Windows and most Linux/macOS installs).")));
            child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Model extraction failed (${code}).`)));
        });
        const extracted = join(temporary, MODEL_NAME);
        const keywords = buildWakeKeywords(await readFile(join(extracted, MODEL_FILES.tokens), "utf8"));
        for (const file of Object.values(MODEL_FILES)) {
            if ((await stat(join(extracted, file))).size === 0) throw new Error(`Empty model file: ${file}`);
            await copyFile(join(extracted, file), join(directory, file));
        }
        await writeFile(wakeModelPaths(directory).keywords, keywords, "utf8");
        console.log(`Wake model ready in ${directory}`);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
