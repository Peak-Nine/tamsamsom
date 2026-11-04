/**
 * Builds public/app.html from the original tool (tool/market-estimator.html, kept unchanged
 * so it can be swapped for a newer version) plus a few named edits:
 *   - load our runtime before the tool, and the web/sign-out and PDF scripts after it
 *   - JSZip and pdf.js from this site instead of cdnjs (same versions)
 *   - a "Download a PDF report" card on the Summary page, and its button action
 *   - error messages that pointed people to claude.ai
 * Each edit must match exactly once; otherwise the build stops and says which one, so a new
 * version of the tool never ships half-patched. Also copies jsPDF into public/assets/vendor.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "tool", "market-estimator.html");
const OUT = path.join(ROOT, "public", "app.html");

const EDITS = [
  {
    name: "runtime before the tool, JSZip from this site",
    find: '<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>',
    replace: '<script src="/assets/runtime.js"></script>\n<script src="/assets/vendor/jszip.min.js"></script>',
  },
  {
    name: "pdf.js from this site",
    find:
      "    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');\n    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js');",
    replace: "    await loadScript('/assets/vendor/pdf.min.js');\n    await loadScript('/assets/vendor/pdf.worker.min.js');",
  },
  {
    name: "pdf.js worker from this site",
    find: "lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';",
    replace: "lib.GlobalWorkerOptions.workerSrc = '/assets/vendor/pdf.worker.min.js';",
  },
  {
    name: "scripts after the tool",
    find: "</body>",
    replace: '<script src="/assets/runtime-after.js"></script>\n<script src="/assets/report.js"></script>\n</body>',
  },
  {
    name: "PDF card on the Summary page",
    find: "<p class=\"micro\" style=\"margin:8px 0 0\">With your own workbook, only the M5 tab is written; every other tab stays exactly as it is.</p>\n          ${S.busy.export ? `<p style=\"margin-top:10px\">${busyLine(S.busy.export)}</p>` : ''}\n        </div>",
    replace:
      "<p class=\"micro\" style=\"margin:8px 0 0\">With your own workbook, only the M5 tab is written; every other tab stays exactly as it is.</p>\n          ${S.busy.export ? `<p style=\"margin-top:10px\">${busyLine(S.busy.export)}</p>` : ''}\n        </div>\n" +
      "        <div class=\"card\">\n" +
      "          <div class=\"row\" style=\"gap:10px;margin-bottom:6px\">${ico('download', 'lime')}<h3 class=\"h\" style=\"margin:0\">Download a PDF report</h3></div>\n" +
      "          <p class=\"small muted\">A clean report to share: the venture, the results, every building block with its evidence, and the sources.</p>\n" +
      "          <div class=\"row\" style=\"margin-top:8px\"><button class=\"btn ink\" data-act=\"exportpdf\" ${S.busy.pdf ? 'disabled' : ''}>${icon('download')}Download PDF</button></div>\n" +
      "          ${S.busy.pdf ? `<p style=\"margin-top:10px\">${busyLine(S.busy.pdf)}</p>` : ''}\n" +
      "        </div>",
  },
  {
    name: "PDF button action",
    find: "    case 'exportfresh': exportFresh(); break;",
    replace: "    case 'exportfresh': exportFresh(); break;\n    case 'exportpdf': if (window.exportPdf) window.exportPdf(); break;",
  },
  {
    name: "message: AI not set up",
    find: "sampling_disabled: 'Claude is not available for this account.',",
    replace: "sampling_disabled: 'The AI is not set up on this site yet. Ask Peak Nine to check the API key.',",
  },
  {
    name: "message: AI busy",
    find: "rate_limited: 'Claude is busy or your usage limit is reached. Wait a minute and try again.',",
    replace: "rate_limited: 'The AI is busy or today\\'s limit is reached. Wait a minute and try again.',",
  },
  {
    name: "message: AI unavailable",
    find: "unavailable: 'The AI is not available in this view. Open the tool on claude.ai or in the Claude app.',",
    replace: "unavailable: 'The AI could not be reached. Check your connection and try again.',",
  },
  {
    name: "research depth note",
    find: "uses more of your Claude usage.",
    replace: "uses more of the AI budget.",
  },
];

function applyEdits(html, edits = EDITS) {
  let out = html;
  for (const e of edits) {
    const n = out.split(e.find).length - 1;
    if (n !== 1) throw new Error(`Edit "${e.name}" matched ${n} times (expected exactly 1). Has the tool changed?`);
    out = out.replace(e.find, () => e.replace);
  }
  return out;
}

function copyVendor() {
  const dir = path.join(ROOT, "public", "assets", "vendor");
  fs.mkdirSync(dir, { recursive: true });
  const files = [
    [path.join(ROOT, "node_modules", "jspdf", "dist", "jspdf.umd.min.js"), "jspdf.umd.min.js"],
    [path.join(ROOT, "node_modules", "jspdf-autotable", "dist", "jspdf.plugin.autotable.min.js"), "jspdf.plugin.autotable.min.js"],
    // The same versions the tool loaded from cdnjs, now served from this site.
    [path.join(ROOT, "node_modules", "jszip", "dist", "jszip.min.js"), "jszip.min.js"],
    [path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.min.js"), "pdf.min.js"],
    [path.join(ROOT, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.js"), "pdf.worker.min.js"],
  ];
  for (const [from, to] of files) fs.copyFileSync(from, path.join(dir, to));
}

if (require.main === module) {
  const html = applyEdits(fs.readFileSync(SRC, "utf8"));
  fs.writeFileSync(OUT, html);
  copyVendor();
  console.log(`Built ${path.relative(ROOT, OUT)} (${EDITS.length} edits) and copied jsPDF.`);
}

module.exports = { applyEdits, EDITS };
