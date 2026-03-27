/**
 * Discord OAuth2 authentication routes.
 * Extracted from the main dashboard so the entry point stays lean.
 */
import { Router } from "express";

const DISCORD_API = "https://discord.com/api/v10";

const STAFF_ROLE_NAMES = [
    "administrator", "management", "developer", "bot staff",
    "supervisor", "ia", "sheriff", "staff", "owner", "co-owner"
];

/**
 * @param {Object} context - Shared bot context from index.js
 * @param {{ getDashboardGuild: Function, requireAuth: Function }} helpers
 * @returns {import("express").Router}
 */
export function createAuthRouter(context, { getDashboardGuild, requireAuth, hasStaffAccess }) {
    const { client } = context;

    const CLIENT_ID     = process.env.CLIENT_ID;
    const CLIENT_SECRET = process.env.CLIENT_SECRET;
    const DASHBOARD_URL = process.env.DASHBOARD_URL || `http://localhost:${process.env.PORT || 8100}`;
    const REDIRECT_URI  = `${DASHBOARD_URL}/auth/discord/callback`;

    async function isStaffMember(userId) {
        const guild = await getDashboardGuild();
        if (!guild) return false;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) return false;
        if (member.permissions.has(8n)) return true;
        return member.roles.cache.some(r =>
            STAFF_ROLE_NAMES.some(n => r.name.toLowerCase().includes(n))
        );
    }

    const router = Router();

    router.get("/auth/discord", (req, res) => {
        if (req.session.user) return res.redirect("/");
        if (!CLIENT_ID || !CLIENT_SECRET) {
            return res.status(500).send("OAuth2 not configured. Set CLIENT_ID and CLIENT_SECRET env vars.");
        }
        const params = new URLSearchParams({
            client_id:     CLIENT_ID,
            redirect_uri:  REDIRECT_URI,
            response_type: "code",
            scope:         "identify guilds"
        });
        res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
    });

    router.get("/auth/discord/callback", async (req, res) => {
        const code = req.query.code;
        if (typeof code !== "string" || !code) return res.redirect("/auth/discord");

        try {
            const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
                method:  "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body:    new URLSearchParams({
                    client_id:     CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type:    "authorization_code",
                    code,
                    redirect_uri:  REDIRECT_URI
                })
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) {
                throw new Error(tokenData.error_description || "No access token received");
            }

            const userRes  = await fetch(`${DISCORD_API}/users/@me`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}` }
            });
            const userData = await userRes.json();
            if (!userData.id) throw new Error("Could not fetch Discord user info");

            const avatarUrl = userData.avatar
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=64`
                : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(userData.id) % 5n)}.png`;

            const isStaff = typeof hasStaffAccess === "function"
                ? await hasStaffAccess(userData.id)
                : await isStaffMember(userData.id);

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
            console.error("[Auth] OAuth2 error:", err.message);
            res.redirect("/login?error=oauth_failed");
        }
    });

    router.get("/auth/logout", requireAuth, (req, res) => {
        req.session.destroy(() => res.redirect("/login"));
    });

    return router;
}
