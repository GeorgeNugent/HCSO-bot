/**
 * Dashboard client-side JavaScript
 * Handles AJAX form submissions and toast notifications.
 */

/* ── Toast notification system ───────────────────────────────── */
function showToast(message, type = "info", duration = 4000) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s";
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/* ── AJAX form handler ───────────────────────────────────────── */
async function submitForm(form) {
    const endpoint = form.dataset.endpoint;
    if (!endpoint) return;

    const submitBtn = form.querySelector("[type=submit]");
    const originalText = submitBtn?.textContent;

    // Disable button while loading
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "Working...";
    }

    // Find or create result div
    let resultEl = form.querySelector(".inline-result");
    if (!resultEl) {
        resultEl = document.createElement("div");
        resultEl.className = "inline-result";
        form.appendChild(resultEl);
    }
    resultEl.style.display = "none";
    resultEl.className = "inline-result";

    try {
        const body = {};
        new FormData(form).forEach((v, k) => { body[k] = v; });

        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });

        const data = await res.json();

        if (data.success) {
            const msg = buildSuccessMessage(endpoint, data);
            resultEl.textContent = "✅ " + msg;
            resultEl.classList.add("result-success");
            resultEl.style.display = "block";
            showToast("✅ " + msg, "success");

            // Reset form on success (keep selects as-is for convenience)
            form.querySelectorAll("input[type=text], input[type=number], textarea")
                .forEach(el => { if (el.name !== "amount" && el.name !== "minutes") el.value = ""; });
        } else {
            const errMsg = data.error || "Unknown error";
            resultEl.textContent = "❌ " + errMsg;
            resultEl.classList.add("result-error");
            resultEl.style.display = "block";
            showToast("❌ " + errMsg, "error");
        }
    } catch (err) {
        const errMsg = "Network error — please try again.";
        resultEl.textContent = "❌ " + errMsg;
        resultEl.classList.add("result-error");
        resultEl.style.display = "block";
        showToast("❌ " + errMsg, "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
}

function buildSuccessMessage(endpoint, data) {
    if (endpoint.includes("strike-remove")) return `Removed ${data.removed} strike(s). Now has ${data.totalStrikes}.`;
    if (endpoint.includes("strike"))        return `Strike added. Total: ${data.totalStrikes}.`;
    if (endpoint.includes("purge"))         return `Deleted ${data.deleted} message(s).`;
    if (endpoint.includes("ban"))           return "Member has been banned.";
    if (endpoint.includes("kick"))          return "Member has been kicked.";
    if (endpoint.includes("timeout"))       return "Member has been timed out.";
    if (endpoint.includes("unban"))         return "Member has been unbanned.";
    if (endpoint.includes("announce"))      return "Announcement posted!";
    if (endpoint.includes("end-loa"))       return "LOA ended.";
    if (endpoint.includes("loa"))           return "LOA has been set.";
    if (endpoint.includes("case-close"))    return "Case has been closed.";
    return "Action completed.";
}

/* ── Attach handlers to all cmd-forms ────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".cmd-form").forEach(form => {
        form.addEventListener("submit", async e => {
            e.preventDefault();
            await submitForm(form);
        });
    });
});
