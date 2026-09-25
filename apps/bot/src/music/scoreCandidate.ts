import type { TrackCandidate } from "@discord-music-platform/shared";

export function normalizeQuery(value: string): string {
    return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function clean(value: string): string {
    return normalizeQuery(value).replace(/\b(?:official(?: music)? (?:audio|video)|official|lyrics?|hd|hq|4k(?: upgrade)?)\b/g, " ")
        .trim().replace(/\s+/g, " ");
}

function similarity(query: string, value: string): number {
    const wanted = new Set(clean(query).split(" ").filter(Boolean));
    const actual = new Set(clean(value).split(" ").filter(Boolean));
    if (!wanted.size || !actual.size) {
        return 0;
    }
    const matches = [...wanted].filter((token) => actual.has(token)).length;
    // Coverage matters most, but additional title words lower confidence too.
    return 0.8 * matches / wanted.size + 0.2 * matches / actual.size;
}

const versions = ["live", "remix", "acoustic", "instrumental", "cover", "karaoke", "sped up", "slowed", "extended"];

/** Initial lexical scoring; retains version intent rather than trusting API order. */
export function scoreCandidate(query: string, candidate: TrackCandidate): TrackCandidate {
    const { title, artist } = candidate.track;
    const by = /^(.+?)\s+by\s+(.+)$/i.exec(query.trim());
    const separated = /^(.+?)\s+[-–—]\s+(.+)$/.exec(query.trim());
    let confidence: number;
    if (by) {
        confidence = Math.max(
            0.65 * similarity(by[1], title) + 0.35 * similarity(by[2], artist),
            similarity(query, title), // "Stand by Me" can itself be the whole title.
        );
    } else if (separated) {
        confidence = 0.65 * similarity(separated[2], title) + 0.35 * similarity(separated[1], artist);
    } else {
        confidence = Math.max(similarity(query, title), similarity(query, `${title} ${artist}`));
    }
    const normalizedQuery = ` ${normalizeQuery(query)} `;
    const normalizedTitle = ` ${normalizeQuery(title)} `;
    for (const version of versions) {
        const requested = normalizedQuery.includes(` ${version} `);
        const present = normalizedTitle.includes(` ${version} `);
        if (requested !== present) {
            confidence -= requested ? 0.4 : 0.25;
        }
    }
    // Reserve room for the official-label signal, so a perfect lyric upload
    // cannot tie an equally good official result merely due to score clamping.
    confidence = confidence * 0.95 + (/\bofficial\b/i.test(title) ? 0.05 : 0);
    return { ...candidate, confidence: Math.min(1, Math.max(0, confidence)) };
}
