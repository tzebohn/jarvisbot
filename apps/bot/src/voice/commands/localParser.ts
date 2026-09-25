import type { MusicCommand } from "@discord-music-platform/shared";
import { normalizeTranscript } from "../transcription/normalizeTranscript.js";
import type { ParsedVoiceCommand, ParseReason } from "./types.js";

export const MAX_COMMAND_TEXT_LENGTH = 1_000;
export const MAX_PLAY_QUERY_LENGTH = 500;

export type LocalParseResult =
    | { command: ParsedVoiceCommand; reason: ParseReason }
    | { text: string }; // Only an uncertain result is eligible for cloud interpretation.

const controls: [Exclude<MusicCommand["type"], "play">, RegExp][] = [
    ["pause", /^(?:pause(?: (?:it|(?:the |this |current )?(?:music|song|track|playback)))?|paws (?:the )?music|hold the music)$/i],
    ["resume", /^(?:(?:resume|unpause)(?: (?:it|(?:the )?(?:music|song|track|playback)))?|continue(?: (?:playing|(?:the )?(?:music|song|track|playback)))?|start (?:the music |playing )?again)$/i],
    ["skip", /^(?:skip(?: (?:it|this|(?:the |this |current )?(?:song|track|one)))?|next(?: (?:song|track))?|(?:go|move) to (?:the )?next (?:song|track)|play the next (?:song|track))$/i],
    ["queue", /^(?:(?:queue|cue)|(?:show|list)(?: me)? (?:the )?(?:queue|cue)|what(?:'s| is) (?:in|on) (?:the )?(?:queue|cue)|what(?:'s| is) (?:up next|next|coming up))$/i],
    ["stop", /^stop(?: (?:it|playing|playback|(?:the |this |current )?(?:music|song|track)))?$/i],
    ["leave", /^(?:leave(?: (?:the |this |current )?(?:voice )?channel)?|disconnect(?: from (?:the |this |current )?(?:voice )?channel)?)$/i],
];

const unsupported = /^(?:(?:shuffle|repeat|loop|seek|rewind|remove|delete|join|volume|mute|unmute|lyrics|search)\b|(?:turn|set) (?:the )?volume\b|(?:clear|empty) (?:the )?queue\b|(?:now playing|what(?:'s| is) playing)\b)/i;
const joinedCommand = /(?:\b(?:and(?: then)?|then|or)\b|;|[.!?]\s)\s*(?:please\s+)?(?:play|put on|pause|resume|unpause|skip|stop|shuffle|loop|repeat|leave|disconnect|join|remove|clear|show|list|tell|turn|set|queue)\b/i;

function reject(reason: ParseReason): LocalParseResult { return { command: { type: "unknown" }, reason }; }

/** Query text is opaque: never fuzzy-correct names or remove version/artist words. */
export function validPlayQuery(query: string): boolean {
    return query.length > 0 && query.length <= MAX_PLAY_QUERY_LENGTH && /[\p{L}\p{N}]/u.test(query)
        && !/^(?:it(?: again)?|this(?: one)?|that(?: one)?|something|anything|some music|music|a song|a track|the song|the track|the music|please)$/i.test(query);
}

/** Whole-utterance grammar, not keyword searching: "don't skip" is never "skip". */
export function parseLocalCommand(input: unknown): LocalParseResult {
    if (typeof input !== "string" || input.length > MAX_COMMAND_TEXT_LENGTH
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input)) return reject("invalid-input");
    const text = normalizeTranscript(input);
    if (text.length > MAX_COMMAND_TEXT_LENGTH) return reject("invalid-input");
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return reject("empty");
    // Limited wrappers preserve the remainder (especially song titles).
    const request = text.replace(/^(?:please[, ]+)?(?:(?:can|could|would|will) you )?(?:please[, ]+|kindly )?/i, "").trim();
    if (/^(?:don't|do not|never|not|no|if|unless|when)\b/i.test(request)) return reject("negated");
    // V5 removes a final quote, so accept both forms of an explicitly quoted query.
    // Full anchoring prevents a trailing second action from hiding behind a quoted title.
    const quotedPlay = /^(?:play|put on|queue up)\s+"([^"\n]+?)(?:"(?:,? please)?)?$/i.exec(request);
    if (quotedPlay) {
        const query = quotedPlay[1].trim();
        return validPlayQuery(query) ? { command: { type: "play", query }, reason: "matched" } : reject("missing-query");
    }
    if (joinedCommand.test(request)) return reject("multiple-commands");
    const control = request.replace(/(?:,? (?:please|thanks|thank you|for me))+$/i, "").trim();
    for (const [type, pattern] of controls) {
        if (pattern.test(control)) return { command: { type }, reason: "matched" };
    }
    if (unsupported.test(request)) return reject("unsupported");
    if (/^(?:play|put on|queue up)$/i.test(control)) return reject("missing-query");
    const play = /^(?:play|put on|queue up)\s+(.+)$/i.exec(request)
        ?? /^add\s+(.+?)\s+to (?:the )?queue$/i.exec(control);
    if (play) {
        // These modifiers may describe a second/future action rather than a song title.
        // Let the fallback disambiguate instead of greedily treating the whole sentence as a query.
        if (/\b(?:if|unless|after this|after the|when this|when the|in \d+ (?:seconds?|minutes?))\b/i.test(play[1])) return { text };
        // Unpunctuated "please"/"for me" may be part of a title (e.g. Say Please).
        // Do not confidently truncate a title; let the fallback interpret that ambiguity.
        if (/(?<!,) (?:please|for me)$/i.test(play[1])) return { text };
        const query = play[1].replace(/, (?:please|for me)$/i, "").trim();
        if (!validPlayQuery(query)) return reject("missing-query");
        return { command: { type: "play", query }, reason: "matched" };
    }
    return { text };
}
