"use strict";

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
// Import PDF Generator
const { generateReportPDF } = require("./utils/reportGenerator");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ----- Paths configuration (Robust & Simple)
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");

// El usuario define process.env.DATA_DIR en Render (ej: /var/data/cobranza/cha)
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const DB_FILE = path.join(DATA_DIR, "notas.json");
const STATUS_FILE = path.join(DATA_DIR, "status.json"); // Control de cierre

console.log(`[System] DATA_DIR: ${DATA_DIR}`);

// ----- Backup Automático (Scheduler)
const { initScheduler } = require("./utils/scheduler");
const R2_ENABLED = process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET;

if (R2_ENABLED) {
  initScheduler();
} else {
  console.log("[System] Backup automático DESACTIVADO (Faltan credenciales R2)");
}

// Ensure folders exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ----- Migration: Local -> Persistent (Idempotent)
const IS_PERSISTENT_MODE = !!process.env.DATA_DIR;

if (IS_PERSISTENT_MODE) {
  try {
    const localDataDir = path.join(ROOT, "data");
    const localUploadsDir = path.join(ROOT, "uploads");

    function migrateFiles(srcDir, destDir) {
      if (!fs.existsSync(srcDir)) return;
      const files = fs.readdirSync(srcDir);
      let count = 0;
      for (const file of files) {
        if (file.startsWith(".")) continue;
        const srcPath = path.join(srcDir, file);
        const destPath = path.join(destDir, file);
        try {
          if (fs.statSync(srcPath).isFile() && !fs.existsSync(destPath)) {
            fs.copyFileSync(srcPath, destPath);
            count++;
          }
        } catch (e) {
          console.error(`[Migra] Error copiando ${file}:`, e.message);
        }
      }
      if (count > 0) console.log(`[Migra] Se migraron ${count} archivos de ${srcDir} a ${destDir}`);
    }

    migrateFiles(localDataDir, DATA_DIR);
    migrateFiles(localUploadsDir, UPLOADS_DIR);
  } catch (err) {
    console.error("[Migra] Fallo en proceso de migración:", err);
  }
}

// ----- DB helpers & Persistence
const { atomicWrite } = require("./utils/persistence");

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveDB(notas) {
  atomicWrite(DB_FILE, notas);
}

// ----- V2 Schema Migration (Runtime)
// Ensure all records have 'pagos' array. If not, migrate 'pagado' value.
function ensureSchemaV2(notas) {
  let changed = false;
  notas.forEach(n => {
    if (!Array.isArray(n.pagos)) {
      // Legacy Migration
      const legacyPagado = typeof n.pagado === "number" ? n.pagado : 0;
      n.pagos = [];
      if (legacyPagado > 0) {
        // Create initial historical record
        n.pagos.push({
          fecha: n.firstPaymentAt || new Date().toISOString(),
          monto: legacyPagado,
          isLegacy: true
        });
      }
      changed = true;
    }
    // Backward compatibility: Ensure root 'pagado' matches sum of current payments
    // (We re-calculate strictly to trust the array as source of truth)
    const sumPagos = n.pagos.reduce((sum, p) => sum + (Number(p.monto) || 0), 0);
    if (n.pagado !== sumPagos) {
      n.pagado = sumPagos;
      changed = true;
    }
  });

  if (changed) {
    console.log("[Schema] Migración V2 aplicada a registros inconsistentes.");
    saveDB(notas);
  }
  return notas;
}

// ----- Report Status Helpers
function getReportStatus() {
  try {
    if (!fs.existsSync(STATUS_FILE)) return { active: false, startTime: null };
    return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return { active: false, startTime: null };
  }
}

function saveReportStatus(status) {
  atomicWrite(STATUS_FILE, status);
}

