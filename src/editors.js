'use strict';
// Rileva gli editor più comuni installati e apre i file con quello scelto.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function winCandidates() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    ['Visual Studio Code', [path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'), path.join(pf, 'Microsoft VS Code', 'Code.exe')]],
    ['Cursor', [path.join(local, 'Programs', 'cursor', 'Cursor.exe')]],
    ['Notepad++', [path.join(pf, 'Notepad++', 'notepad++.exe'), path.join(pf86, 'Notepad++', 'notepad++.exe')]],
    ['Sublime Text', [path.join(pf, 'Sublime Text', 'sublime_text.exe'), path.join(pf, 'Sublime Text 3', 'sublime_text.exe')]],
    ['VSCodium', [path.join(local, 'Programs', 'VSCodium', 'VSCodium.exe'), path.join(pf, 'VSCodium', 'VSCodium.exe')]],
  ];
}
function macCandidates() {
  return [
    ['Visual Studio Code', ['/Applications/Visual Studio Code.app']],
    ['Cursor', ['/Applications/Cursor.app']],
    ['Sublime Text', ['/Applications/Sublime Text.app']],
    ['BBEdit', ['/Applications/BBEdit.app']],
    ['VSCodium', ['/Applications/VSCodium.app']],
  ];
}
function linuxCandidates() {
  return [
    ['Visual Studio Code', ['/usr/bin/code', '/snap/bin/code', '/usr/share/code/code']],
    ['Cursor', ['/usr/bin/cursor']],
    ['Sublime Text', ['/usr/bin/subl', '/opt/sublime_text/sublime_text']],
    ['Kate', ['/usr/bin/kate']],
    ['gedit', ['/usr/bin/gedit']],
  ];
}

function detectEditors() {
  const list = process.platform === 'win32' ? winCandidates() : process.platform === 'darwin' ? macCandidates() : linuxCandidates();
  const found = [];
  for (const [name, paths] of list) {
    const p = paths.find((x) => x && fs.existsSync(x));
    if (p) found.push({ name, path: p });
  }
  return found;
}

// Nome leggibile per un editor indicato a mano (es. "C:\...\idea64.exe" → "idea64")
function nameFromPath(p) {
  return path.basename(p).replace(/\.(exe|app|cmd|bat)$/i, '');
}

function openInEditor(editor, files) {
  if (!editor || !editor.path) throw new Error('Nessun editor configurato. Sceglilo nelle impostazioni.');
  if (!fs.existsSync(editor.path)) throw new Error(`Editor non trovato: ${editor.path}`);
  const [cmd, args] = editor.path.endsWith('.app') ? ['open', ['-a', editor.path, ...files]] : [editor.path, files];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

module.exports = { detectEditors, nameFromPath, openInEditor };
