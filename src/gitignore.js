'use strict';
// Aggiunta di regole al file .gitignore nella radice del repository.

const fs = require('fs');
const path = require('path');

// Trasforma un percorso relativo (con "/") in una regola che corrisponde solo a quel file.
function patternForPath(rel) {
  let p = rel.replace(/\\/g, '/').replace(/([*?[\]\\])/g, '\\$1');
  p = p.replace(/( +)$/, (m) => m.replace(/ /g, '\\ ')); // spazi finali significativi
  return '/' + p;
}

function patternForExtension(ext) {
  const clean = ext.replace(/^\./, '').replace(/([*?[\]\\])/g, '\\$1');
  return `*.${clean}`;
}

// Estensione di un file (senza punto) oppure null per file senza estensione o "nascosti" come .env
function extensionOf(rel) {
  const base = rel.split('/').pop();
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return null;
  return base.slice(i + 1);
}

/** Aggiunge le regole mancanti e restituisce quelle effettivamente aggiunte. */
function addPatterns(repoRoot, patterns) {
  const file = path.join(repoRoot, '.gitignore');
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch { /* il file non esiste ancora */ }
  const existing = new Set(content.split(/\r?\n/).map((l) => l.trim()));
  const added = [...new Set(patterns)].filter((p) => !existing.has(p));
  if (!added.length) return [];
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const prefix = content && !/\r?\n$/.test(content) ? eol : '';
  fs.writeFileSync(file, content + prefix + added.join(eol) + eol);
  return added;
}

module.exports = { patternForPath, patternForExtension, extensionOf, addPatterns };
