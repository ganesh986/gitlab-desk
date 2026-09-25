'use strict';
// Wrapper minimale attorno all'eseguibile `git` installato sul sistema.
// Nessuna dipendenza da Electron: questo modulo è testabile con Node puro.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // oltre questa soglia il diff non viene mostrato

let gitBinary = 'git';
function setGitBinary(bin) { gitBinary = bin && bin.trim() ? bin.trim() : 'git'; }

class GitError extends Error {
  constructor(message, { code, stderr, args } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code;
    this.stderr = stderr;
    this.args = args;
  }
}

/**
 * Esegue git e restituisce stdout come stringa.
 * opts.env: variabili aggiuntive; opts.input: testo da inviare su stdin.
 */
function run(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // mai bloccarsi aspettando input da terminale
        GIT_OPTIONAL_LOCKS: '0',  // status non deve prendere lock sull'indice
        LC_ALL: 'C',              // messaggi in inglese: più facili da interpretare
        ...(opts.env || {}),
      },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        reject(new GitError('Git non trovato. Installa Git oppure indica il percorso nelle impostazioni.', { code: 'ENOENT', args }));
      } else reject(e);
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0 || (opts.okCodes || []).includes(code)) resolve(stdout);
      else reject(new GitError(humanizeError(stderr || stdout, args), { code, stderr, args }));
    });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

// Traduce gli errori più comuni in indicazioni comprensibili.
function humanizeError(text, args) {
  const t = (text || '').trim();
  const rules = [
    [/Authentication failed|could not read Username|HTTP Basic: Access denied|403/i,
      'Autenticazione rifiutata dal server. Controlla il token nelle impostazioni (servono gli scope read_repository e write_repository).'],
    [/SSL certificate problem|unable to get local issuer certificate|self.signed certificate/i,
      'Il certificato del server non è riconosciuto da Git. Su Windows prova: git config --global http.sslBackend schannel. Altrimenti chiedi all\'IT il certificato aziendale e impostalo con http.sslCAInfo.'],
    [/Could not resolve host|Failed to connect|Connection timed out|Connection refused/i,
      'Il server GitLab non è raggiungibile. Verifica la connessione o la VPN aziendale.'],
    [/Permission denied \(publickey\)/i,
      'Chiave SSH rifiutata. Aggiungi la tua chiave pubblica su GitLab oppure usa l\'URL HTTPS del repository.'],
    [/not possible to fast-forward|have diverged/i,
      'Il branch locale e quello remoto hanno commit diversi. Serve un merge o un rebase.'],
    [/\[rejected\].*\(fetch first\)|non-fast-forward|Updates were rejected/i,
      'Il server ha commit che tu non hai. Fai prima un Pull, poi riprova il Push.'],
    [/Your local changes to the following files would be overwritten/i,
      'Hai modifiche non salvate che verrebbero sovrascritte. Fai commit oppure scartale prima di continuare.'],
    [/CONFLICT|Automatic merge failed/i,
      'Ci sono conflitti da risolvere. Apri i file indicati nelle modifiche, sistemali e poi fai commit.'],
    [/protected branch|pre-receive hook declined/i,
      'Il server ha rifiutato il push: il branch è protetto. Lavora su un nuovo branch e apri una merge request.'],
    [/nothing to commit/i, 'Non ci sono modifiche da includere nel commit.'],
    [/Please tell me who you are|empty ident/i,
      'Git non conosce il tuo nome e la tua email. Impostali con: git config --global user.name "Nome Cognome" e git config --global user.email "tu@azienda.it".'],
    [/not a git repository/i, 'La cartella selezionata non è un repository Git.'],
    [/already exists and is not an empty directory/i, 'La cartella di destinazione esiste già e non è vuota.'],
    [/a branch named .* already exists/i, 'Esiste già un branch con questo nome.'],
  ];
  for (const [re, msg] of rules) if (re.test(t)) return `${msg}\n\nDettagli: ${lastLines(t)}`;
  return t || `git ${args[0]} non è andato a buon fine.`;
}
function lastLines(t, n = 4) { return t.split('\n').filter(Boolean).slice(-n).join('\n'); }

