/**
 * Gather live statistics for all guilds the bot is in.
 * Used by the /servers overview and /departments/:guildId pages.
 */
import { getAllDepartments, getBranding } from "../embeds/departmentThemes.js";

/**
 * @param {import("discord.js").Client} client
 */
export function createServerStats(client) {
    /** Return a summary row for every guild the bot is in. */
    async function getAllServers() {
        const departments = getAllDepartments();
        const branding    = getBranding();
        const servers     = [];

        for (const [guildId, guild] of client.guilds.cache) {
            const dept = departments[guildId] ?? null;
            servers.push({
                id:          guildId,
                name:        guild.name,
                memberCount: guild.memberCount,
                online:      true,
                department:  dept ? dept.name   : branding.fallback.name,
                shortName:   dept ? dept.shortName : branding.fallback.shortName,
                color:       dept ? dept.color  : branding.defaultColor,
                footer:      dept ? dept.footer : branding.fallback.footer,
                logo:        dept?.logo ?? null,
                icon:        guild.iconURL({ size: 64 }) ?? null
            });
        }

        return servers.sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Return detailed info for a single guild. */
    async function getServerDetail(guildId) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return null;

        try { await guild.members.fetch(); } catch { /* non-fatal */ }

        const departments = getAllDepartments();
        const branding    = getBranding();
        const dept        = departments[guildId] ?? null;

        return {
            id:          guildId,
            name:        guild.name,
            memberCount: guild.memberCount,
            online:      true,
            department:  dept ? dept.name   : branding.fallback.name,
            shortName:   dept ? dept.shortName : branding.fallback.shortName,
            color:       dept ? dept.color  : branding.defaultColor,
            footer:      dept ? dept.footer : branding.fallback.footer,
            description: dept?.description ?? "",
            logo:        dept?.logo ?? null,
            icon:        guild.iconURL({ size: 128 }) ?? null
        };
    }

    return { getAllServers, getServerDetail };
}
