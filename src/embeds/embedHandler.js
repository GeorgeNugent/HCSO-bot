/**
 * Embed builder that automatically applies department branding.
 * Use createDepartmentEmbed(guildId, options) instead of EmbedBuilder
 * directly whenever you want consistent department colours and footers.
 */
import { EmbedBuilder } from "discord.js";
import { getTheme } from "./departmentThemes.js";

/**
 * Build a branded EmbedBuilder for the given guild.
 * @param {string|null} guildId
 * @param {{
 *   title?:       string,
 *   description?: string,
 *   fields?:      import("discord.js").APIEmbedField[],
 *   thumbnail?:   string,
 *   image?:       string,
 *   timestamp?:   boolean
 * }} opts
 * @returns {EmbedBuilder}
 */
export function createDepartmentEmbed(guildId, opts = {}) {
    const theme  = getTheme(guildId);
    const hex    = parseInt(theme.color.replace("#", ""), 16);

    const embed = new EmbedBuilder()
        .setColor(hex)
        .setFooter({ text: theme.footer || theme.name });

    if (opts.title)        embed.setTitle(opts.title);
    if (opts.description)  embed.setDescription(opts.description);
    if (opts.thumbnail)    embed.setThumbnail(opts.thumbnail);
    if (opts.image)        embed.setImage(opts.image);
    if (opts.timestamp)    embed.setTimestamp();
    if (opts.fields?.length) embed.addFields(opts.fields);

    return embed;
}

/** Numeric color value for the given guild (Discord-ready). */
export function getDepartmentColor(guildId) {
    return parseInt(getTheme(guildId).color.replace("#", ""), 16);
}

/** Human-readable department name for the given guild. */
export function getDepartmentName(guildId) {
    return getTheme(guildId).name;
}
