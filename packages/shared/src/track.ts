export type MusicSource =
  | "spotify"
  | "youtube"
  | "soundcloud";

export interface Track {
  id: string;

  title: string;
  artist: string;

  album?: string;
  duration?: number;
  thumbnail?: string;

  source: MusicSource;
  url: string;
}

export interface TrackCandidate {
  track: Track;
  confidence: number;
  provider: MusicSource;
}
