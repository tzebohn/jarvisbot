// Protocol fixture only: exercises subprocess lifecycle without a model or Python dependency.
import { createInterface } from "node:readline";
process.stdout.write('{"type":"ready"}\n');
createInterface({ input: process.stdin }).on("line", (line) => {
    const { id, wav } = JSON.parse(line);
    const sample = Buffer.from(wav, "base64").readInt16LE(44);
    if (sample === 2) return; // Hung inference, cancelled by the parent.
    if (sample === 3) { process.stdout.write("malformed-json\n"); return; }
    if (sample === 4) { process.exit(1); }
    const finish = () => process.stdout.write(JSON.stringify({ type: "result", id, text: `Jarvis play ${sample}`,
        language: "en", segments: [{ avg_logprob: -0.3 }] }) + "\n");
    if (sample === 1) setTimeout(finish, 50);
    else finish();
});
