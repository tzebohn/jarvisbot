import type { Track } from "@discord-music-platform/shared";

// Defaults to domain tracks; the player queues tracks together with their audio inputs.
export class MusicQueue<T = Track> {
    private tracks: T[] = [];

    add(track: T) {
        this.tracks.push(track);
    }

    next(): T | undefined {
        return this.tracks.shift();
    }

    peek(): T | undefined {
        return this.tracks[0];
    }

    clear() {
        this.tracks = [];
    }

    shuffle(): void {
        for (let index = this.tracks.length - 1; index > 0; index--) {
            const other = Math.floor(Math.random() * (index + 1));
            [this.tracks[index], this.tracks[other]] = [this.tracks[other], this.tracks[index]];
        }
    }

    get size() {
        return this.tracks.length;
    }

    get all() {
        return [...this.tracks];
    }
}
