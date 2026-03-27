/**
 * Dashboard routes for multi-server / department pages.
 *   GET  /servers                         — all guilds the bot is in
 *   GET  /departments/:guildId            — per-department member management page
 *   POST /api/guild/:guildId/strike       — give a member a strike
 *   POST /api/guild/:guildId/strike-remove— remove a strike
 *   POST /api/guild/:guildId/kick         — kick a member
 *   POST /api/guild/:guildId/ban          — ban a member
 *   POST /api/guild/:guildId/timeout      — timeout a member
 *   POST /api/guild/:guildId/unban        — unban a member
 */
import { Router } from "express";
import { getAllDepartments, getBranding } from "../embeds/departmentThemes.js";

/**
 * @param {{ requireStaff: Function, segmentGuard: Function, serverStats: Object, client: Object,
 *           config: Object, saveConfig: Function,
 *           strikes: Object, saveStrikes: Function,
 *           getUserStrikeEntries: Function, syncUserStrikeRoles: Function,
 *           MAX_STRIKES: number, patrols: Object, loa: Object, casesData: Object, saveCases: Function, saveLOA: Function }} deps
 * @returns {import("express").Router}
 */
export function createDepartmentRoutes({ requireStaff, segmentGuard, serverStats, client, config, saveConfig, strikes, saveStrikes, getUserStrikeEntries, syncUserStrikeRoles, MAX_STRIKES, patrols, loa, casesData, saveCases, saveLOA }) {
    const router = Router();
    const HCSO_GUILD_ID = "1482203107432595601";
    const STRIKE_ROLE_IDS = [
        "1485084924921774242",
        "1485084972535648326",
        "1485085025157382244"
    ];
    const SHERIFF_ALERT_ROLE_ID = "1482203108108013584";

    function isSupervisorPlus(member) {
        if (!member) return false;
        if (member.permissions?.has?.("Administrator")) return true;

        return member.roles.cache.some(role => {
            const name = String(role.name || "").toLowerCase();
            return name.includes("supervisor")
                || name.includes("command")
                || name.includes("sheriff")
                || name.includes("undersheriff")
                || name.includes("assistant sheriff")
                || name.includes("chief deputy")
                || name.includes("captain")
                || name.includes("major");
        });
    }

    // ── Case helpers (mirrored from routes.js) ────────────────────────────────
    function resolveCaseKey(rawId) {
        const id = String(rawId || "").trim();
        if (!id) return null;
        const cases = casesData?.cases || {};
        if (id in cases) return id;
        const up = id.toUpperCase();
        if (up in cases) return up;
        const found = Object.keys(cases).find(k => k.toLowerCase() === id.toLowerCase());
        return found || null;
    }

    function ensureCaseCounter() {
        if (!casesData) return;
        if (typeof casesData.caseCounter !== "number" || isNaN(casesData.caseCounter)) {
            const max = Object.keys(casesData.cases || {})
                .map(k => parseInt((k.match(/\d+/) || ["0"])[0]))
                .filter(n => !isNaN(n))
                .reduce((a, b) => Math.max(a, b), 0);
            casesData.caseCounter = max;
        }
    }

    // ── All servers / departments overview ────────────────────────────────────
        // -- Joint Operations --
    router.get("/departments/joint", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const departments = getAllDepartments();
            const branding    = getBranding();

            const deptGuilds = [];
            for (const [guildId, guild] of client.guilds.cache) {
                const dept = departments[guildId];
                if (dept && dept.type === "main") continue;

                try { await guild.members.fetch(); } catch {}

                const strikeCount = Object.values(strikes[guildId] || {})
                    .reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);

                deptGuilds.push({
                    id:          guildId,
                    name:        guild.name,
                    shortName:   dept ? dept.shortName : branding.fallback.shortName,
                    icon:        guild.iconURL({ size: 64 }) ?? null,
                    logo:        dept?.logo ?? null,
                    color:       dept ? (dept.color || branding.defaultColor) : branding.defaultColor,
                    memberCount: guild.memberCount,
                    strikeCount,
                    online:      true
                });
            }

            const totalMembers = deptGuilds.reduce((s, g) => s + g.memberCount, 0);
            const totalStrikes = deptGuilds.reduce((s, g) => s + g.strikeCount, 0);
            const totalPatrols = patrols   ? Object.values(patrols).filter(p => p.active).length : 0;
            const totalLOAs    = loa       ? Object.values(loa).filter(l => l.onLOA).length      : 0;
            const openCases    = casesData
                ? Object.values(casesData.cases || {}).filter(c => String(c.status || "").trim().toLowerCase() !== "closed" && c.closed !== true).length
                : 0;

            res.render("joint", { page: "joint", deptGuilds, totalMembers, totalStrikes, totalPatrols, totalLOAs, openCases, branding });
        } catch (err) {
            console.error("[Dept] /departments/joint error:", err.message);
            res.render("error", { page: "error", message: "Could not load joint operations.", branding: getBranding() });
        }
    });
    router.get("/servers", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const servers      = await serverStats.getAllServers();
            const branding     = getBranding();
            const totalMembers = servers.reduce((s, g) => s + g.memberCount, 0);

            res.render("servers", {
                page: "servers",
                servers,
                branding,
                totalMembers
            });
        } catch (err) {
            console.error("[Dept] /servers error:", err.message);
            res.render("error", { page: "error", message: "Could not load server list.", branding: getBranding() });
        }
    });

    // ── Per-department member management page ─────────────────────────────────
    router.get("/departments/:guildId", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const departments = getAllDepartments();
            const branding    = getBranding();
            const dept        = departments[guildId] ?? null;
            const detail      = await serverStats.getServerDetail(guildId);

            if (!detail) {
                return res.render("error", {
                    page:    "error",
                    message: "Server not found or bot is not in that server.",
                    branding
                });
            }

            // Fetch member list for this guild
            const guild = client.guilds.cache.get(guildId);
            let members = [];
            let memberLoadError = "";
            if (guild) {
                try {
                    // Prefer the fetch() return value instead of relying on cache.
                    let fetched = await guild.members.fetch().catch((err) => {
                        memberLoadError = err?.message || "Member fetch failed";
                        return null;
                    });

                    let memberList = fetched ? [...fetched.values()] : [...guild.members.cache.values()];

                    // Fallback path for hosts that keep cache very small.
                    if (memberList.length <= 1) {
                        const listed = await guild.members.list({ limit: 1000 }).catch(() => null);
                        if (listed && listed.size > memberList.length) {
                            memberList = [...listed.values()];
                        }
                    }

                    members = memberList
                        .filter(m => !m.user.bot)
                        .map(m => {
                            const highestRole = [...m.roles.cache.values()]
                                .filter(r => r.name !== "@everyone")
                                .sort((a, b) => b.position - a.position)[0];

                            const strikeCountByRole = STRIKE_ROLE_IDS.reduce((count, roleId) => {
                                return count + (m.roles.cache.has(roleId) ? 1 : 0);
                            }, 0);

                            return {
                                id:          m.id,
                                name:        m.displayName || m.user.username,
                                username:    m.user.username,
                                avatar:      m.user.displayAvatarURL({ size: 32 }),
                                highestRole: highestRole?.name || "No department role",
                                strikeCount: strikeCountByRole,
                                joinedAt:    m.joinedAt ? m.joinedAt.toLocaleDateString() : "Unknown",
                                timedOut:    m.communicationDisabledUntilTimestamp
                                                 ? m.communicationDisabledUntilTimestamp > Date.now()
                                                 : false
                            };
                        })
                        .sort((a, b) => a.name.localeCompare(b.name));
                } catch (e) {
                    console.error("[Dept] Member fetch error:", e.message);
                    memberLoadError = e?.message || "Member load failed";
                }
            }

            // Department-scoped cases (own + joint ops)
            const deptCases = casesData
                ? Object.entries(casesData.cases || {})
                    .filter(([, c]) => c.department === guildId || c.department === "joint")
                    .sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt))
                    .slice(0, 200)
                    .map(([id, c]) => ({ id, title: c.title || id, status: c.status || "Open", createdAt: c.createdAt, department: c.department }))
                : [];
            const deptOpenCases = deptCases.filter(c => String(c.status || "").trim().toLowerCase() !== "closed");

            // Members of this guild who are on LOA
            const guildMemberIds = new Set(members.map(m => m.id));
            const usersOnLoa = Object.entries(loa || {})
                .filter(([uid, d]) => d.onLOA && guildMemberIds.has(uid))
                .map(([uid, d]) => {
                    const m = members.find(x => x.id === uid);
                    return { id: uid, name: m?.name || uid, startDate: d.startDate, endDate: d.endDate };
                });

            const isHcsoDepartment = String(guildId) === HCSO_GUILD_ID || String(dept?.shortName || "").toUpperCase() === "HCSO";
            let canManageEndLoa = true;
            if (isHcsoDepartment) {
                const requesterId = req.session.user?.id || null;
                const requesterMember = requesterId && guild ? await guild.members.fetch(requesterId).catch(() => null) : null;
                canManageEndLoa = isSupervisorPlus(requesterMember);
            }

            // Strike log for this guild
            const guildStrikeStore = strikes[guildId] || {};
            const deptStrikeLogs = Object.entries(guildStrikeStore)
                .flatMap(([uid, entries]) => (Array.isArray(entries) ? entries : []).map(e => ({
                    userId: uid,
                    name:   members.find(m => m.id === uid)?.name || uid,
                    reason: e.reason   || "No reason",
                    date:   e.date     ? new Date(e.date).toLocaleDateString() : "—",
                    givenBy: e.givenBy || "Unknown"
                })))
                .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
                .slice(0, 100);

            res.render("department", {
                page:       "department",
                guildId,
                dept:       dept ?? branding.fallback,
                detail,
                members,
                memberLoadError,
                MAX_STRIKES:     MAX_STRIKES ?? 3,
                branding,
                deptCases,
                deptOpenCases,
                usersOnLoa,
                deptStrikeLogs,
                isHcsoDepartment,
                canManageEndLoa
            });
        } catch (err) {
            console.error("[Dept] /departments/:guildId error:", err.message);
            res.render("error", { page: "error", message: "Could not load department.", branding: getBranding() });
        }
    });

    // ── Helper: resolve guild safely ──────────────────────────────────────────
    async function getGuild(guildId) {
        return client.guilds.cache.get(guildId)
            ?? await client.guilds.fetch(guildId).catch(() => null);
    }

    // ── API: Strike ───────────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/strike", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { userId, reason } = req.body;
            if (!userId || !reason) return res.status(400).json({ error: "Missing userId or reason" });

            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const entries = getUserStrikeEntries(guildId, userId);
            if (entries.length >= (MAX_STRIKES ?? 3)) {
                return res.status(400).json({ error: `User already has max strikes` });
            }
            entries.push({ reason, givenBy: req.session.user.id, date: new Date().toISOString() });
            saveStrikes();
            if (syncUserStrikeRoles) await syncUserStrikeRoles(guild, userId, entries.length);

            const memberAfterStrike = await guild.members.fetch(userId).catch(() => null);
            const hasAllThreeStrikeRoles = memberAfterStrike
                ? STRIKE_ROLE_IDS.every(roleId => memberAfterStrike.roles.cache.has(roleId))
                : false;

            if (hasAllThreeStrikeRoles) {
                const strikeLogChannelId = (function getStrikeLogChannelId() {
                    const channels = config.logChannels || {};
                    const guildScoped = channels[guildId] && typeof channels[guildId] === "object" ? channels[guildId] : null;
                    if (guildScoped && guildScoped.strike) return guildScoped.strike;
                    return channels.strike || channels.moderation || null;
                })();

                const alertChannel = strikeLogChannelId
                    ? (client.channels.cache.get(strikeLogChannelId) || await client.channels.fetch(strikeLogChannelId).catch(() => null))
                    : null;

                if (alertChannel && alertChannel.isTextBased()) {
                    await alertChannel.send({
                        content: `<@&${SHERIFF_ALERT_ROLE_ID}> <@${userId}> now has all three strike roles.`
                    }).catch(() => {});
                }
            }

            res.json({ success: true, totalStrikes: entries.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Strike Remove ────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/strike-remove", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { userId, amount } = req.body;
            if (!userId) return res.status(400).json({ error: "Missing userId" });

            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const entries = getUserStrikeEntries(guildId, userId);
            const remove  = Math.min(parseInt(amount) || 1, entries.length);
            entries.splice(entries.length - remove, remove);
            saveStrikes();
            if (syncUserStrikeRoles) await syncUserStrikeRoles(guild, userId, entries.length);
            res.json({ success: true, removed: remove, totalStrikes: entries.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Kick ─────────────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/kick", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { userId, reason } = req.body;
            if (!userId || !reason) return res.status(400).json({ error: "Missing userId or reason" });

            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member)          return res.status(404).json({ error: "Member not found" });
            if (!member.kickable)  return res.status(403).json({ error: "Cannot kick this member" });

            await member.kick(`Dashboard kick by ${req.session.user.username}: ${reason}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Ban ──────────────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/ban", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { userId, reason } = req.body;
            if (!userId || !reason) return res.status(400).json({ error: "Missing userId or reason" });

            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            await guild.members.ban(userId, {
                reason: `Dashboard ban by ${req.session.user.username}: ${reason}`
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Timeout ──────────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/timeout", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { userId, minutes, reason } = req.body;
            if (!userId || !minutes) return res.status(400).json({ error: "Missing userId or minutes" });

            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member)             return res.status(404).json({ error: "Member not found" });
            if (!member.moderatable) return res.status(403).json({ error: "Cannot timeout this member" });

            const ms = Math.min(parseInt(minutes) * 60 * 1000, 28 * 24 * 60 * 60 * 1000);
            await member.timeout(ms, `Dashboard timeout by ${req.session.user.username}: ${reason || "No reason"}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Unban ────────────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/unban", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: "Missing userId" });

            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            await guild.bans.remove(userId, `Unbanned via dashboard by ${req.session.user.username}`);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case – Create ────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/case-create", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { title, incidentType, location, suspect, summary, jointOps } = req.body;
            if (!title) return res.status(400).json({ error: "Title is required" });
            if (!casesData) return res.status(503).json({ error: "Cases not available" });

            ensureCaseCounter();
            casesData.caseCounter = (casesData.caseCounter || 0) + 1;
            const id  = `CASE-${String(casesData.caseCounter).padStart(6, "0")}`;
            const isJoint = jointOps === "true" || jointOps === true;

            casesData.cases[id] = {
                title,
                incidentType: incidentType || "",
                location:     location     || "",
                suspect:      suspect      || "",
                summary:      summary      || "",
                status:       "Open",
                department:   isJoint ? "joint" : guildId,
                createdAt:    new Date().toISOString(),
                createdBy:    req.session.user.id,
                evidence:     [],
                notes:        []
            };
            await saveCases();
            res.json({ success: true, message: `Case ${id} created.`, caseId: id });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case – View ──────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/case-view", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { caseId } = req.body;
            if (!caseId) return res.status(400).json({ error: "caseId required" });
            if (!casesData) return res.status(503).json({ error: "Cases not available" });

            const key = resolveCaseKey(caseId);
            if (!key) return res.status(404).json({ error: `Case '${caseId}' not found` });

            const c = casesData.cases[key];
            if (c.department !== guildId && c.department !== "joint") {
                return res.status(403).json({ error: "Access denied – not your department's case" });
            }

            res.json({ success: true, case: { id: key, ...c } });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case – Close ─────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/case-close", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { caseId, reason } = req.body;
            if (!caseId) return res.status(400).json({ error: "caseId required" });
            if (!casesData) return res.status(503).json({ error: "Cases not available" });

            const key = resolveCaseKey(caseId);
            if (!key) return res.status(404).json({ error: `Case '${caseId}' not found` });

            const c = casesData.cases[key];
            if (c.department !== guildId && c.department !== "joint") {
                return res.status(403).json({ error: "Access denied" });
            }

            c.status     = "Closed";
            c.closedAt   = new Date().toISOString();
            c.closedBy   = req.session.user.id;
            if (reason) c.closeReason = reason;
            await saveCases();
            res.json({ success: true, message: `Case ${key} closed.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case – Assign ────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/case-assign", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { caseId, assignTo } = req.body;
            if (!caseId || !assignTo) return res.status(400).json({ error: "caseId and assignTo required" });
            if (!casesData) return res.status(503).json({ error: "Cases not available" });

            const key = resolveCaseKey(caseId);
            if (!key) return res.status(404).json({ error: `Case '${caseId}' not found` });

            const c = casesData.cases[key];
            if (c.department !== guildId && c.department !== "joint") {
                return res.status(403).json({ error: "Access denied" });
            }

            c.assignedTo = assignTo;
            const displayName = req.body.assignToName || assignTo;
            await saveCases();
            res.json({ success: true, message: `Case ${key} assigned to ${displayName}.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Evidence – Add ───────────────────────────────────────────────────
    router.post("/api/guild/:guildId/evidence-add", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { caseId, evidence } = req.body;
            if (!caseId || !evidence) return res.status(400).json({ error: "caseId and evidence required" });
            if (!casesData) return res.status(503).json({ error: "Cases not available" });

            const key = resolveCaseKey(caseId);
            if (!key) return res.status(404).json({ error: `Case '${caseId}' not found` });

            const c = casesData.cases[key];
            if (c.department !== guildId && c.department !== "joint") {
                return res.status(403).json({ error: "Access denied" });
            }

            if (!Array.isArray(c.evidence)) c.evidence = [];
            c.evidence.push({ text: evidence, addedBy: req.session.user.id, addedAt: new Date().toISOString() });
            await saveCases();
            res.json({ success: true, message: `Evidence added to ${key}.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: Case – Delete ────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/case-delete", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { caseId, confirmation } = req.body;
            if (!caseId) return res.status(400).json({ error: "caseId required" });
            if (confirmation !== "YES") return res.status(400).json({ error: 'Type "YES" to confirm deletion' });
            if (!casesData) return res.status(503).json({ error: "Cases not available" });

            const key = resolveCaseKey(caseId);
            if (!key) return res.status(404).json({ error: `Case '${caseId}' not found` });

            const c = casesData.cases[key];
            if (c.department !== guildId && c.department !== "joint") {
                return res.status(403).json({ error: "Access denied" });
            }

            delete casesData.cases[key];
            await saveCases();
            res.json({ success: true, message: `Case ${key} deleted.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: LOA – Set ────────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/loa", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { userId, startDate, endDate, reason } = req.body;
            if (!userId || !endDate) return res.status(400).json({ error: "userId and endDate required" });
            if (!loa) return res.status(503).json({ error: "LOA data not available" });

            loa[userId] = {
                onLOA:     true,
                startDate: startDate || new Date().toISOString().split("T")[0],
                endDate,
                reason:    reason || ""
            };
            await saveLOA();
            res.json({ success: true, message: `LOA set for <@${userId}> until ${endDate}.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── API: LOA – End ────────────────────────────────────────────────────────
    router.post("/api/guild/:guildId/end-loa", requireStaff, segmentGuard("departments"), async (req, res) => {
        try {
            const { guildId } = req.params;
            const { userId } = req.body;
            if (!userId) return res.status(400).json({ error: "userId required" });
            if (!loa) return res.status(503).json({ error: "LOA data not available" });

            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            const departments = getAllDepartments();
            const dept = departments[guildId];
            const shortName = String(dept?.shortName || "").toUpperCase();
            const isLawEnforcement = ["HCSO", "CPD", "FHP"].includes(shortName);

            // Law enforcement depts require supervisor+ permission
            if (isLawEnforcement) {
                const requesterId = req.session.user?.id || null;
                const requesterMember = requesterId ? await guild.members.fetch(requesterId).catch(() => null) : null;
                if (!isSupervisorPlus(requesterMember)) {
                    return res.status(403).json({ error: `Only supervisors+ can end LOA in ${shortName}.` });
                }
            }
            // Staff department allows any staff member

            if (!loa[userId]?.onLOA) {
                return res.status(400).json({ error: "This user is not on LOA" });
            }

            loa[userId].onLOA   = false;
            loa[userId].endedAt = new Date().toISOString();
            await saveLOA();
            res.json({ success: true, message: `LOA ended for <@${userId}>.` });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Department Settings: Fetch main server roles and current config ──────────
    router.get("/api/guild/:guildId/settings", requireStaff, async (req, res) => {
        try {
            const { guildId } = req.params;
            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            // Fetch roles from MAIN server (not the department guild)
            const mainGuild = client.guilds.cache.get(guildId);
            if (!mainGuild) return res.status(404).json({ error: "Guild not found" });

            const mainServerRoles = (await mainGuild.roles.fetch().catch(() => null))?.map(r => ({
                id: r.id,
                name: r.name,
                color: r.hexColor || '#808080'
            })).filter(r => r.name !== '@everyone').sort((a, b) => a.name.localeCompare(b.name)) || [];

            // Get current department access config for this guild
            const departmentAccessByGuild = config.departmentAccessByGuild || {};
            const departmentAccess = departmentAccessByGuild[guildId] || [];

            res.json({
                success: true,
                mainServerRoles,
                departmentAccess
            });
        } catch (err) {
            console.error("[Dept] /api/guild/:guildId/settings error:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── Department Settings: Save department access ──────────────────────────
    router.post("/api/guild/:guildId/settings/department-access", requireStaff, async (req, res) => {
        try {
            const { guildId } = req.params;
            const { roleIds } = req.body;
            if (!Array.isArray(roleIds)) return res.status(400).json({ error: "roleIds must be an array" });

            const guild = await getGuild(guildId);
            if (!guild) return res.status(404).json({ error: "Guild not found" });

            // Initialize if needed
            if (!config.departmentAccessByGuild) config.departmentAccessByGuild = {};
            config.departmentAccessByGuild[guildId] = roleIds;
            await saveConfig();

            res.json({ success: true, message: "Department access updated" });
        } catch (err) {
            console.error("[Dept] /api/guild/:guildId/settings/department-access error:", err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ── DEPRECATED: Old endpoints below (kept for reference) ────────────────

    return router;
}

