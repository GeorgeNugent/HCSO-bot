/**
 * Dashboard routes for multi-server / department pages.
 *   GET /servers          — all guilds the bot is in
 *   GET /departments/:id  — per-department detail page
 */
import { Router } from "express";
import { getAllDepartments, getBranding } from "../embeds/departmentThemes.js";

/**
 * @param {{ requireStaff: Function, serverStats: Object, client: Object }} deps
 * @returns {import("express").Router}
 */
export function createDepartmentRoutes({ requireStaff, serverStats }) {
    const router = Router();

    // ── All servers / departments overview ────────────────────────────────────
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

    // ── Per-department detail page ─────────────────────────────────────────────
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

            res.render("department", {
                page:    "department",
                guildId,
                dept:    dept ?? branding.fallback,
                detail,
                branding
            });
        } catch (err) {
            console.error("[Dept] /departments/:guildId error:", err.message);
            res.render("error", { page: "error", message: "Could not load department.", branding: getBranding() });
        }
    });

    return router;
}
