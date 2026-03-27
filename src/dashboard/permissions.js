/**
 * Express auth middleware for the Twin Palms dashboard.
 * Extracted so it can be reused across all route files.
 */

export function createPermissions() {
    const BOT_OWNER_ID = "967375704486449222";

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
        if (req.session.user.id === BOT_OWNER_ID) return next();
        if (!req.session.isStaff) {
            if (req.path.startsWith("/api/")) {
                return res.status(403).json({ error: "Access denied: staff only" });
            }
            return res.render("access-denied", { page: "denied" });
        }
        next();
    }

    return { requireAuth, requireStaff };
}
