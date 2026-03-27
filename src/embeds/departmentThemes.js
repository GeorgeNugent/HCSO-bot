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

function normalize(input) {
    return String(input || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function findByShortName(departments, shortName) {
    const target = String(shortName || "").toUpperCase();
    return Object.values(departments).find(d => String(d?.shortName || "").toUpperCase() === target) || null;
}

function inferDepartmentFromGuildName(guildName, departments) {
    const normalizedName = normalize(guildName);
    if (!normalizedName) return null;

    const hasCpdHints = normalizedName.includes("cpd")
        || normalizedName.includes("clewiston")
        || (normalizedName.includes("police") && normalizedName.includes("department"));
    if (hasCpdHints && !normalizedName.includes("highway patrol")) {
        return findByShortName(departments, "CPD");
    }

    const hasFhpHints = normalizedName.includes("fhp")
        || (normalizedName.includes("highway") && normalizedName.includes("patrol"))
        || normalizedName.includes("state patrol")
        || normalizedName.includes("florida highway");
    if (hasFhpHints) {
        return findByShortName(departments, "FHP");
    }

    const hasHcsoHints = normalizedName.includes("hcso")
        || normalizedName.includes("hendry")
        || normalizedName.includes("sheriff office")
        || normalizedName.includes("sheriffs office");
    if (hasHcsoHints) {
        return findByShortName(departments, "HCSO");
    }

    return null;
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

/**
 * Resolve department metadata for a guild using ID first, then known name patterns.
 * @param {{ id?: string, name?: string } | string | null} guildOrId
 * @returns {object|null}
 */
export function resolveDepartmentForGuild(guildOrId) {
    const depts = load(DEPARTMENTS_PATH);
    const guildId = typeof guildOrId === "string" ? guildOrId : String(guildOrId?.id || "");
    const guildName = typeof guildOrId === "string" ? "" : String(guildOrId?.name || "");

    if (guildId && depts[guildId]) return depts[guildId];

    return inferDepartmentFromGuildName(guildName, depts);
}

/** Return the full departments map keyed by server ID. */
export function getAllDepartments() {
    return load(DEPARTMENTS_PATH);
}

/** Return the global branding config. */
export function getBranding() {
    return load(BRANDING_PATH);
}
