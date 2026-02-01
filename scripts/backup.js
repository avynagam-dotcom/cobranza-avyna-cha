"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

async function runBackup() {
    console.log("\n========================================");
    console.log("  Iniciando Protocolo de Respaldo (CHA)");
    console.log("========================================");

    const R2_ENDPOINT = process.env.R2_ENDPOINT;
    const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
    const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
    const R2_BUCKET = process.env.R2_BUCKET;

    // Configuration via Environment
    // El usuario define process.env.DATA_DIR (ej: /var/data/cobranza/cha)
    const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
    const SOURCE_DIR = DATA_DIR;

    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
        throw new Error("❌ Faltan variables de entorno CRÍTICAS para el backup (R2)");
    }

    const date = new Date().toISOString().split("T")[0];
    const filename = `backup-${date}.tar.gz`;
    const archivePath = path.join("/tmp", filename);

    try {
        console.log(`\n🔍 Verificando origen en: ${SOURCE_DIR}`);

        if (!fs.existsSync(SOURCE_DIR)) {
            console.warn(`⚠️ ALERTA: No existe el directorio origen: ${SOURCE_DIR}`);
            return;
        }

        console.log(`\n📦 Comprimiendo contenido de ${SOURCE_DIR} en ${archivePath}...`);
        execSync(`tar -czf ${archivePath} .`, { cwd: SOURCE_DIR });

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
        // Namespace específico: cha/
        const s3Key = `cha/${filename}`;

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