// ----- Business Logic Helpers
function pad2(n) {
  return String(n).padStart(2, "0");
}
function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function getMexicoDate(date = new Date()) {
  const options = { timeZone: "America/Mexico_City", year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' };
  const formatter = new Intl.DateTimeFormat([], options);
  const parts = formatter.formatToParts(date);
  const get = (type) => parts.find(p => p.type === type).value;
  return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

function getCurrentBatchKey(now = new Date()) {
  const mxDate = getMexicoDate(now);
  const day = mxDate.getDay();
  const daysSinceTuesday = (day - 2 + 7) % 7;
  const d = new Date(mxDate);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysSinceTuesday);
  return ymd(d);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

function parseMoney(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/\s/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  const decPos = Math.max(lastDot, lastComma);
  let normalized;
  if (decPos === -1) {
    normalized = s.replace(/[^\d]/g, "");
  } else {
    const intPart = s.slice(0, decPos).replace(/[^\d]/g, "");
    const decPart = s.slice(decPos + 1).replace(/[^\d]/g, "").slice(0, 2);
    normalized = `${intPart}.${decPart}`;
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function extractTotalFromText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const totalLines = lines.filter((l) => /total/i.test(l)).filter((l) => !/sub\s*total/i.test(l));
  const patterns = [
    /(TOTAL\s*A\s*PAGAR)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
    /(IMPORTE\s*TOTAL)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
    /(^|\b)(TOTAL)\s*[:\-]?\s*\$?\s*([0-9][0-9.,\s]*)/i,
  ];
  let candidates = [];
  for (const l of totalLines) {
    for (const p of patterns) {
      const m = l.match(p);
      if (m) {
        const val = parseMoney(m[m.length - 1]);
        if (val != null) candidates.push(val);
      }
    }
  }
  if (candidates.length === 0) {
    for (const p of patterns) {
      const all = [...text.matchAll(p)];
      if (all.length) {
        const last = all[all.length - 1];
        const val = parseMoney(last[last.length - 1]);
        if (val != null) candidates.push(val);
      }
    }
  }
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function extractClienteFromText(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sameLine = [
    /(CLIENTE)\s*[:\-]\s*(.+)$/i,
    /(NOMBRE)\s*[:\-]\s*(.+)$/i,
    /(RAZ[ÓO]N\s+SOCIAL)\s*[:\-]\s*(.+)$/i,
  ];
  for (const l of lines) {
    for (const p of sameLine) {
      const m = l.match(p);
      if (m && m[2] && m[2].trim().length >= 3) return m[2].trim();
    }
  }
  const nextLineLabels = [/^CLIENTE$/i, /^NOMBRE$/i, /^RAZ[ÓO]N\s+SOCIAL$/i];
  for (let i = 0; i < lines.length - 1; i++) {
    if (nextLineLabels.some((rx) => rx.test(lines[i]))) {
      const v = (lines[i + 1] || "").trim();
      if (v && v.length >= 3 && !/^(RFC|FECHA|FOLIO|TOTAL|SUBTOTAL)$/i.test(v)) return v;
    }
  }
  for (const l of lines) {
    const m = l.match(/^(\d{4,})\s*[-–—]\s*(.+)$/);
    if (m && m[2]) return `${m[1]} - ${m[2].trim()}`;
  }
  return null;
}

function computeCredito(nota, now = new Date()) {
  const deliveredAt = nota.deliveredAt ? new Date(nota.deliveredAt) : null;
  const dueAt = nota.dueAt ? new Date(nota.dueAt) : null;

  // V2: pagado comes from schema reduction, ensured by ensureSchemaV2
  const total = typeof nota.total === "number" && Number.isFinite(nota.total) ? nota.total : null;
  const pagado = typeof nota.pagado === "number" && Number.isFinite(nota.pagado) ? nota.pagado : 0;

  let saldo = null;
  if (total != null) saldo = Math.max(total - pagado, 0);

  let statusCredito = "PRE_ENTREGA";

  if (deliveredAt) {
    if (saldo === 0 && total != null) {
      statusCredito = "LIQUIDADO";
    } else if (dueAt) {
      const msNow = now.getTime();
      const msDue = dueAt.getTime();
      const threeDaysMs = 3 * 24 * 60 * 60 * 1000;

      if (msNow >= msDue) statusCredito = "VENCIDO";
      else if (msNow >= msDue - threeDaysMs) statusCredito = "POR_VENCER";
      else statusCredito = "EN_PLAZO";
    } else {
      statusCredito = "EN_PLAZO";
    }
  }

  return {
    deliveredAt: nota.deliveredAt || null,
    dueAt: nota.dueAt || null,
    saldo,
    statusCredito,
  };
}

// ----- VIP Logic Reference: 
// >$10,000 monthly volume AND impeccable punctuality (0 delays)
function isVIP(nota, allNotes) {
  // We can evaluate VIP based on Client Name Grouping or single note context?
  // User request: "Algoritmo de Inteligencia VIP". Assuming client-based.
  // We need to normalize client name for grouping.
  if (!nota.cliente) return false;

  const clientName = nota.cliente.toLowerCase().trim();
  const clientNotes = allNotes.filter(n => (n.cliente || "").toLowerCase().trim() === clientName);

  // 1. Volume Check (Monthly Avg or Total? Request says "Volumen Mensual > $10,000")
  // Let's check Total Volume of current month for simplicity, or just look at this note?
  // "Volumen Mensual" usually implies aggregate. Let's aggregate delivered notes this month.
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  const monthNotes = clientNotes.filter(n => {
    if (!n.deliveredAt) return false;
    const d = new Date(n.deliveredAt);
    return d.getMonth() === currentMonth && d.getFullYear() === currentYear;
  });

  const monthVolume = monthNotes.reduce((sum, n) => sum + (n.total || 0), 0);

  // If this note pushes them over, they are VIP for this note too.
  // Actually, let's just use the current note's Total if it's big, 
  // OR if their aggregate is big.
  // Just complying strict to "Volumen Mensual > 10,000".
  if (monthVolume < 10000) return false;

  // 2. Punctuality Check: 0 delays AFTER due date.
  // We check ALL history for this client.
  const hasDelays = clientNotes.some(n => {
    // If it was ever paid late or is currently late
    // Simplest check: Is it VENCIDO now?
    if (computeCredito(n, now).statusCredito === "VENCIDO") return true;

    // Check history (if we had payment dates vs due dates).
    // V2 Schema allows checking payment dates!
    if (n.pagos && n.dueAt) {
      const due = new Date(n.dueAt).getTime();
      // Any payment made AFTER due date?
      return n.pagos.some(p => new Date(p.fecha).getTime() > due);
    }
    return false;
  });

  return !hasDelays;
}

// ----- Multer (PDF upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

app.use(express.static(PUBLIC_DIR));

// ----- API ENDPOINTS

// 1. Listar Notas (con VIP y Schema check)
app.get("/api/notas", (req, res) => {
  let notas = loadDB();
  // Ensure V2 Schema on read (lazy migration / safety)
  notas = ensureSchemaV2(notas);

  const batchKey = getCurrentBatchKey();
  const now = new Date();

  const notasProcessed = notas.map((n) => {
    const computed = computeCredito(n, now);
    // Inject VIP status
    const vip = isVIP(n, notas); // Pass all notes context for aggregation
    return { ...n, ...computed, isVIP: vip };
  });

  res.json({ batchKey, notas: notasProcessed });
});

// 2. Upload PDF
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  try {
    const batchKey = getCurrentBatchKey();
    if (!req.file || !req.file.buffer) return res.status(400).json({ ok: false, message: "No PDF" });

    const originalName = req.file.originalname || "nota.pdf";
    let notas = ensureSchemaV2(loadDB());

    const existingIdx = notas.findIndex(
      (n) => String(n.batchKey) === String(batchKey) &&
        String(n.originalName || "").toLowerCase() === String(originalName).toLowerCase()
    );

    const parsed = await pdfParse(req.file.buffer);
    const text = parsed && parsed.text ? parsed.text : "";
    const cliente = extractClienteFromText(text) || null;
    const total = extractTotalFromText(text);
    const uploadedAt = new Date().toISOString();

    if (existingIdx !== -1) {
      const ex = notas[existingIdx];
      if (ex.deliveredAt) return res.json({ ok: false, duplicate: true, message: "Nota duplicada (ya entregada)" });

      // Update existing
      ex.cliente = cliente;
      ex.total = typeof total === "number" && Number.isFinite(total) ? total : null;
      ex.uploadedAt = uploadedAt;

      const filename = ex.filename || `${batchKey}__${ex.id}__${originalName}`.replace(/[^\w.\-() \u00C0-\u017F]/g, "_");
      ex.filename = filename;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), req.file.buffer);

      notas[existingIdx] = ex;
      saveDB(notas);
      return res.json({ ok: true, replaced: true, nota: { ...ex, ...computeCredito(ex) } });
    }

    // New Note
    const id = crypto.randomUUID();
    const safeName = `${batchKey}__${id}__${originalName}`.replace(/[^\w.\-() \u00C0-\u017F]/g, "_");
    fs.writeFileSync(path.join(UPLOADS_DIR, safeName), req.file.buffer);

    const nota = {
      id,
      batchKey,
      originalName,
      filename: safeName,
      cliente,
      total: typeof total === "number" && Number.isFinite(total) ? total : null,
      pagado: 0,
      pagos: [], // V2 Init
      deliveredAt: null,
      dueAt: null,
      firstPaymentAt: null,
      uploadedAt,
    };

    notas.push(nota);
    saveDB(notas);
    return res.json({ ok: true, nota: { ...nota, ...computeCredito(nota) } });
  } catch (e) {
    console.error("UPLOAD ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al subir PDF" });
  }
});