// ---------------------------------------------------------------------------
// Autenticazione HTTPS con token, senza scriverlo su disco né sulla riga di comando.
// Usa GIT_CONFIG_COUNT (Git ≥ 2.31) per aggiungere un header solo verso l'host GitLab.

function authEnv(remoteUrl, auth) {
  if (!auth || !auth.token || !auth.baseUrl || !remoteUrl) return {};
  let remote, base;
  try { remote = new URL(remoteUrl); base = new URL(auth.baseUrl); } catch { return {}; }
  if (!/^https?:$/.test(remote.protocol) || remote.host.toLowerCase() !== base.host.toLowerCase()) return {};
  const basic = Buffer.from(`oauth2:${auth.token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${remote.protocol}//${remote.host}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

// ---------------------------------------------------------------------------
// Repository

async function repoRoot(dir) {
  const out = await run(dir, ['rev-parse', '--show-toplevel']);
  return path.normalize(out.trim());
}

async function hasHead(cwd) {
  try { await run(cwd, ['rev-parse', '--verify', '-q', 'HEAD']); return true; } catch { return false; }
}

async function remoteUrl(cwd, remote = 'origin') {
  try { return (await run(cwd, ['remote', 'get-url', remote])).trim(); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Status (porcelain v2, separato da NUL)

function parseStatus(raw) {
  const result = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const tokens = raw.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') result.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') result.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') result.upstream = value;
      else if (key === 'branch.ab') {
        const m = value.match(/\+(\d+) -(\d+)/);
        if (m) { result.ahead = +m[1]; result.behind = +m[2]; }
      }
      continue;
    }
    const type = line[0];
    if (type === '1') {
      const parts = line.split(' ');
      result.files.push(fileEntry(parts[1], parts.slice(8).join(' ')));
    } else if (type === '2') {
      const parts = line.split(' ');
      const f = fileEntry(parts[1], parts.slice(9).join(' '));
      f.origPath = tokens[++i];
      f.kind = 'renamed';
      result.files.push(f);
    } else if (type === 'u') {
      const parts = line.split(' ');
      const f = fileEntry(parts[1], parts.slice(10).join(' '));
      f.kind = 'conflict';
      f.conflict = true;
      result.files.push(f);
    } else if (type === '?') {
      result.files.push({ path: line.slice(2), kind: 'added', untracked: true, staged: false });
    }
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

function fileEntry(xy, p) {
  const [x, y] = xy.split('');
  const code = x !== '.' ? x : y;
  const kind = { A: 'added', D: 'deleted', R: 'renamed', C: 'renamed', M: 'modified', T: 'modified' }[code] || 'modified';
  return { path: p, kind, staged: x !== '.', unstaged: y !== '.' };
}

async function status(cwd) {
  const raw = await run(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
  const s = parseStatus(raw);
  s.hasHead = !!s.oid;
  s.state = await repoState(cwd);
  s.conflicts = s.files.filter((f) => f.conflict).length;
  if (s.state === 'rebasing') s.rebaseBranch = await rebaseHeadName(cwd);
  s.rebased = s.upstream && s.ahead && s.behind ? await looksRebased(cwd, s.upstream) : false;
  return s;
}

// Branch divergente perché riscritto con un rebase: tutti i commit che ha solo il server
// hanno un equivalente locale (stesse modifiche, commit diverso)
async function looksRebased(cwd, upstream) {
  try {
    const out = await run(cwd, ['rev-list', '--right-only', '--cherry-mark', '--no-merges', `HEAD...${upstream}`]);
    const lines = out.split('\n').filter(Boolean);
    return lines.length > 0 && lines.every((l) => l.startsWith('='));
  } catch { return false; }
}

// Merge o rebase in corso?
async function repoState(cwd) {
  try {
    const gitDir = (await run(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merging';
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebasing';
  } catch { /* ignore */ }
  return null;
}

async function gitDir(cwd) {
  return (await run(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
}

async function rebaseHeadName(cwd) {
  try {
    const dir = await gitDir(cwd);
    for (const d of ['rebase-merge', 'rebase-apply']) {
      const f = path.join(dir, d, 'head-name');
      if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim().replace(/^refs\/heads\//, '');
    }
  } catch { /* ignore */ }
  return null;
}

// Messaggio proposto da Git per il commit di merge (o di squash)
async function pendingMessage(cwd) {
  try {
    const dir = await gitDir(cwd);
    for (const name of ['MERGE_MSG', 'SQUASH_MSG']) {
      const f = path.join(dir, name);
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => !l.startsWith('#'));
      const summary = (lines.shift() || '').trim();
      return { summary, description: lines.join('\n').trim(), kind: name === 'MERGE_MSG' ? 'merge' : 'squash' };
    }
  } catch { /* ignore */ }
  return null;
}

// File che contengono ancora i segni di conflitto (<<<<<<< ======= >>>>>>>)
function filesWithMarkers(cwd, rels) {
  const re = /^<{7}(?: |$)[\s\S]*?^>{7}(?: |$)/m;
  return rels.filter((rel) => {
    try {
      const abs = path.join(cwd, rel);
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 20 * 1024 * 1024) return false;
      const buf = fs.readFileSync(abs);
      return !buf.includes(0) && re.test(buf.toString('utf8'));
    } catch { return false; }
  });
}

function assertNoMarkers(cwd, rels) {
  const bad = filesWithMarkers(cwd, rels);
  if (bad.length) {
    throw new GitError(`Questi file contengono ancora i segni di conflitto (<<<<<<< e >>>>>>>): ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}. Aprili nell'editor, scegli quale versione tenere e salva.`);
  }
}

