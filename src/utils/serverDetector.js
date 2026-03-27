/**
 * Server / guild → department detection helpers.
 * Everything is driven from src/config/departments.json so departments
 * can be added without code changes.
 */
import { getAllDepartments, getBranding } from "../embeds/departmentThemes.js";

/**
 * Return the full department config for a guild, or null if not registered.
 * @param {string|null} guildId
 * @returns {{ name, shortName, color, footer, description } | null}
 */
export function detectDepartment(guildId) {
    if (!guildId) return null;
    const depts = getAllDepartments();
    return depts[guildId] ?? null;
}

/** Department name, falling back to the community name from branding.json. */
export function getDepartmentName(guildId) {
    const dept = detectDepartment(guildId);
    return dept ? dept.name : getBranding().fallback.name;
}

/** Hex color string (#RRGGBB) for a guild. */
export function getDepartmentColor(guildId) {
    const dept = detectDepartment(guildId);
    return dept ? dept.color : getBranding().defaultColor;
}
