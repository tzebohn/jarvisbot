import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as discord from "discord.js";

test("legacy cleanup removes only this bot's old chat commands in global and configured guild scopes", async (context) => {
    const previous = { ...process.env };
    process.env.DISCORD_TOKEN = "test-token";
    process.env.DISCORD_CLIENT_ID = "test-application";
    process.env.DISCORD_GUILD_ID = "test-guild";
    context.after(() => {
        for (const key of ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID"]) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key];
        }
    });
    context.mock.method(console, "log", () => {});
    const removed = [];
    const fetched = [];
    class REST {
        setToken(token) { assert.equal(token, "test-token"); return this; }
        async get(route) {
            fetched.push(route);
            return [
                ...["join", "leave", "play", "ping", "playtest", "pluh"].map((name) => ({ id: name, name, type: 1 })),
                { id: "unrelated", name: "admin", type: 1 },
                { id: "context-menu", name: "play", type: 3 },
            ];
        }
        async delete(route) { removed.push(route); }
    }
    mock.module("dotenv/config", { namedExports: {} });
    mock.module("discord.js", { namedExports: { ...discord, REST } });
    await import("../src/removeLegacyCommands.ts");
    const { Routes } = discord;
    assert.deepEqual(fetched, [Routes.applicationCommands("test-application"),
        Routes.applicationGuildCommands("test-application", "test-guild")]);
    assert.equal(removed.length, 12);
    assert.ok(removed.includes(Routes.applicationGuildCommand("test-application", "test-guild", "play")));
    assert.ok(removed.includes(Routes.applicationCommand("test-application", "play")));
    assert.ok(removed.every((route) => !route.includes("unrelated") && !route.includes("context-menu")));
});
