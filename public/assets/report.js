/**
 * "Download PDF": a clean report of a project, built in the browser with jsPDF (served from
 * this site, loaded only when someone asks for a PDF). It reads the same numbers the tool shows:
 *   1. title page block: project, date, who made it
 *   2. the venture brief (or the team's answers when the brief isn't validated yet)
 *   3. results: TAM, SAM, SOM and beachhead, each with its share of the market before it
 *   4. per market: the team's definition and every building block, with its evidence and source
 *   5. the sources behind the numbers
 * Uses the tool's own functions (evalMarket, exportModel, fmtEur, …), so figures match the screen.
 */
/* global S, MK, MK_NAME, evalMarket, pctOfPrev, fmtPct, fmtEur, fmtNum, exportModel, briefOk, ans, usedBy, toast, setBusy, safeName */
(function () {
  "use strict";

  function load(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("could not load " + src));
      document.head.appendChild(s);
    });
  }
  async function libs() {
    if (!(window.jspdf && window.jspdf.jsPDF)) await load("/assets/vendor/jspdf.umd.min.js");
    if (typeof window.autoTable !== "function") await load("/assets/vendor/jspdf.plugin.autotable.min.js");
    return { jsPDF: window.jspdf.jsPDF, autoTable: window.autoTable };
  }

  const INK = [33, 37, 41];
  const MUTED = [110, 117, 125];
  const LINE = [222, 226, 230];
  const ACCENT = [196, 214, 0];
  const M = 16; // page margin, mm

  // Standard PDF fonts cover Latin-1 and €; anything else would print as gibberish.
  const clean = (s) =>
    String(s == null ? "" : s)
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/…/g, "...")
      .replace(/[^\x09\x0a\x0d\x20-\x7e -ÿ€]/g, "");

  function valueText(b) {
    if (b.value == null || b.value === "") return "";
    const unit = String(b.unit || "").trim();
    return unit === "%" ? fmtNum(b.value, "%") : `${fmtNum(b.value)}${unit ? " " + unit : ""}`;
  }

  /** Flatten blocks (with sub-blocks indented) into table rows. */
  function blockRows(blocks, depth = 0) {
    const rows = [];
    blocks.forEach((b, i) => {
      const op = i === 0 || !b.op ? "" : b.op === "÷" ? "/ " : "x ";
      rows.push([
        clean(`${"   ".repeat(depth)}${op}${b.name || "(unnamed)"}`),
        clean(b.children ? "computed" : valueText(b) || "not filled in"),
        b.children ? "" : b.evidence === "DATA" ? "Data" : "Assumption",
        clean([b.source, b.comment].filter(Boolean).join(" - ")),
      ]);
      if (b.children) rows.push(...blockRows(b.children, depth + 1));
    });
    return rows;
  }

  async function exportPdf() {
    setBusy("pdf", "Building the PDF report");
    try {
      const { jsPDF, autoTable } = await libs();
      const doc = new jsPDF({ unit: "mm", format: "a4" });
      const W = doc.internal.pageSize.getWidth();
      const H = doc.internal.pageSize.getHeight();
      let y = M;

      const ensure = (h) => {
        if (y + h > H - M - 8) {
          doc.addPage();
          y = M;
        }
      };
      const heading = (t, size = 13) => {
        ensure(14);
        doc.setFont("helvetica", "bold").setFontSize(size).setTextColor(...INK);
        doc.text(clean(t), M, y + 5);
        y += size >= 13 ? 9 : 7;
      };
      const para = (t, { size = 10, color = INK, gap = 3 } = {}) => {
        if (!t) return;
        doc.setFont("helvetica", "normal").setFontSize(size).setTextColor(...color);
        for (const line of doc.splitTextToSize(clean(t), W - 2 * M)) {
          ensure(5);
          doc.text(line, M, y + 4);
          y += size * 0.45;
        }
        y += gap;
      };
      const table = (head, body, columnStyles = {}) => {
        autoTable(doc, {
          head: [head],
          body,
          startY: y,
          margin: { left: M, right: M, bottom: M + 8 },
          styles: { font: "helvetica", fontSize: 8.5, cellPadding: 1.8, textColor: INK, lineColor: LINE, lineWidth: 0.1, overflow: "linebreak" },
          headStyles: { fillColor: [245, 246, 247], textColor: INK, fontStyle: "bold" },
          columnStyles,
        });
        y = doc.lastAutoTable.finalY + 6;
      };

      // 1. Title
      const proj = (S.proj && S.proj.name) || "Project";
      doc.setFillColor(...ACCENT).rect(M, y, 18, 1.6, "F");
      y += 7;
      doc.setFont("helvetica", "bold").setFontSize(20).setTextColor(...INK);
      doc.text(clean(proj), M, y + 6);
      y += 12;
      para(`Market sizing report  |  ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}${S.me && S.me.name && S.me.name !== "Visitor" ? "  |  prepared by " + S.me.name : ""}`, {
        size: 9,
        color: MUTED,
        gap: 6,
      });

      // 2. The venture
      heading("The venture");
      if (briefOk()) para(S.intro.brief.text, { gap: 5 });
      else {
        const model = exportModel();
        if (model.problem) para(`Problem: ${model.problem}`);
        if (model.marketTarget) para(model.marketTarget);
        if (!model.problem && !model.marketTarget) para("The venture brief is not filled in yet.", { color: MUTED });
        y += 2;
      }

      // 3. Results
      heading("Results");
      const results = MK.map((k) => {
        const e = evalMarket(k);
        const p = pctOfPrev(k);
        return [
          `${k}  ${MK_NAME[k]}`,
          e.total != null ? clean(fmtEur(e.total)) + (e.partial ? " (so far)" : "") : "not computed",
          p != null ? `${clean(fmtPct(p))} of the ${MK[MK.indexOf(k) - 1]}` : "",
          e.blocks ? `${e.validated} of ${e.blocks} blocks validated` : "no blocks yet",
        ];
      });
      table(["Market", "Size", "Share", "Status"], results, { 0: { cellWidth: 62, fontStyle: "bold" }, 1: { cellWidth: 32 } });

      // 4. Per market
      const model = exportModel();
      MK.forEach((k) => {
        const m = model.markets[k] || { definition: "", divisions: [] };
        heading(`${k}: ${MK_NAME[k]}`, 12);
        para(m.definition ? `Definition: ${m.definition}` : "No definition yet.", { color: m.definition ? INK : MUTED });
        if (!m.divisions.length) {
          para("No building blocks yet.", { color: MUTED, gap: 5 });
          return;
        }
        m.divisions.forEach((d, i) => {
          if (m.divisions.length > 1 || d.title) para(d.title || `Part ${i + 1}`, { size: 9.5, color: MUTED, gap: 1 });
          table(["Building block", "Value", "Evidence", "Source and notes"], blockRows(d.blocks), {
            0: { cellWidth: 52 },
            1: { cellWidth: 28 },
            2: { cellWidth: 22 },
          });
        });
      });

      // 5. Sources
      const srcs = Object.values(S.sources || {}).filter((s) => s && !s.deleted && usedBy(s.id).length);
      heading("Sources behind the numbers");
      if (srcs.length) {
        table(
          ["Source", "Link", "Found by"],
          srcs.map((s) => [clean(s.title || ""), clean(s.url || ""), s.origin === "ai" ? "AI" : "Team"]),
          { 1: { cellWidth: 70 }, 2: { cellWidth: 18 } }
        );
      } else para("No block is backed by a source yet.", { color: MUTED });

      // Footer on every page
      const pages = doc.getNumberOfPages();
      for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFont("helvetica", "normal").setFontSize(8).setTextColor(...MUTED);
        doc.text(clean(`${proj}  |  Peak Nine Market Estimator`), M, H - 8);
        doc.text(`${i} / ${pages}`, W - M, H - 8, { align: "right" });
      }

      doc.save(`${safeName(proj)} - Market sizing report.pdf`);
      toast("PDF report saved.");
    } catch (err) {
      console.warn(err);
      toast("The PDF could not be made: " + ((err && err.message) || "unknown error"), "warn");
    } finally {
      setBusy("pdf", false);
    }
  }

  window.exportPdf = exportPdf;
})();
