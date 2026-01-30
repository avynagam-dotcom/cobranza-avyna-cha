"use strict";

const fs = require("fs");
const path = require("path");

// Configuration: Always prefer process.env.DATA_DIR
// If not set, fallback to local ./data
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
const AUDIT_FILE = path.join(DATA_DIR, "audit.jsonl");

function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      console.error(`[Persistence] Error creando directorio ${dir}:`, e.message);
    }
  }
}

function appendAuditLog(operation, details) {
  try {
    ensureDirExists(AUDIT_FILE);

    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      operation,
      details,
    });
    // Append (a)
    fs.appendFileSync(AUDIT_FILE, entry + "\n", "utf8");
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

    // Asegurar que el directorio destino existe
    ensureDirExists(tmpPath);

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

  } catch (err) {
    console.error(`[Persistence] CRITICAL ERROR guardando ${filePath}:`, err);
    // Intentar borrar el tmp si quedó corrupto o falló el proceso
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
    }
    throw err;
  }
}

module.exports = { atomicWrite, DATA_DIR };
