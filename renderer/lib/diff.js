// Parser + penampil unified diff (dipakai untuk PR GitHub dan MR GitLab).
import { esc, html, raw, icon } from './h.js';

export function parseDiff(text) {
  const files = [];
  let f = null, h = null, oldNo = 0, newNo = 0;
  const start = (path) => { f = { path, oldPath: path, status: 'diubah', additions: 0, deletions: 0, binary: false, hunks: [] }; files.push(f); h = null; };
  for (const line of String(text || '').split('\n')) {
    let m;
    if ((m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line))) { start(m[2]); f.oldPath = m[1]; continue; }
    if (!f) continue;
    if (line.startsWith('new file mode')) { f.status = 'baru'; continue; }
    if (line.startsWith('deleted file mode')) { f.status = 'dihapus'; continue; }
    if (line.startsWith('rename from ')) { f.status = 'diganti nama'; continue; }
    if (line.startsWith('Binary files')) { f.binary = true; continue; }
    if (line.startsWith('--- ') && !h) continue;
    if (line.startsWith('+++ ') && !h) continue;
    if ((m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line))) { h = { header: line, lines: [] }; f.hunks.push(h); oldNo = +m[1]; newNo = +m[2]; continue; }
    if (!h) continue;
    if (line.startsWith('+')) { f.additions++; h.lines.push({ t: 'add', o: '', n: newNo++, x: line.slice(1) }); }
    else if (line.startsWith('-')) { f.deletions++; h.lines.push({ t: 'del', o: oldNo++, n: '', x: line.slice(1) }); }
    else if (line.startsWith('\\')) h.lines.push({ t: 'meta', o: '', n: '', x: line });
    else h.lines.push({ t: 'ctx', o: oldNo++, n: newNo++, x: line.startsWith(' ') ? line.slice(1) : line });
  }
  return files;
}

const SIGN = { add: '+', del: '−', ctx: ' ', meta: '' };

export function renderFile(f, { limit = 400 } = {}) {
  const total = f.hunks.reduce((n, h) => n + h.lines.length, 0);
  let shown = 0, cut = false;
  const rows = [];
  for (const h of f.hunks) {
    rows.push(`<tr class="diff-hunk"><td colspan="4">${esc(h.header)}</td></tr>`);
    for (const l of h.lines) {
      if (shown >= limit) { cut = true; break; }
      shown++;
      rows.push(`<tr class="diff-${l.t}"><td class="diff-no">${l.o}</td><td class="diff-no">${l.n}</td><td class="diff-sign">${SIGN[l.t]}</td><td class="diff-code">${esc(l.x)}</td></tr>`);
    }
    if (cut) break;
  }
  return html`
    <details class="diff-file" open>
      <summary class="diff-head">
        <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-slate-800" title="${f.path}">${f.path}</span>
        <span class="shrink-0 text-xs text-slate-400">${f.status}</span>
        <span class="shrink-0 text-xs font-medium text-success-700">+${f.additions}</span>
        <span class="shrink-0 text-xs font-medium text-danger-600">−${f.deletions}</span>
      </summary>
      ${f.binary ? html`<p class="p-4 text-xs text-slate-500">File biner tidak ditampilkan.</p>` : html`
        <div class="overflow-x-auto"><table class="diff-table"><tbody>${raw(rows.join(''))}</tbody></table></div>
        ${cut ? html`<p class="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">${icon('info', 'h-3.5 w-3.5 inline')} Menampilkan ${shown} dari ${total} baris. Buka di GitHub/GitLab untuk diff lengkap.</p>` : ''}`}
    </details>`;
}

export function renderDiff(text, opts) {
  const files = parseDiff(text);
  if (!files.length) return html`<p class="p-6 text-center text-sm text-slate-500">Tidak ada perubahan file.</p>`;
  const add = files.reduce((n, f) => n + f.additions, 0), del = files.reduce((n, f) => n + f.deletions, 0);
  return html`
    <div class="mb-3 flex items-center gap-3 text-sm text-slate-500">${icon('files')}<span>${files.length} file</span><span class="font-medium text-success-700">+${add}</span><span class="font-medium text-danger-600">−${del}</span></div>
    <div class="space-y-3">${files.map((f) => renderFile(f, opts))}</div>`;
}
