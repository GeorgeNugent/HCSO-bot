/**
 * Twin Palms Roleplay — Control Panel
 * Main dashboard assembly point.
 *
 * This file wires together all sub-modules (auth, permissions, routes,
 * departments) and starts the Express server.
 *
 * root dashboard.js re-exports startDashboard from here so index.js
 * does not need to be changed.
 */
import express from "express";
import session from "express-session";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { createPermissions }      from "./permissions.js";
import { createAuthRouter }       from "./auth.js";
import { createMainRoutes }       from "./routes.js";
import { createDepartmentRoutes } from "./departments.js";
import { createServerStats }      from "./serverStats.js";
import { getAllDepartments, getBranding } from "../embeds/departmentThemes.js";

// Locate project root: src/dashboard → src → project root
const __dirname  = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../../");

/**
 * Start the Twin Palms Roleplay web dashboard.
 * Accepts the same context object that index.js currently passes.
 * @param {Object} context
 */
export function startDashboard(context) {
    const { client } = context;

    const SESSION_SECRET = process.env.SESSION_SECRET || "twin-palms-dashboard-secret-change-me";
    const port           = context.port || Number(process.env.PORT) || 8100;
    const GUILD_ID       = process.env.GUILD_ID;

    // ── Express app ──────────────────────────────────────────────────────────
    const app = express();

    app.set("view engine", "ejs");
    app.set("views", join(PROJECT_ROOT, "views"));
    app.use(express.static(join(PROJECT_ROOT, "public")));
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use(session({
        secret:            SESSION_SECRET,
        resave:            false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure:   false,   // set true behind HTTPS proxy
            maxAge:   7 * 24 * 60 * 60 * 1000
        }
    }));

    // ── Shared helper: resolve the configured guild ───────────────────────────
    async function getDashboardGuild() {
        if (!GUILD_ID) return null;
        const cached = client.guilds.cache.get(GUILD_ID);
        if (cached) return cached;
        return await client.guilds.fetch(GUILD_ID).catch(() => null);
    }

    // ── Sub-modules ───────────────────────────────────────────────────────────
    const { requireAuth, requireStaff } = createPermissions();
    const serverStats = createServerStats(client);

    // ── res.locals available in every view ────────────────────────────────────
    app.use(async (req, res, next) => {
        const branding     = getBranding();
        const departments  = getAllDepartments();
        const servers      = await serverStats.getAllServers().catch(() => []);

        res.locals.botName    = branding.botName;
        res.locals.botAvatar  = client.user?.displayAvatarURL({ size: 64 }) || "";
        res.locals.user       = req.session.user  || null;
        res.locals.isStaff    = req.session.isStaff || false;
        res.locals.branding   = branding;
        res.locals.departments = departments;
        res.locals.servers    = servers;
        next();
    });

    // ── Mount routers ─────────────────────────────────────────────────────────
    app.use(createAuthRouter(context, { getDashboardGuild, requireAuth }));
    app.use(createMainRoutes(context,  { requireAuth, requireStaff, getDashboardGuild }));
    app.use(createDepartmentRoutes({ requireStaff, serverStats, client }));

    // ── 404 fallback ─────────────────────────────────────────────────────────
    app.use((req, res) => {
        res.status(404).render("error", {
            page:    "error",
            message: "Page not found.",
            branding: getBranding()
        });
    });

    // ── Start listening ───────────────────────────────────────────────────────
    app.listen(port, "0.0.0.0", () => {
        console.log(`[Dashboard] Twin Palms Roleplay — Control Panel listening on http://0.0.0.0:${port}`);
    });

    return app;
}
