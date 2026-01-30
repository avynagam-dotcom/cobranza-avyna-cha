"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

async function runBackup() {
    console.log("\n========================================");
    console.log("  Iniciando Protocolo de Respaldo (CHA)");
    console.log("========================================");

    const SYSTEM_NAME = process.env.SYSTEM_NAME || "avyna-cha";
    const R2_ENDPOINT = process.env.R2_ENDPOINT;
    const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const R2_BUCKET = process.env.R2_BUCKET;

    // Carpeta de datos a respaldar (específica para CHA)
    const DATA_DIR = "/var/data/cobranza-cha";

    // Si no existe el disco persistente, intentamos la local (desarrollo/fallback)
    let SOURCE_DIR;
    if (fs.existsSync(DATA_DIR)) {
        console.log(`[INFO] Detectado disco persistente en: ${DATA_DIR}`);
        SOURCE_DIR = DATA_DIR;
    } else {
        console.log(`[WARN] No se detectó disco persistente. Usando ruta local relativa.`);
        SOURCE_DIR = path.join(__dirname, "..");
    }

    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        throw new Error("❌ Faltan variables de entorno CRÍTICAS para el backup (R2)");
    }

    const date = new Date().toISOString().split("T")[0];
    // Prefijo "cha-" solicitado para diferenciar
    const filename = `cha-backup-${date}.tar.gz`;
    const archivePath = path.join("/tmp", filename);

    try {
        console.log(`\n🔍 Verificando carpetas origen en: ${SOURCE_DIR}`);

        const targets = [];
        const dataPath = path.join(SOURCE_DIR, "data");
        const uploadsPath = path.join(SOURCE_DIR, "uploads");

        if (fs.existsSync(dataPath)) {
            console.log("   ✅ Encontrado: /data");
            targets.push("data");
        } else {
            console.log("   ⚠️ FALTANTE: /data");
        }

        if (fs.existsSync(uploadsPath)) {
            console.log("   ✅ Encontrado: /uploads");
            targets.push("uploads");
        } else {
            console.log("   ⚠️ FALTANTE: /uploads");
        }

        if (targets.length === 0) {
            console.warn("⚠️ ALERTA: No hay nada que respaldar (ni data ni uploads). Abortando.");
            return;
        }

        console.log(`\n📦 Comprimiendo archivos en ${archivePath}...`);
        // Usamos cwd: SOURCE_DIR para que el tar contenga "data/..." y "uploads/..." limpios
        execSync(`tar -czf ${archivePath} ${targets.join(" ")}`, { cwd: SOURCE_DIR });

        const sizeBytes = fs.statSync(archivePath).size;
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
        console.log(`   ➜ Archivo creado. Peso: ${sizeMB} MB`);

        console.log(`\n☁️  Subiendo a Cloudflare R2 (${R2_BUCKET})...`);
        const s3 = new S3Client({
            region: "auto",
            endpoint: R2_ENDPOINT,
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY,
            },
        });

        const fileBuffer = fs.readFileSync(archivePath);
        const s3Key = `${SYSTEM_NAME}/${filename}`;

        await s3.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: "application/gzip",
        }));

        console.log(`✅ EXITO: Respaldo subido correctamente.`);
        console.log(`   Ubicación: ${s3Key}`);

        // Limpieza
        fs.unlinkSync(archivePath);
        console.log("🧹 Limpieza de archivo temporal completada.");

    } catch (error) {
        console.error("\n❌ ERROR CRÍTICO DURANTE EL RESPALDO:");
        console.error(error.message);
        // Si falló, intentamos borrar el temporal si existe
        if (fs.existsSync(archivePath)) {
            try { fs.unlinkSync(archivePath); } catch (e) { }
        }
        throw error;
    }
}

module.exports = runBackup;

if (require.main === module) {
    runBackup().catch(() => process.exit(1));
}

