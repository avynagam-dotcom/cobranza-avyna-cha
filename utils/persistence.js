"use strict";

const fs = require("fs");
const path = require("path");

// Definimos la ruta base para auditoría de forma centralizada para este sistema (CHA)
// Se usará esta ruta si existe el disco persistente, de lo contrario fallback a local.
const RENDER_DISK_PATH = "/var/data/cobranza-cha";
const AUDIT_FILE_NAME = "audit.jsonl";

function getAuditPath() {
  if (fs.existsSync(RENDER_DISK_PATH)) {
    return path.join(RENDER_DISK_PATH, "data", AUDIT_FILE_NAME);
  }
  // En local (dev) guardamos en data/audit.jsonl relativo al root
  return path.join(process.cwd(), "data", AUDIT_FILE_NAME);
}

function appendAuditLog(operation, details) {
  try {
    const auditFile = getAuditPath();
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      operation,
      details,
    });
    // Append (a)
    fs.appendFileSync(auditFile, entry + "\n", "utf8");
  } catch (err) {
    console.error(`[Audit] Error escribiendo log: ${err.message}`);
  }
}

/**
 * atomicWrite
 * @param {string} filePath - Ruta absoluta del archivo final
 * @param {object|array} data - Objeto JSON a guardar
 */
function atomicWrite(filePath, data) {
  const tmpPath = `${filePath}.tmp`;

  try {
    const jsonString = JSON.stringify(data, null, 2);
    
    // 1. Escribir en .tmp
    fs.writeFileSync(tmpPath, jsonString, "utf8");

    // 2. Verificar integridad (peso > 0)
    const stats = fs.statSync(tmpPath);
    if (stats.size === 0) {
      throw new Error(`El archivo temporal ${tmpPath} tiene 0 bytes. Abortando sobreescritura.`);
    }

    // 3. Rename atómico (sobreescribe el original)
    fs.renameSync(tmpPath, filePath);

    // 4. Audit
    const filename = path.basename(filePath);
    appendAuditLog("SAVE_FILE", { filename, size: stats.size });

    // console.log(`[Persistence] Guardado exitoso: ${filename} (${stats.size} bytes)`);

  } catch (err) {
    console.error(`[Persistence] CRITICAL ERROR guardando ${filePath}:`, err);
    // Intentar borrar el tmp si quedó corrupto o falló el proceso
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
    }
    throw err; // Re-lanzar para que quien llame sepa que falló
  }
}

module.exports = { atomicWrite };
