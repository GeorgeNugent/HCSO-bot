/**
 * Utilities for triggering administrative bot actions from the dashboard.
 */
import { ActivityType } from "discord.js";

const ACTIVITY_TYPE_MAP = {
    watching:  ActivityType.Watching,
    listening: ActivityType.Listening,
    playing:   ActivityType.Playing,
    competing: ActivityType.Competing,
    streaming: ActivityType.Streaming
};

/**
 * Change the bot's presence from the dashboard.
 * @param {import("discord.js").Client} client
 * @param {{ status: string, activityType?: string, activityName?: string }} opts
 */
export async function setBotStatus(client, { status = "online", activityType, activityName } = {}) {
    const activities = activityType && activityName
        ? [{ name: activityName, type: ACTIVITY_TYPE_MAP[activityType.toLowerCase()] ?? ActivityType.Watching }]
        : [];
    await client.user.setPresence({ status, activities });
}
