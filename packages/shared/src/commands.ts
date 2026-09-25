/** Input-independent commands supported by the initial voice parser. */
export type MusicCommand =
    | { type: "play"; query: string }
    | { type: "pause" }
    | { type: "resume" }
    | { type: "skip" }
    | { type: "queue" }
    | { type: "stop" }
    | { type: "leave" };
