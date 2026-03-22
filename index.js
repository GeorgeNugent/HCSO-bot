import "dotenv/config";
import { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActivityType, ChannelType, AuditLogEvent } from "discord.js";
import fs from "fs";
import http from "node:http";
import path from "node:path";

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const PORT = Number(process.env.PORT) || 10000;

if (!TOKEN || !CLIENT_ID) {
    console.error("Missing required configuration. Set TOKEN and CLIENT_ID in environment variables or a .env file.");
    process.exit(1);
}

const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Bot is running");
});

healthServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Health server listening on 0.0.0.0:${PORT}`);
});

process.on("unhandledRejection", error => {
    console.error("Unhandled promise rejection:", error);
});

process.on("uncaughtException", error => {
    console.error("Uncaught exception:", error);
});

const PROJECT_ROOT = process.cwd();
const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : PROJECT_ROOT;
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDataFilePath(fileName) {
    return path.join(DATA_DIR, fileName);
}

function ensureJsonDataFile(fileName, fallbackValue) {
    const targetPath = getDataFilePath(fileName);
    if (fs.existsSync(targetPath)) {
        return targetPath;
    }

    const sourcePath = path.join(PROJECT_ROOT, fileName);
    if (targetPath !== sourcePath && fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, targetPath);
        return targetPath;
    }

    fs.writeFileSync(targetPath, JSON.stringify(fallbackValue, null, 2));
    return targetPath;
}

function readJsonData(fileName, fallbackValue) {
    const filePath = ensureJsonDataFile(fileName, fallbackValue);
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonData(fileName, value) {
    fs.writeFileSync(getDataFilePath(fileName), JSON.stringify(value, null, 2));
}

// Load strike data
const strikes = readJsonData("strikes.json", {});

// Load patrol data
const patrols = readJsonData("patrols.json", {});

// Load LOA data
const loa = readJsonData("loa.json", {});

// Load case data
const casesData = readJsonData("cases.json", { cases: {} });

// Load reports data
const reports = readJsonData("reports.json", {});

// Load tickets data
let tickets = readJsonData("tickets.json", { tickets: {} });

// Initialize userRemoved field for existing tickets that don't have it
if (tickets.tickets) {
    Object.values(tickets.tickets).forEach(ticket => {
        if (!ticket.hasOwnProperty('userRemoved')) {
            ticket.userRemoved = false;
        }
    });
}

// Load notes data
let notesData = readJsonData("notes.json", { notes: {} });

// Load commendations data
let commendationsData = readJsonData("commendations.json", {});

// Load config data
let config = readJsonData("config.json", {});

// Initialize config if needed
if (!config.logChannels) {
    config.logChannels = {};
}
if (!config.statusRoles) {
    config.statusRoles = [];
}
if (!config.ticketCounter) {
    config.ticketCounter = 0;
}
if (!config.moduleRoleAccess) {
    config.moduleRoleAccess = {
        patrol: [],
        cases: [],
        ia: [],
        tickets: [],
        moderation: [],
        training: [],
        logs: [],
        bot: [],
        analytics: [],
        supervisor: []
    };
}
if (!config.ticketCategory) {
    config.ticketCategory = null;
}

function saveStrikes() {
    writeJsonData("strikes.json", strikes);
}

function savePatrols() {
    writeJsonData("patrols.json", patrols);
}

function saveLOA() {
    writeJsonData("loa.json", loa);
}

function saveCases() {
    writeJsonData("cases.json", casesData);
}

function saveReports() {
    writeJsonData("reports.json", reports);
}

function saveTickets() {
    writeJsonData("tickets.json", tickets);
}

function saveNotes() {
    writeJsonData("notes.json", notesData);
}

function saveCommendations() {
    writeJsonData("commendations.json", commendationsData);
}

function saveConfig() {
    writeJsonData("config.json", config);
}

function save() {
    saveStrikes();
    savePatrols();
    saveLOA();
    saveCases();
    saveReports();
    saveTickets();
    saveConfig();
}

const MAX_STRIKES = 3;
const LOG_TYPES = ["patrol", "case", "moderation", "strike", "loa", "transcript", "timeout", "ban", "blacklist", "discord", "commendations"];
const STRIKE_ROLE_IDS = [
    "1485084924921774242",
    "1485084972535648326",
    "1485085025157382244"
];
const STRIKE_ALERT_USER_ID = "967375704486449222";
const TRAINING_CERTIFICATION_ROLES = {
    SWAT: "1482203107956883573",
    CUI: "1482203107940241479",
    K9: "1482203107906551939",
    "TRAFFIC ENFORCEMENT": "1482203107885715618",
    "SPEED ENFORCEMENT": "1482203107873259576",
    "INTERNAL AFFAIRS": "1482203107835514980"
};
const TRAINING_CERTIFICATION_ROLE_IDS = Object.values(TRAINING_CERTIFICATION_ROLES);
const TRAINING_NO_CERT_ROLE_ID = "1482203107956883574";

function getGuildStrikeStore(guildId) {
    if (!guildId) return null;

    if (!strikes[guildId] || typeof strikes[guildId] !== "object" || Array.isArray(strikes[guildId])) {
        strikes[guildId] = {};
    }

    // Migrate old global strike format (top-level user IDs) into this guild store.
    let migrated = false;
    for (const [key, value] of Object.entries(strikes)) {
        if (key === guildId) continue;

        const isLegacyEntry = Array.isArray(value) || (value && typeof value === "object" && Array.isArray(value.strikes));
        if (!isLegacyEntry) continue;

        if (!strikes[guildId][key]) {
            strikes[guildId][key] = Array.isArray(value) ? value : value.strikes;
        }

        delete strikes[key];
        migrated = true;
    }

    if (migrated) {
        saveStrikes();
    }

    return strikes[guildId];
}

function getGuildLogChannels(guildId) {
    if (!config.logChannels) {
        config.logChannels = {};
    }

    if (!guildId) {
        return config.logChannels;
    }

    if (!config.logChannels[guildId] || typeof config.logChannels[guildId] !== "object" || Array.isArray(config.logChannels[guildId])) {
        config.logChannels[guildId] = {};
    }

    return config.logChannels[guildId];
}

function getLogChannelId(guildId, logType) {
    if (!config.logChannels) {
        config.logChannels = {};
    }

    const lookupOrder = {
        moderation: ["moderation", "strike", "ban", "blacklist"],
        strike: ["strike", "moderation"],
        ban: ["ban", "moderation"],
        blacklist: ["blacklist", "moderation"]
    };

    const candidates = lookupOrder[logType] || [logType];

    if (guildId) {
        const guildChannels = getGuildLogChannels(guildId);

        for (const candidate of candidates) {
            if (guildChannels[candidate]) {
                return guildChannels[candidate];
            }
        }
    }

    for (const candidate of candidates) {
        if (config.logChannels[candidate]) {
            return config.logChannels[candidate];
        }
    }

    return null;
}

function setLogChannelId(guildId, logType, channelId) {
    const guildChannels = getGuildLogChannels(guildId);
    guildChannels[logType] = channelId;

    // Keep legacy flat keys populated so older log call sites continue to work.
    config.logChannels[logType] = channelId;

    if (logType === "moderation") {
        guildChannels.strike = channelId;
        guildChannels.ban = channelId;
        guildChannels.blacklist = channelId;

        config.logChannels.strike = channelId;
        config.logChannels.ban = channelId;
        config.logChannels.blacklist = channelId;
    }
}

function truncateForField(value, max = 1024) {
    const text = String(value ?? "");
    if (text.length <= max) return text;
    return `${text.slice(0, max - 3)}...`;
}

function formatRoleMentions(roleIds) {
    if (!roleIds || roleIds.length === 0) return "None";
    return roleIds.map(id => `<@&${id}>`).join(", ");
}

function extractRoleIdsFromAuditValue(auditValue) {
    if (!Array.isArray(auditValue)) return [];
    return auditValue
        .map(role => role?.id)
        .filter(Boolean);
}

function normalizeTrainingCertInput(value) {
    return String(value || "")
        .toUpperCase()
        .replace(/[-_]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function resolveTrainingCertificationRoleId(inputValue) {
    const directInput = String(inputValue || "").trim();
    if (TRAINING_CERTIFICATION_ROLE_IDS.includes(directInput)) {
        return directInput;
    }

    const normalized = normalizeTrainingCertInput(inputValue);
    const aliasToCanonical = {
        "K 9": "K9",
        "K-9": "K9",
        IA: "INTERNAL AFFAIRS",
        INTERNALAFFAIRS: "INTERNAL AFFAIRS",
        TRAFFIC: "TRAFFIC ENFORCEMENT",
        SPEED: "SPEED ENFORCEMENT"
    };

    const canonical = aliasToCanonical[normalized] || normalized;
    return TRAINING_CERTIFICATION_ROLES[canonical] || null;
}

function getTrainingCertificationName(roleId) {
    const entry = Object.entries(TRAINING_CERTIFICATION_ROLES)
        .find(([, id]) => id === roleId);
    return entry ? entry[0] : roleId;
}

async function syncNoTrainingCertificationRole(guild, member, me) {
    const noCertRole = guild.roles.cache.get(TRAINING_NO_CERT_ROLE_ID)
        || await guild.roles.fetch(TRAINING_NO_CERT_ROLE_ID).catch(() => null);

    if (!noCertRole) {
        return { action: "none", warning: `No-cert role not found: ${TRAINING_NO_CERT_ROLE_ID}` };
    }

    if (me.roles.highest.comparePositionTo(noCertRole) <= 0) {
        return { action: "none", warning: `Bot role must be above ${noCertRole.name} (${noCertRole.id})` };
    }

    const hasAnyCert = TRAINING_CERTIFICATION_ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
    const hasNoCertRole = member.roles.cache.has(TRAINING_NO_CERT_ROLE_ID);

    if (hasAnyCert && hasNoCertRole) {
        try {
            await member.roles.remove(TRAINING_NO_CERT_ROLE_ID);
            return { action: "removed", warning: null };
        } catch (error) {
            return { action: "none", warning: `Failed to remove ${noCertRole.name}: ${error.message}` };
        }
    }

    if (!hasAnyCert && !hasNoCertRole) {
        try {
            await member.roles.add(TRAINING_NO_CERT_ROLE_ID);
            return { action: "added", warning: null };
        } catch (error) {
            return { action: "none", warning: `Failed to add ${noCertRole.name}: ${error.message}` };
        }
    }

    return { action: "none", warning: null };
}

async function resolveRoleUpdateActor(guild, targetUserId, changedRoleIds, auditChangeKey) {
    if (!guild || !targetUserId || !changedRoleIds || changedRoleIds.length === 0) {
        return null;
    }

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const auditLogs = await guild.fetchAuditLogs({
                type: AuditLogEvent.MemberRoleUpdate,
                limit: 6
            });

            const now = Date.now();
            const match = auditLogs.entries.find(entry => {
                if (!entry || entry.targetId !== targetUserId) return false;
                if (now - entry.createdTimestamp > 15000) return false;

                const relevantChange = entry.changes?.find(change => change.key === auditChangeKey);
                if (!relevantChange) return false;

                const roleIdsInAudit = extractRoleIdsFromAuditValue(relevantChange.new);
                return changedRoleIds.some(roleId => roleIdsInAudit.includes(roleId));
            });

            if (match) {
                return match.executorId || null;
            }
        } catch (error) {
            return null;
        }

        await new Promise(resolve => setTimeout(resolve, 1200));
    }

    return null;
}

function getUserCommendations(userId) {
    if (!commendationsData[userId]) {
        commendationsData[userId] = [];
    }
    return commendationsData[userId];
}

function getUserStrikeEntries(guildId, userId) {
    const guildStrikes = getGuildStrikeStore(guildId);
    if (!guildStrikes) return [];

    if (!guildStrikes[userId]) {
        guildStrikes[userId] = [];
    }

    // Normalize legacy strike format { strikes: [] } into array format.
    if (!Array.isArray(guildStrikes[userId]) && Array.isArray(guildStrikes[userId].strikes)) {
        guildStrikes[userId] = guildStrikes[userId].strikes;
    }

    if (!Array.isArray(guildStrikes[userId])) {
        guildStrikes[userId] = [];
    }

    return guildStrikes[userId];
}

async function syncUserStrikeRoles(guild, userId, strikeCount) {
    if (!guild) {
        return { ok: false, errors: ["No guild context available."] };
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        return { ok: false, errors: ["Target user is not a member of this server."] };
    }

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me) {
        return { ok: false, errors: ["Could not resolve bot member in this server."] };
    }

    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return { ok: false, errors: ["Bot is missing Manage Roles permission."] };
    }

    const errors = [];

    for (let i = 0; i < STRIKE_ROLE_IDS.length; i++) {
        const roleId = STRIKE_ROLE_IDS[i];
        const shouldHaveRole = strikeCount >= i + 1;
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);

        if (!role) {
            errors.push(`Role not found: ${roleId}`);
            continue;
        }

        if (me.roles.highest.comparePositionTo(role) <= 0) {
            errors.push(`Bot role must be above ${role.name} (${role.id})`);
            continue;
        }

        const hasRole = member.roles.cache.has(roleId);

        if (shouldHaveRole && !hasRole) {
            await member.roles.add(roleId).catch(err => {
                errors.push(`Failed to add ${role.name} (${role.id}): ${err.message}`);
            });
        }

        if (!shouldHaveRole && hasRole) {
            await member.roles.remove(roleId).catch(err => {
                errors.push(`Failed to remove ${role.name} (${role.id}): ${err.message}`);
            });
        }
    }

    return {
        ok: errors.length === 0,
        errors
    };
}

async function clearAllStrikeRoles(guild, userId) {
    if (!guild) {
        return { ok: false, errors: ["No guild context available."] };
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) {
        return { ok: false, errors: ["Target user is not a member of this server."] };
    }

    const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!me) {
        return { ok: false, errors: ["Could not resolve bot member in this server."] };
    }

    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return { ok: false, errors: ["Bot is missing Manage Roles permission."] };
    }

    const errors = [];

    for (const roleId of STRIKE_ROLE_IDS) {
        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
        if (!role) {
            errors.push(`Role not found: ${roleId}`);
            continue;
        }

        if (me.roles.highest.comparePositionTo(role) <= 0) {
            errors.push(`Bot role must be above ${role.name} (${role.id})`);
            continue;
        }

        if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(err => {
                errors.push(`Failed to remove ${role.name} (${role.id}): ${err.message}`);
            });
        }
    }

    return {
        ok: errors.length === 0,
        errors
    };
}

async function notifyOverStrikeAttempt(client, userId, currentStrikeCount, attemptedById, reason, source) {
    try {
        const alertUser = await client.users.fetch(STRIKE_ALERT_USER_ID).catch(() => null);
        if (!alertUser) return;

        const alertEmbed = new EmbedBuilder()
            .setColor("#8b0000")
            .setTitle("🚨 Over-Strike Attempt Blocked")
            .addFields(
                { name: "Target User", value: `<@${userId}> (${userId})`, inline: false },
                { name: "Current Strikes", value: `${currentStrikeCount}/${MAX_STRIKES}`, inline: true },
                { name: "Attempted By", value: `<@${attemptedById}> (${attemptedById})`, inline: true },
                { name: "Source", value: source, inline: true },
                { name: "Reason", value: reason?.slice(0, 1024) || "No reason provided", inline: false }
            )
            .setTimestamp();

        await alertUser.send({ embeds: [alertEmbed] }).catch(() => {});
    } catch (error) {
        console.error("Failed to send over-strike alert DM:", error);
    }
}

async function sendStrikeLog(client, guildId, embed) {
    try {
        const strikeChannelId = getLogChannelId(guildId, "strike");
        if (!strikeChannelId) {
            console.warn(`[strike-log] No strike log channel configured for guild ${guildId}`);
            return { ok: false, error: "No strike log channel configured.", channelId: null };
        }

        const strikeChannel = client.channels.cache.get(strikeChannelId)
            || await client.channels.fetch(strikeChannelId).catch(() => null);

        if (!strikeChannel || !strikeChannel.isTextBased()) {
            console.warn(`[strike-log] Strike log channel not found or not text-based: ${strikeChannelId}`);
            return { ok: false, error: `Configured strike log channel is invalid: ${strikeChannelId}`, channelId: strikeChannelId };
        }

        if (strikeChannel.guild && strikeChannel.guild.members.me) {
            const permissions = strikeChannel.permissionsFor(strikeChannel.guild.members.me);
            if (!permissions?.has(PermissionFlagsBits.ViewChannel)) {
                return { ok: false, error: `Bot cannot view <#${strikeChannelId}>.`, channelId: strikeChannelId };
            }
            if (!permissions.has(PermissionFlagsBits.SendMessages)) {
                return { ok: false, error: `Bot cannot send messages in <#${strikeChannelId}>.`, channelId: strikeChannelId };
            }
            if (!permissions.has(PermissionFlagsBits.EmbedLinks)) {
                return { ok: false, error: `Bot is missing Embed Links in <#${strikeChannelId}>.`, channelId: strikeChannelId };
            }
        }

        await strikeChannel.send({ embeds: [embed] });
        return { ok: true, error: null, channelId: strikeChannelId };
    } catch (error) {
        console.error("[strike-log] Failed to send strike log:", error);
        return { ok: false, error: error.message || "Unknown strike log error", channelId: getLogChannelId(guildId, "strike") };
    }
}

async function sendCommendationLog(client, guildId, embed) {
    try {
        const channelId = getLogChannelId(guildId, "commendations");
        if (!channelId) return { ok: false, error: "No commendations log channel configured.", channelId: null };
        const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return { ok: false, error: `Channel not found: ${channelId}`, channelId };
        await channel.send({ embeds: [embed] });
        return { ok: true, error: null, channelId };
    } catch (error) {
        return { ok: false, error: error.message || "Unknown error", channelId: getLogChannelId(guildId, "commendations") };
    }
}

async function safeInteractionErrorReply(interaction, message) {
    const payload = {
        content: message,
        flags: MessageFlags.Ephemeral
    };

    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
            return;
        }

        await interaction.reply(payload);
    } catch (replyError) {
        console.error("Failed to send interaction error reply:", replyError);
    }
}

// Dashboard permission functions
function canAccessDashboard(member) {
    const botOwnerId = "967375704486449222";
    return member.id === botOwnerId || 
           member.permissions.has(PermissionFlagsBits.Administrator) || 
           member.roles.cache.some(r => ["admin", "administrator", "supervisor", "ia", "investigator", "sheriff"].some(role => r.name.toLowerCase().includes(role)));
}

function canAccessModule(member, moduleType) {
    // Bot owner has access to everything
    if (member.id === "967375704486449222") {
        return true;
    }
    
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    const hasRole = (roleName) => member.roles.cache.some(r => r.name.toLowerCase().includes(roleName));
    
    // Check custom role IDs configured by bot owner
    const customRoleIds = config.moduleRoleAccess && config.moduleRoleAccess[moduleType] ? config.moduleRoleAccess[moduleType] : [];
    
    // If "everyone" is configured, allow all access
    if (customRoleIds.includes("everyone")) {
        return true;
    }
    
    const hasCustomRole = customRoleIds.length > 0 && member.roles.cache.some(r => customRoleIds.includes(r.id));
    
    // If custom roles are configured for this module, check those first
    if (customRoleIds.length > 0) {
        return hasCustomRole;
    }
    
    // Otherwise use default role-based access
    const modulePerms = {
        patrol: () => true,
        cases: () => isAdmin || hasRole("detective"),
        ia: () => isAdmin || hasRole("ia") || hasRole("investigator"),
        tickets: () => isAdmin || hasRole("staff"),
        moderation: () => isAdmin || hasRole("moderator"),
        training: () => isAdmin || hasRole("training"),
        logs: () => isAdmin,
        bot: () => isAdmin,
        analytics: () => isAdmin || hasRole("supervisor"),
        supervisor: () => isAdmin || hasRole("supervisor")
    };
    return (modulePerms[moduleType] || (() => false))();
}

// Build dashboard button rows showing only modules the user can access
function buildDashboardComponents(member) {
    const botOwnerId = "967375704486449222";

    const allModules = [
        { id: "patrol",     label: "Patrol",          emoji: "🚔", style: ButtonStyle.Primary },
        { id: "cases",      label: "Cases",           emoji: "📋", style: ButtonStyle.Primary },
        { id: "ia",         label: "IA",              emoji: "⚖️", style: ButtonStyle.Primary },
        { id: "tickets",    label: "Tickets",         emoji: "🎫", style: ButtonStyle.Primary },
        { id: "moderation", label: "Moderation",      emoji: "🔨", style: ButtonStyle.Primary },
        { id: "training",   label: "Training",        emoji: "📚", style: ButtonStyle.Primary },
        { id: "logs",       label: "Logs",            emoji: "📜", style: ButtonStyle.Primary },
        { id: "bot",        label: "Bot Settings",    emoji: "⚙️", style: ButtonStyle.Primary },
        { id: "analytics",  label: "Analytics",       emoji: "📊", style: ButtonStyle.Primary },
        { id: "supervisor", label: "Supervisor Tools", emoji: "👮", style: ButtonStyle.Danger  },
    ];

    const accessible = allModules.filter(m => canAccessModule(member, m.id));

    if (member.id === botOwnerId) {
        accessible.push({ id: "owner", label: "Bot Owner", emoji: "🔧", style: ButtonStyle.Success });
    }

    const rows = [];
    for (let i = 0; i < accessible.length; i += 3) {
        const components = accessible.slice(i, i + 3).map(m =>
            new ButtonBuilder()
                .setCustomId(`dashboard_${m.id}`)
                .setLabel(m.label)
                .setStyle(m.style)
                .setEmoji(m.emoji)
        );
        rows.push(new ActionRowBuilder().addComponents(...components));
    }

    return rows.slice(0, 5);
}