// 3. Entregar
app.post("/api/entregar", (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, message: "Falta id" });

    let notas = ensureSchemaV2(loadDB());
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false, message: "Nota no encontrada" });

    const n = notas[idx];
    if (!n.deliveredAt) {
      const now = new Date();
      n.deliveredAt = iso(now);
      n.dueAt = iso(addDays(now, 15));
    }
    notas[idx] = n;
    saveDB(notas);
    return res.json({ ok: true, nota: { ...n, ...computeCredito(n) } });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "Error al entregar" });
  }
});

// 4. Pago (V2 Schema Update)
app.post("/api/pago", (req, res) => {
  try {
    const { id, monto } = req.body || {};
    const val = Number(monto);
    if (!id || !Number.isFinite(val) || val <= 0) return res.status(400).json({ ok: false, message: "Datos inválidos" });

    let notas = ensureSchemaV2(loadDB());
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false, message: "Nota no encontrada" });

    const n = notas[idx];

    // V2: Add to history
    const now = new Date(); // ALWAYS server time
    const newPayment = {
      id: crypto.randomUUID(),
      monto: val,
      fecha: now.toISOString(),
      timestamp: now.getTime()
    };

    if (!Array.isArray(n.pagos)) n.pagos = [];
    n.pagos.push(newPayment);

    // Update aggregate
    n.pagado = n.pagos.reduce((sum, p) => sum + (Number(p.monto) || 0), 0);

    if (n.deliveredAt && !n.firstPaymentAt) {
      n.firstPaymentAt = now.toISOString();
    }

    notas[idx] = n;
    saveDB(notas);
    return res.json({ ok: true, nota: { ...n, ...computeCredito(n) } });
  } catch (e) {
    console.error("PAGO ERROR:", e);
    return res.status(500).json({ ok: false, message: "Error al registrar pago" });
  }
});

