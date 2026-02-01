"use strict";

const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");

function generateReportPDF(avynaLogoPath, notas, vipClients, kpis, stats) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 50 });
            const buffers = [];

            doc.on("data", buffers.push.bind(buffers));
            doc.on("end", () => {
                const pdfData = Buffer.concat(buffers);
                resolve(pdfData);
            });

            doc.on("error", (err) => {
                reject(err);
            });

            // --- Header ---
            if (fs.existsSync(avynaLogoPath)) {
                doc.image(avynaLogoPath, 50, 45, { width: 50 });
            }

            doc
                .fillColor("#444444")
                .fontSize(20)
                .text("Reporte Mensual - Cobranza CHA", 110, 57)
                .fontSize(10)
                .text("Avyna Game Changers", 200, 65, { align: "right" })
                .moveDown();

            doc.moveTo(50, 100).lineTo(550, 100).stroke();

            // --- KPIs Summary ---
            const yStart = 120;
            doc.fontSize(14).text("Resumen Ejecutivo", 50, yStart);

            doc.fontSize(10).font("Helvetica-Bold");
            doc.text("Cobranza Total:", 50, yStart + 25);
            doc.text("Por Cobrar:", 200, yStart + 25);
            doc.text("Utilidad Cobrada:", 350, yStart + 25);

            doc.font("Helvetica").fontSize(12);
            doc.text(kpis.cobrado, 50, yStart + 40);
            doc.text(kpis.porCobrar, 200, yStart + 40);
            doc.text(kpis.utilidad, 350, yStart + 40);

            doc.fontSize(10).fillColor("#777777");
            doc.text(`% Recuperación: ${kpis.pct}`, 50, yStart + 60);

            // --- Socios Estratégicos (VIP) ---
            doc.moveDown(4);
            doc.fillColor("#000000").fontSize(14).font("Helvetica-Bold");
            doc.text("Socios Estratégicos (VIP ⭐)", { underline: true });
            doc.moveDown(0.5);

            doc.fontSize(10).font("Helvetica");
            if (vipClients.length > 0) {
                vipClients.forEach(client => {
                    doc.text(`• ${client.name} - ${client.volumen}`);
                });
            } else {
                doc.text("No hay socios estratégicos identificados este mes.", { oblique: true });
            }

            // --- Detalle de Operaciones ---
            doc.moveDown(2);
            doc.fontSize(14).font("Helvetica-Bold").text("Detalle de Operaciones");
            doc.moveDown(0.5);

            // Table Header
            const tableTop = doc.y;
            const itemX = 50;
            const totalX = 300;
            const paidX = 380;
            const statusX = 460;

            doc.fontSize(9).font("Helvetica-Bold");
            doc.text("Cliente / Concepto", itemX, tableTop);
            doc.text("Total", totalX, tableTop);
            doc.text("Pagado", paidX, tableTop);
            doc.text("Estado", statusX, tableTop);

            doc.moveTo(itemX, tableTop + 15).lineTo(550, tableTop + 15).stroke();

            let y = tableTop + 25;
            doc.font("Helvetica");

            notas.forEach((nota) => {
                // Simple pagination check
                if (y > 700) {
                    doc.addPage();
                    y = 50;
                }

                const clientName = nota.cliente || nota.originalName || "Sin nombre";
                const isVip = nota.isVIP ? "⭐ " : "";
                const displayName = (isVip + clientName).substring(0, 45);

                doc.text(displayName, itemX, y);
                doc.text(money(nota.total), totalX, y);
                doc.text(money(nota.pagado), paidX, y);

                let statusColor = "#000000";
                if (nota.status === "LIQUIDADO") statusColor = "#28a745"; // Green
                if (nota.status === "VENCIDO") statusColor = "#dc3545"; // Red
                if (nota.status === "POR_VENCER") statusColor = "#ffc107"; // Yellow/Gold

                doc.fillColor(statusColor).text(nota.status, statusX, y);
                doc.fillColor("#000000");

                y += 15;
            });

            // Footer
            const pageCount = doc.bufferedPageRange().count;
            for (let i = 0; i < pageCount; i++) {
                doc.switchToPage(i);
                doc.fontSize(8).text(
                    `Generado: ${new Date().toLocaleString("es-MX")} | Página ${i + 1} de ${pageCount}`,
                    50,
                    doc.page.height - 50,
                    { align: "center", width: 500 }
                );
            }

            doc.end();

        } catch (e) {
            reject(e);
        }
    });
}

function money(val) {
    if (val == null || isNaN(val)) return "$0.00";
    return "$" + val.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { generateReportPDF };