// Transcript generation function
async function generateTranscript(channel, ticket) {
    try {
        // Fetch all messages from the channel
        const messages = await channel.messages.fetch({ limit: 100 });
        const sortedMessages = messages.reverse();

        // Build HTML content
        let htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ticket Transcript - ${ticket.id}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background-color: #36393f;
            color: #dcddde;
            padding: 20px;
        }
        .container {
            max-width: 900px;
            margin: 0 auto;
            background-color: #2f3136;
            border-radius: 8px;
            overflow: hidden;
        }
        .header {
            background-color: #23272a;
            padding: 20px;
            border-bottom: 1px solid #202225;
        }
        .header h1 {
            font-size: 20px;
            margin-bottom: 10px;
        }
        .header-info {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
            font-size: 12px;
            color: #99aab5;
        }
        .messages {
            padding: 20px;
            max-height: 600px;
            overflow-y: auto;
        }
        .message {
            margin-bottom: 15px;
            display: flex;
            gap: 10px;
        }
        .message-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            flex-shrink: 0;
        }
        .message-content {
            flex: 1;
        }
        .message-header {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
        }
        .message-author {
            font-weight: 600;
            color: #fff;
        }
        .message-timestamp {
            font-size: 12px;
            color: #72767d;
            margin-left: auto;
        }
        .message-text {
            font-size: 13px;
            color: #dcddde;
            margin-top: 4px;
            line-height: 1.4;
            word-wrap: break-word;
        }
        .message-attachments {
            margin-top: 8px;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }
        .message-attachment {
            max-width: 200px;
            border-radius: 4px;
            overflow: hidden;
        }
        .message-attachment img {
            max-width: 100%;
            height: auto;
        }
        .footer {
            background-color: #23272a;
            padding: 20px;
            border-top: 1px solid #202225;
            font-size: 12px;
            color: #99aab5;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📋 Ticket Transcript</h1>
            <div class="header-info">
                <div><strong>Opened By:</strong> <@${ticket.opener}></div>
                <div><strong>Ticket ID:</strong> ${ticket.id}</div>
                <div><strong>Type:</strong> ${ticket.type}</div>
                <div><strong>Opened:</strong> ${new Date(ticket.createdAt).toLocaleString()}</div>
                <div><strong>Closed:</strong> ${new Date(ticket.closedAt).toLocaleString()}</div>
                <div><strong>Claimed By:</strong> ${ticket.claimed ? `<${ticket.claimedBy}>` : "Not claimed"}</div>
                <div><strong>Closed By:</strong> ${ticket.closedBy ? `<@${ticket.closedBy}>` : "Unknown"}</div>
                <div><strong>Reason:</strong> ${ticket.closeReason}</div>
            </div>
        </div>
        <div class="messages">`;

        // Add messages
        for (const msg of sortedMessages.values()) {
            const author = msg.author;
            const timestamp = msg.createdAt.toLocaleTimeString();
            
            // Escape HTML in message content
            let content = msg.content
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");

            htmlContent += `
            <div class="message">
                <img class="message-avatar" src="${author.displayAvatarURL({ extension: 'png', size: 64 })}" alt="${author.username}">
                <div class="message-content">
                    <div class="message-header">
                        <span class="message-author">${author.username} (${author.id})</span>
                        <span class="message-timestamp">${timestamp}</span>
                    </div>
                    <div class="message-text">${content}</div>`;

            // Add attachments
            if (msg.attachments.size > 0) {
                htmlContent += '<div class="message-attachments">';
                for (const attachment of msg.attachments.values()) {
                    if (attachment.contentType && attachment.contentType.startsWith('image')) {
                        htmlContent += `<img class="message-attachment" src="${attachment.url}" alt="attachment">`;
                    } else {
                        htmlContent += `<a href="${attachment.url}" target="_blank">${attachment.name}</a>`;
                    }
                }
                htmlContent += '</div>';
            }

            htmlContent += `
                </div>
            </div>`;
        }

        htmlContent += `
        </div>
        <div class="footer">
            <p>Transcript generated on ${new Date().toLocaleString()} | HCSO Ticket System</p>
        </div>
    </div>
</body>
</html>`;

        return htmlContent;
    } catch (error) {
        console.error("Error generating transcript:", error);
        return null;
    }
}

// Save transcript to file
async function saveTranscript(ticketId, htmlContent) {
    try {
        if (!fs.existsSync(TRANSCRIPTS_DIR)) {
            fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
        }
        const fileName = `transcript-${ticketId}-${Date.now()}.html`;
        fs.writeFileSync(path.join(TRANSCRIPTS_DIR, fileName), htmlContent);
        return fileName;
    } catch (error) {
        console.error("Error saving transcript:", error);
        return null;
    }
}

// Send transcript to log channel
async function sendTranscript(client, ticket, transcriptFileName, htmlContent) {
    try {
        console.log("[SENDTRANSCRIPT] Starting transcript send for ticket:", ticket.id);
        console.log("[SENDTRANSCRIPT] Config:", JSON.stringify(config.logChannels));
        
        if (!config.logChannels) {
            console.error("[SENDTRANSCRIPT] No log channels configured in config");
            throw new Error("No log channels configured");
        }

        const logChannelId = getLogChannelId(ticket.guildId, "transcript");

        if (!logChannelId) {
            console.error("[SENDTRANSCRIPT] No transcript log channel configured");
            console.error("[SENDTRANSCRIPT] Available log channels:", Object.keys(config.logChannels));
            throw new Error("No transcript log channel configured");
        }
        console.log("[SENDTRANSCRIPT] Fetching transcript log channel with ID:", logChannelId);
        
        const logChannel = await client.channels.fetch(logChannelId).catch(err => {
            console.error("[SENDTRANSCRIPT] Failed to fetch log channel:", err.message || err);
            throw new Error(`Failed to fetch log channel: ${err.message}`);
        });
        
        if (!logChannel) {
            console.error("[SENDTRANSCRIPT] Log channel not found with ID:", logChannelId);
            throw new Error("Log channel not found");
        }

        if (!logChannel.isTextBased()) {
            console.error("[SENDTRANSCRIPT] Log channel is not a text channel:", logChannelId);
            throw new Error("Log channel is not a text channel");
        }

        if (!htmlContent) {
            console.error("[SENDTRANSCRIPT] HTML content is empty");
            throw new Error("HTML content is empty");
        }

        const transcriptEmbed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("📋 Ticket Transcript Generated")
            .addFields(
                { name: "Ticket ID", value: ticket.id, inline: true },
                { name: "Type", value: ticket.type || "Unknown", inline: true },
                { name: "Opener", value: `<@${ticket.opener}>`, inline: true },
                { name: "Claimed By", value: ticket.claimed ? `<@${ticket.claimedBy}>` : "Not claimed", inline: true },
                { name: "Created", value: new Date(ticket.createdAt).toLocaleString(), inline: true },
                { name: "Closed", value: new Date(ticket.closedAt).toLocaleString(), inline: true },
                { name: "Reason", value: ticket.closeReason || "No reason provided", inline: false }
            )
            .setTimestamp();

        console.log("[SENDTRANSCRIPT] Sending transcript with filename:", transcriptFileName);
        console.log("[SENDTRANSCRIPT] HTML content length:", htmlContent.length);
        
        const buffer = Buffer.from(htmlContent, 'utf8');
        console.log("[SENDTRANSCRIPT] Buffer created, size:", buffer.length);
        
        await logChannel.send({ 
            embeds: [transcriptEmbed], 
            files: [{ attachment: buffer, name: transcriptFileName }] 
        }).catch(err => {
            console.error("[SENDTRANSCRIPT] Failed to send message to log channel:", err.message || err);
            throw err;
        });
        
        console.log("[SENDTRANSCRIPT] ✅ Transcript sent successfully for ticket:", ticket.id);
    } catch (error) {
        console.error("[SENDTRANSCRIPT] Error sending transcript:", error.message || error);
        throw error;
    }
}

// Send transcript via DM to opener and closer
async function dmTranscript(client, ticket, transcriptFileName, htmlContent) {
    try {
        // Get the opener user
        let opener;
        try {
            opener = await client.users.fetch(ticket.opener);
        } catch (error) {
            console.warn("Could not fetch opener user:", ticket.opener);
        }

        if (opener) {
            try {
                console.log("[TRANSCRIPT DM] Sending transcript to opener");
                const dmEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("📋 Your Ticket Transcript")
                    .setDescription(`Your ticket has been closed and a transcript has been generated.`)
                    .addFields(
                        { name: "Ticket ID", value: ticket.id, inline: false },
                        { name: "Ticket Type", value: ticket.type, inline: false },
                        { name: "Submitted By", value: `<@${ticket.opener}>`, inline: true },
                        { name: "Claimed By", value: ticket.claimed && ticket.claimedBy ? `<@${ticket.claimedBy}>` : "Not claimed", inline: true }
                    )
                    .setTimestamp();
                
                await opener.send({ 
                    embeds: [dmEmbed], 
                    files: [{ attachment: Buffer.from(htmlContent), name: transcriptFileName }] 
                });
                console.log("[TRANSCRIPT DM] Sent to opener successfully");
            } catch (error) {
                console.warn("Could not send DM to opener:", error.message);
            }
        }

        // Get the closer user if they exist and are not the opener
        if (ticket.closedBy && ticket.closedBy !== ticket.opener) {
            let closer;
            try {
                closer = await client.users.fetch(ticket.closedBy);
            } catch (error) {
                console.warn("Could not fetch closer user:", ticket.closedBy);
            }

            if (closer) {
                try {
                    console.log("[TRANSCRIPT DM] Sending transcript to closer");
                    const dmEmbed = new EmbedBuilder()
                        .setColor("#2d5a3d")
                        .setTitle("📋 Ticket Closed - Transcript Generated")
                        .setDescription(`A ticket you closed has been transcribed.`)
                        .addFields(
                            { name: "Ticket ID", value: ticket.id, inline: false },
                            { name: "Ticket Type", value: ticket.type, inline: false },
                            { name: "Ticket Opener", value: `<@${ticket.opener}>`, inline: false }
                        )
                        .setTimestamp();
                    
                    await closer.send({ 
                        embeds: [dmEmbed], 
                        files: [{ attachment: Buffer.from(htmlContent), name: transcriptFileName }] 
                    });
                    console.log("[TRANSCRIPT DM] Sent to closer successfully");
                } catch (error) {
                    console.warn("Could not send DM to closer:", error.message);
                }
            }
        }
    } catch (error) {
        console.error("Error sending transcript DMs:", error);
    }
}

// Slash commands
const commands = [
    new SlashCommandBuilder()
        .setName("strike")
        .setDescription("Give a user a strike")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(true)),

    new SlashCommandBuilder()
        .setName("strike-remove")
        .setDescription("Remove strikes from a user")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true).setMinValue(1)),

    new SlashCommandBuilder()
        .setName("strike-logs")
        .setDescription("View a user’s strike history")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),

    new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Delete messages (staff only)")
        .addIntegerOption(o => o.setName("amount").setDescription("Number of messages (max 500)").setRequired(true).setMinValue(1).setMaxValue(500)),

    new SlashCommandBuilder()
        .setName("patrol")
        .setDescription("Start a patrol logging session"),

    new SlashCommandBuilder()
        .setName("patrol-today")
        .setDescription("View your patrol hours today")
        .addUserOption(o => o.setName("user").setDescription("User (optional)").setRequired(false)),

    new SlashCommandBuilder()
        .setName("patrol-week")
        .setDescription("View your patrol hours this week")
        .addUserOption(o => o.setName("user").setDescription("User (optional)").setRequired(false)),

    new SlashCommandBuilder()
        .setName("patrol-month")
        .setDescription("View your patrol hours this month")
        .addUserOption(o => o.setName("user").setDescription("User (optional)").setRequired(false)),

    new SlashCommandBuilder()
        .setName("loa")
        .setDescription("Submit a Leave of Absence request")
        .addStringOption(o => o.setName("start-date").setDescription("Start date (MM-DD-YYYY)").setRequired(true))
        .addStringOption(o => o.setName("end-date").setDescription("End date (MM-DD-YYYY)").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason (optional)").setRequired(false)),

    new SlashCommandBuilder()
        .setName("end-loa")
        .setDescription("End your Leave of Absence"),

    new SlashCommandBuilder()
        .setName("report")
        .setDescription("File an incident report")
        .addStringOption(o => o.setName("incident-type").setDescription("Type of incident").setRequired(true).addChoices(
            { name: "Traffic Stop", value: "Traffic Stop" },
            { name: "Pursuit", value: "Pursuit" },
            { name: "Disturbance", value: "Disturbance" },
            { name: "Arrest", value: "Arrest" },
            { name: "Robbery", value: "Robbery" },
            { name: "Assault", value: "Assault" },
            { name: "Other", value: "Other" }
        ))
        .addStringOption(o => o.setName("location").setDescription("Location of incident").setRequired(true))
        .addStringOption(o => o.setName("summary").setDescription("Summary of what happened").setRequired(true))
        .addStringOption(o => o.setName("suspect").setDescription("Suspect name or @ mention").setRequired(false)),

    new SlashCommandBuilder()
        .setName("case-create")
        .setDescription("Create a new case")
        .addStringOption(o => o.setName("title").setDescription("Case title").setRequired(true))
        .addStringOption(o => o.setName("incident-type").setDescription("Type of incident").setRequired(true).addChoices(
            { name: "Robbery", value: "Robbery" },
            { name: "Assault", value: "Assault" },
            { name: "Traffic Stop", value: "Traffic Stop" },
            { name: "Pursuit", value: "Pursuit" },
            { name: "Arrest", value: "Arrest" },
            { name: "Disturbance", value: "Disturbance" },
            { name: "Other", value: "Other" }
        ))
        .addStringOption(o => o.setName("location").setDescription("Location").setRequired(true))
        .addStringOption(o => o.setName("summary").setDescription("Case summary").setRequired(true))
        .addStringOption(o => o.setName("suspect").setDescription("Suspect name or @ mention").setRequired(false)),

    new SlashCommandBuilder()
        .setName("case-view")
        .setDescription("View case details")
        .addStringOption(o => o.setName("case-id").setDescription("Case ID (e.g., CASE-000001)").setRequired(true).setAutocomplete(true)),

    new SlashCommandBuilder()
        .setName("case-assign")
        .setDescription("Assign a case to a deputy")
        .addStringOption(o => o.setName("case-id").setDescription("Case ID").setRequired(true).setAutocomplete(true))
        .addUserOption(o => o.setName("assignee").setDescription("Deputy to assign").setRequired(true))
        .addStringOption(o => o.setName("note").setDescription("Optional note").setRequired(false)),

    new SlashCommandBuilder()
        .setName("case-unassign")
        .setDescription("Unassign a case from a deputy")
        .addStringOption(o => o.setName("case-id").setDescription("Case ID").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason for unassignment").setRequired(false)),

    new SlashCommandBuilder()
        .setName("evidence-add")
        .setDescription("Add evidence to a case")
        .addStringOption(o => o.setName("case-id").setDescription("Case ID").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("description").setDescription("Evidence description").setRequired(true)),

    new SlashCommandBuilder()
        .setName("case-close")
        .setDescription("Close an existing case")
        .addStringOption(o => o.setName("case-id").setDescription("Case ID").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("reason").setDescription("Closing reason (optional)").setRequired(false)),

    new SlashCommandBuilder()
        .setName("case-delete")
        .setDescription("Permanently delete a case")
        .addStringOption(o => o.setName("case-id").setDescription("Case ID").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("confirmation").setDescription("Type YES to confirm deletion").setRequired(true)),

    new SlashCommandBuilder()
        .setName("case-my")
        .setDescription("View cases assigned to you"),

    new SlashCommandBuilder()
        .setName("case-search")
        .setDescription("Search for cases by keyword or case ID")
        .addStringOption(o => o.setName("query").setDescription("Search term (ID, suspect, location, etc.)").setRequired(true)),

    new SlashCommandBuilder()
        .setName("case-edit")
        .setDescription("Edit case information")
        .addStringOption(o => o.setName("case-id").setDescription("Case ID").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("field").setDescription("Field to edit").setRequired(true).addChoices(
            { name: "Title", value: "title" },
            { name: "Incident Type", value: "incidentType" },
            { name: "Location", value: "location" },
            { name: "Suspect", value: "suspect" },
            { name: "Summary", value: "summary" },
            { name: "Status", value: "status" },
            { name: "Assigned Officer", value: "assignedTo" }
        ))
        .addStringOption(o => o.setName("value").setDescription("New value").setRequired(true)),

    new SlashCommandBuilder()
        .setName("case-reopen")
        .setDescription("Reopen a closed case when new evidence emerges")
        .addStringOption(o => o.setName("case-id").setDescription("Case ID").setRequired(true).setAutocomplete(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason for reopening").setRequired(true)),

    new SlashCommandBuilder()
        .setName("commendation")
        .setDescription("Manage officer commendations")
        .addSubcommand(sub =>
            sub.setName("give")
                .setDescription("Award a commendation to an officer")
                .addUserOption(o => o.setName("user").setDescription("Officer to commend").setRequired(true))
                .addStringOption(o => o.setName("reason").setDescription("Reason for the commendation").setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName("list")
                .setDescription("View all commendations for an officer")
                .addUserOption(o => o.setName("user").setDescription("Officer to view").setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName("remove")
                .setDescription("Remove a specific commendation from an officer")
                .addUserOption(o => o.setName("user").setDescription("Officer").setRequired(true))
                .addIntegerOption(o => o.setName("number").setDescription("Commendation number to remove").setRequired(true).setMinValue(1))
        ),

    new SlashCommandBuilder()
        .setName("set-log-channel")
        .setDescription("Set the log channel for a specific log type")
        .addStringOption(o => o.setName("log-type").setDescription("Log type").setRequired(true).addChoices(
            { name: "Patrol Logs", value: "patrol" },
            { name: "Case Logs", value: "case" },
            { name: "Moderation Logs (Strike/Ban/Blacklist)", value: "moderation" },
            { name: "LOA Logs", value: "loa" },
            { name: "Transcript Logs", value: "transcript" },
            { name: "Timeout Logs", value: "timeout" },
            { name: "Discord Logs", value: "discord" },
            { name: "Commendation Logs", value: "commendations" }
        )),

    new SlashCommandBuilder()
        .setName("ticket-panel")
        .setDescription("Deploy the HCSO Ticket Panel (admins only)"),

    new SlashCommandBuilder()
        .setName("ticket-add-user")
        .setDescription("Add a user to the current ticket")
        .addUserOption(o => o.setName("user").setDescription("User to add").setRequired(true)),

    new SlashCommandBuilder()
        .setName("ticketcatset")
        .setDescription("Set the category ID for tickets")
        .addStringOption(o => o.setName("category-id").setDescription("Category ID").setRequired(true)),

    new SlashCommandBuilder()
        .setName("set-status")
        .setDescription("Change the bot's status to a preset")
        .addStringOption(o => o
            .setName("status")
            .setDescription("Select a status")
            .setRequired(true)
            .addChoices(
                { name: "Online", value: "online" },
                { name: "Idle", value: "idle" },
                { name: "Do Not Disturb", value: "dnd" },
                { name: "Invisible", value: "invisible" },
                { name: "Watching Patrol Logs", value: "watching_patrol" },
                { name: "Listening to Radio Traffic", value: "listening_radio" },
                { name: "Playing HCSO Operations", value: "playing_hcso" },
                { name: "Watching Over Hendry County", value: "watching_hc" },
                { name: "Competing in Patrol Hours", value: "competing_patrol" }
            )
        ),

    new SlashCommandBuilder()
        .setName("transcript")
        .setDescription("Generate and send a transcript of the current or closed ticket"),

    new SlashCommandBuilder()
        .setName("dashboard")
        .setDescription("Open the HCSO Department control dashboard (Admin only)")

].map(c => c.toJSON());

// Register commands
const rest = new REST({ version: "10" }).setToken(TOKEN);
await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });

// Create bot
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ]
});

async function sendDiscordEventLog(guildId, embed) {
    try {
        const channelId = getLogChannelId(guildId, "discord");
        if (!channelId) return;

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        await channel.send({ embeds: [embed] }).catch(() => {});
    } catch (error) {
        console.error("Discord event log send failed:", error);
    }
}

client.on("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);

    // Keep a periodic heartbeat in logs so uptime is visible on hosting dashboards.
    setInterval(() => {
        console.log(`[heartbeat] Bot online | uptime=${Math.floor(process.uptime())}s`);
    }, 5 * 60 * 1000);
    
    // Restore previous status if it exists
    if (config.currentStatus) {
        const statusMap = {
            online: { status: "online", activity: null },
            idle: { status: "idle", activity: null },
            dnd: { status: "dnd", activity: null },
            invisible: { status: "invisible", activity: null },
            watching_patrol: { status: "online", activity: { name: "Patrol Logs", type: "WATCHING" } },
            listening_radio: { status: "online", activity: { name: "Radio Traffic", type: "LISTENING" } },
            playing_hcso: { status: "online", activity: { name: "HCSO Operations", type: "PLAYING" } },
            watching_hc: { status: "online", activity: { name: "Over Hendry County Sheriff's Office", type: "WATCHING" } },
            competing_patrol: { status: "online", activity: { name: "Patrol Hours", type: "COMPETING" } }
        };

        if (config.currentStatus.custom) {
            const activityTypeMap = {
                "Playing": "PLAYING",
                "Watching": "WATCHING",
                "Listening": "LISTENING",
                "Competing": "COMPETING"
            };
            client.user.setPresence({
                activities: [{ name: config.currentStatus.message, type: activityTypeMap[config.currentStatus.type] }],
                status: "online"
            });
        } else {
            const selectedStatus = statusMap[config.currentStatus];
            if (selectedStatus) {
                client.user.setPresence({
                    activities: selectedStatus.activity ? [selectedStatus.activity] : [],
                    status: selectedStatus.status
                });
            } else {
                client.user.setActivity("Hendry County Sheriff's Office", { type: "WATCHING" });
            }
        }
    } else {
        client.user.setActivity("Hendry County Sheriff's Office", { type: "WATCHING" });
    }
});

// Handle commands
client.on("interactionCreate", async interaction => {
    if (interaction.isChatInputCommand()) {
        console.log(`[command] /${interaction.commandName} by ${interaction.user.tag} in guild ${interaction.guildId || "DM"}`);
    }

    // Handle button clicks
    if (interaction.isButton()) {
        try {
            const patrolLogChannelId = getLogChannelId(interaction.guildId, "patrol");
            const logChannel = patrolLogChannelId ? client.channels.cache.get(patrolLogChannelId) : null;

            if (interaction.customId === "start_patrol") {
                const deputyId = interaction.user.id;

                // Check if user is on LOA
                if (loa[deputyId] && loa[deputyId].onLOA) {
                    return interaction.reply({
                        content: "❌ You are currently on an approved LOA and cannot begin patrol until your LOA has ended.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (patrols[deputyId] && patrols[deputyId].active) {
                    return interaction.reply({
                        content: "❌ You're already on patrol!",
                        flags: MessageFlags.Ephemeral
                    });
                }

                patrols[deputyId] = {
                    active: true,
                    startTime: Date.now(),
                    deputyName: interaction.user.username
                };
                savePatrols();

                const stopButton = new ButtonBuilder()
                    .setCustomId("stop_patrol")
                    .setLabel("Stop Patrol")
                    .setStyle(ButtonStyle.Danger);

                const row = new ActionRowBuilder().addComponents(stopButton);

                return interaction.reply({
                    content: `✅ Patrol started at <t:${Math.floor(Date.now() / 1000)}:t>`,
                    components: [row],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === "stop_patrol") {
                const deputyId = interaction.user.id;

                if (!patrols[deputyId] || !patrols[deputyId].active) {
                    return interaction.reply({
                        content: "❌ You're not on patrol!",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const startTime = patrols[deputyId].startTime;
                const endTime = Date.now();
                const duration = endTime - startTime;

                const hours = Math.floor(duration / (1000 * 60 * 60));
                const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));

                const startDate = new Date(startTime);
                const endDate = new Date(endTime);

                const startTimeStr = startDate.toLocaleTimeString();
                const endTimeStr = endDate.toLocaleTimeString();

                const logEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("🚓 Patrol Shift Logged")
                    .addFields(
                        { name: "Deputy", value: `<@${deputyId}>`, inline: false },
                        { name: "Shift Length", value: `${hours}h ${minutes}m`, inline: true },
                        { name: "Start Time", value: startTimeStr, inline: true },
                        { name: "End Time", value: endTimeStr, inline: true }
                    )
                    .setTimestamp();

const patrolLogChannel = client.channels.cache.get(config.logChannels.patrol);
            if (patrolLogChannel) {
                await patrolLogChannel.send({ embeds: [logEmbed] });
                }

                // Store completed patrol
                if (!patrols[deputyId].completed) {
                    patrols[deputyId].completed = [];
                }
                patrols[deputyId].completed.push({
                    startTime: startTime,
                    endTime: endTime,
                    duration: duration,
                    date: new Date(startTime).toDateString()
                });

                patrols[deputyId].active = false;
                savePatrols();

                return interaction.reply({
                    content: `✅ Patrol ended. Logged ${hours}h ${minutes}m to patrol logs.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Ticket button handlers
            if (interaction.customId.startsWith("ticket_") && !interaction.customId.includes("close") && !interaction.customId.includes("claim") && !interaction.customId.includes("accept") && !interaction.customId.includes("deny") && !interaction.customId.includes("reason") && !interaction.customId.includes("delete") && !interaction.customId.includes("send")) {
                const ticketType = interaction.customId.replace("ticket_", "").replace(/_/g, " ");
                const ticketTypeDisplay = ticketType.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
                const userId = interaction.user.id;
                const userName = interaction.user.username;
                const guildId = interaction.guildId;
                
                // Check if user already has an open ticket (where they haven't been removed and channel exists)
                const existingTicket = Object.values(tickets.tickets).find(
                    t => t.opener === userId && t.guildId === guildId && t.status === "open" && !t.userRemoved
                );
                
                if (existingTicket) {
                    // Verify the channel still exists in Discord
                    try {
                        await interaction.guild.channels.fetch(existingTicket.channel);
                        // Channel exists, so block ticket creation
                        return interaction.reply({
                            content: `❌ You already have an open ticket. Please close it first or contact support.`,
                            flags: MessageFlags.Ephemeral
                        });
                    } catch (error) {
                        // Channel doesn't exist anymore, mark as removed so user can create new ticket
                        existingTicket.status = "closed";
                        existingTicket.userRemoved = true;
                        saveTickets();
                        console.log("[TICKET] Channel for", existingTicket.id, "no longer exists, allowing new ticket");
                    }
                }

                // Create channel
                if (!config.ticketCategory) {
                    return interaction.reply({
                        content: "❌ Ticket category not configured. An admin must run `/ticketcatset <category-id>` first.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                const category = await interaction.guild.channels.fetch(config.ticketCategory);
                const channelName = `${userName.toLowerCase()}-${ticketType.toLowerCase().replace(/ /g, "-")}`;
                
                const ticketChannel = await interaction.guild.channels.create({
                    name: channelName,
                    type: 0, // Text channel
                    parent: category,
                    permissionOverwrites: [
                        {
                            id: interaction.guild.id,
                            deny: ["ViewChannel"]
                        },
                        {
                            id: userId,
                            allow: ["ViewChannel", "SendMessages", "ReadMessageHistory"]
                        }
                    ]
                });

                // Store ticket data
                // Generate next ticket ID with incrementing counter
                config.ticketCounter += 1;
                const ticketNumber = String(config.ticketCounter).padStart(2, '0');
                const ticketId = `TICKET-${ticketNumber}`;
                
                tickets.tickets[ticketId] = {
                    id: ticketId,
                    type: ticketType,
                    opener: userId,
                    openerName: userName,
                    channel: ticketChannel.id,
                    guildId: guildId,
                    status: "open",
                    claimed: false,
                    claimedBy: null,
                    createdAt: new Date().toISOString(),
                    closedAt: null,
                    closeReason: null,
                    participants: [userId],
                    firstMessageProcessed: false,
                    userRemoved: false
                };
                saveTickets();
                saveConfig();

                // Add staff access to the channel
                const staffRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase().includes("staff"));
                if (staffRole) {
                    await ticketChannel.permissionOverwrites.create(staffRole, {
                        ViewChannel: true,
                        SendMessages: true,
                        ReadMessageHistory: true
                    });
                }

                // Send welcome message in ticket channel
                const welcomeEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle(`Welcome to your ${ticketTypeDisplay} ticket`)
                    .setDescription("Please notify us of your problem below.")
                    .addFields(
                        { name: "Ticket ID", value: ticketId, inline: true },
                        { name: "Type", value: ticketTypeDisplay, inline: true }
                    )
                    .setTimestamp();

                const closeButton = new ButtonBuilder()
                    .setCustomId(`ticket_close_request_${ticketId}`)
                    .setLabel("Close Request")
                    .setStyle(ButtonStyle.Danger);

                const claimButton = new ButtonBuilder()
                    .setCustomId(`ticket_claim_${ticketId}`)
                    .setLabel("Claim")
                    .setStyle(ButtonStyle.Primary);

                const forceCloseButton = new ButtonBuilder()
                    .setCustomId(`ticket_force_close_${ticketId}`)
                    .setLabel("Close")
                    .setStyle(ButtonStyle.Danger);

                const buttonRow = new ActionRowBuilder().addComponents(closeButton, claimButton, forceCloseButton);

                await ticketChannel.send({
                    embeds: [welcomeEmbed],
                    components: [buttonRow]
                });

                return interaction.reply({
                    content: `✅ Ticket created! <#${ticketChannel.id}>`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Close Request handler
            if (interaction.customId.startsWith("ticket_close_request_")) {
                const ticketId = interaction.customId.replace("ticket_close_request_", "");
                const ticket = tickets.tickets[ticketId];

                if (!ticket) {
                    return interaction.reply({
                        content: "❌ Ticket not found.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Only staff can use this button
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return interaction.reply({
                        content: "❌ Only staff members can request to close a ticket.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Show modal for close reason
                const modal = new ModalBuilder()
                    .setCustomId(`ticket_close_reason_${ticketId}`)
                    .setTitle("Close Request Reason");

                const reasonInput = new TextInputBuilder()
                    .setCustomId("close_reason")
                    .setLabel("Reason for closing")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                const actionRow = new ActionRowBuilder().addComponents(reasonInput);
                modal.addComponents(actionRow);

                await interaction.showModal(modal);
            }

            // Claim handler
            if (interaction.customId.startsWith("ticket_claim_")) {
                const ticketId = interaction.customId.replace("ticket_claim_", "");
                const ticket = tickets.tickets[ticketId];

                if (!ticket) {
                    return interaction.reply({
                        content: "❌ Ticket not found.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Check if user has the required role
                const requiredRole = "1300240721600708628";
                if (!interaction.member.roles.cache.has(requiredRole)) {
                    return interaction.reply({
                        content: "❌ You do not have permission to claim tickets.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Prevent ticket opener from claiming their own ticket
                if (interaction.user.id === ticket.opener) {
                    return interaction.reply({
                        content: "❌ You cannot claim your own ticket. Use the **Close** button if you created this by accident.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (ticket.claimed) {
                    return interaction.reply({
                        content: `❌ This ticket is already claimed by <@${ticket.claimedBy}>.`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Claim the ticket
                ticket.claimed = true;
                ticket.claimedBy = interaction.user.id;
                saveTickets();

                const claimEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setDescription(`This ticket has been claimed by <@${interaction.user.id}>.\nThey will be assisting you from here.`)
                    .setTimestamp();

                await interaction.reply({ embeds: [claimEmbed] });
            }

            // Force close handler
            if (interaction.customId.startsWith("ticket_force_close_")) {
                const ticketId = interaction.customId.replace("ticket_force_close_", "");
                const ticket = tickets.tickets[ticketId];

                if (!ticket) {
                    return interaction.reply({
                        content: "❌ Ticket not found.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Determine who closed it and what reason
                let closeReason = "Force closed by staff";
                let closedBy = interaction.user.id;
                if (interaction.user.id === ticket.opener) {
                    closeReason = "Closed by ticket opener";
                }

                // Mark as closed
                ticket.status = "closed";
                ticket.closedAt = new Date().toISOString();
                ticket.closeReason = closeReason;
                ticket.closedBy = closedBy;
                saveTickets();

                console.log("[TICKET CLOSE] Ticket", ticketId, "marked as closed");

                const closeEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setDescription("This ticket has now been closed.\nThank you for contacting HCSO.\n\nThe ticket opener has been removed from this channel. Staff can still review this ticket.")
                    .setTimestamp();

                await interaction.reply({ embeds: [closeEmbed] });

                // Generate transcript before removing access
                console.log("[TRANSCRIPT] Generating transcript for", ticketId);
                const transcriptHtml = await generateTranscript(interaction.channel, ticket);
                if (transcriptHtml) {
                    console.log("[TRANSCRIPT] Transcript generated successfully, length:", transcriptHtml.length);
                    const transcriptFile = await saveTranscript(ticketId, transcriptHtml);
                    if (transcriptFile) {
                        console.log("[TRANSCRIPT] Transcript file saved:", transcriptFile);
                        console.log("[TRANSCRIPT] Config logChannels:", config.logChannels);
                        try {
                            await sendTranscript(interaction.client, ticket, transcriptFile, transcriptHtml);
                            console.log("[TRANSCRIPT] ✅ Transcript sent to log channel successfully");
                        } catch (sendError) {
                            console.error("[TRANSCRIPT] ❌ Error sending transcript to log channel:", sendError.message || sendError);
                        }
                        try {
                            await dmTranscript(interaction.client, ticket, transcriptFile, transcriptHtml);
                        } catch (dmError) {
                            console.error("[TRANSCRIPT] ❌ Error sending transcript via DM:", dmError.message || dmError);
                        }
                    } else {
                        console.error("[TRANSCRIPT] Failed to save transcript file");
                    }
                } else {
                    console.error("[TRANSCRIPT] Failed to generate transcript HTML");
                }

                // Remove ticket opener from channel instead of deleting it
                setTimeout(async () => {
                    try {
                        await interaction.channel.permissionOverwrites.delete(ticket.opener);
                        console.log("[TICKET CLOSE] Removed", ticket.opener, "from channel");
                        
                        // Mark that user was removed from this ticket so they can open a new one
                        ticket.userRemoved = true;
                        saveTickets();
                        const archiveEmbed = new EmbedBuilder()
                            .setColor("#ffa500")
                            .setTitle("📋 Ticket Archived")
                            .setDescription(`Ticket #${ticketId} has been closed and archived.\nThe transcript has been saved to the transcript logs.\n\nOnce the investigation is complete, click the button below to permanently delete this ticket.`)
                            .setTimestamp();
                        
                        const deleteButton = new ButtonBuilder()
                            .setCustomId(`ticket_delete_${ticketId}`)
                            .setLabel("Delete Ticket")
                            .setStyle(ButtonStyle.Danger);
                        
                        const sendTranscriptButton = new ButtonBuilder()
                            .setCustomId(`ticket_send_transcript_${ticketId}`)
                            .setLabel("Send Transcript")
                            .setStyle(ButtonStyle.Primary);
                        
                        const buttonRow = new ActionRowBuilder().addComponents(sendTranscriptButton, deleteButton);
                        
                        await interaction.channel.send({ embeds: [archiveEmbed], components: [buttonRow] }).catch(() => {});
                    } catch (error) {
                        console.error("Error removing opener from channel:", error);
                    }
                }, 1000);
            }

            // Accept close handler
            if (interaction.customId.startsWith("ticket_accept_close_")) {
                const ticketId = interaction.customId.replace("ticket_accept_close_", "");
                const ticket = tickets.tickets[ticketId];

                if (!ticket) {
                    return interaction.reply({
                        content: "❌ Ticket not found.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Mark as closed
                ticket.status = "closed";
                ticket.closedAt = new Date().toISOString();
                ticket.closeReason = "Accepted close request";
                ticket.closedBy = interaction.user.id;
                saveTickets();

                console.log("[TICKET CLOSE] Ticket", ticketId, "marked as closed (accepted)");

                const closeEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setDescription("This ticket has now been closed.\nThank you for contacting HCSO.\n\nThe ticket opener has been removed from this channel. Staff can still review this ticket.")
                    .setTimestamp();

                await interaction.reply({ embeds: [closeEmbed] });

                // Generate transcript before removing access
                console.log("[TRANSCRIPT] Generating transcript for", ticketId);
                const transcriptHtml = await generateTranscript(interaction.channel, ticket);
                if (transcriptHtml) {
                    console.log("[TRANSCRIPT] Transcript generated successfully, length:", transcriptHtml.length);
                    const transcriptFile = await saveTranscript(ticketId, transcriptHtml);
                    if (transcriptFile) {
                        console.log("[TRANSCRIPT] Transcript file saved:", transcriptFile);
                        console.log("[TRANSCRIPT] Config logChannels:", config.logChannels);
                        try {
                            await sendTranscript(interaction.client, ticket, transcriptFile, transcriptHtml);
                            console.log("[TRANSCRIPT] ✅ Transcript sent to log channel successfully");
                        } catch (sendError) {
                            console.error("[TRANSCRIPT] ❌ Error sending transcript to log channel:", sendError.message || sendError);
                        }
                        try {
                            await dmTranscript(interaction.client, ticket, transcriptFile, transcriptHtml);
                        } catch (dmError) {
                            console.error("[TRANSCRIPT] ❌ Error sending transcript via DM:", dmError.message || dmError);
                        }
                    } else {
                        console.error("[TRANSCRIPT] Failed to save transcript file");
                    }
                } else {
                    console.error("[TRANSCRIPT] Failed to generate transcript HTML");
                }

                // Remove ticket opener from channel instead of deleting it
                setTimeout(async () => {
                    try {
                        await interaction.channel.permissionOverwrites.delete(ticket.opener);
                        console.log("[TICKET CLOSE] Removed", ticket.opener, "from channel");
                        
                        // Mark that user was removed from this ticket so they can open a new one
                        ticket.userRemoved = true;
                        saveTickets();
                        const archiveEmbed = new EmbedBuilder()
                            .setColor("#ffa500")
                            .setTitle("📋 Ticket Archived")
                            .setDescription(`Ticket #${ticketId} has been closed and archived.\nThe transcript has been saved to the transcript logs.\n\nOnce the investigation is complete, click the button below to permanently delete this ticket.`)
                            .setTimestamp();
                        
                        const deleteButton = new ButtonBuilder()
                            .setCustomId(`ticket_delete_${ticketId}`)
                            .setLabel("Delete Ticket")
                            .setStyle(ButtonStyle.Danger);
                        
                        const sendTranscriptButton = new ButtonBuilder()
                            .setCustomId(`ticket_send_transcript_${ticketId}`)
                            .setLabel("Send Transcript")
                            .setStyle(ButtonStyle.Primary);
                        
                        const buttonRow = new ActionRowBuilder().addComponents(sendTranscriptButton, deleteButton);
                        
                        await interaction.channel.send({ embeds: [archiveEmbed], components: [buttonRow] }).catch(() => {});
                    } catch (error) {
                        console.error("Error removing opener from channel:", error);
                    }
                }, 1000);
            }

            // Deny close handler
            if (interaction.customId.startsWith("ticket_deny_close_")) {
                const ticketId = interaction.customId.replace("ticket_deny_close_", "");
                const ticket = tickets.tickets[ticketId];

                if (!ticket) {
                    return interaction.reply({
                        content: "❌ Ticket not found.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const denyEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setDescription("The ticket will remain open.")
                    .setTimestamp();

                await interaction.reply({ embeds: [denyEmbed] });
            }

            // Delete ticket handler
            if (interaction.customId.startsWith("ticket_delete_")) {
                const ticketId = interaction.customId.replace("ticket_delete_", "");
                const ticket = tickets.tickets[ticketId];

                if (!ticket) {
                    return interaction.reply({
                        content: "❌ Ticket not found.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Check if user is staff
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return interaction.reply({
                        content: "❌ Only staff can delete tickets.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const deleteConfirmEmbed = new EmbedBuilder()
                    .setColor("#8b0000")
                    .setTitle("🗑️ Ticket Permanently Deleted")
                    .setDescription(`Ticket #${ticketId} has been permanently deleted.\nThe transcript remains in the transcript logs for record-keeping.`)
                    .setTimestamp();

                await interaction.reply({ embeds: [deleteConfirmEmbed] });

                // Delete the ticket from the database
                delete tickets.tickets[ticketId];
                saveTickets();
                console.log("[TICKET DELETE] Ticket", ticketId, "removed from database");

                // Delete the channel after a short delay
                setTimeout(async () => {
                    try {
                        await interaction.channel.delete();
                        console.log("[TICKET DELETE] Channel deleted for ticket", ticketId);
                    } catch (error) {
                        console.error("Error deleting ticket channel:", error);
                    }
                }, 1500);
            }

            // Send transcript handler
            if (interaction.customId.startsWith("ticket_send_transcript_")) {
                const ticketId = interaction.customId.replace("ticket_send_transcript_", "");
                const ticket = tickets.tickets[ticketId];

                if (!ticket) {
                    return interaction.reply({
                        content: "❌ Ticket not found.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Check if user is staff
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return interaction.reply({
                        content: "❌ Only staff can send transcripts.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                try {
                    console.log("[TRANSCRIPT RESEND] Regenerating transcript for", ticketId);
                    
                    // Regenerate the transcript
                    const transcriptHtml = await generateTranscript(interaction.channel, ticket);
                    if (!transcriptHtml) {
                        return interaction.reply({
                            content: "❌ Failed to generate transcript.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    // Save the transcript
                    const transcriptFile = await saveTranscript(ticketId, transcriptHtml);
                    if (!transcriptFile) {
                        return interaction.reply({
                            content: "❌ Failed to save transcript.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    // Send to transcript log channel
                    console.log("[TRANSCRIPT RESEND] Sending to transcript channel");
                    try {
                        await sendTranscript(interaction.client, ticket, transcriptFile, transcriptHtml);
                        console.log("[TRANSCRIPT RESEND] ✅ Transcript sent successfully");
                    } catch (sendError) {
                        console.error("[TRANSCRIPT RESEND] ❌ Error sending transcript:", sendError.message || sendError);
                        throw sendError;
                    }

                    const successEmbed = new EmbedBuilder()
                        .setColor("#2d5a3d")
                        .setTitle("✅ Transcript Sent")
                        .setDescription(`Transcript for ticket #${ticketId} has been sent to the transcript logs.`)
                        .setTimestamp();

                    await interaction.reply({ embeds: [successEmbed] });
                } catch (error) {
                    console.error("Error sending transcript:", error);
                    const errorEmbed = new EmbedBuilder()
                        .setColor("#8b0000")
                        .setTitle("❌ Error Sending Transcript")
                        .setDescription(error.message || "An error occurred while sending the transcript.")
                        .setTimestamp();
                    
                    await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
                }
            }
        } catch (error) {
            console.error(error);
            await interaction.reply({
                content: `Error: ${error.message}`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }

    // Force End Patrol button handler
    if (interaction.isButton() && interaction.customId.startsWith("force_end_patrol_")) {
        try {
            const targetUserId = interaction.customId.replace("force_end_patrol_", "");

            // Check permission
            if (!canAccessModule(interaction.member, "supervisor")) {
                return interaction.reply({
                    content: "❌ You don't have permission to force end patrols.",
                    flags: MessageFlags.Ephemeral
                });
            }

            // End the patrol
            if (patrols[targetUserId]) {
                const deputyName = patrols[targetUserId].deputyName;
                patrols[targetUserId].active = false;
                patrols[targetUserId].endTime = Date.now();
                savePatrols();

                const embed = new EmbedBuilder()
                    .setColor("#00FF00")
                    .setTitle("✅ Patrol Ended")
                    .setDescription(`**${deputyName}'s** patrol has been force ended.`)
                    .addFields(
                        {
                            name: "Ended By",
                            value: interaction.user.username,
                            inline: true
                        },
                        {
                            name: "Ended At",
                            value: new Date().toLocaleTimeString(),
                            inline: true
                        }
                    )
                    .setTimestamp();

                // Send log to patrol channel
                const patrolLogChannel = client.channels.cache.get(config.logChannels.patrol);
                if (patrolLogChannel) {
                    await patrolLogChannel.send({ embeds: [embed] }).catch(() => {});
                }

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            } else {
                return interaction.reply({
                    content: "❌ Patrol not found.",
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            console.error("Force end patrol error:", error);
            return interaction.reply({
                content: `❌ Error: ${error.message}`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }

    // Notes Create button handler
    if (interaction.isButton() && interaction.customId === "notes_create") {
        try {
            const modal = new ModalBuilder()
                .setCustomId("notes_create_modal")
                .setTitle("Create Member Note");

            const userIdInput = new TextInputBuilder()
                .setCustomId("note_user_id")
                .setLabel("User ID")
                .setPlaceholder("Enter the user ID to create a note for")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const noteInput = new TextInputBuilder()
                .setCustomId("note_content")
                .setLabel("Note Content")
                .setPlaceholder("e.g., Warning for spam in general chat - repeat offense")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true);

            const row1 = new ActionRowBuilder().addComponents(userIdInput);
            const row2 = new ActionRowBuilder().addComponents(noteInput);
            modal.addComponents(row1, row2);

            return interaction.showModal(modal);
        } catch (error) {
            console.error("Notes create button error:", error);
            return interaction.reply({
                content: `❌ Error: ${error.message}`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }

    // Notes View button handler
    if (interaction.isButton() && interaction.customId === "notes_view") {
        try {
            const modal = new ModalBuilder()
                .setCustomId("notes_view_modal")
                .setTitle("View Member Notes");

            const userIdInput = new TextInputBuilder()
                .setCustomId("note_view_user_id")
                .setLabel("User ID")
                .setPlaceholder("Enter the user ID to view their notes")
                .setStyle(TextInputStyle.Short)
                .setRequired(true);

            const row = new ActionRowBuilder().addComponents(userIdInput);
            modal.addComponents(row);

            return interaction.showModal(modal);
        } catch (error) {
            console.error("Notes view button error:", error);
            return interaction.reply({
                content: `❌ Error: ${error.message}`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }

    // Handle autocomplete for case-id options
    if (interaction.isAutocomplete()) {
        const focusedOption = interaction.options.getFocused(true);
        
        if (focusedOption.name === "case-id") {
            const query = focusedOption.value.toUpperCase();
            const commandName = interaction.commandName;
            const allCases = Object.values(casesData.cases);
            
            // For reopen: show only closed cases
            // For other commands: show all cases
            let casesToShow = allCases;
            if (commandName === "case-reopen") {
                casesToShow = allCases.filter(c => c.status === "Closed");
            }
            
            // Filter cases based on query (match ID or title)
            const filtered = casesToShow.filter(c => 
                c.caseId.includes(query) ||
                c.title.toUpperCase().includes(query)
            ).slice(0, 25); // Discord limit is 25 choices
            
            // Format choices as "CASE-000001 — Case Title"
            const choices = filtered.map(c => ({
                name: `${c.caseId} — ${c.title} (${c.status})`,
                value: c.caseId
            }));
            
            await interaction.respond(choices);
        }
    }

    // Handle modal submissions for ticket close reason
    if (interaction.isModalSubmit()) {
        try {
            // Handle promote modal
            if (interaction.customId === "promote_modal") {
                const userId = interaction.fields.getTextInputValue("promote_user_id");
                const roleId = interaction.fields.getTextInputValue("promote_role_id");

                const embed = new EmbedBuilder()
                    .setColor("#00FF00")
                    .setTitle("✏️ Member Promoted")
                    .setDescription(`<@${userId}> has been promoted.`)
                    .addFields(
                        { name: "Role Added", value: `<@&${roleId}>`, inline: true },
                        { name: "Promoted By", value: interaction.user.username, inline: true }
                    )
                    .setTimestamp();

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Handle demote modal
            if (interaction.customId === "demote_modal") {
                const userId = interaction.fields.getTextInputValue("demote_user_id");
                const roleId = interaction.fields.getTextInputValue("demote_role_id");

                const embed = new EmbedBuilder()
                    .setColor("#FF6B6B")
                    .setTitle("✏️ Member Demoted")
                    .setDescription(`<@${userId}> has been demoted.`)
                    .addFields(
                        { name: "Role Removed", value: `<@&${roleId}>`, inline: true },
                        { name: "Demoted By", value: interaction.user.username, inline: true }
                    )
                    .setTimestamp();

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === "training_addcert_modal" || interaction.customId === "training_removecert_modal") {
                if (!interaction.guildId || !interaction.guild) {
                    return interaction.reply({
                        content: "❌ This action can only be used in a server.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const isAddAction = interaction.customId === "training_addcert_modal";
                const userId = interaction.fields.getTextInputValue("training_user_id").trim();
                const certInput = interaction.fields.getTextInputValue("training_cert_name").trim();
                const certRoleId = resolveTrainingCertificationRoleId(certInput);

                if (!certRoleId) {
                    return interaction.reply({
                        content: "❌ Invalid certification. Use one of: SWAT, CUI, K9, TRAFFIC ENFORCEMENT, SPEED ENFORCEMENT, INTERNAL AFFAIRS (or one of their role IDs).",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const guild = interaction.guild;
                const targetMember = await guild.members.fetch(userId).catch(() => null);
                if (!targetMember) {
                    return interaction.reply({
                        content: "❌ That user is not in this server.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
                if (!me) {
                    return interaction.reply({
                        content: "❌ Could not resolve bot member in this server.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
                    return interaction.reply({
                        content: "❌ Bot is missing Manage Roles permission.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (me.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
                    return interaction.reply({
                        content: "❌ Bot role must be above the target member's highest role.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const certRole = guild.roles.cache.get(certRoleId) || await guild.roles.fetch(certRoleId).catch(() => null);
                if (!certRole) {
                    return interaction.reply({
                        content: `❌ Certification role not found: ${certRoleId}`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (me.roles.highest.comparePositionTo(certRole) <= 0) {
                    return interaction.reply({
                        content: `❌ Bot role must be above ${certRole.name} (${certRole.id}).`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                const alreadyHasRole = targetMember.roles.cache.has(certRoleId);

                if (isAddAction && alreadyHasRole) {
                    return interaction.reply({
                        content: `❌ <@${targetMember.id}> already has ${certRole.name}.`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                if (!isAddAction && !alreadyHasRole) {
                    return interaction.reply({
                        content: `❌ <@${targetMember.id}> does not have ${certRole.name}.`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                try {
                    if (isAddAction) {
                        await targetMember.roles.add(certRoleId);
                    } else {
                        await targetMember.roles.remove(certRoleId);
                    }
                } catch (error) {
                    return interaction.reply({
                        content: `❌ Failed to ${isAddAction ? "add" : "remove"} ${certRole.name}: ${error.message}`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                await targetMember.fetch().catch(() => null);
                const noCertSync = await syncNoTrainingCertificationRole(guild, targetMember, me);

                const embed = new EmbedBuilder()
                    .setColor(isAddAction ? "#2d5a3d" : "#8b0000")
                    .setTitle(isAddAction ? "✅ Certification Added" : "✅ Certification Removed")
                    .addFields(
                        { name: "Member", value: `<@${targetMember.id}>`, inline: true },
                        { name: "Certification", value: `${getTrainingCertificationName(certRoleId)} (<@&${certRoleId}>)`, inline: false },
                        { name: "Updated By", value: `<@${interaction.user.id}>`, inline: true }
                    )
                    .setTimestamp();

                if (noCertSync.action === "added") {
                    embed.addFields({
                        name: "No-Cert Role Update",
                        value: `Added <@&${TRAINING_NO_CERT_ROLE_ID}> because member has no certifications.`,
                        inline: false
                    });
                }

                if (noCertSync.action === "removed") {
                    embed.addFields({
                        name: "No-Cert Role Update",
                        value: `Removed <@&${TRAINING_NO_CERT_ROLE_ID}> because member has a certification.`,
                        inline: false
                    });
                }

                if (noCertSync.warning) {
                    embed.addFields({
                        name: "No-Cert Sync Warning",
                        value: noCertSync.warning.slice(0, 1024),
                        inline: false
                    });
                }

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Handle moderation modal submissions
            if (interaction.customId === "strike_modal") {
                const userId = interaction.fields.getTextInputValue("strike_user_id");
                const reason = interaction.fields.getTextInputValue("strike_reason");

                if (!interaction.guildId) {
                    return interaction.reply({
                        content: "❌ This action can only be used in a server.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const strikeEntries = getUserStrikeEntries(interaction.guildId, userId);

                if (strikeEntries.length >= MAX_STRIKES) {
                    await notifyOverStrikeAttempt(
                        interaction.client,
                        userId,
                        strikeEntries.length,
                        interaction.user.id,
                        reason,
                        "dashboard strike modal"
                    );

                    const overLimitLogEmbed = new EmbedBuilder()
                        .setColor("#8b0000")
                        .setTitle("🚨 Over-Strike Attempt Blocked")
                        .addFields(
                            { name: "User", value: `<@${userId}>`, inline: false },
                            { name: "Current Strikes", value: `${strikeEntries.length}/${MAX_STRIKES}`, inline: true },
                            { name: "Attempted By", value: `<@${interaction.user.id}>`, inline: true },
                            { name: "Reason", value: reason, inline: false },
                            { name: "Source", value: "Dashboard Strike Modal", inline: true }
                        )
                        .setTimestamp();

                    const overLimitLogResult = await sendStrikeLog(interaction.client, interaction.guildId, overLimitLogEmbed);

                    const limitEmbed = new EmbedBuilder()
                        .setColor("#8b0000")
                        .setTitle("❌ Strike Limit Reached")
                        .addFields(
                            { name: "User", value: `<@${userId}>`, inline: false },
                            { name: "Current Strikes", value: `${MAX_STRIKES}`, inline: true },
                            { name: "Status", value: `Maximum strikes reached (${MAX_STRIKES}/${MAX_STRIKES})`, inline: false }
                        )
                        .setTimestamp();

                    if (!overLimitLogResult.ok) {
                        limitEmbed.addFields({
                            name: "Log Warning",
                            value: overLimitLogResult.error.slice(0, 1024),
                            inline: false
                        });
                    }

                    return interaction.reply({ embeds: [limitEmbed], flags: MessageFlags.Ephemeral });
                }

                // Add strike
                strikeEntries.push({
                    reason,
                    date: new Date().toISOString(),
                    givenBy: interaction.user.id
                });
                saveStrikes();

                const totalStrikes = strikeEntries.length;
                const roleId = STRIKE_ROLE_IDS[totalStrikes - 1] || "None";
                const roleSync = await syncUserStrikeRoles(interaction.guild, userId, totalStrikes);

                const embed = new EmbedBuilder()
                    .setColor("#FF6B6B")
                    .setTitle("✅ Strike Issued")
                    .setDescription(`<@${userId}> has been issued a strike.`)
                    .addFields(
                        { name: "Reason", value: reason, inline: false },
                        { name: "Total Strikes", value: totalStrikes.toString(), inline: true },
                        { name: "Role Added", value: `<@&${roleId}>`, inline: true },
                        { name: "Issued By", value: interaction.user.username, inline: true }
                    )
                    .setTimestamp();

                if (!roleSync.ok && roleSync.errors.length > 0) {
                    embed.addFields({
                        name: "Role Sync Warning",
                        value: roleSync.errors.slice(0, 2).join("\n").slice(0, 1024),
                        inline: false
                    });
                }

                const strikeLogEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("⚖️ Strike Logged")
                    .addFields(
                        { name: "User", value: `<@${userId}>`, inline: false },
                        { name: "Strike Count", value: `${totalStrikes}/${MAX_STRIKES}`, inline: true },
                        { name: "Reason", value: reason, inline: false },
                        { name: "Given By", value: `<@${interaction.user.id}>`, inline: true },
                        { name: "Source", value: "Dashboard Strike Modal", inline: true }
                    )
                    .setTimestamp();

                const strikeLogResult = await sendStrikeLog(interaction.client, interaction.guildId, strikeLogEmbed);

                if (!strikeLogResult.ok) {
                    embed.addFields({
                        name: "Log Warning",
                        value: strikeLogResult.error.slice(0, 1024),
                        inline: false
                    });
                }

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === "timeout_modal") {
                const userId = interaction.fields.getTextInputValue("timeout_user_id");
                const durationStr = interaction.fields.getTextInputValue("timeout_duration").toLowerCase();
                const reason = interaction.fields.getTextInputValue("timeout_reason");

                // Parse duration
                let durationMs = 0;
                const match = durationStr.match(/(\d+)([mh])/);
                if (!match) {
                    return interaction.reply({
                        content: "❌ Invalid duration format. Use 20m for minutes or 2h for hours.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const value = parseInt(match[1]);
                const unit = match[2];

                if (unit === "m") {
                    durationMs = value * 60 * 1000;
                } else if (unit === "h") {
                    durationMs = value * 60 * 60 * 1000;
                }

                // Apple timeout (limited to 28 days by Discord)
                const maxDuration = 28 * 24 * 60 * 60 * 1000;
                if (durationMs > maxDuration) {
                    return interaction.reply({
                        content: "❌ Duration cannot exceed 28 days.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const embed = new EmbedBuilder()
                    .setColor("#FFD700")
                    .setTitle("⏱️ Timeout Issued")
                    .setDescription(`<@${userId}> has been timed out.`)
                    .addFields(
                        { name: "Duration", value: durationStr, inline: true },
                        { name: "Reason", value: reason, inline: false },
                        { name: "Issued By", value: interaction.user.username, inline: true }
                    )
                    .setTimestamp();

                // Log to timeout channel if configured
                const timeoutLogChannel = client.channels.cache.get(config.logChannels.timeout);
                if (timeoutLogChannel) {
                    await timeoutLogChannel.send({ embeds: [embed] }).catch(() => {});
                }

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === "ban_modal") {
                const userId = interaction.fields.getTextInputValue("ban_user_id");
                const reason = interaction.fields.getTextInputValue("ban_reason");

                const embed = new EmbedBuilder()
                    .setColor("#8B0000")
                    .setTitle("🚫 Ban Issued")
                    .setDescription(`<@${userId}> has been banned from the server.`)
                    .addFields(
                        { name: "Reason", value: reason, inline: false },
                        { name: "Banned By", value: interaction.user.username, inline: true }
                    )
                    .setTimestamp();

                // Log to ban channel if configured
                const banLogChannelId = getLogChannelId(interaction.guildId, "ban");
                const banLogChannel = banLogChannelId
                    ? (client.channels.cache.get(banLogChannelId) || await client.channels.fetch(banLogChannelId).catch(() => null))
                    : null;
                if (banLogChannel) {
                    await banLogChannel.send({ embeds: [embed] }).catch(() => {});
                }

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === "blacklist_modal") {
                const userId = interaction.fields.getTextInputValue("blacklist_user_id");
                const reason = interaction.fields.getTextInputValue("blacklist_reason");

                const embed = new EmbedBuilder()
                    .setColor("#2C2F33")
                    .setTitle("📝 Added to Blacklist")
                    .setDescription(`<@${userId}> has been added to the blacklist.`)
                    .addFields(
                        { name: "Reason", value: reason, inline: false },
                        { name: "Blacklisted By", value: interaction.user.username, inline: true }
                    )
                    .setTimestamp();

                // Log to blacklist channel if configured
                const blacklistLogChannelId = getLogChannelId(interaction.guildId, "blacklist");
                const blacklistLogChannel = blacklistLogChannelId
                    ? (client.channels.cache.get(blacklistLogChannelId) || await client.channels.fetch(blacklistLogChannelId).catch(() => null))
                    : null;
                if (blacklistLogChannel) {
                    await blacklistLogChannel.send({ embeds: [embed] }).catch(() => {});
                }

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Handle create note modal submission
            if (interaction.customId === "notes_create_modal") {
                const userId = interaction.fields.getTextInputValue("note_user_id");
                const noteContent = interaction.fields.getTextInputValue("note_content");

                // Initialize user notes if not exists
                if (!notesData.notes[userId]) {
                    notesData.notes[userId] = [];
                }

                // Add note
                notesData.notes[userId].push({
                    text: noteContent,
                    author: interaction.user.id,
                    authorName: interaction.user.username,
                    timestamp: new Date().toISOString()
                });
                saveNotes();

                const embed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("✅ Note Created")
                    .setDescription(`Note added for <@${userId}>.`)
                    .addFields(
                        { name: "Note", value: noteContent, inline: false },
                        { name: "Created By", value: interaction.user.username, inline: true },
                        { name: "Total Notes", value: notesData.notes[userId].length.toString(), inline: true }
                    )
                    .setTimestamp();

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Handle view notes modal submission
            if (interaction.customId === "notes_view_modal") {
                const userId = interaction.fields.getTextInputValue("note_view_user_id");

                // Check if user has notes
                if (!notesData.notes[userId] || notesData.notes[userId].length === 0) {
                    return interaction.reply({
                        content: `❌ No notes found for <@${userId}>.`,
                        flags: MessageFlags.Ephemeral
                    });
                }

                const userNotes = notesData.notes[userId];
                const embed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle(`📝 Notes for ${userId}`)
                    .setDescription(`Total notes: ${userNotes.length}`)
                    .setTimestamp();

                // Add notes to embed (limit to 25 fields per embed)
                for (let i = 0; i < Math.min(userNotes.length, 25); i++) {
                    const note = userNotes[i];
                    const noteDate = new Date(note.timestamp).toLocaleString();
                    const fieldValue = `**By:** ${note.authorName}\n**Date:** ${noteDate}\n**Note:** ${note.text}`;
                    
                    embed.addFields({
                        name: `Note ${i + 1}`,
                        value: fieldValue,
                        inline: false
                    });
                }

                // Add pagination info if needed
                if (userNotes.length > 25) {
                    embed.setFooter({
                        text: `Showing first 25 of ${userNotes.length} notes`
                    });
                }

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Handle promote/demote modal submissions
            if (interaction.customId === "promote_modal") {
                const userId = interaction.fields.getTextInputValue("promote_user_id");
                const roleId = interaction.fields.getTextInputValue("promote_role_id");

                const embed = new EmbedBuilder()
                    .setColor("#00FF00")
                    .setTitle("✍️ Member Promoted")
                    .setDescription(`<@${userId}> has been promoted.`)
                    .addFields(
                        { name: "Role Added", value: `<@&${roleId}>`, inline: true },
                        { name: "Promoted By", value: interaction.user.username, inline: true }
                    )
                    .setTimestamp();

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId === "demote_modal") {
                const userId = interaction.fields.getTextInputValue("demote_user_id");
                const roleId = interaction.fields.getTextInputValue("demote_role_id");

                const embed = new EmbedBuilder()
                    .setColor("#FF6B6B")
                    .setTitle("✍️ Member Demoted")
                    .setDescription(`<@${userId}> has been demoted.`)
                    .addFields(
                        { name: "Role Removed", value: `<@&${roleId}>`, inline: true },
                        { name: "Demoted By", value: interaction.user.username, inline: true }
                    )
                    .setTimestamp();

                return interaction.reply({
                    embeds: [embed],
                    flags: MessageFlags.Ephemeral
                });
            }

            // Handle alert supervisors message collection
            if (interaction.isMessage && interaction.content && interaction.channelId && !interaction.author.bot) {
                // Check if message is in response to supervisor alert
                try {
                    const repliedTo = await interaction.channel.messages.fetch(interaction.reference?.messageId);
                    if (repliedTo && repliedTo.content && repliedTo.content.includes("Send Alert to Supervisors")) {
                        const alertMessage = interaction.content;
                        
                        // Delete the user's message
                        await interaction.delete().catch(() => {});

                        // Find all members who have access to supervisor tools
                        const guild = interaction.guild;
                        const supervisorRoleIds = config.moduleRoleAccess?.supervisor || [];
                        
                        let supervisorMembers = new Set();
                        
                        for (const member of (await guild.members.fetch()).values()) {
                            // Check if they have supervisor access
                            const hasAccess = canAccessModule(member, "supervisor");
                            if (hasAccess) {
                                supervisorMembers.add(member);
                            }
                        }

                        // Send DM to each supervisor
                        const alertEmbed = new EmbedBuilder()
                            .setColor("#FF0000")
                            .setTitle("🚨 Supervisor Alert")
                            .setDescription(alertMessage)
                            .addFields(
                                { name: "Sent By", value: interaction.author.username, inline: true },
                                { name: "Sent At", value: new Date().toLocaleString(), inline: true }
                            )
                            .setTimestamp();

                        for (const supervisor of supervisorMembers) {
                            try {
                                await supervisor.send({ embeds: [alertEmbed] });
                            } catch (err) {
                                console.log(`Could not DM ${supervisor.user.username}`);
                            }
                        }

                        // Confirm alert was sent
                        const confirmEmbed = new EmbedBuilder()
                            .setColor("#00FF00")
                            .setTitle("✅ Alert Sent")
                            .setDescription(`Alert sent to ${supervisorMembers.size} supervisor(s).`)
                            .setTimestamp();

                        await interaction.reply({
                            embeds: [confirmEmbed],
                            flags: MessageFlags.Ephemeral
                        }).catch(() => {});
                    }
                } catch (err) {
                    // Not a reply to supervisor alert, ignore
                }
            }

            // Handle role configuration modal submissions
            if (interaction.customId.startsWith("role_config_")) {
                const botOwnerId = "967375704486449222";
                if (interaction.user.id !== botOwnerId) {
                    return interaction.reply({
                        content: "❌ Only the bot owner can configure roles.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const moduleType = interaction.customId.replace("role_config_", "");
                const roleInput = interaction.fields.getTextInputValue("role_id_input").trim();
                
                // Parse role IDs/keywords from comma-separated input
                const roleIds = roleInput
                    .split(",")
                    .map(id => id.trim().toLowerCase())
                    .filter(id => id.length > 0);

                // Update config with new role IDs
                if (!config.moduleRoleAccess) {
                    config.moduleRoleAccess = {};
                }
                config.moduleRoleAccess[moduleType] = roleIds;
                saveConfig();

                const moduleName = {
                    patrol: "Patrol",
                    cases: "Cases",
                    ia: "IA",
                    tickets: "Tickets",
                    moderation: "Moderation",
                    training: "Training",
                    logs: "Logs",
                    bot: "Bot Settings",
                    analytics: "Analytics",
                    supervisor: "Supervisor"
                };

                // Format the role IDs for display
                let roleDisplay = "";
                if (roleIds.length === 0) {
                    roleDisplay = "No specific roles (default access rules apply)";
                } else if (roleIds.includes("everyone")) {
                    roleDisplay = "@everyone - Everyone has access";
                } else {
                    roleDisplay = roleIds.map(id => `<@&${id}>`).join(", ");
                }

                const successEmbed = new EmbedBuilder()
                    .setColor("#00FF00")
                    .setTitle("✅ Configuration Updated")
                    .setDescription(`**${moduleName[moduleType] || moduleType}** access roles have been updated.`)
                    .addFields(
                        { name: "Allowed Roles", value: roleDisplay, inline: false }
                    )
                    .setTimestamp();

                return interaction.reply({
                    embeds: [successEmbed],
                    flags: MessageFlags.Ephemeral
                });
            }

            if (interaction.customId.startsWith("ticket_close_reason_")) {
                const ticketId = interaction.customId.replace("ticket_close_reason_", "");
                const ticket = tickets.tickets[ticketId];
                const reason = interaction.fields.getTextInputValue("close_reason");

                if (!ticket) {
                    return interaction.reply({
                        content: "❌ Ticket not found.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const closeRequestEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("Close Request")
                    .setDescription(`<@${interaction.user.id}> has requested to close this ticket.\n\nReason:\n\`\`\`${reason}\`\`\`\n\nPlease accept or deny using the buttons below.`)
                    .setTimestamp();

                const acceptButton = new ButtonBuilder()
                    .setCustomId(`ticket_accept_close_${ticketId}`)
                    .setLabel("Accept & Close")
                    .setStyle(ButtonStyle.Success);

                const denyButton = new ButtonBuilder()
                    .setCustomId(`ticket_deny_close_${ticketId}`)
                    .setLabel("Deny")
                    .setStyle(ButtonStyle.Danger);

                const buttonRow = new ActionRowBuilder().addComponents(acceptButton, denyButton);

                // Send the close request to the ticket channel
                const ticketChannel = await interaction.client.channels.fetch(ticket.channel);
                await ticketChannel.send({
                    content: `<@${ticket.opener}>`,
                    embeds: [closeRequestEmbed],
                    components: [buttonRow]
                });

                return interaction.reply({
                    content: "✅ Close request sent to ticket opener.",
                    flags: MessageFlags.Ephemeral
                });
            }
        } catch (error) {
            console.error("Modal submission error:", error);
            interaction.reply({
                content: `Error: ${error.message}`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }

    // Dashboard module button handlers
    if (interaction.isButton && interaction.isButton() && interaction.customId.startsWith("dashboard_")) {
        try {
            // Check if user has access to dashboard
            if (!canAccessDashboard(interaction.member)) {
                return interaction.reply({
                    content: "❌ You don't have permission to access the dashboard.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const moduleType = interaction.customId.replace("dashboard_", "");

            // Check if user has access to this specific module (skip for owner module and owner sub-buttons - they have their own checks)
            if (!moduleType.startsWith("owner") && !canAccessModule(interaction.member, moduleType)) {
                return interaction.reply({
                    content: "❌ You don't have permission to access this module.",
                    flags: MessageFlags.Ephemeral
                });
            }

            // PATROL MODULE
            if (moduleType === "patrol") {
                const patrolEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("🚔 Patrol System")
                    .setDescription("Manage and monitor all patrol activities in the department.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_patrol_active").setLabel("Active Patrols").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_patrol_end").setLabel("Force End").setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId("dashboard_patrol_zones").setLabel("Zones").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_patrol_settings").setLabel("Settings").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [patrolEmbed],
                    components: [row1, row2],
                    flags: MessageFlags.Ephemeral
                });
            }

            // CASES MODULE
            if (moduleType === "cases") {
                const casesEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("📋 Case Management")
                    .setDescription("Create, manage, and investigate cases efficiently.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_cases_create").setLabel("Create Case").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_cases_view").setLabel("View Case").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_cases_assign").setLabel("Assign").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_cases_close").setLabel("Close").setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId("dashboard_cases_evidence").setLabel("Evidence").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_cases_search").setLabel("Search").setStyle(ButtonStyle.Primary)
                );

                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [casesEmbed],
                    components: [row1, row2, row3],
                    flags: MessageFlags.Ephemeral
                });
            }

            // IA MODULE
            if (moduleType === "ia") {
                const iaEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("⚖️ Internal Affairs")
                    .setDescription("Manage Internal Affairs investigations and compliance.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_ia_open").setLabel("Open IA Case").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_ia_evidence").setLabel("Add Evidence").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_ia_notes").setLabel("Notes").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_ia_assign").setLabel("Assign").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_ia_close").setLabel("Close").setStyle(ButtonStyle.Danger)
                );

                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [iaEmbed],
                    components: [row1, row2, row3],
                    flags: MessageFlags.Ephemeral
                });
            }

            // TICKETS MODULE
            if (moduleType === "tickets") {
                const ticketsEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("🎫 Ticket System")
                    .setDescription("Configure and manage all ticket system features.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_tickets_create").setLabel("Create Panel").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_tickets_transcript").setLabel("Transcript Settings").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_tickets_logs").setLabel("Ticket Logs").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_tickets_categories").setLabel("Categories").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [ticketsEmbed],
                    components: [row1, row2],
                    flags: MessageFlags.Ephemeral
                });
            }

            // MODERATION MODULE
            if (moduleType === "moderation") {
                const modEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("🔨 Moderation Tools")
                    .setDescription("Enforce department policies and manage member discipline.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_mod_strike").setLabel("Strike").setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId("dashboard_mod_timeout").setLabel("Timeout").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_mod_ban").setLabel("Ban").setStyle(ButtonStyle.Danger)
                );

                const row1b = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_mod_blacklist").setLabel("Blacklist").setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId("dashboard_mod_notes").setLabel("Notes").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [modEmbed],
                    components: [row1, row1b, row2],
                    flags: MessageFlags.Ephemeral
                });


            }

            // TRAINING MODULE
            if (moduleType === "training") {
                const trainingEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("📚 Training & Certifications")
                    .setDescription("Manage member training status and certifications.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_training_addcert").setLabel("Add Cert").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_training_removecert").setLabel("Remove Cert").setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId("dashboard_training_required").setLabel("Training Required").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_training_complete").setLabel("Training Complete").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [trainingEmbed],
                    components: [row1, row2],
                    flags: MessageFlags.Ephemeral
                });
            }

            // LOGS MODULE
            if (moduleType === "logs") {
                const logsEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("📜 Log Channel Settings")
                    .setDescription("Configure log channels for all department systems.")
                    .addFields(
                        { name: "Instructions", value: "Click a button, then run /set-log-channel <type> in the channel you want to set.", inline: false }
                    )
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_logs_patrol").setLabel("Set Patrol Log").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_logs_case").setLabel("Set Case Log").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_logs_strike").setLabel("Set Strike Log").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_logs_loa").setLabel("Set LOA Log").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_logs_transcript").setLabel("Set Transcript Log").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_logs_ticket").setLabel("Set Ticket Log").setStyle(ButtonStyle.Primary)
                );

                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_logs_ia").setLabel("Set IA Log").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_logs_commendations").setLabel("Set Commendation Log").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [logsEmbed],
                    components: [row1, row2, row3],
                    flags: MessageFlags.Ephemeral
                });
            }

            // BOT SETTINGS MODULE
            if (moduleType === "bot") {
                const botEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("⚙️ Bot Settings")
                    .setDescription("Configure bot behavior, status, and settings.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_bot_status").setLabel("Set Status").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_bot_custom").setLabel("Custom Status").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_bot_info").setLabel("Bot Info").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_bot_ping").setLabel("Ping").setStyle(ButtonStyle.Success)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [botEmbed],
                    components: [row1, row2],
                    flags: MessageFlags.Ephemeral
                });
            }

            // ANALYTICS MODULE
            if (moduleType === "analytics") {
                const analyticsEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("📊 Analytics & Activity")
                    .setDescription("View comprehensive department statistics and activity reports.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_analytics_patrol").setLabel("Patrol Stats").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_analytics_cases").setLabel("Case Stats").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_analytics_ia").setLabel("IA Stats").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_analytics_tickets").setLabel("Ticket Stats").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_analytics_activity").setLabel("Activity Check").setStyle(ButtonStyle.Primary)
                );

                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [analyticsEmbed],
                    components: [row1, row2, row3],
                    flags: MessageFlags.Ephemeral
                });
            }

            // SUPERVISOR MODULE
            if (moduleType === "supervisor") {
                const supervisorEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("👮 Supervisor Tools")
                    .setDescription("Advanced administrative and supervisory functions.")
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_supervisor_promote").setLabel("Promote").setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId("dashboard_supervisor_demote").setLabel("Demote").setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId("dashboard_supervisor_review").setLabel("Review").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_supervisor_alert").setLabel("Alert Supervisors").setStyle(ButtonStyle.Danger)
                );

                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [supervisorEmbed],
                    components: [row1, row2, row3],
                    flags: MessageFlags.Ephemeral
                });
            }

            // PATROL SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_patrol_")) {
                const subAction = interaction.customId.replace("dashboard_patrol_", "");
                
                if (subAction === "active") {
                    let patrolList = "**Currently Active Patrols:**\n\n";
                    let count = 0;
                    
                    for (const [deputyId, patrol] of Object.entries(patrols)) {
                        if (patrol.active) {
                            const duration = Math.floor((Date.now() - patrol.startTime) / 1000 / 60);
                            patrolList += `👮 **${patrol.deputyName}** - <t:${Math.floor(patrol.startTime / 1000)}:R> (${duration} min)\n`;
                            count++;
                        }
                    }
                    
                    if (count === 0) patrolList += "No active patrols right now.";
                    
                    return interaction.reply({
                        content: patrolList,
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "end") {
                    // Check if user has access to Supervisor Tools
                    if (!canAccessModule(interaction.member, "supervisor")) {
                        return interaction.reply({
                            content: "❌ You don't have permission to force end patrols. Only supervisors can end other deputies' shifts.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    // Get active patrols
                    const activePatrols = [];
                    for (const [userId, patrolData] of Object.entries(patrols)) {
                        if (patrolData.active) {
                            activePatrols.push({
                                userId,
                                deputyName: patrolData.deputyName,
                                startTime: patrolData.startTime
                            });
                        }
                    }

                    if (activePatrols.length === 0) {
                        return interaction.reply({
                            content: "✅ No active patrols to end.",
                            flags: MessageFlags.Ephemeral
                        });
                    }

                    // Create embed showing active patrols
                    const embed = new EmbedBuilder()
                        .setColor("#FF6B6B")
                        .setTitle("🛑 Force End Patrol")
                        .setDescription(`**${activePatrols.length}** active patrol(s) available to end:`)
                        .addFields(
                            activePatrols.map(patrol => {
                                const duration = Math.floor((Date.now() - patrol.startTime) / 60000);
                                return {
                                    name: patrol.deputyName,
                                    value: `Patrol Duration: ${duration} minutes`,
                                    inline: false
                                };
                            })
                        )
                        .setTimestamp();

                    // Create buttons for each active patrol
                    const rows = [];
                    for (let i = 0; i < activePatrols.length; i += 2) {
                        const row = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId(`force_end_patrol_${activePatrols[i].userId}`)
                                .setLabel(`End ${activePatrols[i].deputyName}'s Patrol`)
                                .setStyle(ButtonStyle.Danger)
                        );
                        
                        if (i + 1 < activePatrols.length) {
                            row.addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`force_end_patrol_${activePatrols[i + 1].userId}`)
                                    .setLabel(`End ${activePatrols[i + 1].deputyName}'s Patrol`)
                                    .setStyle(ButtonStyle.Danger)
                            );
                        }
                        rows.push(row);
                    }

                    return interaction.reply({
                        embeds: [embed],
                        components: rows,
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "zones") {
                    return interaction.reply({
                        content: "📍 **Patrol Zones**\n\nZone management coming soon. Patrols are currently unrestricted department-wide.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "settings") {
                    return interaction.reply({
                        content: "⚙️ **Patrol Settings**\n\n• Patrols automatically tracked with start/end times\n• Deputies can start/stop patrols anytime\n• LOA deputies cannot start patrols\n• Patrol history available via `/patrol` command",
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // CASES SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_cases_")) {
                const subAction = interaction.customId.replace("dashboard_cases_", "");
                
                if (subAction === "create") {
                    return interaction.reply({
                        content: "📋 **Create Case**\n\nUse `/case-create` command to create a new investigation case.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "view") {
                    let caseList = "**Active Cases:**\n\n";
                    let count = 0;
                    
                    for (const [caseId, caseData] of Object.entries(casesData.cases || {})) {
                        if (!caseData.closed && count < 5) {
                            caseList += `📂 **${caseData.caseNumber}** - ${caseData.title}\n`;
                            count++;
                        }
                    }
                    
                    if (count === 0) caseList += "No active cases currently.";
                    return interaction.reply({
                        content: caseList,
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "assign") {
                    return interaction.reply({
                        content: "👮 **Assign Detective**\n\nUse `/case-assign` to assign a detective to an active case.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "close") {
                    return interaction.reply({
                        content: "🔒 **Close Case**\n\nUse `/case-close` to close and archive an investigation.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "evidence") {
                    return interaction.reply({
                        content: "🔍 **Evidence Management**\n\nUse `/evidence-add` to add evidence to an active case.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "search") {
                    return interaction.reply({
                        content: "🔎 **Search Cases**\n\nUse `/case-search` to find and review past cases.",
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // IA SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_ia_")) {
                const subAction = interaction.customId.replace("dashboard_ia_", "");
                
                if (subAction === "open") {
                    return interaction.reply({
                        content: "📋 **Open IA Case**\n\nInternal Affairs investigators use this to initiate new investigations. Contact your IA supervisor to create a case.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "evidence") {
                    return interaction.reply({
                        content: "🔍 **Add Evidence**\n\nDocument and upload evidence related to ongoing IA investigations.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "notes") {
                    return interaction.reply({
                        content: "📝 **Internal Notes**\n\nAdd confidential notes to IA cases. Only visible to authorized IA personnel.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "assign") {
                    return interaction.reply({
                        content: "👮 **Assign Investigator**\n\nAssign IA investigators to conduct investigations.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "close") {
                    return interaction.reply({
                        content: "✅ **Close Investigation**\n\nClose completed IA cases with findings and resolution.",
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // TICKETS SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_tickets_")) {
                const subAction = interaction.customId.replace("dashboard_tickets_", "");
                
                if (subAction === "create") {
                    return interaction.reply({
                        content: "🎫 **Create Ticket Panel**\n\nUse `/ticket-panel` command to deploy a new ticket creation panel.\n\nThis allows members to open support tickets.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "transcript") {
                    return interaction.reply({
                        content: "📜 **Transcript Settings**\n\nTranscripts are automatically generated and sent to your configured transcript log channel when tickets close.\n\nUse `/set-log-channel transcript` to configure.\n\nTranscripts include all messages, user info, and ticket metadata.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "logs") {
                    let ticketLog = "**Recent Tickets:**\n\n";
                    let count = 0;
                    
                    for (const [ticketId, ticket] of Object.entries(tickets.tickets || {})) {
                        if (count < 8) {
                            const status = ticket.closed ? "✅ Closed" : "🔴 Open";
                            ticketLog += `${status} **${ticketId}** - <@${ticket.opener}>\n`;
                            count++;
                        }
                    }
                    
                    if (count === 0) ticketLog += "No tickets yet.";
                    return interaction.reply({
                        content: ticketLog,
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "categories") {
                    return interaction.reply({
                        content: "📂 **Ticket Categories**\n\nTicket types are configured in the ticket panel buttons.\n\nStandard categories:\n• Support\n• Bug Report\n• Feature Request\n• Other",
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // MODERATION SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_mod_")) {
                const subAction = interaction.customId.replace("dashboard_mod_", "");
                
                if (subAction === "strike") {
                    const modal = new ModalBuilder()
                        .setCustomId("strike_modal")
                        .setTitle("Issue Strike");

                    const userIdInput = new TextInputBuilder()
                        .setCustomId("strike_user_id")
                        .setLabel("User ID")
                        .setPlaceholder("Enter the user ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const reasonInput = new TextInputBuilder()
                        .setCustomId("strike_reason")
                        .setLabel("Reason")
                        .setPlaceholder("e.g., Rule violation, misconduct")
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true);

                    const row1 = new ActionRowBuilder().addComponents(userIdInput);
                    const row2 = new ActionRowBuilder().addComponents(reasonInput);
                    modal.addComponents(row1, row2);

                    return interaction.showModal(modal);
                }
                if (subAction === "timeout") {
                    const modal = new ModalBuilder()
                        .setCustomId("timeout_modal")
                        .setTitle("Timeout Member");

                    const userIdInput = new TextInputBuilder()
                        .setCustomId("timeout_user_id")
                        .setLabel("User ID")
                        .setPlaceholder("Enter the user ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const durationInput = new TextInputBuilder()
                        .setCustomId("timeout_duration")
                        .setLabel("Duration")
                        .setPlaceholder("e.g., 20m for 20 minutes or 2h for 2 hours")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const reasonInput = new TextInputBuilder()
                        .setCustomId("timeout_reason")
                        .setLabel("Reason")
                        .setPlaceholder("e.g., Spam, harassment")
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true);

                    const row1 = new ActionRowBuilder().addComponents(userIdInput);
                    const row2 = new ActionRowBuilder().addComponents(durationInput);
                    const row3 = new ActionRowBuilder().addComponents(reasonInput);
                    modal.addComponents(row1, row2, row3);

                    return interaction.showModal(modal);
                }
                if (subAction === "ban") {
                    const modal = new ModalBuilder()
                        .setCustomId("ban_modal")
                        .setTitle("Ban Member");

                    const userIdInput = new TextInputBuilder()
                        .setCustomId("ban_user_id")
                        .setLabel("User ID")
                        .setPlaceholder("Enter the user ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const reasonInput = new TextInputBuilder()
                        .setCustomId("ban_reason")
                        .setLabel("Reason")
                        .setPlaceholder("e.g., Severe rule violation")
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true);

                    const row1 = new ActionRowBuilder().addComponents(userIdInput);
                    const row2 = new ActionRowBuilder().addComponents(reasonInput);
                    modal.addComponents(row1, row2);

                    return interaction.showModal(modal);
                }
                if (subAction === "blacklist") {
                    const modal = new ModalBuilder()
                        .setCustomId("blacklist_modal")
                        .setTitle("Add to Blacklist");

                    const userIdInput = new TextInputBuilder()
                        .setCustomId("blacklist_user_id")
                        .setLabel("User ID")
                        .setPlaceholder("Enter the user ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const reasonInput = new TextInputBuilder()
                        .setCustomId("blacklist_reason")
                        .setLabel("Reason")
                        .setPlaceholder("e.g., Banned reason, known exploiter")
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(true);

                    const row1 = new ActionRowBuilder().addComponents(userIdInput);
                    const row2 = new ActionRowBuilder().addComponents(reasonInput);
                    modal.addComponents(row1, row2);

                    return interaction.showModal(modal);
                }
                if (subAction === "notes") {
                    const notesEmbed = new EmbedBuilder()
                        .setColor("#2d5a3d")
                        .setTitle("📝 Member Notes System")
                        .setDescription("Create and manage notes for members to track behavior and moderation history.")
                        .setTimestamp();

                    const createButton = new ButtonBuilder()
                        .setCustomId("notes_create")
                        .setLabel("Create Note")
                        .setStyle(ButtonStyle.Primary);

                    const viewButton = new ButtonBuilder()
                        .setCustomId("notes_view")
                        .setLabel("View Notes")
                        .setStyle(ButtonStyle.Primary);

                    const row = new ActionRowBuilder().addComponents(createButton, viewButton);

                    return interaction.reply({
                        embeds: [notesEmbed],
                        components: [row],
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // TRAINING SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_training_")) {
                const subAction = interaction.customId.replace("dashboard_training_", "");
                
                if (subAction === "addcert") {
                    const modal = new ModalBuilder()
                        .setCustomId("training_addcert_modal")
                        .setTitle("Issue Training Certification");

                    const userIdInput = new TextInputBuilder()
                        .setCustomId("training_user_id")
                        .setLabel("User ID")
                        .setPlaceholder("Enter member user ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const certInput = new TextInputBuilder()
                        .setCustomId("training_cert_name")
                        .setLabel("Certification")
                        .setPlaceholder("SWAT, CUI, K9, TRAFFIC ENFORCEMENT, SPEED ENFORCEMENT, INTERNAL AFFAIRS")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const row1 = new ActionRowBuilder().addComponents(userIdInput);
                    const row2 = new ActionRowBuilder().addComponents(certInput);
                    modal.addComponents(row1, row2);

                    return interaction.showModal(modal);
                }
                if (subAction === "removecert") {
                    const modal = new ModalBuilder()
                        .setCustomId("training_removecert_modal")
                        .setTitle("Revoke Training Certification");

                    const userIdInput = new TextInputBuilder()
                        .setCustomId("training_user_id")
                        .setLabel("User ID")
                        .setPlaceholder("Enter member user ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const certInput = new TextInputBuilder()
                        .setCustomId("training_cert_name")
                        .setLabel("Certification")
                        .setPlaceholder("SWAT, CUI, K9, TRAFFIC ENFORCEMENT, SPEED ENFORCEMENT, INTERNAL AFFAIRS")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const row1 = new ActionRowBuilder().addComponents(userIdInput);
                    const row2 = new ActionRowBuilder().addComponents(certInput);
                    modal.addComponents(row1, row2);

                    return interaction.showModal(modal);
                }
                if (subAction === "required") {
                    return interaction.reply({
                        content: "📚 **Mark Training Required**\n\nFlag members who need to complete mandatory training courses.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "complete") {
                    return interaction.reply({
                        content: "✅ **Training Complete**\n\nMark training as completed when a member finishes their courses.",
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // LOGS SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_logs_")) {
                const logType = interaction.customId.replace("dashboard_logs_", "");
                const logNames = {
                    patrol: "Patrol Logs",
                    case: "Case Logs",
                    moderation: "Moderation Logs",
                    strike: "Strike Logs",
                    loa: "LOA Logs",
                    transcript: "Transcript Logs",
                    discord: "Discord Logs",
                    ticket: "Ticket Logs",
                    ia: "IA Logs",
                    commendations: "Commendation Logs"
                };
                
                const currentChannel = getLogChannelId(interaction.guildId, logType);
                let channelInfo = currentChannel ? `\n✅ Currently set to: <#${currentChannel}>` : "\n❌ Not configured yet";
                
                return interaction.reply({
                    content: `📜 **${logNames[logType] || 'Log Channel'}**${channelInfo}\n\n**To configure:**\n1. Navigate to the channel where logs should go\n2. Run: \`/set-log-channel ${logType}\``,
                    flags: MessageFlags.Ephemeral
                });
            }

            // BOT SETTINGS SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_bot_")) {
                const subAction = interaction.customId.replace("dashboard_bot_", "");
                
                if (subAction === "status") {
                    return interaction.reply({
                        content: "🎮 **Set Bot Status**\n\nUse `/set-status` command to change the bot's status (Online, Idle, DND, Invisible, etc.)",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "custom") {
                    return interaction.reply({
                        content: "🎯 **Custom Status**\n\nBot status changes are configured through the `/set-status` command with preset activity types.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "info") {
                    const totalSeconds = Math.floor(interaction.client.uptime / 1000);
                    const uptimeHours = Math.floor(totalSeconds / 3600);
                    const uptimeMinutes = Math.floor((totalSeconds % 3600) / 60);
                    const uptimeSeconds = totalSeconds % 60;
                    const uptimeStr = `${uptimeHours}h ${uptimeMinutes}m ${uptimeSeconds}s`;
                    const embed = new EmbedBuilder()
                        .setColor("#2d5a3d")
                        .setTitle("🤖 Bot Information")
                        .addFields(
                            { name: "Bot Name", value: interaction.client.user.username, inline: true },
                            { name: "Bot ID", value: interaction.client.user.id, inline: true },
                            { name: "Uptime", value: uptimeStr, inline: true },
                            { name: "Servers", value: interaction.client.guilds.cache.size.toString(), inline: true }
                        )
                        .setThumbnail(interaction.client.user.displayAvatarURL({ size: 128 }))
                        .setTimestamp();
                    return interaction.reply({
                        embeds: [embed],
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "ping") {
                    const ws = interaction.client.ws.ping;
                    const sent = Date.now();
                    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                    const roundtrip = Date.now() - sent;
                    const embed = new EmbedBuilder()
                        .setColor("#2d5a3d")
                        .setTitle("📡 Bot Latency")
                        .addFields(
                            { name: "WebSocket", value: `${ws}ms`, inline: true },
                            { name: "Roundtrip", value: `${roundtrip}ms`, inline: true }
                        )
                        .setTimestamp();
                    return interaction.editReply({ embeds: [embed] });
                }
            }

            // ANALYTICS SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_analytics_")) {
                const subAction = interaction.customId.replace("dashboard_analytics_", "");
                
                if (subAction === "patrol") {
                    let patrolStats = "**Patrol Statistics**\n\n";
                    let totalPatrols = 0;
                    let totalMinutes = 0;
                    
                    for (const patrol of Object.values(patrols)) {
                        if (patrol.endTime) {
                            totalPatrols++;
                            totalMinutes += (patrol.endTime - patrol.startTime) / 1000 / 60;
                        }
                    }
                    
                    patrolStats += `👮 Total Patrols: ${totalPatrols}\n`;
                    patrolStats += `⏱️ Total Patrol Hours: ${Math.round(totalMinutes / 60)}h\n`;
                    patrolStats += `📊 Active Patrols: ${Object.values(patrols).filter(p => p.active).length}`;
                    
                    return interaction.reply({
                        content: patrolStats,
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "cases") {
                    let caseStats = "**Case Statistics**\n\n";
                    let openCases = 0, closedCases = 0;
                    
                    for (const caseData of Object.values(casesData.cases || {})) {
                        if (caseData.closed) closedCases++;
                        else openCases++;
                    }
                    
                    caseStats += `📂 Open Cases: ${openCases}\n`;
                    caseStats += `✅ Closed Cases: ${closedCases}\n`;
                    caseStats += `📋 Total Cases: ${openCases + closedCases}`;
                    
                    return interaction.reply({
                        content: caseStats,
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "ia") {
                    return interaction.reply({
                        content: "⚖️ **IA Statistics**\n\nInternal Affairs investigation metrics and pending cases tracked separately.",
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "tickets") {
                    let ticketStats = "**Ticket Statistics**\n\n";
                    let openTickets = 0, closedTickets = 0;
                    
                    for (const ticket of Object.values(tickets.tickets || {})) {
                        if (ticket.closed) closedTickets++;
                        else openTickets++;
                    }
                    
                    ticketStats += `🔴 Open Tickets: ${openTickets}\n`;
                    ticketStats += `✅ Closed Tickets: ${closedTickets}\n`;
                    ticketStats += `🎫 Total Tickets: ${openTickets + closedTickets}`;
                    
                    return interaction.reply({
                        content: ticketStats,
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "activity") {
                    let activityReport = "**Department Activity Report**\n\n";
                    let loaCount = Object.values(loa).filter(l => l.onLOA).length;
                    
                    activityReport += `🚔 Active Patrols: ${Object.values(patrols).filter(p => p.active).length}\n`;
                    activityReport += `😴 Members on LOA: ${loaCount}\n`;
                    activityReport += `📊 Open Cases: ${Object.values(casesData.cases || {}).filter(c => !c.closed).length}\n`;
                    activityReport += `🎫 Open Tickets: ${Object.values(tickets.tickets || {}).filter(t => !t.closed).length}`;
                    
                    return interaction.reply({
                        content: activityReport,
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // SUPERVISOR SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_supervisor_")) {
                const subAction = interaction.customId.replace("dashboard_supervisor_", "");
                
                if (subAction === "promote") {
                    const modal = new ModalBuilder()
                        .setCustomId("promote_modal")
                        .setTitle("Promote Member");

                    const userIdInput = new TextInputBuilder()
                        .setCustomId("promote_user_id")
                        .setLabel("User ID")
                        .setPlaceholder("Enter the user ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const roleIdInput = new TextInputBuilder()
                        .setCustomId("promote_role_id")
                        .setLabel("Role ID to Add")
                        .setPlaceholder("Enter the role ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const row1 = new ActionRowBuilder().addComponents(userIdInput);
                    const row2 = new ActionRowBuilder().addComponents(roleIdInput);
                    modal.addComponents(row1, row2);

                    return interaction.showModal(modal);
                }
                if (subAction === "demote") {
                    const modal = new ModalBuilder()
                        .setCustomId("demote_modal")
                        .setTitle("Demote Member");

                    const userIdInput = new TextInputBuilder()
                        .setCustomId("demote_user_id")
                        .setLabel("User ID")
                        .setPlaceholder("Enter the user ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const roleIdInput = new TextInputBuilder()
                        .setCustomId("demote_role_id")
                        .setLabel("Role ID to Remove")
                        .setPlaceholder("Enter the role ID")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);

                    const row1 = new ActionRowBuilder().addComponents(userIdInput);
                    const row2 = new ActionRowBuilder().addComponents(roleIdInput);
                    modal.addComponents(row1, row2);

                    return interaction.showModal(modal);
                }
                if (subAction === "review") {
                    let reviewInfo = "**Department Performance Review**\n\n";
                    reviewInfo += `📊 Total Cases: ${Object.keys(casesData.cases || {}).length}\n`;
                    reviewInfo += `🎫 Total Tickets: ${Object.keys(tickets.tickets || {}).length}\n`;
                    reviewInfo += `⚠️ Total Strikes: ${Object.keys(strikes).length}\n`;
                    return interaction.reply({
                        content: reviewInfo,
                        flags: MessageFlags.Ephemeral
                    });
                }
                if (subAction === "alert") {
                    return interaction.reply({
                        content: "📝 **Send Alert to Supervisors**\n\nReply to this message with your alert. The message will be sent to all supervisors via DM.",
                        flags: MessageFlags.Ephemeral
                    });
                }
            }

            // BOT OWNER SECTION
            if (moduleType === "owner") {
                // Only allow bot owner
                const botOwnerId = "967375704486449222";
                if (interaction.user.id !== botOwnerId) {
                    return interaction.reply({
                        content: "❌ Only the bot owner can access this section.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                // Build fields with configured roles
                const moduleConfigs = [
                    { name: "Patrol Module", key: "patrol" },
                    { name: "Cases Module", key: "cases" },
                    { name: "IA Module", key: "ia" },
                    { name: "Tickets Module", key: "tickets" },
                    { name: "Moderation Module", key: "moderation" },
                    { name: "Training Module", key: "training" },
                    { name: "Logs Module", key: "logs" },
                    { name: "Bot Settings", key: "bot" },
                    { name: "Analytics Module", key: "analytics" },
                    { name: "Supervisor Tools", key: "supervisor" }
                ];

                const fields = moduleConfigs.map(module => {
                    const configuredRoles = config.moduleRoleAccess && config.moduleRoleAccess[module.key] ? config.moduleRoleAccess[module.key] : [];
                    let accessText = "";
                    
                    if (configuredRoles.length === 0) {
                        // Use default role descriptions
                        const defaults = {
                            patrol: "Accessible to: Everyone",
                            cases: "Accessible to: Detectives+",
                            ia: "Accessible to: IA/Investigator+",
                            tickets: "Accessible to: Staff+",
                            moderation: "Accessible to: Moderators+",
                            training: "Accessible to: Training Officers+",
                            logs: "Accessible to: Admins only",
                            bot: "Accessible to: Admins only",
                            analytics: "Accessible to: Supervisors+",
                            supervisor: "Accessible to: Supervisors+"
                        };
                        accessText = defaults[module.key] || "Accessible to: Admins only";
                    } else if (configuredRoles.includes("everyone")) {
                        accessText = "Accessible to: @everyone";
                    } else {
                        accessText = "Accessible to: " + configuredRoles.map(id => `<@&${id}>`).join(", ");
                    }
                    
                    return { name: module.name, value: accessText, inline: false };
                });

                const ownerEmbed = new EmbedBuilder()
                    .setColor("#FFD700")
                    .setTitle("🔧 Bot Owner Configuration")
                    .setDescription("Configure dashboard access and role permissions for your department.")
                    .addFields(...fields)
                    .setTimestamp();

                const row1 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_owner_patrol").setLabel("Configure Patrol").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_owner_cases").setLabel("Configure Cases").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_owner_ia").setLabel("Configure IA").setStyle(ButtonStyle.Primary)
                );

                const row2 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_owner_tickets").setLabel("Configure Tickets").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_owner_moderation").setLabel("Configure Moderation").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_owner_training").setLabel("Configure Training").setStyle(ButtonStyle.Primary)
                );

                const row3 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_owner_logs").setLabel("Configure Logs").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_owner_bot").setLabel("Configure Bot").setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId("dashboard_owner_analytics").setLabel("Configure Analytics").setStyle(ButtonStyle.Primary)
                );

                const row4 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_owner_supervisor").setLabel("Configure Supervisor").setStyle(ButtonStyle.Primary)
                );

                const row5 = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId("dashboard_back").setLabel("← Back").setStyle(ButtonStyle.Secondary)
                );

                return interaction.reply({
                    embeds: [ownerEmbed],
                    components: [row1, row2, row3, row4, row5],
                    flags: MessageFlags.Ephemeral
                });
            }

            // BOT OWNER CONFIGURATION SUB-BUTTONS
            if (interaction.customId.startsWith("dashboard_owner_")) {
                const botOwnerId = "967375704486449222";
                if (interaction.user.id !== botOwnerId) {
                    return interaction.reply({
                        content: "❌ Only the bot owner can configure roles.",
                        flags: MessageFlags.Ephemeral
                    });
                }

                const moduleType = interaction.customId.replace("dashboard_owner_", "");
                const moduleName = {
                    patrol: "Patrol",
                    cases: "Cases",
                    ia: "IA",
                    tickets: "Tickets",
                    moderation: "Moderation",
                    training: "Training",
                    logs: "Logs",
                    bot: "Bot Settings",
                    analytics: "Analytics",
                    supervisor: "Supervisor"
                };

                // Create modal for role configuration
                const modal = new ModalBuilder()
                    .setCustomId(`role_config_${moduleType}`)
                    .setTitle(`Configure ${moduleName[moduleType] || moduleType} Access`);

                const roleInput = new TextInputBuilder()
                    .setCustomId("role_id_input")
                    .setLabel("Enter Role ID(s) (comma-separated)")
                    .setPlaceholder("e.g., 123456789,987654321")
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setValue((config.moduleRoleAccess[moduleType] || []).join(","));

                const row = new ActionRowBuilder().addComponents(roleInput);
                modal.addComponents(row);

                return interaction.showModal(modal);
            }

            // BACK BUTTON - Return to main dashboard
            if (moduleType === "back") {
                const dashboardEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("🏢 HCSO Department Dashboard")
                    .setDescription("Select a module below to manage patrol, cases, IA, tickets, logs, and more.")
                    .setThumbnail(interaction.client.user.displayAvatarURL({ size: 128 }))
                    .setTimestamp();

                return interaction.reply({
                    embeds: [dashboardEmbed],
                    components: buildDashboardComponents(interaction.member),
                    flags: MessageFlags.Ephemeral
                });
            }

        } catch (error) {
            console.error("Dashboard button error:", error);
            interaction.reply({
                content: "❌ An error occurred. Please try again.",
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }

    if (!interaction.isChatInputCommand()) return;

    try {
        const staff = interaction.user;

    // /patrol
    if (interaction.commandName === "patrol") {
        // Check if user has permission
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            const embed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Permission Denied")
                .addFields(
                    { name: "Error", value: "Only staff members can use this command.", inline: false }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const startButton = new ButtonBuilder()
            .setCustomId("start_patrol")
            .setLabel("Start Patrol")
            .setStyle(ButtonStyle.Success);

        const row = new ActionRowBuilder().addComponents(startButton);

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("🚓 Patrol Logs")
            .setDescription("Click the button below to start your patrol")
            .addFields(
                { name: "Instructions", value: "Click **Start Patrol** to begin logging time. Click **Stop Patrol** when done.", inline: false }
            )
            .setTimestamp();

        return interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }

    // /patrol-today
    if (interaction.commandName === "patrol-today") {
        const targetUser = interaction.options.getUser("user") || interaction.user;
        const userId = targetUser.id;

        if (!patrols[userId] || !patrols[userId].completed || patrols[userId].completed.length === 0) {
            const embed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📊 Today's Patrol Hours")
                .addFields(
                    { name: "Deputy", value: `<@${userId}>`, inline: false },
                    { name: "Total Hours", value: "0h 0m", inline: true }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        const today = new Date().toDateString();
        const todayPatrols = patrols[userId].completed.filter(p => p.date === today);

        let totalDuration = 0;
        todayPatrols.forEach(patrol => {
            totalDuration += patrol.duration;
        });

        const totalHours = Math.floor(totalDuration / (1000 * 60 * 60));
        const totalMinutes = Math.floor((totalDuration % (1000 * 60 * 60)) / (1000 * 60));

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("📊 Today's Patrol Hours")
            .addFields(
                { name: "Deputy", value: `<@${userId}>`, inline: false },
                { name: "Total Hours", value: `${totalHours}h ${totalMinutes}m`, inline: true },
                { name: "Shifts", value: `${todayPatrols.length}`, inline: true }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // /patrol-week
    if (interaction.commandName === "patrol-week") {
        const targetUser = interaction.options.getUser("user") || interaction.user;
        const userId = targetUser.id;

        if (!patrols[userId] || !patrols[userId].completed || patrols[userId].completed.length === 0) {
            const embed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📊 Weekly Patrol Hours")
                .addFields(
                    { name: "Deputy", value: `<@${userId}>`, inline: false },
                    { name: "Total Hours", value: "0h 0m", inline: true }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // Calculate week start (Monday)
        const today = new Date();
        const dayOfWeek = today.getDay();
        const diff = today.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
        const weekStart = new Date(today.setDate(diff));
        weekStart.setHours(0, 0, 0, 0);

        const weekPatrols = patrols[userId].completed.filter(p => {
            const patrolDate = new Date(p.date);
            return patrolDate >= weekStart;
        });

        let totalDuration = 0;
        weekPatrols.forEach(patrol => {
            totalDuration += patrol.duration;
        });

        const totalHours = Math.floor(totalDuration / (1000 * 60 * 60));
        const totalMinutes = Math.floor((totalDuration % (1000 * 60 * 60)) / (1000 * 60));

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("📊 Weekly Patrol Hours")
            .addFields(
                { name: "Deputy", value: `<@${userId}>`, inline: false },
                { name: "Total Hours", value: `${totalHours}h ${totalMinutes}m`, inline: true },
                { name: "Shifts", value: `${weekPatrols.length}`, inline: true }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // /patrol-month
    if (interaction.commandName === "patrol-month") {
        const targetUser = interaction.options.getUser("user") || interaction.user;
        const userId = targetUser.id;

        if (!patrols[userId] || !patrols[userId].completed || patrols[userId].completed.length === 0) {
            const embed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📊 Monthly Patrol Hours")
                .addFields(
                    { name: "Deputy", value: `<@${userId}>`, inline: false },
                    { name: "Total Hours", value: "0h 0m", inline: true }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // Get current month patrols
        const today = new Date();
        const currentMonth = today.getMonth();
        const currentYear = today.getFullYear();

        const monthPatrols = patrols[userId].completed.filter(p => {
            const patrolDate = new Date(p.date);
            return patrolDate.getMonth() === currentMonth && patrolDate.getFullYear() === currentYear;
        });

        let totalDuration = 0;
        monthPatrols.forEach(patrol => {
            totalDuration += patrol.duration;
        });

        const totalHours = Math.floor(totalDuration / (1000 * 60 * 60));
        const totalMinutes = Math.floor((totalDuration % (1000 * 60 * 60)) / (1000 * 60));

        const monthName = today.toLocaleString('default', { month: 'long', year: 'numeric' });

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("📊 Monthly Patrol Hours")
            .addFields(
                { name: "Deputy", value: `<@${userId}>`, inline: false },
                { name: "Month", value: monthName, inline: true },
                { name: "Total Hours", value: `${totalHours}h ${totalMinutes}m`, inline: true },
                { name: "Shifts", value: `${monthPatrols.length}`, inline: true }
            )
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    }

    // /loa
    if (interaction.commandName === "loa") {
        const userId = interaction.user.id;
        const startDate = interaction.options.getString("start-date");
        const endDate = interaction.options.getString("end-date");
        const reason = interaction.options.getString("reason") || "No reason provided";

        // Validate date format (MM-DD-YYYY)
        const dateRegex = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])-\d{4}$/;
        if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
            const embed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Invalid Date Format")
                .addFields(
                    { name: "Error", value: "Dates must be in MM-DD-YYYY format", inline: false }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        // Store LOA
        loa[userId] = {
            onLOA: true,
            startDate: startDate,
            endDate: endDate,
            reason: reason
        };
        saveLOA();

        // Assign LOA role
        const loaRole = await interaction.guild.roles.fetch("1300431447655448607").catch(() => null);
        if (loaRole && interaction.member.manageable) {
            await interaction.member.roles.add(loaRole).catch(() => {});
        }

        // Send confirmation embed
        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Leave of Absence Approved")
            .addFields(
                { name: "Deputy", value: `<@${userId}>`, inline: false },
                { name: "Start Date", value: startDate, inline: true },
                { name: "End Date", value: endDate, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();

        // Try to DM the user
        try {
            await interaction.user.send({
                content: "Your Leave of Absence has been approved. When you return, use /end-loa to remove your LOA status and resume duty."
            });
        } catch (err) {
            console.log("Could not DM user");
        }

        interaction.reply({ embeds: [embed] });

        // Log to LOA channel
        const loaLogChannel = client.channels.cache.get(config.logChannels.loa);
        if (loaLogChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📋 Leave of Absence Created")
                .addFields(
                    { name: "Deputy", value: `<@${userId}>`, inline: false },
                    { name: "Start Date", value: startDate, inline: true },
                    { name: "End Date", value: endDate, inline: true },
                    { name: "Reason", value: reason, inline: false }
                )
                .setTimestamp();
            loaLogChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /end-loa
    if (interaction.commandName === "end-loa") {
        const userId = interaction.user.id;

        if (!loa[userId] || !loa[userId].onLOA) {
            const embed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ No Active LOA")
                .addFields(
                    { name: "Error", value: "You do not have an active LOA to end.", inline: false }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        // Remove LOA role
        const loaRole = await interaction.guild.roles.fetch("1300431447655448607").catch(() => null);
        if (loaRole && interaction.member.manageable) {
            await interaction.member.roles.remove(loaRole).catch(() => {});
        }

        // Clear LOA status
        delete loa[userId];
        saveLOA();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ LOA Ended")
            .addFields(
                { name: "Deputy", value: `<@${userId}>`, inline: false },
                { name: "Status", value: "You are now cleared for duty.", inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // Log to LOA channel
        const loaEndChannel = client.channels.cache.get(config.logChannels.loa);
        if (loaEndChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("✅ Leave of Absence Ended")
                .addFields(
                    { name: "Deputy", value: `<@${userId}>`, inline: false },
                    { name: "Status", value: "Returned to active duty", inline: false }
                )
                .setTimestamp();
            loaEndChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /report
    if (interaction.commandName === "report") {
        const incidentType = interaction.options.getString("incident-type");
        const location = interaction.options.getString("location");
        const suspect = interaction.options.getString("suspect") || "Unknown";
        const summary = interaction.options.getString("summary");
        const filedBy = interaction.user;

        const reportId = `RPT-${Date.now()}`;

        reports[reportId] = {
            filedBy: filedBy.id,
            incidentType: incidentType,
            location: location,
            suspect: suspect,
            summary: summary,
            timestamp: new Date().toISOString()
        };
        saveReports();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Incident Report Filed")
            .addFields(
                { name: "Report ID", value: reportId, inline: true },
                { name: "Your report has been filed and logged.", value: "\u200b", inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });

        // Log to case channel
        const reportLogChannel = client.channels.cache.get(config.logChannels.case);
        if (reportLogChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📋 Incident Report")
                .addFields(
                    { name: "Filed By", value: `<@${filedBy.id}>`, inline: false },
                    { name: "Incident Type", value: incidentType, inline: true },
                    { name: "Location", value: location, inline: true },
                    { name: "Suspect", value: suspect, inline: false },
                    { name: "Summary", value: summary, inline: false },
                    { name: "Report ID", value: reportId, inline: true }
                )
                .setTimestamp();
            reportLogChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /case-create
    if (interaction.commandName === "case-create") {
        const title = interaction.options.getString("title");
        const incidentType = interaction.options.getString("incident-type");
        const location = interaction.options.getString("location");
        const suspect = interaction.options.getString("suspect") || "Unknown";
        const summary = interaction.options.getString("summary");
        const createdBy = interaction.user;

        // Generate case ID
        casesData.caseCounter++;
        const caseId = `CASE-${String(casesData.caseCounter).padStart(6, '0')}`;

        casesData.cases[caseId] = {
            caseId: caseId,
            title: title,
            incidentType: incidentType,
            location: location,
            suspect: suspect,
            summary: summary,
            createdBy: createdBy.id,
            assignedTo: null,
            evidence: [],
            status: "Open",
            createdAt: new Date().toISOString()
        };
        saveCases();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Case Created")
            .addFields(
                { name: "Case ID", value: caseId, inline: true },
                { name: "Title", value: title, inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // Log to case channel
        const caseCreateChannel = client.channels.cache.get(config.logChannels.case);
        if (caseCreateChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📁 New Case Created")
                .addFields(
                    { name: "Case ID", value: caseId, inline: false },
                    { name: "Title", value: title, inline: false },
                    { name: "Incident Type", value: incidentType, inline: true },
                    { name: "Location", value: location, inline: true },
                    { name: "Suspect", value: suspect, inline: false },
                    { name: "Filed By", value: `<@${createdBy.id}>`, inline: true },
                    { name: "Status", value: "Open", inline: true }
                )
                .setTimestamp();
            caseCreateChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /case-view
    if (interaction.commandName === "case-view") {
        const caseId = interaction.options.getString("case-id").toUpperCase();

        if (!casesData.cases[caseId]) {
            return interaction.reply({
                content: "❌ Case not found.",
                flags: MessageFlags.Ephemeral
            });
        }

        const caseFile = casesData.cases[caseId];
        const evidenceList = caseFile.evidence.length > 0 
            ? caseFile.evidence.map((e, i) => `${i + 1}. ${e.description} (Added by <@${e.officerId}>)`).join("\n")
            : "No evidence has been added to this case yet.";

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle(`📁 Case File: ${caseId}`)
            .addFields(
                { name: "Title", value: caseFile.title, inline: false },
                { name: "Incident Type", value: caseFile.incidentType, inline: true },
                { name: "Location", value: caseFile.location, inline: true },
                { name: "Suspect", value: caseFile.suspect, inline: false },
                { name: "Summary", value: caseFile.summary, inline: false },
                { name: "Filed By", value: `<@${caseFile.createdBy}>`, inline: true },
                { name: "Assigned To", value: caseFile.assignedTo ? `<@${caseFile.assignedTo}>` : "Unassigned", inline: true },
                { name: "Status", value: caseFile.status, inline: true },
                { name: "Evidence", value: evidenceList, inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });
    }

    // /case-assign
    if (interaction.commandName === "case-assign") {
        const caseId = interaction.options.getString("case-id").toUpperCase();
        const assignee = interaction.options.getUser("assignee");
        const note = interaction.options.getString("note") || "No note provided";

        if (!casesData.cases[caseId]) {
            return interaction.reply({
                content: "❌ Case not found.",
                flags: MessageFlags.Ephemeral
            });
        }

        casesData.cases[caseId].assignedTo = assignee.id;
        casesData.cases[caseId].assignedBy = interaction.user.id;
        casesData.cases[caseId].assignNote = note;
        casesData.cases[caseId].assignedAt = new Date().toISOString();
        saveCases();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Case Assigned")
            .addFields(
                { name: "Case ID", value: caseId, inline: true },
                { name: "Assigned To", value: `<@${assignee.id}>`, inline: true }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // DM the assigned user
        assignee.send(`You have been assigned to Case **${caseId}**. Use \`/case-view\` to see details.`).catch(() => {});

        // Log to case channel
        const assignChannel = client.channels.cache.get(config.logChannels.case);
        if (assignChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📌 Case Assigned")
                .addFields(
                    { name: "Case ID", value: caseId, inline: false },
                    { name: "Assigned To", value: `<@${assignee.id}>`, inline: true },
                    { name: "Assigned By", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Note", value: note, inline: false }
                )
                .setTimestamp();
            assignChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /case-unassign
    if (interaction.commandName === "case-unassign") {
        const caseId = interaction.options.getString("case-id").toUpperCase();
        const reason = interaction.options.getString("reason") || "Not specified";

        if (!casesData.cases[caseId]) {
            return interaction.reply({
                content: "❌ Case not found.",
                flags: MessageFlags.Ephemeral
            });
        }

        const previousAssignee = casesData.cases[caseId].assignedTo;

        if (!previousAssignee) {
            return interaction.reply({
                content: "❌ This case is not assigned to anyone.",
                flags: MessageFlags.Ephemeral
            });
        }

        casesData.cases[caseId].assignedTo = null;
        casesData.cases[caseId].unassignedBy = interaction.user.id;
        casesData.cases[caseId].unassignReason = reason;
        casesData.cases[caseId].unassignedAt = new Date().toISOString();
        saveCases();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Case Unassigned")
            .addFields(
                { name: "Case ID", value: caseId, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // DM the unassigned user
        client.users.fetch(previousAssignee).then(user => {
            user.send(`You have been unassigned from Case **${caseId}**. Reason: ${reason}`).catch(() => {});
        }).catch(() => {});

        // Log to case channel
        const unassignChannel = client.channels.cache.get(config.logChannels.case);
        if (unassignChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📌 Case Unassigned")
                .addFields(
                    { name: "Case ID", value: caseId, inline: false },
                    { name: "Unassigned User", value: `<@${previousAssignee}>`, inline: true },
                    { name: "Action By", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Reason", value: reason, inline: false }
                )
                .setTimestamp();
            unassignChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /evidence-add
    if (interaction.commandName === "evidence-add") {
        const caseId = interaction.options.getString("case-id").toUpperCase();
        const description = interaction.options.getString("description");
        const officerId = interaction.user.id;

        if (!casesData.cases[caseId]) {
            return interaction.reply({
                content: "❌ Case not found.",
                flags: MessageFlags.Ephemeral
            });
        }

        const evidenceId = `EVI-${Date.now()}`;

        casesData.cases[caseId].evidence.push({
            evidenceId: evidenceId,
            description: description,
            officerId: officerId,
            timestamp: new Date().toISOString()
        });
        saveCases();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Evidence Added")
            .addFields(
                { name: "Case ID", value: caseId, inline: true },
                { name: "Evidence ID", value: evidenceId, inline: true }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // Log to case channel
        const caseChannel = client.channels.cache.get(config.logChannels.case);
        if (caseChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📸 Evidence Added")
                .addFields(
                    { name: "Case ID", value: caseId, inline: false },
                    { name: "Officer", value: `<@${officerId}>`, inline: true },
                    { name: "Description", value: description, inline: false }
                )
                .setTimestamp();
            caseChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /case-close
    if (interaction.commandName === "case-close") {
        const caseId = interaction.options.getString("case-id").toUpperCase();
        const reason = interaction.options.getString("reason") || "Not specified";

        if (!casesData.cases[caseId]) {
            return interaction.reply({
                content: "❌ Case not found.",
                flags: MessageFlags.Ephemeral
            });
        }

        if (casesData.cases[caseId].status === "Closed") {
            return interaction.reply({
                content: "❌ This case is already closed.",
                flags: MessageFlags.Ephemeral
            });
        }

        casesData.cases[caseId].status = "Closed";
        casesData.cases[caseId].closedBy = interaction.user.id;
        casesData.cases[caseId].closedReason = reason;
        casesData.cases[caseId].closedAt = new Date().toISOString();
        saveCases();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Case Closed")
            .addFields(
                { name: "Case ID", value: caseId, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // DM the assigned officer if any
        if (casesData.cases[caseId].assignedTo) {
            client.users.fetch(casesData.cases[caseId].assignedTo).then(user => {
                user.send(`Case **${caseId}** has been closed. Reason: ${reason}`).catch(() => {});
            }).catch(() => {});
        }

        // Log to case channel
        const caseChannel = client.channels.cache.get(config.logChannels.case);
        if (caseChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("🔒 Case Closed")
                .addFields(
                    { name: "Case ID", value: caseId, inline: false },
                    { name: "Closed By", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Reason", value: reason, inline: false }
                )
                .setTimestamp();
            caseChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /case-reopen
    if (interaction.commandName === "case-reopen") {
        const caseId = interaction.options.getString("case-id").toUpperCase();
        const reason = interaction.options.getString("reason");

        if (!casesData.cases[caseId]) {
            return interaction.reply({
                content: "❌ Case not found.",
                flags: MessageFlags.Ephemeral
            });
        }

        if (casesData.cases[caseId].status !== "Closed") {
            return interaction.reply({
                content: "❌ This case is not closed. You can only reopen closed cases.",
                flags: MessageFlags.Ephemeral
            });
        }

        casesData.cases[caseId].status = "Open";
        casesData.cases[caseId].reopenedBy = interaction.user.id;
        casesData.cases[caseId].reopenReason = reason;
        casesData.cases[caseId].reopenedAt = new Date().toISOString();
        saveCases();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Case Reopened")
            .addFields(
                { name: "Case ID", value: caseId, inline: true },
                { name: "Reason", value: reason, inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // DM the assigned officer if any
        if (casesData.cases[caseId].assignedTo) {
            client.users.fetch(casesData.cases[caseId].assignedTo).then(user => {
                user.send(`Case **${caseId}** has been reopened due to new evidence. Reason: ${reason}`).catch(() => {});
            }).catch(() => {});
        }

        // Log to case channel
        const caseChannel = client.channels.cache.get(config.logChannels.case);
        if (caseChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("🔓 Case Reopened")
                .addFields(
                    { name: "Case ID", value: caseId, inline: false },
                    { name: "Reopened By", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Reason", value: reason, inline: false }
                )
                .setTimestamp();
            caseChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /case-delete
    if (interaction.commandName === "case-delete") {
        const caseId = interaction.options.getString("case-id").toUpperCase();
        const confirmation = interaction.options.getString("confirmation");

        if (!casesData.cases[caseId]) {
            return interaction.reply({
                content: "❌ Case not found.",
                flags: MessageFlags.Ephemeral
            });
        }

        if (confirmation.toUpperCase() !== "YES") {
            return interaction.reply({
                content: "❌ Deletion cancelled. Type 'YES' to confirm deletion.",
                flags: MessageFlags.Ephemeral
            });
        }

        delete casesData.cases[caseId];
        saveCases();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Case Deleted")
            .addFields(
                { name: "Case ID", value: caseId, inline: true },
                { name: "Status", value: "Case has been permanently removed.", inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // Log to case channel
        const caseChannel = client.channels.cache.get(config.logChannels.case);
        if (caseChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("🗑️ Case Deleted")
                .addFields(
                    { name: "Case ID", value: caseId, inline: false },
                    { name: "Deleted By", value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();
            caseChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /case-my
    if (interaction.commandName === "case-my") {
        const userId = interaction.user.id;
        const assignedCases = Object.values(casesData.cases).filter(c => c.assignedTo === userId);

        if (assignedCases.length === 0) {
            const embed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📂 Your Active Cases")
                .addFields(
                    { name: "Status", value: "You currently have no assigned cases.", inline: false }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        let caseList = assignedCases.map(c => `${c.caseId} — ${c.title} (${c.status})`).join("\n");
        
        // Split into multiple embeds if needed
        const embeds = [];
        const lines = caseList.split("\n");
        let currentEmbed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("📂 Your Active Cases");

        lines.forEach((line, i) => {
            if (currentEmbed.length > 5500) {
                embeds.push(currentEmbed.setTimestamp());
                currentEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("📂 Your Active Cases (Continued)");
            }
            if (i === 0) {
                currentEmbed.addFields({ name: "Cases", value: line, inline: false });
            } else {
                currentEmbed.data.fields[0].value += "\n" + line;
            }
        });

        embeds.push(currentEmbed.setTimestamp());
        return interaction.reply({ embeds: embeds });
    }

    // /case-search
    if (interaction.commandName === "case-search") {
        const query = interaction.options.getString("query").toLowerCase();
        const results = Object.values(casesData.cases).filter(c => 
            c.caseId.toLowerCase().includes(query) ||
            c.title.toLowerCase().includes(query) ||
            c.suspect.toLowerCase().includes(query) ||
            c.location.toLowerCase().includes(query) ||
            c.incidentType.toLowerCase().includes(query) ||
            c.summary.toLowerCase().includes(query)
        );

        if (results.length === 0) {
            return interaction.reply({
                content: `❌ No cases found matching your search for **"${query}"**.`,
                flags: MessageFlags.Ephemeral
            });
        }

        let resultList = results.map(c => `${c.caseId} — ${c.title} (${c.status})`).join("\n");

        const embeds = [];
        const lines = resultList.split("\n");
        let currentEmbed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle(`🔍 Search Results for "${query}"`)
            .addFields({ name: `Found ${results.length} case(s)`, value: lines[0], inline: false });

        for (let i = 1; i < lines.length; i++) {
            if (currentEmbed.length > 5500) {
                embeds.push(currentEmbed.setTimestamp());
                currentEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle(`🔍 Search Results (Continued)`);
                currentEmbed.addFields({ name: "\u200b", value: lines[i], inline: false });
            } else {
                currentEmbed.data.fields[0].value += "\n" + lines[i];
            }
        }

        embeds.push(currentEmbed.setTimestamp());
        return interaction.reply({ embeds: embeds });
    }

    // /case-edit
    if (interaction.commandName === "case-edit") {
        const caseId = interaction.options.getString("case-id").toUpperCase();
        const field = interaction.options.getString("field");
        const value = interaction.options.getString("value");

        if (!casesData.cases[caseId]) {
            return interaction.reply({
                content: "❌ Case not found.",
                flags: MessageFlags.Ephemeral
            });
        }

        const caseFile = casesData.cases[caseId];
        const oldValue = caseFile[field] || "N/A";

        // Update the field
        if (field === "assignedTo") {
            // Handle user mention/ID for assignedTo field
            caseFile.assignedTo = value.replace(/[<@!>]/g, '') || null;
        } else {
            caseFile[field] = value;
        }

        caseFile.lastEditedBy = interaction.user.id;
        caseFile.lastEditedAt = new Date().toISOString();
        saveCases();

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("✅ Case Updated")
            .addFields(
                { name: "Case ID", value: caseId, inline: true },
                { name: "Field Changed", value: field, inline: true },
                { name: "Old Value", value: String(oldValue).slice(0, 100), inline: false },
                { name: "New Value", value: String(value).slice(0, 100), inline: false }
            )
            .setTimestamp();

        interaction.reply({ embeds: [embed] });

        // Log to case channel
        const caseChannel = client.channels.cache.get(config.logChannels.case);
        if (caseChannel) {
            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("✏️ Case Updated")
                .addFields(
                    { name: "Case ID", value: caseId, inline: false },
                    { name: "Field", value: field, inline: true },
                    { name: "Old Value", value: String(oldValue).slice(0, 100), inline: true },
                    { name: "New Value", value: String(value).slice(0, 100), inline: false },
                    { name: "Updated By", value: `<@${interaction.user.id}>`, inline: true }
                )
                .setTimestamp();
            caseChannel.send({ embeds: [logEmbed] }).catch(() => {});
        }
    }

    // /set-log-channel
    if (interaction.commandName === "set-log-channel") {
        try {
            if (!interaction.guildId) {
                return interaction.reply({
                    content: "❌ This command can only be used in a server.",
                    flags: MessageFlags.Ephemeral
                });
            }

            // Check permission
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                const errorEmbed = new EmbedBuilder()
                    .setColor("#8b0000")
                    .setTitle("❌ Permission Denied")
                    .setDescription("You do not have permission to configure log channels.")
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
            }

            const logType = interaction.options.getString("log-type");
            const channelId = interaction.channel.id;

            // Validate log type
            if (!LOG_TYPES.includes(logType)) {
                const errorEmbed = new EmbedBuilder()
                    .setColor("#8b0000")
                    .setTitle("❌ Invalid Log Type")
                    .setDescription("Valid options: patrol, case, moderation, loa, transcript, timeout, discord.")
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
            }

            // Update config
            setLogChannelId(interaction.guildId, logType, channelId);
            saveConfig();

            const typeNames = {
                patrol: "Patrol Logs",
                case: "Case Logs",
                moderation: "Moderation Logs",
                strike: "Strike Logs",
                loa: "LOA Logs",
                transcript: "Transcript Logs",
                timeout: "Timeout Logs",
                ban: "Ban Logs",
                blacklist: "Blacklist Logs",
                discord: "Discord Logs",
                commendations: "Commendation Logs"
            };

            const successEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("✅ Log Channel Updated")
                .setDescription(`**${typeNames[logType]}** - <#${channelId}> - logs will be sent to this channel from now`)
                .setTimestamp();

            await interaction.reply({ embeds: [successEmbed] });
        } catch (error) {
            console.error("Set log channel error:", error);
            const errorEmbed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Logging Configuration Failed")
                .setDescription(`The logging command did not work please try again or try contact the bot developer <@967375704486449222>`)
                .addFields(
                    { name: "Error Details", value: error.message || "Unknown error", inline: false }
                )
                .setTimestamp();

            await safeInteractionErrorReply(interaction, `❌ Logging Configuration Failed\n${error.message || "Unknown error"}`);
        }
    }

    // /ticketcatset
    if (interaction.commandName === "ticketcatset") {
        try {
            // Check permission
            if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
                const errorEmbed = new EmbedBuilder()
                    .setColor("#8b0000")
                    .setTitle("❌ Permission Denied")
                    .setDescription("You do not have permission to configure ticket categories.")
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
            }

            const categoryId = interaction.options.getString("category-id");

            // Validate that the category exists and is actually a category
            try {
                const category = await interaction.guild.channels.fetch(categoryId);
                if (category.type !== ChannelType.GuildCategory) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor("#8b0000")
                        .setTitle("❌ Invalid Category")
                        .setDescription("The ID you provided is not a valid category channel.")
                        .setTimestamp();
                    return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
                }
            } catch (error) {
                const errorEmbed = new EmbedBuilder()
                    .setColor("#8b0000")
                    .setTitle("❌ Category Not Found")
                    .setDescription(`Could not find a category with ID: ${categoryId}`)
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
            }

            // Update config
            config.ticketCategory = categoryId;
            saveConfig();

            const successEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("✅ Ticket Category Updated")
                .setDescription(`Ticket category has been set to: <#${categoryId}>`)
                .addFields(
                    { name: "Category ID", value: categoryId, inline: false }
                )
                .setTimestamp();

            interaction.reply({ embeds: [successEmbed] });
        } catch (error) {
            console.error("Ticket category set error:", error);
            const errorEmbed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Category Configuration Failed")
                .setDescription("The ticket category command did not work. Please try again or contact the bot developer.")
                .addFields(
                    { name: "Error Details", value: error.message || "Unknown error", inline: false }
                )
                .setTimestamp();
            await interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }

    // /ticket-panel
    if (interaction.commandName === "ticket-panel") {
        try {
            // Check if user is admin
            if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({
                    content: "You do not have permission to use this command.",
                    flags: MessageFlags.Ephemeral
                });

                client.on("guildMemberAdd", async member => {
                    const embed = new EmbedBuilder()
                        .setColor("#2d5a3d")
                        .setTitle("📥 Member Joined")
                        .addFields(
                            { name: "Member", value: `<@${member.id}> (${member.user.tag})`, inline: false },
                            { name: "User ID", value: member.id, inline: true },
                            { name: "Account Created", value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:F>`, inline: true }
                        )
                        .setTimestamp();

                    await sendDiscordEventLog(member.guild.id, embed);
                });

                client.on("guildMemberRemove", async member => {
                    const embed = new EmbedBuilder()
                        .setColor("#8b0000")
                        .setTitle("📤 Member Left")
                        .addFields(
                            { name: "Member", value: `${member.user.tag} (${member.id})`, inline: false },
                            { name: "User ID", value: member.id, inline: true },
                            {
                                name: "Joined Server",
                                value: member.joinedTimestamp
                                    ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`
                                    : "Unknown",
                                inline: true
                            }
                        )
                        .setTimestamp();

                    await sendDiscordEventLog(member.guild.id, embed);
                });

                client.on("messageDelete", async message => {
                    if (!message.guild || message.author?.bot) return;

                    if (message.partial) {
                        await message.fetch().catch(() => null);
                    }

                    const authorText = message.author ? `<@${message.author.id}> (${message.author.tag})` : "Unknown (uncached message)";
                    const content = message.content ? truncateForField(message.content, 1000) : "(No text content or unavailable from cache)";
                    const attachmentText = message.attachments?.size
                        ? truncateForField(Array.from(message.attachments.values()).map(att => att.url).join("\n"), 1000)
                        : "None";

                    const embed = new EmbedBuilder()
                        .setColor("#b97a00")
                        .setTitle("🗑️ Message Deleted")
                        .addFields(
                            { name: "Author", value: authorText, inline: false },
                            { name: "Channel", value: `<#${message.channelId}>`, inline: true },
                            { name: "Message ID", value: message.id, inline: true },
                            { name: "Content", value: content, inline: false },
                            { name: "Attachments", value: attachmentText, inline: false }
                        )
                        .setTimestamp();

                    await sendDiscordEventLog(message.guild.id, embed);
                });

                client.on("messageUpdate", async (oldMessage, newMessage) => {
                    if (!newMessage.guild || newMessage.author?.bot) return;

                    if (oldMessage.partial) {
                        await oldMessage.fetch().catch(() => null);
                    }

                    if (newMessage.partial) {
                        await newMessage.fetch().catch(() => null);
                    }

                    const before = oldMessage.content ?? "(Unavailable from cache)";
                    const after = newMessage.content ?? "(Unavailable from cache)";

                    if (before === after) return;

                    const embed = new EmbedBuilder()
                        .setColor("#2f4f8f")
                        .setTitle("✏️ Message Edited")
                        .addFields(
                            {
                                name: "Author",
                                value: newMessage.author ? `<@${newMessage.author.id}> (${newMessage.author.tag})` : "Unknown",
                                inline: false
                            },
                            { name: "Channel", value: `<#${newMessage.channelId}>`, inline: true },
                            { name: "Message ID", value: newMessage.id, inline: true },
                            { name: "Before", value: truncateForField(before, 1000), inline: false },
                            { name: "After", value: truncateForField(after, 1000), inline: false }
                        )
                        .setTimestamp();

                    await sendDiscordEventLog(newMessage.guild.id, embed);
                });

                client.on("guildMemberUpdate", async (oldMember, newMember) => {
                    if (!newMember.guild) return;

                    const addedRoles = newMember.roles.cache
                        .filter(role => !oldMember.roles.cache.has(role.id) && role.id !== newMember.guild.id)
                        .map(role => role.id);

                    const removedRoles = oldMember.roles.cache
                        .filter(role => !newMember.roles.cache.has(role.id) && role.id !== newMember.guild.id)
                        .map(role => role.id);

                    if (addedRoles.length === 0 && removedRoles.length === 0) return;

                    let addedBy = null;
                    let removedBy = null;

                    if (addedRoles.length > 0) {
                        addedBy = await resolveRoleUpdateActor(newMember.guild, newMember.id, addedRoles, "$add");
                    }

                    if (removedRoles.length > 0) {
                        removedBy = await resolveRoleUpdateActor(newMember.guild, newMember.id, removedRoles, "$remove");
                    }

                    const embed = new EmbedBuilder()
                        .setColor("#6a3db8")
                        .setTitle("🛡️ Member Roles Updated")
                        .addFields(
                            { name: "Affected Member", value: `<@${newMember.id}> (${newMember.user.tag})`, inline: false }
                        )
                        .setTimestamp();

                    if (addedRoles.length > 0) {
                        embed.addFields(
                            { name: "Roles Added", value: formatRoleMentions(addedRoles), inline: false },
                            {
                                name: "Added By",
                                value: addedBy ? `<@${addedBy}> (${addedBy})` : "Unknown (missing audit log permission or no recent entry)",
                                inline: false
                            }
                        );
                    }

                    if (removedRoles.length > 0) {
                        embed.addFields(
                            { name: "Roles Removed", value: formatRoleMentions(removedRoles), inline: false },
                            {
                                name: "Removed By",
                                value: removedBy ? `<@${removedBy}> (${removedBy})` : "Unknown (missing audit log permission or no recent entry)",
                                inline: false
                            }
                        );
                    }

                    await sendDiscordEventLog(newMember.guild.id, embed);
                });
            }

            const ticketEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("Welcome to HCSO Tickets")
                .setDescription("How can we help you today? Please choose one of the ticket types below.");

            const ticketButtons = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("ticket_ia_report")
                    .setLabel("IA Report")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId("ticket_general_support")
                    .setLabel("General Support")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId("ticket_ia_inquiry")
                    .setLabel("IA Inquiry")
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId("ticket_appeal_ban")
                    .setLabel("Appeal Ban")
                    .setStyle(ButtonStyle.Primary)
            );

            await interaction.reply({
                embeds: [ticketEmbed],
                components: [ticketButtons]
            });
        } catch (error) {
            console.error("Ticket panel error:", error);
            interaction.reply({
                content: `Error creating ticket panel: ${error.message}`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }

    // /ticket-add-user
    if (interaction.commandName === "ticket-add-user") {
        try {
            const userToAdd = interaction.options.getUser("user");
            
            // Check if command is run in a ticket channel
            const ticket = Object.values(tickets.tickets).find(t => t.channel === interaction.channel.id);
            if (!ticket) {
                return interaction.reply({
                    content: "❌ This command can only be used in a ticket channel.",
                    flags: MessageFlags.Ephemeral
                });
            }

            // Check permission (staff or ticket opener)
            const isStaff = interaction.member.permissions.has(PermissionFlagsBits.ManageMessages);
            const isOpener = interaction.user.id === ticket.opener;
            
            if (!isStaff && !isOpener) {
                return interaction.reply({
                    content: "❌ Only staff or the ticket opener can add users to this ticket.",
                    flags: MessageFlags.Ephemeral
                });
            }

            // Check if user is already in the ticket
            if (ticket.participants && ticket.participants.includes(userToAdd.id)) {
                return interaction.reply({
                    content: `❌ <@${userToAdd.id}> is already in this ticket.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            // Add user to channel permissions
            await interaction.channel.permissionOverwrites.create(userToAdd.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
            });

            // Add user to participants list
            if (!ticket.participants) {
                ticket.participants = [];
            }
            ticket.participants.push(userToAdd.id);
            saveTickets();

            const successEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("✅ User Added to Ticket")
                .setDescription(`<@${userToAdd.id}> has been added to this ticket and can now see all messages and participate.`)
                .setTimestamp();

            await interaction.reply({ embeds: [successEmbed] });
        } catch (error) {
            console.error("Ticket add user error:", error);
            const errorEmbed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Error Adding User")
                .setDescription(error.message || "An error occurred while adding the user.")
                .setTimestamp();
            
            interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }

    // /set-status
    if (interaction.commandName === "set-status") {
        try {
            // Check permission
            const canUseCommand = interaction.member.permissions.has(PermissionFlagsBits.Administrator) || 
                                (config.statusRoles && config.statusRoles.some(roleId => interaction.member.roles.cache.has(roleId)));
            
            if (!canUseCommand) {
                return interaction.reply({
                    content: "❌ You do not have permission to change the bot's status.",
                    flags: MessageFlags.Ephemeral
                });
            }

            const statusValue = interaction.options.getString("status");
            
            const statusMap = {
                online: { status: "online", activity: null },
                idle: { status: "idle", activity: null },
                dnd: { status: "dnd", activity: null },
                invisible: { status: "invisible", activity: null },
                watching_patrol: { status: "online", activity: { name: "Patrol Logs", type: ActivityType.Watching } },
                listening_radio: { status: "online", activity: { name: "Radio Traffic", type: ActivityType.Listening } },
                playing_hcso: { status: "online", activity: { name: "HCSO Operations", type: ActivityType.Playing } },
                watching_hc: { status: "online", activity: { name: "Over Hendry County Sheriff's Office", type: ActivityType.Watching } },
                competing_patrol: { status: "online", activity: { name: "Patrol Hours", type: ActivityType.Competing } }
            };

            const selectedStatus = statusMap[statusValue];
            
            // Update bot status
            await interaction.client.user.setPresence({
                activities: selectedStatus.activity ? [selectedStatus.activity] : [],
                status: selectedStatus.status
            });

            // Store status in config
            config.currentStatus = statusValue;
            saveConfig();

            const statusNames = {
                online: "Online",
                idle: "Idle",
                dnd: "Do Not Disturb",
                invisible: "Invisible",
                watching_patrol: "Watching Patrol Logs",
                listening_radio: "Listening to Radio Traffic",
                playing_hcso: "Playing HCSO Operations",
                watching_hc: "Watching Over Hendry County",
                competing_patrol: "Competing in Patrol Hours"
            };

            const confirmEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("✅ Bot Status Updated")
                .addFields(
                    { name: "New Status", value: statusNames[statusValue], inline: false },
                    { name: "Updated By", value: `<@${interaction.user.id}>`, inline: false }
                )
                .setTimestamp();

            await interaction.reply({ embeds: [confirmEmbed] });
        } catch (error) {
            console.error("Set status error:", error);
            const errorEmbed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Error Updating Status")
                .setDescription(error.message || "An error occurred while updating the status.")
                .setTimestamp();
            
            interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }

    // /transcript
    if (interaction.commandName === "transcript") {
        try {
            // Check if this is a ticket channel
            const channelName = interaction.channel.name;
            if (!channelName.startsWith("ticket-")) {
                return interaction.reply({
                    content: "❌ This command can only be used in ticket channels.",
                    flags: MessageFlags.Ephemeral
                });
            }

            // Extract ticket ID from channel name
            const ticketId = channelName.replace("ticket-", "");
            const ticket = tickets.tickets[ticketId];

            if (!ticket) {
                return interaction.reply({
                    content: "❌ Ticket not found.",
                    flags: MessageFlags.Ephemeral
                });
            }

            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            // Generate transcript
            console.log("[TRANSCRIPT] Generating transcript for", ticketId);
            const transcriptHtml = await generateTranscript(interaction.channel, ticket);
            if (!transcriptHtml) {
                return interaction.editReply({
                    content: "❌ Failed to generate transcript."
                });
            }

            console.log("[TRANSCRIPT] Transcript generated successfully");
            const transcriptFile = await saveTranscript(ticketId, transcriptHtml);
            if (!transcriptFile) {
                return interaction.editReply({
                    content: "❌ Failed to save transcript."
                });
            }

            console.log("[TRANSCRIPT] Transcript file saved:", transcriptFile);

            // Send to transcript log channel
            await sendTranscript(interaction.client, ticket, transcriptFile, transcriptHtml);

            // Send to user who requested it via DM
            try {
                const dmEmbed = new EmbedBuilder()
                    .setColor("#2d5a3d")
                    .setTitle("📋 Ticket Transcript Generated")
                    .setDescription(`You have generated a transcript for ticket #${ticketId}.`)
                    .addFields(
                        { name: "Ticket Type", value: ticket.type || "N/A", inline: true },
                        { name: "Opened By", value: `<@${ticket.opener}>`, inline: true },
                        { name: "Status", value: ticket.status, inline: true }
                    )
                    .setTimestamp();

                await interaction.user.send({ 
                    embeds: [dmEmbed], 
                    files: [{ attachment: Buffer.from(transcriptHtml), name: transcriptFile }] 
                }).catch(() => {});
            } catch (error) {
                console.error("Error sending transcript DM:", error);
            }

            await interaction.editReply({
                content: "✅ Transcript generated and sent to the transcript log channel. A copy has been sent to your DMs."
            });
        } catch (error) {
            console.error("Transcript command error:", error);
            const errorEmbed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Error Generating Transcript")
                .setDescription(error.message || "An error occurred while generating the transcript.")
                .setTimestamp();
            
            interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral }).catch(() => {});
        }
    }

    // /strike
    if (interaction.commandName === "strike") {
        const user = interaction.options.getUser("user");
        const reason = interaction.options.getString("reason");

        if (!interaction.guildId) {
            return interaction.reply({
                content: "❌ This command can only be used in a server.",
                flags: MessageFlags.Ephemeral
            });
        }

        const strikeEntries = getUserStrikeEntries(interaction.guildId, user.id);

        if (strikeEntries.length >= MAX_STRIKES) {
            await notifyOverStrikeAttempt(
                interaction.client,
                user.id,
                strikeEntries.length,
                staff.id,
                reason,
                "/strike command"
            );

            const overLimitLogEmbed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("🚨 Over-Strike Attempt Blocked")
                .addFields(
                    { name: "User", value: `<@${user.id}>`, inline: false },
                    { name: "Current Strikes", value: `${strikeEntries.length}/${MAX_STRIKES}`, inline: true },
                    { name: "Attempted By", value: `<@${staff.id}>`, inline: true },
                    { name: "Reason", value: reason, inline: false },
                    { name: "Source", value: "/strike command", inline: true }
                )
                .setTimestamp();

            const overLimitLogResult = await sendStrikeLog(interaction.client, interaction.guildId, overLimitLogEmbed);

            const embed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Strike Limit Reached")
                .addFields(
                    { name: "User", value: `<@${user.id}>`, inline: false },
                    { name: "Current Strikes", value: `${MAX_STRIKES}`, inline: true },
                    { name: "Status", value: `Maximum strikes reached (${MAX_STRIKES}/${MAX_STRIKES})`, inline: false }
                )
                .setTimestamp();

            if (!overLimitLogResult.ok) {
                embed.addFields({
                    name: "Log Warning",
                    value: overLimitLogResult.error.slice(0, 1024),
                    inline: false
                });
            }

            return interaction.reply({ embeds: [embed] });
        }

        strikeEntries.push({
            reason: reason,
            givenBy: staff.id,
            date: new Date().toISOString()
        });

        saveStrikes();

        const totalStrikes = strikeEntries.length;
        const roleId = STRIKE_ROLE_IDS[totalStrikes - 1] || "None";
        const roleSync = await syncUserStrikeRoles(interaction.guild, user.id, totalStrikes);

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("⚖️ Strike Added")
            .addFields(
                { name: "User", value: `<@${user.id}>`, inline: false },
                { name: "Total Strikes", value: `${totalStrikes}`, inline: true },
                { name: "Role Added", value: `<@&${roleId}>`, inline: true },
                { name: "Reason", value: reason, inline: false },
                { name: "Given By", value: `<@${staff.id}>`, inline: true }
            )
            .setTimestamp();

        if (!roleSync.ok && roleSync.errors.length > 0) {
            embed.addFields({
                name: "Role Sync Warning",
                value: roleSync.errors.slice(0, 2).join("\n").slice(0, 1024),
                inline: false
            });
        }

        interaction.reply({ embeds: [embed] });

        const logEmbed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("⚖️ Strike Logged")
            .addFields(
                { name: "User", value: `<@${user.id}>`, inline: false },
                { name: "Strike Count", value: `${totalStrikes}/${MAX_STRIKES}`, inline: true },
                { name: "Reason", value: reason, inline: false },
                { name: "Given By", value: `<@${staff.id}>`, inline: true },
                { name: "Source", value: "/strike command", inline: true }
            )
            .setTimestamp();
        const strikeLogResult = await sendStrikeLog(interaction.client, interaction.guildId, logEmbed);

        if (!strikeLogResult.ok) {
            embed.addFields({
                name: "Log Warning",
                value: strikeLogResult.error.slice(0, 1024),
                inline: false
            });
        }
    }

    // /strike-remove
    if (interaction.commandName === "strike-remove") {
        await interaction.deferReply();

        const user = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");

        if (!interaction.guildId) {
            return interaction.editReply({
                content: "❌ This command can only be used in a server."
            });
        }

        const strikeEntries = getUserStrikeEntries(interaction.guildId, user.id);

        const removed = Math.min(amount, strikeEntries.length);
        strikeEntries.splice(0, removed);
        saveStrikes();

        // Always clear all strike roles first to avoid stale role states.
        const clearRolesResult = await clearAllStrikeRoles(interaction.guild, user.id);

        // Re-apply the proper role state for remaining strikes.
        const roleSync = await syncUserStrikeRoles(interaction.guild, user.id, strikeEntries.length);
        const roleErrors = [...clearRolesResult.errors, ...roleSync.errors];

        const removedRoleLabel = removed > 0 ? `${removed}` : "0";

        const embed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("🗑️ Strikes Removed")
            .addFields(
                { name: "User", value: `<@${user.id}>`, inline: false },
                { name: "Strikes Removed", value: removedRoleLabel, inline: true },
                { name: "Remaining Strikes", value: `${strikeEntries.length}`, inline: true },
                { name: "Removed By", value: `<@${staff.id}>`, inline: false }
            )
            .setTimestamp();

        if (roleErrors.length > 0) {
            embed.addFields({
                name: "Role Sync Warning",
                value: roleErrors.slice(0, 2).join("\n").slice(0, 1024),
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });

        // Log to strike channel
        const strikeRemoveLogEmbed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("🗑️ Strikes Removed")
            .addFields(
                { name: "User", value: `<@${user.id}>`, inline: false },
                { name: "Strikes Removed", value: removedRoleLabel, inline: true },
                { name: "Remaining Strikes", value: `${strikeEntries.length}`, inline: true },
                { name: "Removed By", value: `<@${staff.id}>`, inline: true },
                { name: "Source", value: "/strike-remove command", inline: true }
            )
            .setTimestamp();
        const strikeRemoveLogResult = await sendStrikeLog(interaction.client, interaction.guildId, strikeRemoveLogEmbed);

        if (!strikeRemoveLogResult.ok) {
            embed.addFields({
                name: "Log Warning",
                value: strikeRemoveLogResult.error.slice(0, 1024),
                inline: false
            });
        }
    }

    // /strike-logs
    if (interaction.commandName === "strike-logs") {
        const user = interaction.options.getUser("user");

        if (!interaction.guildId) {
            return interaction.reply({
                content: "❌ This command can only be used in a server.",
                flags: MessageFlags.Ephemeral
            });
        }

        const logs = getUserStrikeEntries(interaction.guildId, user.id);

        if (!logs || logs.length === 0) {
            const embed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("📋 Strike History")
                .addFields(
                    { name: "User", value: `<@${user.id}>`, inline: false },
                    { name: "Total Strikes", value: "None", inline: true }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        // Create embeds with max 5 strikes each to avoid character limit
        const embeds = [];
        let currentEmbed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle("📋 Strike History")
            .addFields(
                { name: "User", value: `<@${user.id}>`, inline: false },
                { name: "Total Strikes", value: `${logs.length}`, inline: true }
            );

        logs.forEach((entry, i) => {
            const givenBy = entry.givenBy || entry.issuedBy || "Unknown";
            currentEmbed.addFields(
                { name: `Strike #${i + 1}`, value: `**Reason:** ${entry.reason}\n**Given By:** <@${givenBy}>`, inline: false }
            );

            // If we've added 5 strikes or it's the last one, finalize this embed
            if ((i + 1) % 5 === 0 || i === logs.length - 1) {
                currentEmbed.setTimestamp();
                embeds.push(currentEmbed);
                if (i !== logs.length - 1) {
                    currentEmbed = new EmbedBuilder()
                        .setColor("#2d5a3d")
                        .setTitle("📋 Strike History (Continued)");
                }
            }
        });

        return interaction.reply({ embeds: embeds });
    }

    // /commendation
    if (interaction.commandName === "commendation") {
        const sub = interaction.options.getSubcommand();

        if (sub === "give") {
            const user = interaction.options.getUser("user");
            const reason = interaction.options.getString("reason");

            const entries = getUserCommendations(user.id);
            const commendationNumber = entries.length + 1;

            entries.push({
                id: commendationNumber,
                reason,
                givenBy: interaction.user.id,
                date: new Date().toISOString().slice(0, 10)
            });
            saveCommendations();

            const embed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("🏅 Commendation Issued")
                .setDescription(`Commendation added for <@${user.id}>.`)
                .addFields(
                    { name: `Commendation #${commendationNumber}`, value: `**Reason:** ${reason}`, inline: false },
                    { name: "Given By", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Date", value: new Date().toISOString().slice(0, 10), inline: true }
                )
                .setTimestamp();

            interaction.reply({ embeds: [embed] });

            const logEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("=== NEW COMMENDATION ===")
                .addFields(
                    { name: "Officer", value: `<@${user.id}>`, inline: false },
                    { name: "Given By", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Commendation #", value: `${commendationNumber}`, inline: true },
                    { name: "Reason", value: reason, inline: false },
                    { name: "Date", value: new Date().toISOString().slice(0, 10), inline: true }
                )
                .setTimestamp();

            await sendCommendationLog(interaction.client, interaction.guildId, logEmbed);
        }

        if (sub === "list") {
            const user = interaction.options.getUser("user");
            const entries = getUserCommendations(user.id);

            if (entries.length === 0) {
                return interaction.reply({
                    content: `This officer has no commendations.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            const embeds = [];
            let currentEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle(`=== COMMENDATIONS FOR ${user.username.toUpperCase()} ===`)
                .setDescription(`Total Commendations: **${entries.length}**`);

            entries.forEach((entry, i) => {
                const fieldValue = `**Given By:** <@${entry.givenBy}>\n**Date:** ${entry.date}\n**Reason:** ${entry.reason}`;
                currentEmbed.addFields({ name: `#${entry.id}`, value: fieldValue, inline: false });

                if ((i + 1) % 10 === 0 || i === entries.length - 1) {
                    currentEmbed.setTimestamp();
                    embeds.push(currentEmbed);
                    if (i !== entries.length - 1) {
                        currentEmbed = new EmbedBuilder()
                            .setColor("#2d5a3d")
                            .setTitle("=== COMMENDATIONS (Continued) ===");
                    }
                }
            });

            return interaction.reply({ embeds });
        }

        if (sub === "remove") {
            const user = interaction.options.getUser("user");
            const number = interaction.options.getInteger("number");

            const entries = getUserCommendations(user.id);
            const idx = entries.findIndex(e => e.id === number);

            if (idx === -1) {
                return interaction.reply({
                    content: `❌ Commendation #${number} not found for <@${user.id}>.`,
                    flags: MessageFlags.Ephemeral
                });
            }

            entries.splice(idx, 1);
            saveCommendations();

            const embed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("🗑️ Commendation Removed")
                .setDescription(`Commendation #${number} has been removed from <@${user.id}>.`)
                .addFields(
                    { name: "Removed By", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Date", value: new Date().toISOString().slice(0, 10), inline: true }
                )
                .setTimestamp();

            interaction.reply({ embeds: [embed] });

            const logEmbed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("=== COMMENDATION REMOVED ===")
                .addFields(
                    { name: "Officer", value: `<@${user.id}>`, inline: false },
                    { name: "Removed By", value: `<@${interaction.user.id}>`, inline: true },
                    { name: "Commendation #", value: `${number}`, inline: true },
                    { name: "Date", value: new Date().toISOString().slice(0, 10), inline: true }
                )
                .setTimestamp();

            await sendCommendationLog(interaction.client, interaction.guildId, logEmbed);
        }
    }

    // /purge
    if (interaction.commandName === "purge") {
        // Check if user has permission
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
            const embed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Permission Denied")
                .addFields(
                    { name: "Error", value: "You don't have permission to use this command.", inline: false }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        const amount = interaction.options.getInteger("amount");

        try {
            const messages = await interaction.channel.bulkDelete(amount, true);

            const embed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("🗑️ Messages Purged")
                .addFields(
                    { name: "Amount Deleted", value: `${messages.size}`, inline: true },
                    { name: "Channel", value: `<#${interaction.channel.id}>`, inline: true },
                    { name: "Purged By", value: `<@${staff.id}>`, inline: false }
                )
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        } catch (error) {
            const embed = new EmbedBuilder()
                .setColor("#8b0000")
                .setTitle("❌ Purge Failed")
                .addFields(
                    { name: "Error", value: "Could not delete messages. Messages older than 2 weeks cannot be deleted.", inline: false }
                )
                .setTimestamp();
            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
    }

    // /dashboard command
    if (interaction.commandName === "dashboard") {
        try {
            // Check if user has access to dashboard
            if (!canAccessDashboard(interaction.member)) {
                const errorEmbed = new EmbedBuilder()
                    .setColor("#8b0000")
                    .setTitle("❌ Access Denied")
                    .setDescription("Only Administrators, Supervisors, IA, or Sheriff can access the dashboard.")
                    .setTimestamp();
                return interaction.reply({ embeds: [errorEmbed], flags: MessageFlags.Ephemeral });
            }

            // Create main dashboard embed
            const dashboardEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("🏢 HCSO Department Dashboard")
                .setDescription("Select a module below to manage patrol, cases, IA, tickets, logs, and more.")
                .setThumbnail(interaction.client.user.displayAvatarURL({ size: 128 }))
                .setTimestamp();

            // Build button rows showing only modules this user can access
            const dashboardRows = buildDashboardComponents(interaction.member);
            if (dashboardRows.length === 0) {
                return interaction.reply({
                    content: "❌ You don't have access to any dashboard modules.",
                    flags: MessageFlags.Ephemeral
                });
            }

            return interaction.reply({
                embeds: [dashboardEmbed],
                components: dashboardRows,
                flags: MessageFlags.Ephemeral
            });
        } catch (error) {
            console.error("Dashboard command error:", error);
            return interaction.reply({
                content: "❌ An error occurred while loading the dashboard.",
                flags: MessageFlags.Ephemeral
            });
        }
    }
    } catch (error) {
        console.error(error);
        await safeInteractionErrorReply(interaction, `Error: ${error.message}`);
    }
});

// Handle messages in ticket channels
client.on("messageCreate", async message => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Check if this is a ticket channel
    const ticketEntry = Object.entries(tickets.tickets).find(
        ([_, ticket]) => ticket.channel === message.channelId && ticket.status === "open"
    );

    if (!ticketEntry) return;

    const [ticketId, ticket] = ticketEntry;

    // Check if this is the ticket opener's first message (only process it once)
    if (message.author.id === ticket.opener && !ticket.firstMessageProcessed) {
        // Mark as processed so we don't do this again
        ticket.firstMessageProcessed = true;
        saveTickets();

        // Delete the user's message
        await message.delete().catch(() => {});

        // Repost it in a green embed
        const userEmbed = new EmbedBuilder()
            .setColor("#2d5a3d")
            .setTitle(`${message.author.username}'s Message`)
            .setDescription(message.content || "(No content)")
            .setFooter({ text: message.author.username })
            .setTimestamp(message.createdTimestamp);

        // Add attachments if any
        if (message.attachments.size > 0) {
            const attachments = Array.from(message.attachments.values())
                .map(att => `[${att.name}](${att.url})`)
                .join(", ");
            userEmbed.addFields({ name: "Attachments", value: attachments, inline: false });
        }

        await message.channel.send({ embeds: [userEmbed] }).catch(() => {});
    }

    // Handle supervisor alert messages
    if (message.reference) {
        try {
            const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
            if (repliedTo && repliedTo.author.id === message.client.user.id && repliedTo.content.includes("Send Alert to Supervisors")) {
                const alertMessage = message.content;
                
                // Delete the user's message
                await message.delete().catch(() => {});

                // Find all members who have access to supervisor tools
                const guild = message.guild;
                const supervisorRoleIds = config.moduleRoleAccess?.supervisor || [];
                
                let supervisorMembers = new Set();
                
                for (const member of (await guild.members.fetch()).values()) {
                    // Check if they have supervisor access
                    const hasAccess = canAccessModule(member, "supervisor");
                    if (hasAccess) {
                        supervisorMembers.add(member);
                    }
                }

                // Send DM to each supervisor
                const alertEmbed = new EmbedBuilder()
                    .setColor("#FF0000")
                    .setTitle("🚨 Supervisor Alert")
                    .setDescription(alertMessage)
                    .addFields(
                        { name: "Sent By", value: message.author.username, inline: true },
                        { name: "Sent At", value: new Date().toLocaleString(), inline: true }
                    )
                    .setTimestamp();

                for (const supervisor of supervisorMembers) {
                    try {
                        await supervisor.send({ embeds: [alertEmbed] });
                    } catch (err) {
                        console.log(`Could not DM ${supervisor.user.username}`);
                    }
                }

                // Confirm alert was sent
                const confirmEmbed = new EmbedBuilder()
                    .setColor("#00FF00")
                    .setTitle("✅ Alert Sent")
                    .setDescription(`Alert sent to ${supervisorMembers.size} supervisor(s).`)
                    .setTimestamp();

                await message.channel.send({
                    embeds: [confirmEmbed]
                }).catch(() => {});
            }
        } catch (err) {
            // Not a reply to supervisor alert, ignore
        }
    }
});

// Handle prefix commands
client.on("messageCreate", async message => {
    if (message.author.bot) return;
    if (!message.content.startsWith(">")) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // >addrank command
    if (command === "addrank") {
        try {
            // Check admin permission
            if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return message.reply("❌ You do not have permission to use this command.");
            }

            // Get mentioned role
            const role = message.mentions.roles.first();
            if (!role) {
                return message.reply("❌ Please mention a role. Example: `>addrank @Role`");
            }

            // Initialize statusRoles array if it doesn't exist
            if (!config.statusRoles) {
                config.statusRoles = [];
            }

            // Check if role is already in the list
            if (config.statusRoles.includes(role.id)) {
                return message.reply(`❌ <@&${role.id}> already has access to status commands.`);
            }

            // Add role to statusRoles
            config.statusRoles.push(role.id);
            saveConfig();

            const confirmEmbed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle("✅ Role Added")
                .setDescription(`<@&${role.id}> can now use the set-status command.`)
                .setTimestamp();

            await message.reply({ embeds: [confirmEmbed] });
        } catch (error) {
            console.error("Addrank error:", error);
            message.reply(`❌ Error: ${error.message}`);
        }
    }
});

client.login(TOKEN);