// 5. Eliminar
app.delete("/api/notas/:id", (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ ok: false, message: "Falta id" });

    let notas = loadDB();
    const idx = notas.findIndex((n) => String(n.id) === String(id));
    if (idx === -1) return res.status(404).json({ ok: false, message: "Nota no encontrada" });

    const n = notas[idx];
    if (n.filename) {
      const p = path.join(UPLOADS_DIR, n.filename);
      if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch { }
    }

    notas.splice(idx, 1);
    saveDB(notas);
    return res.json({ ok: true, message: "Eliminada" });
  } catch (e) {
    return res.status(500).json({ ok: false, message: "Error al eliminar" });
  }
});

// 6. KPIs
app.get("/api/kpis", (req, res) => {
  let notas = ensureSchemaV2(loadDB());
  const entregadas = notas.filter((n) => !!n.deliveredAt);

  let totalCobrable = 0;
  let totalCobrado = 0;

  for (const n of entregadas) {
    const total = typeof n.total === "number" && Number.isFinite(n.total) ? n.total : 0;
    const pagado = typeof n.pagado === "number" && Number.isFinite(n.pagado) ? n.pagado : 0;
    totalCobrable += total;
    totalCobrado += Math.min(pagado, total);
  }

  const totalSaldo = Math.max(totalCobrable - totalCobrado, 0);
  const pctCobranza = totalCobrable > 0 ? totalCobrado / totalCobrable : 0;
  const utilidadCobrada = totalCobrado * 0.4;
  const utilidadPorCobrar = totalSaldo * 0.4;

  res.json({ ok: true, totalCobrable, totalCobrado, totalSaldo, pctCobranza, utilidadCobrada, utilidadPorCobrar });
});

