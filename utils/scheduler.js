"use strict";

const cron = require("node-cron");
const backup = require("../scripts/backup");

function initScheduler() {
    console.log("[Scheduler] Inicializando cron jobs...");

    // 09:00 UTC = 03:00 AM CDMX (aprox)
    // Run at minute 0, hour 9, every day
    cron.schedule("0 9 * * *", () => {
        console.log("[Scheduler] ⏰ Ejecutando backup programado (09:00 UTC)...");
        backup().catch(err => {
            console.error("[Scheduler] ❌ Error en backup programado:", err.message);
        });
    }, {
        timezone: "UTC"
    });

    console.log("[Scheduler] ✅ Backup programado para las 09:00 UTC diariamente.");
}

module.exports = { initScheduler };