// ---------------------------------------------------------------------------
// Diff

async function fileDiff(cwd, file) {
  // File nuovi non tracciati: costruiamo il diff leggendo il file
  if (file.untracked || !(await hasHead(cwd))) return untrackedDiff(cwd, file.path);
  const args = ['diff', '--no-color', '--no-ext-diff', '-M', 'HEAD', '--'];
  if (file.origPath) args.push(file.origPath);
  args.push(file.path);
  const out = await run(cwd, args);
  if (Buffer.byteLength(out) > MAX_DIFF_BYTES) return { tooLarge: true };
  return { patch: out };
}

function untrackedDiff(cwd, rel) {
  const abs = path.join(cwd, rel);
  let stat;
  try { stat = fs.statSync(abs); } catch { return { patch: '' }; }
  if (stat.isDirectory()) return { patch: '' };
  if (stat.size > MAX_DIFF_BYTES) return { tooLarge: true };
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) return { binary: true };
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const body = lines.map((l) => '+' + l).join('\n');
  return { patch: `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${body}\n` };
}

// ---------------------------------------------------------------------------
// Commit: include solo i file selezionati (modello "spunta per includere")

async function commit(cwd, { paths, summary, description, amend = false }) {
  if (!summary || !summary.trim()) throw new GitError('Scrivi un titolo per il commit.');
  const state = await repoState(cwd);
  if (state === 'rebasing') throw new GitError('È in corso un rebase: usa "Continua rebase" invece del commit.');
  if (state === 'merging') return commitMerge(cwd, { paths: paths || [], summary, description });
  if (!amend && (!paths || !paths.length)) throw new GitError('Seleziona almeno un file da includere nel commit.');
  if (paths && paths.length) assertNoMarkers(cwd, paths);
  const head = await hasHead(cwd);
  if (head) await run(cwd, ['reset', '-q']); // svuota l'indice (le modifiche restano nei file)
  if (paths && paths.length) {
    await run(cwd, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') });
  }
  const message = description && description.trim() ? `${summary.trim()}\n\n${description.trim()}\n` : `${summary.trim()}\n`;
  const args = ['commit', '-F', '-'];
  if (amend) args.push('--amend');
  await run(cwd, args, { input: message });
  return (await run(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
}

// Commit che conclude un merge: l'indice non va svuotato, altrimenti Git dimentica il merge
async function commitMerge(cwd, { paths, summary, description }) {
  const s = parseStatus(await run(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']));
  const conflicted = s.files.filter((f) => f.conflict).map((f) => f.path);
  const excludedConflicts = conflicted.filter((p) => !paths.includes(p));
  if (excludedConflicts.length) {
    throw new GitError(`Per completare il merge devi includere anche i file in conflitto: ${excludedConflicts.slice(0, 5).join(', ')}.`);
  }
  assertNoMarkers(cwd, paths);
  if (paths.length) await run(cwd, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0') });
  const message = description && description.trim() ? `${summary.trim()}\n\n${description.trim()}\n` : `${summary.trim()}\n`;
  await run(cwd, ['commit', '-F', '-'], { input: message });
  return (await run(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
}

// Annulla l'ultimo commit mantenendo le modifiche nei file
async function undoLastCommit(cwd) {
  const parents = (await run(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD'])).trim().split(' ');
  if (parents.length < 2) throw new GitError('Il primo commit del repository non può essere annullato da qui.');
  await run(cwd, ['reset', '--soft', 'HEAD~1']);
  await run(cwd, ['reset', '-q']);
}

async function discard(cwd, files) {
  const tracked = files.filter((f) => !f.untracked).flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  const untracked = files.filter((f) => f.untracked).map((f) => f.path);
  if (tracked.length && (await hasHead(cwd))) {
    await run(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { input: tracked.join('\0') });
  }
  // I file non tracciati vengono semplicemente eliminati (solo se dentro il repository)
  const root = path.resolve(cwd) + path.sep;
  for (const rel of untracked) {
    const abs = path.resolve(cwd, rel);
    if (!abs.startsWith(root)) continue;
    fs.rmSync(abs, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Cronologia

const US = '\x1f';
const RS = '\x1e';

async function log(cwd, { limit = 100, skip = 0, range } = {}) {
  if (!(await hasHead(cwd))) return [];
  const args = ['log', `--format=%H${US}%h${US}%an${US}%ae${US}%aI${US}%s${US}%b${RS}`, `-n${limit}`, `--skip=${skip}`];
  if (range) args.push(range);
  const out = await run(cwd, args);
  return out.split(RS).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [sha, short, author, email, date, subject, body] = r.split(US);
    return { sha, short, author, email, date, subject, body: (body || '').trim() };
  });
}

// Commit locali non ancora presenti sul server
async function unpushedShas(cwd, upstream) {
  if (!(await hasHead(cwd))) return [];
  const args = upstream ? ['rev-list', `${upstream}..HEAD`] : ['rev-list', 'HEAD', '--not', '--remotes=origin'];
  try { return (await run(cwd, args)).split('\n').filter(Boolean); } catch { return []; }
}

async function showCommit(cwd, sha) {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new GitError('Commit non valido.');
  const out = await run(cwd, ['show', '--no-color', '--no-ext-diff', '-M', '--format=', '--patch', sha]);
  if (Buffer.byteLength(out) > MAX_DIFF_BYTES * 2) return { tooLarge: true };
  return { patch: out };
}

// File modificati in un commit (per i merge: rispetto al primo genitore, come fa GitHub Desktop)

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function checkSha(sha) {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new GitError('Commit non valido.');
}

async function parentOf(cwd, sha) {
  const out = (await run(cwd, ['rev-list', '--parents', '-n', '1', sha])).trim().split(' ');
  return { parent: out[1] || null, isMerge: out.length > 2 };
}

function parseNameStatus(raw) {
  const t = raw.split('\0').filter((x, i, arr) => !(x === '' && i === arr.length - 1));
  const files = [];
  for (let i = 0; i < t.length; i++) {
    const code = t[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      files.push({ path: t[i + 2], origPath: t[i + 1], kind: 'renamed' });
      i += 2;
    } else {
      files.push({ path: t[i + 1], kind: { A: 'added', D: 'deleted', M: 'modified', T: 'modified' }[letter] || 'modified' });
      i += 1;
    }
  }
  return files;
}

async function commitFiles(cwd, sha) {
  checkSha(sha);
  const { parent, isMerge } = await parentOf(cwd, sha);
  const out = await run(cwd, ['diff-tree', '-r', '-M', '-z', '--name-status', '--no-commit-id', parent || EMPTY_TREE, sha]);
  return { files: parseNameStatus(out), isMerge };
}

const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml' };

async function blobDataUri(cwd, rev, rel, mime) {
  try {
    const size = +(await run(cwd, ['cat-file', '-s', `${rev}:${rel}`])).trim();
    if (!size || size > 8 * 1024 * 1024) return null;
    const buf = await runBuffer(cwd, ['cat-file', 'blob', `${rev}:${rel}`]);
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

// Come run, ma restituisce i byte grezzi (per le immagini)
function runBuffer(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, args, { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const out = [];
    child.stdout.on('data', (d) => out.push(d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new GitError(`git ${args[0]} non riuscito`))));
  });
}

async function commitFileDiff(cwd, sha, file) {
  checkSha(sha);
  const { parent } = await parentOf(cwd, sha);
  const ext = (file.path.split('.').pop() || '').toLowerCase();
  if (IMAGE_TYPES[ext]) {
    const mime = IMAGE_TYPES[ext];
    const [before, after] = await Promise.all([
      parent && file.kind !== 'added' ? blobDataUri(cwd, parent, file.origPath || file.path, mime) : null,
      file.kind !== 'deleted' ? blobDataUri(cwd, sha, file.path, mime) : null,
    ]);
    if (before || after) return { image: { before, after } };
  }
  const args = ['diff', '--no-color', '--no-ext-diff', '-M', parent || EMPTY_TREE, sha, '--'];
  if (file.origPath) args.push(file.origPath);
  args.push(file.path);
  const out = await run(cwd, args);
  if (Buffer.byteLength(out) > MAX_DIFF_BYTES) return { tooLarge: true };
  if (/^Binary files /m.test(out)) return { binary: true };
  return { patch: out };
}

// ---------------------------------------------------------------------------
// Branch

async function branches(cwd) {
  const fmt = ['%(refname)', '%(refname:short)', '%(upstream:short)', '%(HEAD)', '%(committerdate:iso-strict)'].join('%1f');
  const out = await run(cwd, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes']);
  const local = [];
  const remote = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, name, upstream, head, date] = line.split(US);
    if (ref.startsWith('refs/heads/')) local.push({ name, upstream: upstream || null, current: head === '*', date });
    else if (!ref.endsWith('/HEAD')) remote.push({ name, date });
  }
  return { local, remote };
}

async function validateBranchName(cwd, name) {
  try { return (await run(cwd, ['check-ref-format', '--branch', name])).trim(); }
  catch { throw new GitError(`"${name}" non è un nome di branch valido. Evita spazi, "..", "~", "^", ":" e caratteri speciali.`); }
}

async function createBranch(cwd, name, from) {
  const valid = await validateBranchName(cwd, name);
  const args = ['switch', '-c', valid];
  if (from) args.push(from);
  await run(cwd, args);
  return valid;
}

async function checkout(cwd, name, { remote = false } = {}) {
  if (remote) {
    const localName = name.replace(/^[^/]+\//, '');
    const { local } = await branches(cwd);
    if (local.some((b) => b.name === localName)) await run(cwd, ['switch', localName]);
    else await run(cwd, ['switch', '-c', localName, '--track', name]);
    return localName;
  }
  await run(cwd, ['switch', name]);
  return name;
}

async function deleteBranch(cwd, name, force = false) {
  await run(cwd, ['branch', force ? '-D' : '-d', name]);
}

async function renameBranch(cwd, oldName, newName) {
  const valid = await validateBranchName(cwd, newName);
  const { local } = await branches(cwd);
  const b = local.find((x) => x.name === oldName);
  if (!b) throw new GitError(`Il branch ${oldName} non esiste.`);
  await run(cwd, ['branch', '-m', oldName, valid]);
  // Il branch sul server mantiene il vecchio nome: al prossimo push verrà pubblicato con quello nuovo
  if (b.upstream) await run(cwd, ['branch', '--unset-upstream', valid]).catch(() => {});
  return { name: valid, wasPublished: !!b.upstream, oldUpstream: b.upstream };
}

async function deleteRemoteBranch(cwd, name, auth) {
  const url = await remoteUrl(cwd);
  await run(cwd, ['push', 'origin', '--delete', name], { env: authEnv(url, auth) });
}

// ---------------------------------------------------------------------------
// Stash (modifiche accantonate)

async function stashAll(cwd, branch) {
  const s = await status(cwd);
  if (!s.files.length) throw new GitError('Non ci sono modifiche da accantonare.');
  const when = new Date().toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
  await run(cwd, ['stash', 'push', '--include-untracked', '-m', `GitLab Desk ${when}`]);
  return s.files.length;
}

async function stashList(cwd) {
  const out = await run(cwd, ['stash', 'list', `--format=%gd${US}%gs${US}%cI`]).catch(() => '');
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, subject, date] = line.split(US);
    const m = subject.match(/^(?:WIP on|On) ([^:]+): (.*)$/);
    return { ref, branch: m ? m[1] : null, message: m ? m[2] : subject, date };
  });
}

function checkStashRef(ref) {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new GitError('Riferimento allo stash non valido.');
}

async function stashFiles(cwd, ref) {
  checkStashRef(ref);
  const out = await run(cwd, ['stash', 'show', '--name-only', '--include-untracked', ref])
    .catch(() => run(cwd, ['stash', 'show', '--name-only', ref]).catch(() => ''));
  return out.split('\n').filter(Boolean);
}

async function stashPop(cwd, ref) {
  checkStashRef(ref);
  try { await run(cwd, ['stash', 'pop', ref]); return { conflicts: false }; }
  catch (e) {
    const s = await status(cwd);
    if (s.conflicts) return { conflicts: true };
    throw e;
  }
}

async function stashDrop(cwd, ref) {
  checkStashRef(ref);
  await run(cwd, ['stash', 'drop', ref]);
}

// ---------------------------------------------------------------------------
// Confronto, merge e rebase

async function compare(cwd, other) {
  const out = (await run(cwd, ['rev-list', '--left-right', '--count', `HEAD...${other}`])).trim();
  const [ahead, behind] = out.split(/\s+/).map(Number);
  return { ahead, behind };
}

// Anteprima di un merge: quanti commit arrivano e se ci saranno conflitti (Git ≥ 2.38)
async function mergePreview(cwd, branch) {
  const { ahead, behind } = await compare(cwd, branch);
  const result = { incoming: behind, outgoing: ahead, upToDate: behind === 0, fastForward: ahead === 0 && behind > 0, conflicts: null };
  if (result.upToDate || result.fastForward) { result.conflicts = []; return result; }
  try {
    const out = await run(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', 'HEAD', branch], { okCodes: [1] });
    const lines = out.split('\n').filter(Boolean);
    result.conflicts = [...new Set(lines.slice(1))];
  } catch { result.conflicts = null; /* Git troppo vecchio: conflitti non prevedibili */ }
  return result;
}

async function ensureClean(cwd, what) {
  const s = await status(cwd);
  if (s.state) throw new GitError(`C'è già un ${s.state === 'merging' ? 'merge' : 'rebase'} in corso: completalo o annullalo prima.`);
  if (s.files.length) {
    const e = new GitError(`Hai ${s.files.length} file con modifiche non committate. Prima di ${what} fai commit oppure accantona le modifiche (stash).`);
    e.code = 'DIRTY';
    throw e;
  }
  return s;
}

async function merge(cwd, branch, { squash = false } = {}) {
  await ensureClean(cwd, squash ? 'fare lo squash' : 'fare il merge');
  const args = ['merge', '--no-edit'];
  if (squash) args.push('--squash');
  args.push(branch);
  try {
    const out = await run(cwd, args);
    return { conflicts: false, upToDate: /Already up to date/i.test(out), squash };
  } catch (e) {
    const s = await status(cwd);
    if (s.conflicts) return { conflicts: true, count: s.conflicts, squash };
    throw e;
  }
}

async function abortMerge(cwd) {
  const state = await repoState(cwd);
  if (state === 'merging') await run(cwd, ['merge', '--abort']);
  else await run(cwd, ['reset', '--merge']); // squash con conflitti: non c'è MERGE_HEAD
}

const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' };

async function rebase(cwd, onto) {
  await ensureClean(cwd, 'fare il rebase');
  try { await run(cwd, ['rebase', onto], { env: NO_EDITOR }); return { conflicts: false }; }
  catch (e) {
    const s = await status(cwd);
    if (s.state === 'rebasing') return { conflicts: true, count: s.conflicts };
    throw e;
  }
}

async function rebaseContinue(cwd) {
  const s = await status(cwd);
  const changed = s.files.map((f) => f.path);
  assertNoMarkers(cwd, changed);
  if (changed.length) await run(cwd, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: changed.join('\0') });
  try {
    await run(cwd, ['-c', 'core.editor=true', 'rebase', '--continue'], { env: NO_EDITOR });
    return { conflicts: false, done: (await repoState(cwd)) !== 'rebasing' };
  } catch (e) {
    const after = await status(cwd);
    if (after.state === 'rebasing' && after.conflicts) return { conflicts: true, count: after.conflicts };
    if (after.state === 'rebasing' && /nothing to commit|No changes/i.test(e.stderr || '')) {
      await run(cwd, ['rebase', '--skip'], { env: NO_EDITOR });
      return rebaseContinue(cwd);
    }
    throw e;
  }
}

async function rebaseAbort(cwd) {
  await run(cwd, ['rebase', '--abort']);
}

// ---------------------------------------------------------------------------
// Rete

async function fetch(cwd, auth) {
  const url = await remoteUrl(cwd);
  if (!url) throw new GitError('Il repository non ha un remote "origin".');
  await run(cwd, ['fetch', '--prune', 'origin'], { env: authEnv(url, auth) });
}

async function pull(cwd, auth) {
  const url = await remoteUrl(cwd);
  await run(cwd, ['pull', '--no-rebase', '--no-edit'], { env: authEnv(url, auth) });
}

async function push(cwd, auth) {
  const url = await remoteUrl(cwd);
  if (!url) throw new GitError('Il repository non ha un remote "origin".');
  const s = await status(cwd);
  if (!s.branch) throw new GitError('Non sei su un branch (HEAD staccato). Crea o seleziona un branch prima del push.');
  const args = s.upstream ? ['push', 'origin', `HEAD:refs/heads/${s.upstream.replace(/^origin\//, '')}`] : ['push', '-u', 'origin', s.branch];
  await run(cwd, args, { env: authEnv(url, auth) });
  return s.branch;
}

// Push forzato "sicuro": fallisce se nel frattempo qualcun altro ha pubblicato commit
async function forcePush(cwd, auth) {
  const url = await remoteUrl(cwd);
  const s = await status(cwd);
  if (!s.branch || !s.upstream) throw new GitError('Il branch non è pubblicato: usa il normale push.');
  const remoteBranch = s.upstream.replace(/^origin\//, '');
  await run(cwd, ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${remoteBranch}`], { env: authEnv(url, auth) });
}

async function clone(url, dest, auth) {
  const parent = path.dirname(dest);
  await run(parent, ['clone', '--', url, dest], { env: authEnv(url, auth) });
  return dest;
}

module.exports = {
  GitError, setGitBinary, run, authEnv, repoRoot, remoteUrl, hasHead,
  parseStatus, status, fileDiff, commit, undoLastCommit, discard,
  log, unpushedShas, showCommit, commitFiles, commitFileDiff, branches, createBranch, checkout, deleteBranch, validateBranchName,
  fetch, pull, push, forcePush, clone,
  pendingMessage, filesWithMarkers, renameBranch, deleteRemoteBranch,
  stashAll, stashList, stashFiles, stashPop, stashDrop,
  compare, mergePreview, merge, abortMerge, rebase, rebaseContinue, rebaseAbort,
};
