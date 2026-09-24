(() => {
'use strict';
/* global window */
// Converte l'output di `git diff` / `git show` in una struttura e la disegna come tabella.

const MAX_LINES_RENDERED = 6000;

function parsePatch(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLn = 0;
  let newLn = 0;
  const lines = patch.split('\n');
  const start = (oldPath, newPath) => {
    file = { oldPath, newPath, hunks: [], adds: 0, dels: 0, binary: false, meta: [] };
    files.push(file);
    hunk = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
      start(m ? m[1] : '', m ? m[2] : '');
      continue;
    }
    if (!file && (line.startsWith('--- ') || line.startsWith('@@'))) start('', '');
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('--- ')) { const p = line.slice(4).replace(/^a\//, ''); if (p !== '/dev/null') file.oldPath = p; continue; }
      if (line.startsWith('+++ ')) { const p = line.slice(4).replace(/^b\//, ''); if (p !== '/dev/null') file.newPath = p; continue; }
      if (line.startsWith('Binary files')) { file.binary = true; continue; }
      if (/^(new file|deleted file|rename from|rename to|similarity index|old mode|new mode)/.test(line)) { file.meta.push(line); continue; }
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldLn = m ? +m[1] : 0;
      newLn = m ? +m[2] : 0;
      hunk = { header: line, context: m ? m[3].trim() : '', lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const c = line[0];
    if (c === '+') { hunk.lines.push({ type: 'add', newLn: newLn++, text: line.slice(1) }); file.adds++; }
    else if (c === '-') { hunk.lines.push({ type: 'del', oldLn: oldLn++, text: line.slice(1) }); file.dels++; }
    else if (c === ' ') { hunk.lines.push({ type: 'ctx', oldLn: oldLn++, newLn: newLn++, text: line.slice(1) }); }
    else if (c === '\\') { hunk.lines.push({ type: 'note', text: 'Nessun a capo alla fine del file' }); }
  }
  return files;
}

function renderDiff(result, { showFileHeaders = true } = {}) {
  const { h } = window.UI;
  if (!result) return h('div', { class: 'diff-message' }, 'Seleziona un file per vedere le modifiche.');
  if (result.tooLarge) return h('div', { class: 'diff-message' }, 'Il diff è troppo grande per essere mostrato qui. Aprilo con il tuo editor.');
  if (result.binary) return h('div', { class: 'diff-message' }, 'File binario: il contenuto non può essere mostrato come testo.');
  const files = parsePatch(result.patch || '');
  if (!files.length) return h('div', { class: 'diff-message' }, 'Nessuna differenza di contenuto (può essere cambiato solo il nome o i permessi).');

  let budget = MAX_LINES_RENDERED;
  return h('div', null, files.map((f) => {
    const name = f.oldPath && f.newPath && f.oldPath !== f.newPath ? `${f.oldPath} → ${f.newPath}` : (f.newPath || f.oldPath);
    const head = showFileHeaders && h('div', { class: 'diff-file-head' },
      h('span', null, name),
      h('span', { class: 'stats' }, h('span', { class: 'a' }, `+${f.adds}`), ' ', h('span', { class: 'd' }, `−${f.dels}`)));
    if (f.binary) return h('section', { class: 'diff-file' }, head, h('div', { class: 'diff-message' }, 'File binario modificato.'));
    if (!f.hunks.length) return h('section', { class: 'diff-file' }, head, h('div', { class: 'diff-message' }, f.meta.join('\n') || 'Nessuna modifica al contenuto.'));
    const rows = [];
    for (const hk of f.hunks) {
      rows.push(h('tr', { class: 'hunk' }, h('td', { class: 'ln' }), h('td', { class: 'ln' }), h('td', { class: 'code' }, hk.header)));
      for (const l of hk.lines) {
        if (budget-- <= 0) break;
        const sign = l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ';
        rows.push(h('tr', { class: l.type },
          h('td', { class: 'ln' }, l.oldLn || ''),
          h('td', { class: 'ln' }, l.newLn || ''),
          h('td', { class: 'code' }, l.type === 'note' ? l.text : `${sign} ${l.text}`)));
      }
      if (budget <= 0) {
        rows.push(h('tr', { class: 'note' }, h('td', { class: 'ln' }), h('td', { class: 'ln' }), h('td', { class: 'code' }, 'Diff troncato: apri il file nel tuo editor per vederlo tutto.')));
        break;
      }
    }
    return h('section', { class: 'diff-file' }, head, h('table', { class: 'diff' }, h('tbody', null, rows)));
  }));
}

window.Diff = { parsePatch, renderDiff };
})();
