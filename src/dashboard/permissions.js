/**
 * Express auth middleware for the Twin Palms dashboard.
 * Extracted so it can be reused across all route files.
 */

export function createPermissions({ hasStaffAccess } = {}) {
    const BOT_OWNER_IDS = ["967375704486449222", "327951443090735104"];

    function requireAuth(req, res, next) {
        if (!req.session.user) {
            req.session.returnTo = req.originalUrl;
            return res.redirect("/auth/discord");
        }
        next();
    }

    async function requireStaff(req, res, next) {
        if (!req.session.user) {
            req.session.returnTo = req.originalUrl;
            return res.redirect("/auth/discord");
        }
        const userId = String(req.session.user.id);
        if (BOT_OWNER_IDS.includes(userId)) return next();

        if (typeof hasStaffAccess === "function") {
            try {
                req.session.isStaff = await hasStaffAccess(userId);
            } catch {
                // Fall back to session cache if live validation fails.
            }
        }

        if (!req.session.isStaff) {
            console.log(`[Dashboard Auth] requireStaff denied user ${userId} on ${req.originalUrl}`);
            if (req.path.startsWith("/api/")) {
                return res.status(403).json({ error: "Access denied: staff only" });
            }
            return res.render("access-denied", { page: "denied" });
        }
        next();
    }

    return { requireAuth, requireStaff };
}
