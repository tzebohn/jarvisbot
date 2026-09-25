import assert from "node:assert/strict";
import { test } from "node:test";
import { describePlaybackError, sanitizeDiagnostic } from "../src/music/playbackDiagnostics.ts";

test("diagnostics preserve nested system causes but remove signed URLs and credentials", (context) => {
    const previous = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = "example-secret-api-key";
    context.after(() => {
        if (previous === undefined) delete process.env.YOUTUBE_API_KEY;
        else process.env.YOUTUBE_API_KEY = previous;
    });
    const cause = Object.assign(new Error("read failed: https://media.example/audio?sig=private example-secret-api-key"), { code: "ECONNRESET" });
    const error = new Error("Audio failed", { cause });
    const description = describePlaybackError(error);
    assert.equal(description.cause.code, "ECONNRESET");
    const logged = JSON.stringify(description);
    assert.ok(!logged.includes("sig=private"));
    assert.ok(!logged.includes("example-secret-api-key"));
    assert.match(sanitizeDiagnostic("\u001b[31mCookie: private\nAuthorization: Bearer token\u001b[0m"), /^Cookie: \[redacted\]\nAuthorization: \[redacted\]$/);
});

test("cyclic causes are bounded rather than crashing failure reporting", () => {
    const error = new Error("cyclic");
    error.cause = error;
    const result = describePlaybackError(error);
    assert.doesNotThrow(() => JSON.stringify(result));
});
