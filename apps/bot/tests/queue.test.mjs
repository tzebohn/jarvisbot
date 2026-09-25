import assert from "node:assert/strict";
import { test } from "node:test";
import { MusicQueue } from "../src/music/Queue.ts";

const first = { id: "1", title: "First", artist: "Artist", source: "youtube", url: "https://example.com/1" };
const second = { ...first, id: "2", title: "Second" };

test("the queue is FIFO, with a non-consuming peek and safe empty operations", () => {
    const queue = new MusicQueue();
    assert.equal(queue.next(), undefined);
    assert.equal(queue.peek(), undefined);
    queue.add(first);
    queue.add(second);
    assert.equal(queue.peek(), first);
    assert.equal(queue.size, 2);
    assert.equal(queue.next(), first);
    assert.equal(queue.next(), second);
    assert.equal(queue.size, 0);
    assert.equal(queue.next(), undefined);
});

test("queue snapshots cannot be used to reorder or remove pending tracks", () => {
    const queue = new MusicQueue();
    queue.add(first);
    queue.add(second);
    const snapshot = queue.all;
    snapshot.reverse();
    snapshot.pop();
    assert.deepEqual(queue.all, [first, second]);
    queue.clear();
    assert.equal(queue.size, 0);
    assert.equal(queue.peek(), undefined);
    assert.deepEqual(snapshot, [second]);
});

test("repeated tracks are independent queue entries and queues do not share state", () => {
    const queue = new MusicQueue();
    const other = new MusicQueue();
    queue.add(first);
    queue.add(first);
    other.add(second);
    assert.equal(queue.next(), first);
    assert.equal(queue.next(), first);
    queue.clear();
    assert.equal(other.next(), second);
});
