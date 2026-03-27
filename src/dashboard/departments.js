/**
 * Dashboard routes for multi-server / department pages.
 *   GET  /servers                         â€” all guilds the bot is in
 *   GET  /departments/:guildId            â€” per-department member management page
 *   POST /api/guild/:guildId/strike       â€” give a member a strike
 *   POST /api/guild/:guildId/strike-removeâ€” remove a strike
 *   POST /api/guild/:guildId/kick         â€” kick a member
 *   POST /api/guild/:guildId/ban          â€” ban a member
 *   POST /api/guild/:guildId/timeout      â€” timeout a member
 *   POST /api/guild/:guildId/unban        â€” unban a member
 */
import { Router } from "express";
import { getAllDepartments, getBranding } from "../embeds/departmentThemes.js";

/**
 * @param {{ requireStaff: Function, serverStats: Object, client: Object,
 *           strikes: Object, saveStrikes: Function,
 *           getUserStrikeEntries: Function, syncUserStrikeRoles: Function,
 *           MAX_STRIKES: number }} deps
 * @returns {import("express").Router}
 */
export function createDepartmentRoutes({ requireStaff, serverStats, client, strikes, saveStrikes, getUserStrikeEntries, syncUserStrikeRoles, MAX_STRIKES }) {
    const router = Router();

    // â”€â”€ All servers / departments overview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    router.get("/servers", requireStaff, async (req, res) => {
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

    // â”€â”€ Per-department member management page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    router.get("/departments/:guildId", requireStaff, async (req, res) => {
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
            if (guild) {
                try {
                    await guild.members.fetch();
                    members = [...guild.members.cache.values()]
                        .filter(m => !m.user.bot)
                        .map(m => {
                            const userStrikes = getUserStrikeEntries ? getUserStrikeEntries(guildId, m.id) : [];
                            return {
                                id:          m.id,
                                name:        m.displayName || m.user.username,
                                username:    m.user.username,
                                avatar:      m.user.displayAvatarURL({ size: 32 }),
                                roles:       m.roles.cache
                                                 .filter(r => r.name !== "@everyone")
                                                 .map(r => r.name)
                                                 .slice(0, 3),
                                strikeCount: userStrikes.length,
                                joinedAt:    m.joinedAt ? m.joinedAt.toLocaleDateString() : "Unknown",
                                timedOut:    m.communicationDisabledUntilTimestamp
                                                 ? m.communicationDisabledUntilTimestamp > Date.now()
                                                 : false
                            };
                        })
                        .sort((a, b) => a.name.localeCompare(b.name));
                } catch (e) {
                    console.error("[Dept] Member fetch error:", e.message);
                }
            }

            res.render("department", {
                page:       "department",
                guildId,
                dept:       dept ?? branding.fallback,
                detail,
                members,
                MAX_STRIKES: MAX_STRIKES ?? 3,
                branding
            });
        } catch (err) {
            console.error("[Dept] /departments/:guildId error:", err.message);
            res.render("error", { page: "error", message: "Could not load department.", branding: getBranding() });
        }
    });

    // â”€â”€ Helper: resolve guild safely â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async function getGuild(guildId) {
        return client.guilds.cache.get(guildId)
            ?? await client.guilds.fetch(guildId).catch(() => null);
    }

    // â”€â”€ API: Strike â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    router.post("/api/guild/:guildId/strike", requireStaff, async (req, res) => {
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
            res.json({ success: true, totalStrikes: entries.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // â”€â”€ API: Strike Remove â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    router.post("/api/guild/:guildId/strike-remove", requireStaff, async (req, res) => {
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

    // â”€â”€ API: Kick â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    router.post("/api/guild/:guildId/kick", requireStaff, async (req, res) => {
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

    // â”€â”€ API: Ban â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    router.post("/api/guild/:guildId/ban", requireStaff, async (req, res) => {
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

    // â”€â”€ API: Timeout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    router.post("/api/guild/:guildId/timeout", requireStaff, async (req, res) => {
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

    // â”€â”€ API: Unban â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    router.post("/api/guild/:guildId/unban", requireStaff, async (req, res) => {
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

    return router;
}

