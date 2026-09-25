import "dotenv/config";
import { ApplicationCommandType, REST, Routes, type RESTGetAPIApplicationCommandsResult } from "discord.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !clientId) {
    throw new Error("Set DISCORD_TOKEN and DISCORD_CLIENT_ID to remove legacy slash commands.");
}

// One-time migration only. Prefix commands need no registration or synchronization.
const legacyNames = new Set(["ping", "join", "leave", "play", "playtest", "pluh"]);
const rest = new REST({ version: "10" }).setToken(token);
for (const scope of [undefined, ...(guildId ? [guildId] : [])]) {
    const route = scope ? Routes.applicationGuildCommands(clientId, scope) : Routes.applicationCommands(clientId);
    const commands = await rest.get(route) as RESTGetAPIApplicationCommandsResult;
    for (const command of commands) {
        if (command.type === ApplicationCommandType.ChatInput && legacyNames.has(command.name)) {
            await rest.delete(scope
                ? Routes.applicationGuildCommand(clientId, scope, command.id)
                : Routes.applicationCommand(clientId, command.id));
            console.log(`Removed /${command.name} (${scope ?? "global"}).`);
        }
    }
}