// 7. Faltantes
app.get("/api/faltantes", (req, res) => {
  let notas = ensureSchemaV2(loadDB());
  const now = new Date();
  const faltantes = notas
    .filter((n) => !!n.deliveredAt)
    .map((n) => ({ ...n, ...computeCredito(n, now) }))
    .filter((n) => (typeof n.saldo === "number" ? n.saldo > 0 : true))
    .sort((a, b) => {
      const rank = (s) => s === "VENCIDO" ? 0 : s === "POR_VENCER" ? 1 : s === "EN_PLAZO" ? 2 : 3;
      const ra = rank(a.statusCredito);
      const rb = rank(b.statusCredito);
      if (ra !== rb) return ra - rb;
      const da = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
      const db = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
      return da - db;
    });
  res.json({ ok: true, faltantes });
});

// 8. Closing Control: Status
app.get("/api/report-status", (req, res) => {
  const status = getReportStatus();
  const now = Date.now();
  let remainingMs = 0;

  if (status.active && status.startTime) {
    const elapsed = now - status.startTime;
    const sixHours = 6 * 60 * 60 * 1000;
    remainingMs = Math.max(0, sixHours - elapsed);

    // Auto-expire
    if (remainingMs === 0 && status.active) {
      status.active = false;
      status.startTime = null;
      saveReportStatus(status);
    }
  }

  res.json({
    ok: true,
    active: status.active,
    remainingMs
  });
});

// 9. Closing Control: Start
app.post("/api/report-start", (req, res) => {
  let status = getReportStatus();
  if (!status.active) {
    status.active = true;
    status.startTime = Date.now();
    saveReportStatus(status);
  }
  res.json({ ok: true });
});

// 10. Generate PDF Report
app.get("/api/report-pdf", async (req, res) => {
  try {
    let notas = ensureSchemaV2(loadDB());

    // Filter logic: Typically a monthly report. 
    // Which month? Current month based on server time?
    // Or just all delivered notes that affect "Este Mes"?
    // Let's assume Reporte Mensual reflects the "Active Month".
    // For simplicity: All delivered notes with activity or active debt.
    // Or just dump EVERYTHING active?
    // Let's dump "Batch Actual" notes + "Deuda Activa".

    // Better yet: Just all known notes to keep it complete, or ask user?
    // User requirement: "Reporte Mensual". Usually implies "Cierre de Mes".
    // Let's filter notes belonging to current month (deliveredAt in current Month) OR pending debt.
    const now = new Date();
    const curMonth = now.getMonth();
    const curYear = now.getFullYear();

    const reportNotes = notas.filter(n => {
      if (!n.deliveredAt) return false;
      const d = new Date(n.deliveredAt);
      const isThisMonth = (d.getMonth() === curMonth && d.getFullYear() === curYear);
      const hasDebt = (n.total - n.pagado) > 0;
      return isThisMonth || hasDebt;
    }).map(n => ({ ...n, ...computeCredito(n, now), isVIP: isVIP(n, notas) }));

    // Calculate Stats
    let totalCobrable = 0, totalCobrado = 0;
    reportNotes.forEach(n => {
      totalCobrable += (n.total || 0);
      totalCobrado += (n.pagado || 0);
    });
    const totalSaldo = Math.max(totalCobrable - totalCobrado, 0);
    const pct = totalCobrable > 0 ? (totalCobrado / totalCobrable) * 100 : 0;

    const stats = {
      cobrado: `$${totalCobrado.toLocaleString("es-MX")}`,
      porCobrar: `$${totalSaldo.toLocaleString("es-MX")}`,
      utilidad: `$${(totalCobrado * 0.4).toLocaleString("es-MX")}`,
      pct: `${pct.toFixed(1)}%`
    };

    // Get VIPs
    const uniqueClients = [...new Set(reportNotes.map(n => n.cliente))].filter(Boolean);
    const vipDetail = uniqueClients
      .filter(c => isVIP({ cliente: c }, notas))
      .map(c => {
        // Mock or calc volume
        return { name: c, volumen: "VIP" };
      });

    const logoPath = path.join(PUBLIC_DIR, "apple-touch-icon.png");
    const pdfBuffer = await generateReportPDF(logoPath, reportNotes, vipDetail, stats, {});

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=Reporte_Cha_${ymd(now)}.pdf`);
    res.send(pdfBuffer);

  } catch (e) {
    console.error("PDF ERROR:", e);
    res.status(500).send("Error generando PDF");
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});