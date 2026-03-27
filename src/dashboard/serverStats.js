/**
 * Gather live statistics for all guilds the bot is in.
 * Used by the /servers overview and /departments/:guildId pages.
 */
import { getBranding, resolveDepartmentForGuild } from "../embeds/departmentThemes.js";

/**
 * @param {import("discord.js").Client} client
 */
export function createServerStats(client) {
    async function getGuildById(guildId) {
        return client.guilds.cache.get(guildId)
            || await client.guilds.fetch(guildId).catch(() => null);
    }

    async function getAllGuildRefs() {
        return await client.guilds.fetch().catch(() => client.guilds.cache);
    }

    /** Return a summary row for every guild the bot is in. */
    async function getAllServers() {
        const branding    = getBranding();
        const servers     = [];

        const guildRefs = await getAllGuildRefs();

        for (const [, guildRef] of guildRefs) {
            const guildId = String(guildRef.id);
            const guild = await getGuildById(guildId);
            if (!guild) continue;

            const dept = resolveDepartmentForGuild({ id: guildId, name: guild.name }) ?? null;
            servers.push({
                id:          guildId,
                name:        guild.name,
                memberCount: guild.memberCount,
                online:      true,
                departmentType: dept?.type || "unknown",
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
        const guild = await getGuildById(guildId);
        if (!guild) return null;

        try { await guild.members.fetch(); } catch { /* non-fatal */ }

        const branding    = getBranding();
        const dept        = resolveDepartmentForGuild({ id: guildId, name: guild.name }) ?? null;

        return {
            id:          guildId,
            name:        guild.name,
            memberCount: guild.memberCount,
            online:      true,
            departmentType: dept?.type || "unknown",
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
