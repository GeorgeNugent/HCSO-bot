import express from "express";
import session from "express-session";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { ActivityType } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DISCORD_API = "https://discord.com/api/v10";

// Role names (case-insensitive substring match) that grant dashboard access
const STAFF_ROLE_NAMES = [
    "administrator", "management", "developer", "bot staff",
    "supervisor", "ia", "sheriff", "staff"
];

/**
 * Start the web dashboard.
 * @param {Object} context - Shared bot state and helpers from index.js
 */
export function startDashboard(context) {
    const {
        client,
        port,
        config,
        strikes,
        patrols,
        loa,
        casesData,
        tickets,
        blacklists,
        commendationsData,
        saveStrikes,
        saveLOA,
        saveCases,
        saveConfig,
        getUserStrikeEntries,
        syncUserStrikeRoles,
        MAX_STRIKES,
    } = context;

    const CLIENT_ID   = process.env.CLIENT_ID;
    const CLIENT_SECRET = process.env.CLIENT_SECRET;
    const SESSION_SECRET = process.env.SESSION_SECRET || "hsco-dashboard-secret-change-me";
    const DASHBOARD_URL  = process.env.DASHBOARD_URL  || `http://localhost:${port}`;
    const GUILD_ID       = process.env.GUILD_ID;
    const REDIRECT_URI   = `${DASHBOARD_URL}/auth/discord/callback`;

    // ── Express app ──────────────────────────────────────────────────────────
    const app = express();

    app.set("view engine", "ejs");
    app.set("views", join(__dirname, "views"));
    app.use(express.static(join(__dirname, "public")));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use(session({
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: false,          // set true if running behind HTTPS proxy
            maxAge: 7 * 24 * 60 * 60 * 1000
        }
    }));

    // res.locals available in every view
    app.use((req, res, next) => {
        res.locals.botName   = client.user?.username   || "HCSO Bot";
        res.locals.botAvatar = client.user?.displayAvatarURL({ size: 64 }) || "";
        res.locals.user      = req.session.user   || null;
        res.locals.isStaff   = req.session.isStaff || false;
        next();
    });

    // ── Helpers ──────────────────────────────────────────────────────────────
    async function isStaffMember(userId) {
        if (!GUILD_ID) return false;
        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) return false;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return false;
        if (member.permissions.has(8n)) return true; // Administrator
        return member.roles.cache.some(r =>
            STAFF_ROLE_NAMES.some(n => r.name.toLowerCase().includes(n))
        );
    }

    // ── Auth middleware ───────────────────────────────────────────────────────
    function requireAuth(req, res, next) {
        if (!req.session.user) {
            req.session.returnTo = req.originalUrl;
            return res.redirect("/auth/discord");
        }
        next();
    }

    function requireStaff(req, res, next) {
        if (!req.session.user) {
            req.session.returnTo = req.originalUrl;
            return res.redirect("/auth/discord");
        }
        if (!req.session.isStaff) {
            if (req.path.startsWith("/api/")) {
                return res.status(403).json({ error: "Access denied: staff only" });
            }
            return res.render("access-denied", { page: "denied" });
        }
        next();
    }

    // ── OAuth2 ────────────────────────────────────────────────────────────────
    app.get("/auth/discord", (req, res) => {
        if (req.session.user) return res.redirect("/");
        if (!CLIENT_ID || !CLIENT_SECRET) {
            return res.status(500).send("OAuth2 not configured. Set CLIENT_SECRET and CLIENT_ID env vars.");
        }
        const params = new URLSearchParams({
            client_id: CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            response_type: "code",
            scope: "identify guilds"
        });
        res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
    });

    app.get("/auth/discord/callback", async (req, res) => {
        const code = req.query.code;
        if (typeof code !== "string" || !code) return res.redirect("/auth/discord");

        try {
            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: "authorization_code",
                    code,
                    redirect_uri: REDIRECT_URI
                })
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) throw new Error(tokenData.error_description || "No access token received");

            const userRes = await fetch(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` }
            });
            const userData = await userRes.json();
            if (!userData.id) throw new Error("Could not fetch Discord user info");

            const avatarUrl = userData.avatar
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=64`
                : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(userData.id) % 5n)}.png`;

            const isStaff = await isStaffMember(userData.id);

            req.session.user = {
                id:            userData.id,
                username:      userData.username,
                discriminator: userData.discriminator || "0",
                avatar:        avatarUrl
            };
            req.session.isStaff = isStaff;

            const returnTo = req.session.returnTo || "/";
            delete req.session.returnTo;
            res.redirect(returnTo);
        } catch (err) {
            console.error("[Dashboard] OAuth2 error:", err.message);
            res.redirect("/login?error=oauth_failed");
        }
    });

    app.get("/auth/logout", requireAuth, (req, res) => {
        req.session.destroy(() => res.redirect("/login"));
    });

    // ── Public routes ─────────────────────────────────────────────────────────
    app.get("/health", (req, res) => res.send("OK"));

    app.get("/login", (req, res) => {
        if (req.session.user) return res.redirect("/");
        res.render("login", { page: "login", error: req.query.error || null });
    });

    // ── Dashboard pages (staff only) ──────────────────────────────────────────
    app.get("/", requireStaff, async (req, res) => {
        const uptime    = process.uptime();
        const h = Math.floor(uptime / 3600);
        const m = Math.floor((uptime % 3600) / 60);
        const s = Math.floor(uptime % 60);

        const guild = GUILD_ID ? client.guilds.cache.get(GUILD_ID) : null;

        let totalStrikes = 0;
        for (const guildStrikes of Object.values(strikes)) {
            if (typeof guildStrikes !== "object" || Array.isArray(guildStrikes)) continue;
            for (const userStrikes of Object.values(guildStrikes)) {
                if (Array.isArray(userStrikes)) totalStrikes += userStrikes.length;
            }
        }

        const activePatrols = Object.values(patrols).filter(p => p.active).length;
        const activeLoas    = Object.values(loa).filter(l => l.onLOA).length;
        const openCases     = Object.values(casesData.cases || {}).filter(c => c.status === "open").length;
        const openTickets   = Object.values(tickets.tickets || {}).filter(t => t.status === "open").length;

        res.render("home", {
            page: "home",
            uptime: `${h}h ${m}m ${s}s`,
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

    app.get("/status", requireStaff, (req, res) => {
        const mem    = process.memoryUsage();
        const uptime = Math.floor(process.uptime());
        res.render("status", {
            page:        "status",
            online:      client.isReady(),
            ping:        client.ws.ping,
            uptimeSeconds: uptime,
            heapUsed:    Math.round(mem.heapUsed  / 1024 / 1024),
            heapTotal:   Math.round(mem.heapTotal / 1024 / 1024),
            rss:         Math.round(mem.rss       / 1024 / 1024),
            nodeVersion: process.version,
            guildCount:  client.guilds.cache.size
        });
    });

    app.get("/commands", requireStaff, async (req, res) => {
        const guild = GUILD_ID ? client.guilds.cache.get(GUILD_ID) : null;
        let members  = [];
        let channels = [];

        if (guild) {
            try {
                await guild.members.fetch();
                members = [...guild.members.cache.values()]
                    .filter(m => !m.user.bot)
                    .map(m => ({ id: m.id, name: m.displayName || m.user.username }))
                    .sort((a, b) => a.name.localeCompare(b.name));

                channels = [...guild.channels.cache.values()]
                    .filter(c => c.type === 0) // GuildText
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

    app.get("/logs", requireStaff, (req, res) => {
        const filter  = req.query.type  || "all";
        const curPage = Math.max(1, parseInt(req.query.page) || 1);
        const perPage = 50;

        const logs = [];

        if (filter === "all" || filter === "strike") {
            for (const [, gStrikes] of Object.entries(strikes)) {
                if (typeof gStrikes !== "object" || Array.isArray(gStrikes)) continue;
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
            for (const [, gBans] of Object.entries(blacklists)) {
                if (typeof gBans !== "object" || Array.isArray(gBans)) continue;
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

    app.get("/settings", requireStaff, (req, res) => {
        res.render("settings", {
            page: "settings",
            cfg: {
                logChannels:        config.logChannels        || {},
                currentStatus:      config.currentStatus      || "watching_hc",
                blacklistJoinAction: config.blacklistJoinAction || "ban",
                ticketTypes:        config.ticketTypes        || [],
                statusRoles:        config.statusRoles        || [],
                moduleRoleAccess:   config.moduleRoleAccess   || {}
            },
            guildId: GUILD_ID || null
        });
    });

    // ── API: Command endpoints ────────────────────────────────────────────────

    app.post("/api/commands/strike", requireStaff, async (req, res) => {
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

    app.post("/api/commands/strike-remove", requireStaff, async (req, res) => {
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

    app.post("/api/commands/ban", requireStaff, async (req, res) => {
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

    app.post("/api/commands/kick", requireStaff, async (req, res) => {
        try {
            const { userId, reason } = req.body;
            if (!userId || !reason) return res.status(400).json({ error: "Missing userId or reason" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild  = client.guilds.cache.get(GUILD_ID);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

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

    app.post("/api/commands/timeout", requireStaff, async (req, res) => {
        try {
            const { userId, minutes, reason } = req.body;
            if (!userId || !minutes) return res.status(400).json({ error: "Missing userId or minutes" });
            if (!GUILD_ID) return res.status(400).json({ error: "GUILD_ID not configured" });

            const guild  = client.guilds.cache.get(GUILD_ID);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member)          return res.status(404).json({ error: "Member not found in guild" });
            if (!member.moderatable) return res.status(403).json({ error: "Cannot timeout this member" });

            const ms = Math.min(parseInt(minutes) * 60 * 1000, 28 * 24 * 60 * 60 * 1000);
            await member.timeout(ms, `Dashboard timeout by ${req.session.user.username}: ${reason || "No reason"}`);
            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] timeout:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/api/commands/unban", requireStaff, async (req, res) => {
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

    app.post("/api/commands/purge", requireStaff, async (req, res) => {
        try {
            const { channelId, amount } = req.body;
            if (!channelId || !amount) return res.status(400).json({ error: "Missing channelId or amount" });

            const channel = client.channels.cache.get(channelId);
            if (!channel?.isTextBased()) return res.status(404).json({ error: "Text channel not found" });

            const count   = Math.min(Math.max(1, parseInt(amount) || 1), 100);
            const deleted = await channel.bulkDelete(count, true);
            res.json({ success: true, deleted: deleted.size });
        } catch (err) {
            console.error("[Dashboard API] purge:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/api/commands/announce", requireStaff, async (req, res) => {
        try {
            const { channelId, title, message } = req.body;
            if (!channelId || !message) return res.status(400).json({ error: "Missing channelId or message" });

            const channel = client.channels.cache.get(channelId);
            if (!channel?.isTextBased()) return res.status(404).json({ error: "Text channel not found" });

            const { EmbedBuilder } = await import("discord.js");
            const embed = new EmbedBuilder()
                .setColor("#2d5a3d")
                .setTitle(title?.trim() || "📢 Announcement")
                .setDescription(message)
                .setFooter({ text: `Posted by ${req.session.user.username} via Dashboard` })
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] announce:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/api/commands/loa", requireStaff, async (req, res) => {
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
            context.saveLOA();

            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] loa:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/api/commands/end-loa", requireStaff, async (req, res) => {
        try {
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: "Missing userId" });

            if (!loa[userId]?.onLOA) return res.status(400).json({ error: "User is not currently on LOA" });

            loa[userId].onLOA = false;
            context.saveLOA();
            res.json({ success: true });
        } catch (err) {
            console.error("[Dashboard API] end-loa:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    app.post("/api/commands/case-close", requireStaff, async (req, res) => {
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

    // ── API: Settings ─────────────────────────────────────────────────────────
    app.post("/api/settings/status", requireStaff, async (req, res) => {
        try {
            const { status } = req.body;
            const valid = ["online","idle","dnd","invisible",
                           "watching_patrol","listening_radio","playing_hcso",
                           "watching_hc","competing_patrol"];
            if (!valid.includes(status)) return res.status(400).json({ error: "Invalid status value" });

            const statusMap = {
                online:           { status: "online",     activity: null },
                idle:             { status: "idle",       activity: null },
                dnd:              { status: "dnd",        activity: null },
                invisible:        { status: "invisible",  activity: null },
                watching_patrol:  { status: "online",     activity: { name: "Patrol Logs",                       type: ActivityType.Watching   } },
                listening_radio:  { status: "online",     activity: { name: "Radio Traffic",                     type: ActivityType.Listening  } },
                playing_hcso:     { status: "online",     activity: { name: "HCSO Operations",                   type: ActivityType.Playing    } },
                watching_hc:      { status: "online",     activity: { name: "Over Hendry County Sheriff's Office", type: ActivityType.Watching } },
                competing_patrol: { status: "online",     activity: { name: "Patrol Hours",                      type: ActivityType.Competing  } }
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

    // ── API: Live stats (polled by status page) ───────────────────────────────
    app.get("/api/stats", requireStaff, (req, res) => {
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

    // ── Start listening ───────────────────────────────────────────────────────
    app.listen(port, "0.0.0.0", () => {
        console.log(`[Dashboard] Listening on http://0.0.0.0:${port}`);
    });

    return app;
}
