import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildWakeKeywords, validateWakeKeywords, getWakePronunciation, WAKE_PRONUNCIATIONS,
    WAKE_KEYWORD, WAKE_TOKENS, wakeModelPaths } from "../src/voice/wake/wakeModel.ts";

// Relevant entries from the installed model, including its actual numeric token IDs.
const vocabulary = "<blk> 0\nAA1 4\nAE1 7\nAH0 9\nIH0 37\nJH 43\nR 56\nS 57\nV 67\n";

test("keyword generation rejects unsupported phones before producing a configuration", () => {
    assert.throws(() => buildWakeKeywords(vocabulary.replace("IH0 37\n", "")), /missing IH0/);
    assert.throws(() => buildWakeKeywords(vocabulary.replace("R 56\n", "")), /missing R/);
    assert.doesNotThrow(() => buildWakeKeywords(vocabulary.replace("AE1 7\n", "")), "fronted vowel is no longer required");
    assert.throws(() => buildWakeKeywords(""), /missing JH/);
    assert.doesNotThrow(() => validateWakeKeywords(buildWakeKeywords(vocabulary), vocabulary));
});

test("runtime allows formatting differences but rejects old, loose, or retuned keyword files", () => {
    const keywords = buildWakeKeywords(vocabulary);
    assert.doesNotThrow(() => validateWakeKeywords(keywords.replaceAll(" ", "  ").replaceAll("\n", "\r\n"), vocabulary));
    for (const invalid of [`${WAKE_TOKENS.join(" ")} @${WAKE_KEYWORD}`, keywords + "JH AA1 R @JAR\n",
        keywords + "JH AA1 V IH0 S @JARVIS_NON_RHOTIC_IH\n",
        keywords + "JH AE1 R V IH0 S @JARVIS_FRONTED_RHOTIC\n",
        keywords.replace("JH AA1 R V AH0 S", "JH AA1 R V AH0"), keywords.replace("@JARVIS\n", "@JARVIS :5 #0.01\n")]) {
        assert.throws(() => validateWakeKeywords(invalid, vocabulary), /setup:wake --keywords-only/);
    }
});

test("American paths retain the canonical primary and vary only the unstressed second vowel", () => {
    assert.equal(WAKE_PRONUNCIATIONS.length, 2);
    assert.deepEqual(WAKE_TOKENS, ["JH", "AA1", "R", "V", "AH0", "S"]);
    assert.equal(WAKE_PRONUNCIATIONS[0].keyword, WAKE_KEYWORD);
    assert.equal(new Set(WAKE_PRONUNCIATIONS.map(({ keyword }) => keyword)).size, 2);
    assert.equal(new Set(WAKE_PRONUNCIATIONS.map(({ tokens }) => tokens.join(" "))).size, 2);
    for (const pronunciation of WAKE_PRONUNCIATIONS) {
        assert.equal(getWakePronunciation(pronunciation.keyword)?.id, pronunciation.id);
        assert.deepEqual(pronunciation.tokens.slice(0, 4), ["JH", "AA1", "R", "V"]);
        assert.ok(["AH0", "IH0"].includes(pronunciation.tokens[4]));
        assert.equal(pronunciation.tokens.at(-1), "S");
        assert.ok(pronunciation.tokens.includes("V"));
        assert.equal(pronunciation.tokens.filter((token) => /\d$/.test(token)).length, 2);
    }
    for (const keyword of ["Jarvis", "jarvis", "JAR", "JARVIS_ANYTHING", "JERVIS", "TRAVIS",
        "JARVIS_NON_RHOTIC_SCHWA", "JARVIS_NON_RHOTIC_IH", "JARVIS_FRONTED_RHOTIC"]) {
        assert.equal(getWakePronunciation(keyword), undefined, "only exact reviewed native labels are accepted");
    }
});

test("installed keyword file is reproducible from the installed vocabulary", async (context) => {
    const paths = wakeModelPaths();
    let tokens, keywords;
    try { [tokens, keywords] = await Promise.all([readFile(paths.tokens, "utf8"), readFile(paths.keywords, "utf8")]); }
    catch (error) {
        if (error.code === "ENOENT") { context.skip("Run setup:wake for installed vocabulary verification"); return; }
        throw error;
    }
    validateWakeKeywords(keywords, tokens);
    assert.equal(keywords.replaceAll("\r\n", "\n"), buildWakeKeywords(tokens));
});
