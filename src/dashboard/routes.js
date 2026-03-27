/**
 * Main dashboard page routes and all API command endpoints.
 * Extracted from the root dashboard.js so the entry point stays lean.
 */
import { Router } from "express";
import { ActivityType } from "discord.js";
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
 * @returns {import("express").Router}
 */
export function createMainRoutes(context, { requireAuth, requireStaff, getDashboardGuild, getMainRoleGuild, segmentGuard, DASHBOARD_SEGMENTS, BOT_OWNER_ID }) {
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
    const router   = Router();

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
        const openCases     = Object.values(casesData.cases || {}).filter(c => c.status === "open").length;
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

        const openCases = Object.entries(casesData.cases || {})
            .filter(([, c]) => c.status !== "closed")
            .map(([id, c]) => ({ id, title: c.title || id }))
            .slice(0, 100);

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

    // ── Settings page ─────────────────────────────────────────────────────────
    router.get("/settings", requireStaff, segmentGuard("settings"), async (req, res) => {
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

        res.render("settings", {
            page:    "settings",
            cfg: {
                logChannels:         config.logChannels         || {},
                currentStatus:       config.currentStatus       || "watching_hc",
                blacklistJoinAction: config.blacklistJoinAction || "ban",
                ticketTypes:         config.ticketTypes         || [],
                statusRoles:         config.statusRoles         || [],
                moduleRoleAccess:    config.moduleRoleAccess    || {},
                dashboardSegmentAccess
            },
            guildId: GUILD_ID || null,
            availableRoles,
            segmentKeys: DASHBOARD_SEGMENTS,
            isBotOwner: req.session.user?.id === BOT_OWNER_ID,
            botOwnerId: BOT_OWNER_ID
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
            saveLOA();
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

            loa[userId].onLOA = false;
            saveLOA();
            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] end-loa:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case Close ───────────────────────────────────────────────────────
    router.post("/api/commands/case-close", requireStaff, segmentGuard("commands"), async (req, res) => {
        try {
            const { caseId, reason } = req.body;
            if (!caseId) return res.status(400).json({ error: "Missing caseId" });

            const entry = casesData.cases?.[caseId];
            if (!entry) return res.status(404).json({ error: "Case not found" });

            entry.status      = "closed";
            entry.closedAt    = new Date().toISOString();
            entry.closedBy    = req.session.user.id;
            if (reason) entry.closeReason = reason;
            saveCases();
            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] case-close:", err.message);
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
