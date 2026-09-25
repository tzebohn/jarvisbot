import { WAKE_PHRASE } from "../wake/wakeModel.js";

/** Strip only leading exact wake phrases; preserve song/artist punctuation and interior mentions. */
export function normalizeTranscript(raw: string, wakePhrase = WAKE_PHRASE): string {
    let text = raw.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
        .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
    const phrase = wakePhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const leadingWake = new RegExp(`^(?:hey\\s+)?${phrase}(?=$|[\\s,.:;!?-])[\\s,.:;!?-]*`, "iu");
    text = text.replace(/^[\s"'.,:;!?-]+/u, "");
    while (leadingWake.test(text)) text = text.replace(leadingWake, "").replace(/^[\s"'.,:;!?-]+/u, "");
    return text.replace(/\s+([,.:;!?])/g, "$1").replace(/[\s"'.,:;!?]+$/u, "").trim();
}
