/**
 * Main dashboard page routes and all API command endpoints.
 * Extracted from the root dashboard.js so the entry point stays lean.
 */
import { Router } from "express";
import { ActivityType, EmbedBuilder } from "discord.js";
import { getBranding } from "../embeds/departmentThemes.js";

/**
 * @param {Object}   context   - Shared bot state passed in from index.js
 * @param {Object}   helpers
 * @param {Function} helpers.requireAuth
 * @param {Function} helpers.requireStaff
 * @param {Function} helpers.getDashboardGuild
 * @param {Function} helpers.getMainRoleGuild
 * @param {Function} helpers.segmentGuard
 * @param {string[]} helpers.DASHBOARD_SEGMENTS
 * @param {string} helpers.BOT_OWNER_ID
 * @param {string} helpers.ROLE_SOURCE_GUILD_ID
 * @returns {import("express").Router}
 */
export function createMainRoutes(context, { requireAuth, requireStaff, getDashboardGuild, getMainRoleGuild, segmentGuard, DASHBOARD_SEGMENTS, BOT_OWNER_ID, ROLE_SOURCE_GUILD_ID }) {
    const {
        client,
        strikes,
        patrols,
        loa,
        casesData,
        tickets,
        blacklists,
        config,
        saveStrikes,
        saveLOA,
        saveCases,
        saveConfig,
        getUserStrikeEntries,
        syncUserStrikeRoles,
        MAX_STRIKES,
    } = context;

    const GUILD_ID = process.env.GUILD_ID;
    const LOA_ROLE_ID = "1482203107806150668";
    const router   = Router();

    function getDashboardLogChannelId(guildId, logType) {
        const channels = config.logChannels || {};
        const guildScoped = guildId && channels[guildId] && typeof channels[guildId] === "object"
            ? channels[guildId]
            : null;

        if (guildScoped && typeof guildScoped[logType] === "string" && guildScoped[logType]) {
            return guildScoped[logType];
        }

        if (typeof channels[logType] === "string" && channels[logType]) {
            return channels[logType];
        }

        return null;
    }

    async function sendDashboardActionLog({ guildId, logType, title, fields, color = 0xF8B637 }) {
        try {
            const channelId = getDashboardLogChannelId(guildId, logType);
            if (!channelId) return;

            const channel = client.channels.cache.get(channelId)
                || await client.channels.fetch(channelId).catch(() => null);

            if (!channel || !channel.isTextBased()) return;

            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(title)
                .addFields(...(fields || []))
                .setTimestamp();

            await channel.send({ embeds: [embed] }).catch(() => {});
        } catch {
            // Non-fatal: dashboard action succeeded even if log channel fails.
        }
    }

    // Returns the exact key used in casesData.cases that matches the given id,
    // trying exact → uppercase → case-insensitive scan so old keys like
    // "CASE-000NaN" are still found even when the caller uppercases them.
    function resolveCaseKey(rawId) {
        const id = String(rawId || "").trim();
        if (!id) return null;
        const cases = casesData.cases || {};
        if (id in cases) return id;
        const up = id.toUpperCase();
        if (up in cases) return up;
        const lower = id.toLowerCase();
        const found = Object.keys(cases).find(k => k.toLowerCase() === lower);
        return found || null;
    }

    function normalizeCaseId(caseId) {
        return String(caseId || "").trim();
    }

    function isCaseClosed(entry) {
        if (!entry) return false;
        if (typeof entry.closed === "boolean") return entry.closed;
        return String(entry.status || "").trim().toLowerCase() === "closed";
    }

    function setCaseStatus(entry, closed) {
        entry.status = closed ? "Closed" : "Open";
        entry.closed = closed;
    }

    function ensureCaseCounter() {
        const current = Number(casesData.caseCounter) || 0;
        const discoveredMax = Object.keys(casesData.cases || {}).reduce((max, id) => {
            const m = /^CASE-(\d+)$/.exec(String(id).toUpperCase());
            return m ? Math.max(max, Number(m[1]) || 0) : max;
        }, 0);
        casesData.caseCounter = Math.max(current, discoveredMax);
    }

    // ── Public ────────────────────────────────────────────────────────────────
    router.get("/health", (req, res) => res.send("OK"));

    router.get("/login", (req, res) => {
        if (req.session.user) return res.redirect("/");
        res.render("login", { page: "login", error: req.query.error || null });
    });

    // ── Dashboard home ────────────────────────────────────────────────────────
    router.get("/", requireStaff, segmentGuard("home"), async (req, res) => {
        const uptime = process.uptime();
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = Math.floor(uptime % 60);

        const guild = await getDashboardGuild();

        let totalStrikes = 0;
        const guildStrikes = GUILD_ID ? strikes[GUILD_ID] : null;
        if (guildStrikes && typeof guildStrikes === "object" && !Array.isArray(guildStrikes)) {
            for (const userStrikes of Object.values(guildStrikes)) {
                if (Array.isArray(userStrikes)) totalStrikes += userStrikes.length;
            }
        }

        const activePatrols = Object.values(patrols).filter(p => p.active).length;
        const activeLoas    = Object.values(loa).filter(l => l.onLOA).length;
        const openCases     = Object.values(casesData.cases || {})
            .filter(c => (c.status ? c.status !== "closed" : !c.closed)).length;
        const openTickets   = Object.values(tickets.tickets || {}).filter(t => t.status === "open").length;

        res.render("home", {
            page:         "home",
            uptime:       `${h}h ${m}m ${s}s`,
            ping:         client.ws.ping,
            guildCount:   client.guilds.cache.size,
            memberCount:  guild?.memberCount || 0,
            totalStrikes,
            activePatrols,
            activeLoas,
            openCases,
            openTickets
        });
    });

    // ── Bot Status ────────────────────────────────────────────────────────────
    router.get("/status", requireStaff, segmentGuard("status"), (req, res) => {
        const mem    = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        res.render("status", {
            page:          "status",
            online:        client.isReady(),
            ping:          client.ws.ping,
            uptimeSeconds: uptime,
            heapUsed:      Math.round(mem.heapUsed  / 1024 / 1024),
            heapTotal:     Math.round(mem.heapTotal / 1024 / 1024),
            rss:           Math.round(mem.rss       / 1024 / 1024),
            nodeVersion:   process.version,
            guildCount:    client.guilds.cache.size
        });
    });

    // ── Commands page ─────────────────────────────────────────────────────────
    router.get("/commands", requireStaff, segmentGuard("commands"), async (req, res) => {
        const guild = await getDashboardGuild();
        let members  = [];
        let channels = [];

        if (guild) {
            try {
                await guild.members.fetch();
                await guild.channels.fetch();
                members = [...guild.members.cache.values()]
                    .filter(m => !m.user.bot)
                    .map(m => ({ id: m.id, name: m.displayName || m.user.username }))
                    .sort((a, b) => a.name.localeCompare(b.name));

                channels = [...guild.channels.cache.values()]
                    .filter(c => c?.isTextBased() && !c.isDMBased() && c.type !== 4)
                    .map(c => ({ id: c.id, name: c.name, parent: c.parent?.name || "Uncategorized" }))
                    .sort((a, b) => a.name.localeCompare(b.name));
            } catch (e) {
                console.error("[Dashboard] Member/channel fetch:", e.message);
            }
        }

        const allCases = Object.entries(casesData.cases || {})
            .map(([id, c]) => ({
                id,
                title: c.title || id,
                status: c.status || (isCaseClosed(c) ? "Closed" : "Open"),
                createdAt: c.createdAt || null,
            }))
            .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
            .slice(0, 500);

        const openCases = allCases.filter(c => String(c.status).toLowerCase() !== "closed").slice(0, 100);

        const usersOnLoa = Object.entries(loa)
            .filter(([, d]) => d.onLOA)
            .map(([id]) => {
                const member = guild?.members.cache.get(id);
                return { id, name: member?.displayName || id };
            });

        res.render("commands", {
            page: "commands",
            members,
            channels,
            openCases,
            allCases,
            usersOnLoa
        });
    });

    // ── Logs page ─────────────────────────────────────────────────────────────
    router.get("/logs", requireStaff, segmentGuard("logs"), (req, res) => {
        const filter  = req.query.type  || "all";
        const curPage = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = 50;
        const logs    = [];

        if (filter === "all" || filter === "strike") {
            const gStrikes = GUILD_ID ? strikes[GUILD_ID] : null;
            if (gStrikes && typeof gStrikes === "object" && !Array.isArray(gStrikes)) {
                for (const [uid, entries] of Object.entries(gStrikes)) {
                    if (!Array.isArray(entries)) continue;
                    entries.forEach(e => logs.push({
                        type: "strike", icon: "⚖️", label: "Strike",
                        userId: uid, description: e.reason || "No reason",
                        performer: e.givenBy,
                        timestamp: new Date(e.date || 0).getTime()
                    }));
                }
            }
        }

        if (filter === "all" || filter === "loa") {
            for (const [uid, data] of Object.entries(loa)) {
                if (!data.onLOA) continue;
                logs.push({
                    type: "loa", icon: "🌴", label: "LOA Active",
                    userId: uid,
                    description: `${data.startDate || "?"} → ${data.endDate || "?"}`,
                    performer: null, timestamp: 0
                });
            }
        }

        if (filter === "all" || filter === "patrol") {
            for (const [uid, data] of Object.entries(patrols)) {
                if (!data.completed) continue;
                data.completed.forEach(p => {
                    const dur = p.duration || 0;
                    const ph  = Math.floor(dur / 3600000);
                    const pm  = Math.floor((dur % 3600000) / 60000);
                    logs.push({
                        type: "patrol", icon: "🚔", label: "Patrol",
                        userId: uid,
                        description: `${ph}h ${pm}m — ${p.date || "unknown"}`,
                        performer: null, timestamp: p.startTime || 0
                    });
                });
            }
        }

        if (filter === "all" || filter === "case") {
            for (const [id, c] of Object.entries(casesData.cases || {})) {
                logs.push({
                    type: "case", icon: "📋", label: "Case",
                    userId: c.createdBy,
                    description: `[${id}] ${c.title || "Untitled"} — ${c.status}`,
                    performer: c.createdBy,
                    timestamp: new Date(c.createdAt || 0).getTime()
                });
            }
        }

        if (filter === "all" || filter === "blacklist") {
            const gBans = GUILD_ID ? blacklists[GUILD_ID] : null;
            if (gBans && typeof gBans === "object" && !Array.isArray(gBans)) {
                for (const [uid, entry] of Object.entries(gBans)) {
                    logs.push({
                        type: "blacklist", icon: "🚫", label: "Blacklist",
                        userId: uid,
                        description: entry.reason || "No reason",
                        performer: entry.moderatorId || null,
                        timestamp: new Date(entry.timestamp || 0).getTime()
                    });
                }
            }
        }

        logs.sort((a, b) => b.timestamp - a.timestamp);
        const totalLogs  = logs.length;
        const totalPages = Math.max(1, Math.ceil(totalLogs / perPage));
        const paginated  = logs.slice((curPage - 1) * perPage, curPage * perPage);

        res.render("logs", {
            page: "logs",
            logs:       paginated,
            filter,
            currentPage: curPage,
            totalPages,
            totalLogs
        });
    });

    async function getBotOwnerAccessViewModel(req) {
        const mainGuild = await getMainRoleGuild();
        const availableRoles = mainGuild
            ? mainGuild.roles.cache
                .filter(r => r.name !== "@everyone")
                .map(r => ({ id: r.id, name: r.name }))
                .sort((a, b) => a.name.localeCompare(b.name))
            : [];

        const dashboardSegmentAccess = config.dashboardSegmentAccess && typeof config.dashboardSegmentAccess === "object"
            ? config.dashboardSegmentAccess
            : {};

        return {
            availableRoles,
            segmentKeys: DASHBOARD_SEGMENTS,
            isBotOwner: req.session.user?.id === BOT_OWNER_ID,
            botOwnerId: BOT_OWNER_ID,
            currentUserId: req.session.user?.id || null,
            roleSourceGuildId: ROLE_SOURCE_GUILD_ID,
            roleSourceGuildName: mainGuild?.name || "Hendry County Sheriff's Office",
            dashboardSegmentAccess
        };
    }

    // ── Settings page ─────────────────────────────────────────────────────────
    router.get("/settings", requireStaff, segmentGuard("settings"), async (req, res) => {
        const ownerVm = await getBotOwnerAccessViewModel(req);

        res.render("settings", {
            page:    "settings",
            cfg: {
                logChannels:         config.logChannels         || {},
                currentStatus:       config.currentStatus       || "watching_hc",
                blacklistJoinAction: config.blacklistJoinAction || "ban",
                ticketTypes:         config.ticketTypes         || [],
                statusRoles:         config.statusRoles         || [],
                moduleRoleAccess:    config.moduleRoleAccess    || {},
                dashboardSegmentAccess: ownerVm.dashboardSegmentAccess
            },
            guildId: GUILD_ID || null,
            isBotOwner: ownerVm.isBotOwner
        });
    });

    // ── Bot Owner page (separate from Settings) ──────────────────────────────
    router.get("/bot-owner", requireStaff, segmentGuard("settings"), async (req, res) => {
        const ownerVm = await getBotOwnerAccessViewModel(req);
        res.render("bot-owner", {
            page: "bot-owner",
            cfg: {
                dashboardSegmentAccess: ownerVm.dashboardSegmentAccess
            },
            availableRoles: ownerVm.availableRoles,
            segmentKeys: ownerVm.segmentKeys,
            isBotOwner: ownerVm.isBotOwner,
            botOwnerId: ownerVm.botOwnerId,
            currentUserId: ownerVm.currentUserId,
            roleSourceGuildId: ownerVm.roleSourceGuildId,
            roleSourceGuildName: ownerVm.roleSourceGuildName
        });
    });

    // ── API: Strike ───────────────────────────────────────────────────────────
    router.post("/api/commands/strike", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { userId, reason } = req.body;
            if (!userId || !reason) return res.status(400).json({ error: "Missing userId or reason" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const entries = getUserStrikeEntries(GUILD_ID, userId);
            if (entries.length >= MAX_STRIKES) {
                return res.status(400).json({ error: `User already has ${MAX_STRIKES}/${MAX_STRIKES} strikes` });
            }
            entries.push({ reason, givenBy: req.session.user.id, date: new Date().toISOString() });
            saveStrikes();
            await syncUserStrikeRoles(guild, userId, entries.length);

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "strike",
                title: "⚖️ Dashboard Strike Added",
                fields: [
                    { name: "Target", value: `<@${userId}>`, inline: true },
                    { name: "Given By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Reason", value: reason, inline: false },
                    { name: "Total Strikes", value: String(entries.length), inline: true }
                ],
                color: 0xE8A020
            });

            res.json({ success: true, totalStrikes: entries.length });
        } catch (err) {
            console.error("[Dashboard API] strike:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Strike Remove ────────────────────────────────────────────────────
    router.post("/api/commands/strike-remove", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { userId, amount } = req.body;
            if (!userId) return res.status(400).json({ error: "Missing userId" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const entries = getUserStrikeEntries(GUILD_ID, userId);
            const remove  = Math.min(parseInt(amount) || 1, entries.length);
            entries.splice(entries.length - remove, remove);
            saveStrikes();
            await syncUserStrikeRoles(guild, userId, entries.length);

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "strike",
                title: "🧹 Dashboard Strike Removed",
                fields: [
                    { name: "Target", value: `<@${userId}>`, inline: true },
                    { name: "Removed By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Removed", value: String(remove), inline: true },
                    { name: "Remaining", value: String(entries.length), inline: true }
                ],
                color: 0x3B82F6
            });

            res.json({ success: true, removed: remove, totalStrikes: entries.length });
        } catch (err) {
            console.error("[Dashboard API] strike-remove:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Ban ──────────────────────────────────────────────────────────────
    router.post("/api/commands/ban", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { userId, reason } = req.body;
            if (!userId || !reason) return res.status(400).json({ error: "Missing userId or reason" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            await guild.members.ban(userId, {
                reason: `Dashboard ban by ${req.session.user.username}: ${reason}`
            });

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "ban",
                title: "🔨 Dashboard Ban",
                fields: [
                    { name: "Target", value: `<@${userId}>`, inline: true },
                    { name: "Banned By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Reason", value: reason, inline: false }
                ],
                color: 0xE03C3C
            });

            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] ban:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Kick ─────────────────────────────────────────────────────────────
    router.post("/api/commands/kick", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { userId, reason } = req.body;
            if (!userId || !reason) return res.status(400).json({ error: "Missing userId or reason" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild  = client.guilds.cache.get(GUILD_ID);
            if (!guild)  return res.status(404).json({ error: "Guild not found" });

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member)         return res.status(404).json({ error: "Member not found in guild" });
            if (!member.kickable) return res.status(403).json({ error: "Cannot kick this member (role hierarchy)" });

            await member.kick(`Dashboard kick by ${req.session.user.username}: ${reason}`);

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "moderation",
                title: "👢 Dashboard Kick",
                fields: [
                    { name: "Target", value: `<@${userId}>`, inline: true },
                    { name: "Kicked By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Reason", value: reason, inline: false }
                ],
                color: 0xE03C3C
            });

            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] kick:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Timeout ──────────────────────────────────────────────────────────
    router.post("/api/commands/timeout", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { userId, minutes, reason } = req.body;
            if (!userId || !minutes) return res.status(400).json({ error: "Missing userId or minutes" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild  = client.guilds.cache.get(GUILD_ID);
            if (!guild)  return res.status(404).json({ error: "Guild not found" });

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member)             return res.status(404).json({ error: "Member not found in guild" });
            if (!member.moderatable) return res.status(403).json({ error: "Cannot timeout this member" });

            const ms = Math.min(parseInt(minutes) * 60 * 1000, 28 * 24 * 60 * 60 * 1000);
            await member.timeout(ms, `Dashboard timeout by ${req.session.user.username}: ${reason || "No reason"}`);

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "timeout",
                title: "⏱️ Dashboard Timeout",
                fields: [
                    { name: "Target", value: `<@${userId}>`, inline: true },
                    { name: "Timed Out By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Minutes", value: String(minutes), inline: true },
                    { name: "Reason", value: reason || "No reason", inline: false }
                ],
                color: 0x8E44AD
            });

            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] timeout:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Unban ────────────────────────────────────────────────────────────
    router.post("/api/commands/unban", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { userId, reason } = req.body;
            if (!userId) return res.status(400).json({ error: "Missing userId" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild = client.guilds.cache.get(GUILD_ID);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            await guild.bans.remove(userId, reason || `Unbanned via dashboard by ${req.session.user.username}`);

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "moderation",
                title: "🔓 Dashboard Unban",
                fields: [
                    { name: "Target", value: `<@${userId}>`, inline: true },
                    { name: "Unbanned By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Reason", value: reason || "No reason", inline: false }
                ],
                color: 0x23A559
            });

            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] unban:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Purge ────────────────────────────────────────────────────────────
    router.post("/api/commands/purge", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { channelId, amount } = req.body;
            if (!channelId || !amount) return res.status(400).json({ error: "Missing channelId or amount" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild = await getDashboardGuild();
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) return res.status(404).json({ error: "Text channel not found" });

            const count   = Math.min(Math.max(1, parseInt(amount) || 1), 100);
            const deleted = await channel.bulkDelete(count, true);

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "moderation",
                title: "🧹 Dashboard Purge",
                fields: [
                    { name: "Channel", value: `<#${channelId}>`, inline: true },
                    { name: "Requested", value: String(count), inline: true },
                    { name: "Deleted", value: String(deleted.size), inline: true },
                    { name: "Performed By", value: `<@${req.session.user.id}>`, inline: true }
                ],
                color: 0x3B82F6
            });

            res.json({ success: true, deleted: deleted.size });
        } catch (err) {
            console.error("[Dashboard API] purge:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Announce ─────────────────────────────────────────────────────────
    router.post("/api/commands/announce", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { channelId, title, message } = req.body;
            if (!channelId || !message) return res.status(400).json({ error: "Missing channelId or message" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild = await getDashboardGuild();
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const channel = await guild.channels.fetch(channelId).catch(() => null);
            if (!channel?.isTextBased()) return res.status(404).json({ error: "Text channel not found" });

            const { EmbedBuilder } = await import("discord.js");
            const branding = getBranding();
            const embed = new EmbedBuilder()
                .setColor(0xF8B637)
                .setTitle(title?.trim() || `📢 ${branding.communityName} Announcement`)
                .setDescription(message)
                .setFooter({ text: `Posted by ${req.session.user.username} via ${branding.dashboardTitle}` })
                .setTimestamp();

            await channel.send({ embeds: [embed] });

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "discord",
                title: "📣 Dashboard Announcement",
                fields: [
                    { name: "Channel", value: `<#${channelId}>`, inline: true },
                    { name: "Posted By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Title", value: title?.trim() || "Announcement", inline: false }
                ],
                color: 0x5865F2
            });

            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] announce:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: LOA ──────────────────────────────────────────────────────────────
    router.post("/api/commands/loa", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { userId, startDate, endDate, reason } = req.body;
            if (!userId || !startDate || !endDate) return res.status(400).json({ error: "Missing required fields" });

            const dateRe = /^\d{2}-\d{2}-\d{4}$/;
            if (!dateRe.test(startDate) || !dateRe.test(endDate)) {
                return res.status(400).json({ error: "Dates must be MM-DD-YYYY" });
            }

            if (!loa[userId]) loa[userId] = {};
            loa[userId].onLOA     = true;
            loa[userId].startDate = startDate;
            loa[userId].endDate   = endDate;
            loa[userId].reason    = reason || "";

            const guild = await getDashboardGuild();
            const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
            if (guild && member) {
                const loaRole = await guild.roles.fetch(LOA_ROLE_ID).catch(() => null);
                if (loaRole) {
                    await member.roles.add(loaRole).catch(() => {});
                }
            }

            saveLOA();

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "loa",
                title: "🌴 Dashboard LOA Set",
                fields: [
                    { name: "Target", value: `<@${userId}>`, inline: true },
                    { name: "Set By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Start", value: startDate, inline: true },
                    { name: "End", value: endDate, inline: true },
                    { name: "Reason", value: reason || "No reason", inline: false },
                    { name: "Role", value: `<@&${LOA_ROLE_ID}>`, inline: true }
                ],
                color: 0x23A559
            });

            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] loa:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: End LOA ──────────────────────────────────────────────────────────
    router.post("/api/commands/end-loa", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: "Missing userId" });

            if (!loa[userId]?.onLOA) return res.status(400).json({ error: "User is not currently on LOA" });

            const guild = await getDashboardGuild();
            const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
            if (guild && member) {
                const loaRole = await guild.roles.fetch(LOA_ROLE_ID).catch(() => null);
                if (loaRole) {
                    await member.roles.remove(loaRole).catch(() => {});
                }
            }

            loa[userId].onLOA = false;
            saveLOA();

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "loa",
                title: "✅ Dashboard LOA Ended",
                fields: [
                    { name: "Target", value: `<@${userId}>`, inline: true },
                    { name: "Ended By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Role Removed", value: `<@&${LOA_ROLE_ID}>`, inline: true }
                ],
                color: 0x23A559
            });

            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] end-loa:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Create ──────────────────────────────────────────────────────
    router.post("/api/commands/case-create", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const title = String(req.body.title || "").trim();
            const incidentType = String(req.body.incidentType || "").trim();
            const location = String(req.body.location || "").trim();
            const suspect = String(req.body.suspect || "").trim() || "Unknown";
            const summary = String(req.body.summary || "").trim();

            if (!title || !incidentType || !location || !summary) {
                return res.status(400).json({ error: "Missing required case fields" });
            }

            ensureCaseCounter();
            casesData.caseCounter += 1;
            const caseId = `CASE-${String(casesData.caseCounter).padStart(6, "0")}`;

            casesData.cases[caseId] = {
                caseId,
                title,
                incidentType,
                location,
                suspect,
                summary,
                createdBy: req.session.user.id,
                assignedTo: null,
                evidence: [],
                status: "Open",
                closed: false,
                createdAt: new Date().toISOString(),
            };
            saveCases();

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "case",
                title: "📁 Dashboard Case Created",
                fields: [
                    { name: "Case ID", value: caseId, inline: true },
                    { name: "Filed By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Title", value: title, inline: false },
                    { name: "Incident Type", value: incidentType, inline: true },
                    { name: "Location", value: location, inline: true },
                    { name: "Suspect", value: suspect, inline: false }
                ],
                color: 0x23A559
            });

            res.json({ success: true, caseId, message: `Case created: ${caseId}` });
        } catch (err) {
            console.error("[Dashboard API] case-create:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case View ────────────────────────────────────────────────────────
    router.post("/api/commands/case-view", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const rawId = normalizeCaseId(req.body.caseId);
            if (!rawId) return res.status(400).json({ error: "Missing caseId" });
            const caseId = resolveCaseKey(rawId);
            if (!caseId) return res.status(404).json({ error: "Case not found" });

            const entry = casesData.cases[caseId];

            const evidenceCount = Array.isArray(entry.evidence) ? entry.evidence.length : 0;
            const assignedText = entry.assignedTo ? `<@${entry.assignedTo}>` : "Unassigned";
            const statusText = isCaseClosed(entry) ? "Closed" : "Open";

            res.json({
                success: true,
                message: `${caseId} | ${statusText} | Assigned: ${assignedText} | Evidence: ${evidenceCount}`,
                case: entry
            });
        } catch (err) {
            console.error("[Dashboard API] case-view:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Search ──────────────────────────────────────────────────────
    router.post("/api/commands/case-search", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const query = String(req.body.query || "").trim().toLowerCase();
            if (!query) return res.status(400).json({ error: "Missing search query" });

            const results = Object.values(casesData.cases || {}).filter(c => {
                const fields = [
                    c.caseId,
                    c.title,
                    c.suspect,
                    c.location,
                    c.incidentType,
                    c.summary
                ];
                return fields.some(v => String(v || "").toLowerCase().includes(query));
            });

            const summary = results
                .slice(0, 10)
                .map(c => `${c.caseId || "UNKNOWN"} - ${c.title || "Untitled"} (${isCaseClosed(c) ? "Closed" : "Open"})`)
                .join("; ");

            res.json({
                success: true,
                count: results.length,
                message: results.length
                    ? `Found ${results.length} case(s). ${summary}`
                    : `No cases found for "${query}".`,
                results: results.slice(0, 50)
            });
        } catch (err) {
            console.error("[Dashboard API] case-search:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Assign ──────────────────────────────────────────────────────
    router.post("/api/commands/case-assign", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const rawId = normalizeCaseId(req.body.caseId);
            const userId = String(req.body.userId || "").trim();
            const note = String(req.body.note || "").trim() || "No note provided";

            if (!rawId || !userId) return res.status(400).json({ error: "Missing caseId or userId" });
            const caseId = resolveCaseKey(rawId);
            if (!caseId) return res.status(404).json({ error: "Case not found" });

            const entry = casesData.cases[caseId];

            entry.assignedTo = userId;
            entry.assignedBy = req.session.user.id;
            entry.assignNote = note;
            entry.assignedAt = new Date().toISOString();
            saveCases();

            await client.users.fetch(userId).then(u => u.send(`You have been assigned to case ${caseId}.`)).catch(() => {});

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "case",
                title: "📌 Dashboard Case Assigned",
                fields: [
                    { name: "Case ID", value: caseId, inline: true },
                    { name: "Assigned To", value: `<@${userId}>`, inline: true },
                    { name: "Assigned By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Note", value: note, inline: false }
                ],
                color: 0x3B82F6
            });

            res.json({ success: true, message: `Case assigned: ${caseId}` });
        } catch (err) {
            console.error("[Dashboard API] case-assign:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Unassign ────────────────────────────────────────────────────
    router.post("/api/commands/case-unassign", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const rawId = normalizeCaseId(req.body.caseId);
            const reason = String(req.body.reason || "").trim() || "Not specified";
            if (!rawId) return res.status(400).json({ error: "Missing caseId" });
            const caseId = resolveCaseKey(rawId);
            if (!caseId) return res.status(404).json({ error: "Case not found" });

            const entry = casesData.cases[caseId];
            if (!entry.assignedTo) return res.status(400).json({ error: "Case is not assigned" });

            const previousAssignee = entry.assignedTo;
            entry.assignedTo = null;
            entry.unassignedBy = req.session.user.id;
            entry.unassignReason = reason;
            entry.unassignedAt = new Date().toISOString();
            saveCases();

            await client.users.fetch(previousAssignee).then(u => u.send(`You have been unassigned from case ${caseId}. Reason: ${reason}`)).catch(() => {});

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "case",
                title: "📌 Dashboard Case Unassigned",
                fields: [
                    { name: "Case ID", value: caseId, inline: true },
                    { name: "Unassigned User", value: `<@${previousAssignee}>`, inline: true },
                    { name: "Action By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Reason", value: reason, inline: false }
                ],
                color: 0xE8A020
            });

            res.json({ success: true, message: `Case unassigned: ${caseId}` });
        } catch (err) {
            console.error("[Dashboard API] case-unassign:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Evidence Add ─────────────────────────────────────────────────────
    router.post("/api/commands/evidence-add", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const rawId = normalizeCaseId(req.body.caseId);
            const description = String(req.body.description || "").trim();
            if (!rawId || !description) return res.status(400).json({ error: "Missing caseId or description" });
            const caseId = resolveCaseKey(rawId);
            if (!caseId) return res.status(404).json({ error: "Case not found" });

            const entry = casesData.cases[caseId];

            const evidenceId = `EVI-${Date.now()}`;
            if (!Array.isArray(entry.evidence)) entry.evidence = [];
            entry.evidence.push({
                evidenceId,
                description,
                officerId: req.session.user.id,
                timestamp: new Date().toISOString(),
            });
            saveCases();

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "case",
                title: "📸 Dashboard Evidence Added",
                fields: [
                    { name: "Case ID", value: caseId, inline: true },
                    { name: "Evidence ID", value: evidenceId, inline: true },
                    { name: "Added By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Description", value: description, inline: false }
                ],
                color: 0x5865F2
            });

            res.json({ success: true, evidenceId, message: `Evidence added to ${caseId}` });
        } catch (err) {
            console.error("[Dashboard API] evidence-add:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Close ───────────────────────────────────────────────────────
    router.post("/api/commands/case-close", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const rawId = normalizeCaseId(req.body.caseId);
            const reason = String(req.body.reason || "").trim();
            if (!rawId) return res.status(400).json({ error: "Missing caseId" });
            const caseId = resolveCaseKey(rawId);
            if (!caseId) return res.status(404).json({ error: "Case not found" });

            const entry = casesData.cases[caseId];

            if (isCaseClosed(entry)) return res.status(400).json({ error: "Case is already closed" });

            setCaseStatus(entry, true);
            entry.closedAt = new Date().toISOString();
            entry.closedBy = req.session.user.id;
            if (reason) {
                entry.closeReason = reason;
                entry.closedReason = reason;
            }
            saveCases();

            if (entry.assignedTo) {
                await client.users.fetch(entry.assignedTo).then(u => u.send(`Case ${caseId} has been closed. Reason: ${reason || "No reason"}`)).catch(() => {});
            }

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "case",
                title: "📋 Dashboard Case Closed",
                fields: [
                    { name: "Case ID", value: caseId, inline: true },
                    { name: "Closed By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Reason", value: reason || "No reason", inline: false }
                ],
                color: 0xE8A020
            });

            res.json({ success: true, message: `Case closed: ${caseId}` });
        } catch (err) {
            console.error("[Dashboard API] case-close:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Reopen ──────────────────────────────────────────────────────
    router.post("/api/commands/case-reopen", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const rawId = normalizeCaseId(req.body.caseId);
            const reason = String(req.body.reason || "").trim();
            if (!rawId) return res.status(400).json({ error: "Missing caseId" });
            const caseId = resolveCaseKey(rawId);
            if (!caseId) return res.status(404).json({ error: "Case not found" });

            const entry = casesData.cases[caseId];
            if (!isCaseClosed(entry)) return res.status(400).json({ error: "Case is not closed" });

            setCaseStatus(entry, false);
            entry.reopenedBy = req.session.user.id;
            entry.reopenReason = reason || "No reason provided";
            entry.reopenedAt = new Date().toISOString();
            saveCases();

            if (entry.assignedTo) {
                await client.users.fetch(entry.assignedTo).then(u => u.send(`Case ${caseId} has been reopened. Reason: ${reason || "No reason"}`)).catch(() => {});
            }

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "case",
                title: "🔓 Dashboard Case Reopened",
                fields: [
                    { name: "Case ID", value: caseId, inline: true },
                    { name: "Reopened By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Reason", value: reason || "No reason", inline: false }
                ],
                color: 0x23A559
            });

            res.json({ success: true, message: `Case reopened: ${caseId}` });
        } catch (err) {
            console.error("[Dashboard API] case-reopen:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Delete ──────────────────────────────────────────────────────
    router.post("/api/commands/case-delete", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const rawId = normalizeCaseId(req.body.caseId);
            const confirmation = String(req.body.confirmation || "").trim().toUpperCase();
            if (!rawId) return res.status(400).json({ error: "Missing caseId" });

            if (confirmation !== "YES") {
                return res.status(400).json({ error: "Deletion cancelled. Type YES to confirm." });
            }

            const caseId = resolveCaseKey(rawId);
            if (!caseId) return res.status(404).json({ error: "Case not found" });

            const entry = casesData.cases[caseId];
            delete casesData.cases[caseId];
            saveCases();

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "case",
                title: "🗑️ Dashboard Case Deleted",
                fields: [
                    { name: "Case ID", value: caseId, inline: true },
                    { name: "Deleted By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Title", value: entry.title || "Unknown", inline: false }
                ],
                color: 0xE03C3C
            });

            res.json({ success: true, message: `Case deleted: ${caseId}` });
        } catch (err) {
            console.error("[Dashboard API] case-delete:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Edit ────────────────────────────────────────────────────────
    router.post("/api/commands/case-edit", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const rawId = normalizeCaseId(req.body.caseId);
            const field = String(req.body.field || "").trim();
            const value = String(req.body.value || "").trim();
            if (!rawId || !field) return res.status(400).json({ error: "Missing caseId or field" });
            const caseId = resolveCaseKey(rawId);
            if (!caseId) return res.status(404).json({ error: "Case not found" });

            const entry = casesData.cases[caseId];

            const allowedFields = new Set(["title", "incidentType", "location", "suspect", "summary", "status", "assignedTo"]);
            if (!allowedFields.has(field)) {
                return res.status(400).json({ error: "Invalid field" });
            }

            const oldValue = entry[field] == null ? "N/A" : String(entry[field]);
            if (field === "assignedTo") {
                entry.assignedTo = value ? value.replace(/[<@!>]/g, "") : null;
            } else if (field === "status") {
                const normalized = value.toLowerCase();
                if (normalized !== "open" && normalized !== "closed") {
                    return res.status(400).json({ error: "Status must be Open or Closed" });
                }
                setCaseStatus(entry, normalized === "closed");
            } else {
                if (!value) return res.status(400).json({ error: "Value cannot be empty" });
                entry[field] = value;
            }

            entry.lastEditedBy = req.session.user.id;
            entry.lastEditedAt = new Date().toISOString();
            saveCases();

            await sendDashboardActionLog({
                guildId: GUILD_ID,
                logType: "case",
                title: "✏️ Dashboard Case Updated",
                fields: [
                    { name: "Case ID", value: caseId, inline: true },
                    { name: "Field", value: field, inline: true },
                    { name: "Updated By", value: `<@${req.session.user.id}>`, inline: true },
                    { name: "Old Value", value: oldValue.slice(0, 200), inline: false },
                    { name: "New Value", value: String(entry[field] ?? value).slice(0, 200) || "N/A", inline: false }
                ],
                color: 0x5865F2
            });

            res.json({ success: true, message: `Case updated: ${caseId}` });
        } catch (err) {
            console.error("[Dashboard API] case-edit:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Bot Status ───────────────────────────────────────────────────────
    router.post("/api/settings/status", requireStaff, segmentGuard("settings"), async (req, res) => {
        try {
            const { status } = req.body;
            const valid = [
                "online","idle","dnd","invisible",
                "watching_patrol","listening_radio","playing_tprp",
                "watching_tp","competing_patrol"
            ];
            if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status value" });

            const statusMap = {
                online:           { status: "online",    activity: null },
                idle:             { status: "idle",      activity: null },
                dnd:              { status: "dnd",       activity: null },
                invisible:        { status: "invisible", activity: null },
                watching_patrol:  { status: "online",    activity: { name: "Patrol Logs",                          type: ActivityType.Watching  } },
                listening_radio:  { status: "online",    activity: { name: "Radio Traffic",                        type: ActivityType.Listening } },
                playing_tprp:     { status: "online",    activity: { name: "Twin Palms Roleplay",                  type: ActivityType.Playing   } },
                watching_tp:      { status: "online",    activity: { name: "Over Twin Palms Roleplay",             type: ActivityType.Watching  } },
                competing_patrol: { status: "online",    activity: { name: "Patrol Hours",                         type: ActivityType.Competing } }
            };

            const s = statusMap[status];
            await client.user.setPresence({ activities: s.activity ? [s.activity] : [], status: s.status });
            config.currentStatus = status;
            saveConfig();
            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] settings/status:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Dashboard segment access (Bot Owner only) ──────────────────────
    router.post("/api/settings/segment-access", requireStaff, segmentGuard("settings"), async (req, res) => {
        try {
            if (req.session.user?.id !== BOT_OWNER_ID) {
                return res.status(403).json({ error: "Only the Bot Owner can change segment access." });
            }

            const incoming = req.body?.segmentAccess;
            if (!incoming || typeof incoming !== "object") {
                return res.status(400).json({ error: "segmentAccess object is required" });
            }

            const normalized = {};
            for (const segment of DASHBOARD_SEGMENTS) {
                const list = Array.isArray(incoming[segment]) ? incoming[segment] : [];
                normalized[segment] = [...new Set(list.map(String).filter(Boolean))];
            }

            config.dashboardSegmentAccess = normalized;
            saveConfig();
            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] settings/segment-access:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Live stats (polled by status page) ───────────────────────────────
    router.get("/api/stats", requireStaff, segmentGuard("status"), (req, res) => {
        const mem = process.memoryUsage();
        res.json({
            ping:      client.ws.ping,
            uptime:    Math.floor(process.uptime()),
            heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024),
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
            online:    client.isReady(),
            guilds:    client.guilds.cache.size
        });
    });

    return router;
}
