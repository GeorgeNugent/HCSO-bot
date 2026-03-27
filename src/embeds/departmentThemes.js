/**
 * Department theme loader.
 * All department data is read from src/config/departments.json so you can
 * add or edit departments without touching code.
 */
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEPARTMENTS_PATH = join(__dirname, "../config/departments.json");
const BRANDING_PATH    = join(__dirname, "../config/branding.json");

function load(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Return the theme for a guild.
 * Falls back to branding.json#fallback for unknown servers.
 * @param {string|null} guildId
 * @returns {{ name, shortName, color, footer, description }}
 */
export function getTheme(guildId) {
    const depts  = load(DEPARTMENTS_PATH);
    const brand  = load(BRANDING_PATH);
    return (guildId && depts[guildId]) ? depts[guildId] : brand.fallback;
}

/** Return the full departments map keyed by server ID. */
export function getAllDepartments() {
    return load(DEPARTMENTS_PATH);
}

/** Return the global branding config. */
export function getBranding() {
    return load(BRANDING_PATH);
}
