'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, net, safeStorage, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const git = require('./src/git');
const { GitLab, parseRemote, matchesInstance, normalizeBaseUrl } = require('./src/gitlab');
const { Settings } = require('./src/settings');
const gitignore = require('./src/gitignore');
const editors = require('./src/editors');

let win;
let settings;
let currentRepo = null;

function gitlab() {
  return new GitLab({ baseUrl: settings.data.gitlabUrl, token: settings.getToken(), fetchImpl: net.fetch.bind(net) });
}

function gitAuth() {
  if (!settings.data.useTokenForGit) return null;
  return { baseUrl: normalizeBaseUrl(settings.data.gitlabUrl), token: settings.getToken() };
}

function requireRepo() {
  if (!currentRepo) throw new Error('Nessun repository aperto.');
  return currentRepo;
}

// Ogni handler restituisce { ok, data } oppure { ok: false, error }
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try { return { ok: true, data: await fn(...args) }; }
    catch (e) {
      console.error(`[${channel}]`, e);
      return { ok: false, error: e.message || String(e), status: e.status };
    }
  });
}

// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'GitLab Desk',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('focus', () => win.webContents.send('app:focus'));

  // I link esterni si aprono nel browser, mai dentro l'app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Stato ricevuto dall'interfaccia, usato per abilitare le voci e scriverne le etichette
let menuState = {};

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const st = menuState;
  const send = (cmd) => () => win && win.webContents.send('menu', cmd);
  const repo = !!st.hasRepo;
  const onBranch = repo && !!st.branch;
  const busy = !!st.inProgress; // merge o rebase in corso
  const def = st.defaultBranch || 'main';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Aggiungi repository locale…', accelerator: 'CmdOrCtrl+O', click: send('add-repo') },
        { label: 'Clona repository…', accelerator: 'CmdOrCtrl+Shift+O', click: send('clone') },
        { type: 'separator' },
        { label: 'Impostazioni…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Esci' },
      ],
    },
    { label: 'Modifica', submenu: [{ role: 'undo', label: 'Annulla' }, { role: 'redo', label: 'Ripeti' }, { type: 'separator' }, { role: 'cut', label: 'Taglia' }, { role: 'copy', label: 'Copia' }, { role: 'paste', label: 'Incolla' }, { role: 'selectAll', label: 'Seleziona tutto' }] },
    {
      label: 'Vista',
      submenu: [
        { label: 'Modifiche', accelerator: 'CmdOrCtrl+1', click: send('tab-changes') },
        { label: 'Cronologia', accelerator: 'CmdOrCtrl+2', click: send('tab-history') },
        { label: 'Merge request', accelerator: 'CmdOrCtrl+3', click: send('tab-mrs') },
        { type: 'separator' },
        { role: 'reload', label: 'Ricarica', accelerator: 'F5' },
        { role: 'toggleDevTools', label: 'Strumenti sviluppatore' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Dimensione reale' }, { role: 'zoomIn', label: 'Ingrandisci' }, { role: 'zoomOut', label: 'Riduci' },
      ],
    },
    {
      label: 'Repository',
      submenu: [
        { label: 'Fetch', accelerator: 'CmdOrCtrl+Shift+F', enabled: repo, click: send('fetch') },
        { label: 'Pull', accelerator: 'CmdOrCtrl+Shift+P', enabled: onBranch && !busy, click: send('pull') },
        { label: 'Push', accelerator: 'CmdOrCtrl+P', enabled: onBranch && !busy, click: send('push') },
        { label: 'Push forzato…', enabled: onBranch && !busy && !!st.published, click: send('force-push') },
        { type: 'separator' },
        {
          label: 'Modo di lavoro',
          enabled: repo,
          submenu: [
            { type: 'radio', label: 'Con merge request', checked: st.workflow !== 'direct', click: send('workflow-mr') },
            { type: 'radio', label: `Push diretto su ${def}`, checked: st.workflow === 'direct', click: send('workflow-direct') },
          ],
        },
        { type: 'separator' },
        { label: 'Mostra nella cartella', enabled: repo, click: send('reveal') },
        { label: 'Apri su GitLab', enabled: repo && !!st.onGitlab, click: send('open-gitlab') },
      ],
    },
    {
      label: 'Branch',
      submenu: [
        { label: 'Nuovo branch…', accelerator: 'CmdOrCtrl+Shift+N', enabled: repo && !busy, click: send('new-branch') },
        { label: 'Rinomina…', accelerator: 'CmdOrCtrl+Shift+R', enabled: onBranch && !busy, click: send('rename-branch') },
        { label: 'Elimina…', accelerator: 'CmdOrCtrl+Shift+D', enabled: onBranch && !busy, click: send('delete-branch') },
        { type: 'separator' },
        { label: 'Scarta tutte le modifiche…', accelerator: 'CmdOrCtrl+Shift+Backspace', enabled: repo && !!st.hasChanges && !busy, click: send('discard-all') },
        { label: 'Accantona tutte le modifiche (stash)', accelerator: 'CmdOrCtrl+Shift+S', enabled: repo && !!st.hasChanges && !busy, click: send('stash') },
        { type: 'separator' },
        { label: `Aggiorna da ${def}`, accelerator: 'CmdOrCtrl+Shift+U', enabled: onBranch && !busy && !!st.defaultBranch && !st.isDefault, click: send('update-from-default') },
        { label: 'Confronta con un branch', accelerator: 'CmdOrCtrl+Shift+B', enabled: onBranch, click: send('compare') },
        { label: 'Unisci nel branch attuale…', accelerator: 'CmdOrCtrl+Shift+M', enabled: onBranch && !busy, click: send('merge') },
        { label: 'Squash e unisci nel branch attuale…', accelerator: 'CmdOrCtrl+Shift+H', enabled: onBranch && !busy, click: send('squash-merge') },
        { label: 'Rebase del branch attuale…', accelerator: 'CmdOrCtrl+Shift+E', enabled: onBranch && !busy, click: send('rebase') },
        { type: 'separator' },
        { label: `Unisci in ${def} e pubblica…`, accelerator: 'CmdOrCtrl+Shift+I', enabled: onBranch && !busy && !st.isDefault && !!st.defaultBranch, click: send('integrate-default') },
        { type: 'separator' },
        { label: 'Confronta su GitLab', accelerator: 'CmdOrCtrl+Shift+C', enabled: onBranch && !!st.onGitlab && !!st.published, click: send('compare-gitlab') },
        { label: 'Mostra il branch su GitLab', accelerator: 'CmdOrCtrl+Alt+B', enabled: onBranch && !!st.onGitlab && !!st.published, click: send('view-branch-gitlab') },
        {
          label: st.mrIid ? `Mostra la merge request !${st.mrIid}` : 'Crea merge request…',
          accelerator: 'CmdOrCtrl+R',
          enabled: onBranch && !!st.onGitlab && !st.isDefault,
          click: send('new-mr'),
        },
      ],
    },
  ]));
}

ipcMain.on('menu:state', (_e, state) => {
  const next = state || {};
  if (JSON.stringify(next) === JSON.stringify(menuState)) return;
  menuState = next;
  buildMenu();
});

// ---------------------------------------------------------------------------
// Impostazioni

function publicSettings() {
  const detected = editors.detectEditors();
  const editor = currentEditor(detected);
  return { ...settings.publicView(), detectedEditors: detected, editorName: editor ? editor.name : null };
}

function currentEditor(detected = editors.detectEditors()) {
  const custom = settings.data.editorPath;
  if (custom) {
    const known = detected.find((e) => e.path === custom);
    return known || { name: editors.nameFromPath(custom), path: custom };
  }
  return detected[0] || null;
}

handle('settings:get', () => publicSettings());

handle('settings:save', ({ gitlabUrl, token, clearToken, useTokenForGit, gitPath, editorPath }) => {
  if (gitlabUrl !== undefined) settings.data.gitlabUrl = normalizeBaseUrl(gitlabUrl);
  if (clearToken) settings.setToken(null);
  else if (token) settings.setToken(token.trim());
  if (useTokenForGit !== undefined) settings.data.useTokenForGit = !!useTokenForGit;
  if (gitPath !== undefined) { settings.data.gitPath = gitPath.trim(); git.setGitBinary(settings.data.gitPath); }
  if (editorPath !== undefined) settings.data.editorPath = editorPath.trim();
  settings.save();
  return publicSettings();
});

handle('settings:test', async ({ gitlabUrl, token } = {}) => {
  const client = new GitLab({
    baseUrl: gitlabUrl || settings.data.gitlabUrl,
    token: token || settings.getToken(),
    fetchImpl: net.fetch.bind(net),
  });
  const user = await client.currentUser();
  let gitVersion = null;
  try { gitVersion = (await git.run(process.cwd(), ['--version'])).trim(); } catch { /* segnalato a parte */ }
  return { user: { name: user.name, username: user.username, avatar: user.avatar_url }, gitVersion };
});

// ---------------------------------------------------------------------------
// Repository

async function openRepo(dir) {
  const root = await git.repoRoot(dir);
  currentRepo = root;
  settings.addRecent(root);
  return repoInfo(root);
}

async function repoInfo(root) {
  const url = await git.remoteUrl(root);
  const remote = parseRemote(url, settings.data.gitlabUrl);
  return {
    path: root,
    name: path.basename(root),
    remoteUrl: url,
    projectPath: remote ? remote.path : null,
    onGitlab: matchesInstance(remote, settings.data.gitlabUrl),
  };
}

handle('repo:recent', () => settings.data.recentRepos
  .map((p) => ({ path: p, name: path.basename(p), exists: fs.existsSync(p) })));

handle('repo:last', async () => {
  const last = settings.data.lastRepo;
  if (!last || !fs.existsSync(last)) return null;
  try { return await openRepo(last); } catch { return null; }
});

handle('repo:open', (p) => openRepo(p));

handle('repo:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Scegli la cartella del repository', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return openRepo(r.filePaths[0]);
});

handle('repo:forget', (p) => { settings.removeRecent(p); if (currentRepo === p) currentRepo = null; return true; });

handle('repo:reveal', () => shell.openPath(requireRepo()));

handle('dialog:pickFile', async (title) => {
  const filters = process.platform === 'win32' ? [{ name: 'Programmi', extensions: ['exe', 'cmd', 'bat'] }] : [];
  const r = await dialog.showOpenDialog(win, { title: title || 'Scegli un file', properties: ['openFile'], filters });
  return r.canceled ? null : r.filePaths[0];
});

handle('dialog:pickFolder', async (title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Scegli una cartella', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

handle('repo:clone', async ({ url, parentDir, name }) => {
  if (!url || !parentDir) throw new Error('Indica l\'URL del repository e la cartella di destinazione.');
  const folder = (name || path.basename(url).replace(/\.git$/, '')).replace(/[<>:"/\\|?*]/g, '-');
  const dest = path.join(parentDir, folder);
  if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new Error(`La cartella ${dest} esiste già e non è vuota.`);
  await git.clone(url, dest, gitAuth());
  return openRepo(dest);
});

// ---------------------------------------------------------------------------
// Git

handle('git:status', async () => {
  const repo = requireRepo();
  const s = await git.status(repo);
  s.unpushed = s.branch ? await git.unpushedShas(repo, s.upstream) : [];
  return s;
});
handle('git:diff', (file) => git.fileDiff(requireRepo(), file));
handle('git:commit', (opts) => git.commit(requireRepo(), opts));
handle('git:undoCommit', () => git.undoLastCommit(requireRepo()));
handle('git:discard', async (files) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Scarta modifiche', 'Annulla'],
    defaultId: 1,
    cancelId: 1,
    message: files.length === 1 ? `Scartare le modifiche a ${files[0].path}?` : `Scartare le modifiche a ${files.length} file?`,
    detail: 'L\'operazione non può essere annullata.',
  });
  if (r.response !== 0) return false;
  await git.discard(requireRepo(), files);
  return true;
});
handle('git:log', (opts) => git.log(requireRepo(), opts));
handle('git:show', (sha) => git.showCommit(requireRepo(), sha));
handle('git:commitFiles', (sha) => git.commitFiles(requireRepo(), sha));
handle('git:commitFileDiff', ({ sha, file }) => git.commitFileDiff(requireRepo(), sha, file));
handle('clipboard:write', (text) => { clipboard.writeText(String(text)); return true; });
handle('git:branches', () => git.branches(requireRepo()));
handle('git:createBranch', ({ name, from }) => git.createBranch(requireRepo(), name, from));
handle('git:checkout', ({ name, remote }) => git.checkout(requireRepo(), name, { remote }));
handle('git:deleteBranch', async (name) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Elimina', 'Annulla'], defaultId: 1, cancelId: 1,
    message: `Eliminare il branch locale ${name}?`,
    detail: 'Il branch sul server non viene toccato.',
  });
  if (r.response !== 0) return false;
  try { await git.deleteBranch(requireRepo(), name); }
  catch (e) {
    const f = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Elimina comunque', 'Annulla'], defaultId: 1, cancelId: 1,
      message: `Il branch ${name} contiene commit non ancora uniti altrove.`,
      detail: 'Eliminandolo potresti perderli se non sono stati pubblicati.',
    });
    if (f.response !== 0) return false;
    await git.deleteBranch(requireRepo(), name, true);
  }
  return true;
});
handle('git:renameBranch', ({ oldName, newName }) => git.renameBranch(requireRepo(), oldName, newName));
handle('git:deleteCurrentBranch', async ({ name, fallback, remote }) => {
  const repo = requireRepo();
  const s = await git.status(repo);
  if (s.files.length) throw new Error('Hai modifiche non committate: fai commit, accantonale o scartale prima di eliminare il branch.');
  if (s.branch === name) {
    const { local } = await git.branches(repo);
    if (local.some((b) => b.name === fallback)) await git.checkout(repo, fallback);
    else await git.checkout(repo, `origin/${fallback}`, { remote: true });
  }
  await git.deleteBranch(repo, name, true);
  if (remote) await git.deleteRemoteBranch(repo, name, gitAuth());
  return true;
});
handle('git:stash', () => git.stashAll(requireRepo()));
handle('git:stashList', () => git.stashList(requireRepo()));
handle('git:stashFiles', (ref) => git.stashFiles(requireRepo(), ref));
handle('git:stashDetails', (sha) => git.stashDetails(requireRepo(), sha));
handle('git:stashFileDiff', ({ sha, file }) => git.stashFileDiff(requireRepo(), sha, file));
handle('git:stashPop', (ref) => git.stashPop(requireRepo(), ref));
handle('git:stashDrop', (ref) => git.stashDrop(requireRepo(), ref));
handle('git:compare', (other) => git.compare(requireRepo(), other));
handle('git:mergePreview', (branch) => git.mergePreview(requireRepo(), branch));
handle('git:merge', ({ branch, squash }) => git.merge(requireRepo(), branch, { squash }));
handle('git:abortMerge', () => git.abortMerge(requireRepo()));
handle('git:rebase', (onto) => git.rebase(requireRepo(), onto));
handle('git:rebaseContinue', () => git.rebaseContinue(requireRepo()));
handle('git:rebaseAbort', () => git.rebaseAbort(requireRepo()));
handle('git:pendingMessage', () => git.pendingMessage(requireRepo()));
handle('git:forcePush', () => git.forcePush(requireRepo(), gitAuth()));
handle('git:markers', (rels) => git.filesWithMarkers(requireRepo(), rels));
handle('git:fetch', () => git.fetch(requireRepo(), gitAuth()));
handle('git:defaultBranch', () => git.remoteDefaultBranch(requireRepo()));
handle('git:pull', () => git.pull(requireRepo(), gitAuth()));
handle('git:push', () => git.push(requireRepo(), gitAuth()));
handle('git:commitsBetween', async (target) => {
  const repo = requireRepo();
  const ref = `origin/${target}`;
  try { return await git.log(repo, { limit: 50, range: `${ref}..HEAD` }); } catch { return []; }
});

// ---------------------------------------------------------------------------
// Azioni sui file modificati

// Percorso assoluto di un file del repository, rifiutando percorsi che escono dalla cartella
function repoFile(rel) {
  const root = path.resolve(requireRepo());
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Percorso non valido.');
  return abs;
}

function ignoreFiles(patterns, files) {
  const added = gitignore.addPatterns(requireRepo(), patterns);
  const tracked = files.filter((f) => !f.untracked).length;
  return { action: 'ignored', added, tracked };
}

function openFilesInEditor(rels) {
  const existing = rels.map(repoFile).filter((p) => fs.existsSync(p)).slice(0, 20);
  if (!existing.length) throw new Error('I file selezionati non esistono più sul disco.');
  editors.openInEditor(currentEditor(), existing);
}

handle('files:openInEditor', (rels) => openFilesInEditor(rels));

handle('files:contextMenu', ({ files, canInclude, canExclude }) => new Promise((resolve) => {
  const n = files.length;
  const rels = files.map((f) => f.path);
  const one = n === 1;
  const editor = currentEditor();
  const existing = rels.filter((r) => { try { return fs.existsSync(repoFile(r)); } catch { return false; } });
  let settled = false;
  const done = (value) => { if (!settled) { settled = true; resolve(value); } };
  const run = (fn) => () => {
    try { done(fn()); } catch (e) { done({ action: 'error', error: e.message }); }
  };

  const exts = [...new Set(rels.map(gitignore.extensionOf).filter(Boolean))].slice(0, 3);
  const onlyGitignore = rels.every((r) => r === '.gitignore');
  const revealLabel = process.platform === 'win32' ? 'Mostra in Esplora risorse' : process.platform === 'darwin' ? 'Mostra nel Finder' : 'Mostra nella cartella';

  const template = [
    { label: one ? 'Scarta le modifiche…' : `Scarta ${n} modifiche selezionate…`, click: () => done({ action: 'discard' }) },
    { type: 'separator' },
    {
      label: one ? 'Ignora il file (aggiungi a .gitignore)' : `Ignora ${n} file selezionati (aggiungi a .gitignore)`,
      enabled: !onlyGitignore,
      click: run(() => ignoreFiles(rels.filter((r) => r !== '.gitignore').map(gitignore.patternForPath), files)),
    },
    ...exts.map((ext) => ({
      label: `Ignora tutti i file .${ext} (aggiungi a .gitignore)`,
      click: run(() => ignoreFiles([gitignore.patternForExtension(ext)], files.filter((f) => gitignore.extensionOf(f.path) === ext))),
    })),
    { type: 'separator' },
    { label: one ? 'Includi nel commit' : 'Includi i file selezionati', enabled: canInclude, click: () => done({ action: 'include' }) },
    { label: one ? 'Escludi dal commit' : 'Escludi i file selezionati', enabled: canExclude, click: () => done({ action: 'exclude' }) },
    { type: 'separator' },
    { label: one ? 'Copia percorso' : 'Copia percorsi', click: run(() => { clipboard.writeText(rels.map(repoFile).join('\n')); return { action: 'copied' }; }) },
    { label: one ? 'Copia percorso relativo' : 'Copia percorsi relativi', click: run(() => { clipboard.writeText(rels.map((r) => r.split('/').join(path.sep)).join('\n')); return { action: 'copied' }; }) },
    { type: 'separator' },
    {
      label: revealLabel,
      click: run(() => {
        const target = existing[0] ? repoFile(existing[0]) : path.dirname(repoFile(rels[0]));
        if (existing[0]) shell.showItemInFolder(target); else shell.openPath(fs.existsSync(target) ? target : requireRepo());
        return { action: 'none' };
      }),
    },
    editor
      ? { label: `Apri in ${editor.name}`, enabled: existing.length > 0, click: run(() => { openFilesInEditor(existing); return { action: 'none' }; }) }
      : { label: 'Apri nell\'editor… (scegli nelle impostazioni)', click: () => done({ action: 'settings' }) },
    {
      label: 'Apri con il programma predefinito',
      enabled: one && existing.length === 1,
      click: run(() => { shell.openPath(repoFile(existing[0])); return { action: 'none' }; }),
    },
  ];
  Menu.buildFromTemplate(template).popup({ window: win, callback: () => setTimeout(() => done(null), 50) });
}));

// ---------------------------------------------------------------------------
// GitLab

const projectCache = new Map();
async function currentProject() {
  const info = await repoInfo(requireRepo());
  if (!info.projectPath) throw new Error('Il remote "origin" di questo repository non punta a un progetto GitLab.');
  if (!info.onGitlab) throw new Error(`Il remote punta a ${info.remoteUrl}, che non corrisponde al server GitLab configurato nelle impostazioni.`);
  const key = `${settings.data.gitlabUrl}|${info.projectPath}`;
  if (!projectCache.has(key)) {
    const p = await gitlab().getProject(info.projectPath);
    projectCache.set(key, {
      id: p.id, name: p.name, path: p.path_with_namespace, webUrl: p.web_url, defaultBranch: p.default_branch,
      removeSourceBranchDefault: p.remove_source_branch_after_merge !== false,
      squashOption: p.squash_option,
    });
  }
  return projectCache.get(key);
}

handle('gl:project', () => currentProject());
handle('gl:branchInfo', async (name) => {
  const p = await currentProject();
  try {
    const b = await gitlab().getBranch(p.id, name);
    return { exists: true, canPush: b.can_push !== false, protected: !!b.protected, developersCanPush: !!b.developers_can_push };
  } catch (e) {
    if (e.status === 404) return { exists: false, canPush: true, protected: false };
    throw e;
  }
});
handle('gl:me', async () => { const u = await gitlab().currentUser(); return { id: u.id, name: u.name, username: u.username }; });
handle('gl:searchProjects', async (q) => (await gitlab().searchProjects(q)).map((p) => ({
  id: p.id, name: p.name, path: p.path_with_namespace, httpUrl: p.http_url_to_repo, sshUrl: p.ssh_url_to_repo,
  description: p.description, lastActivity: p.last_activity_at,
})));
handle('gl:mrs', async ({ state = 'opened', scope } = {}) => {
  const p = await currentProject();
  return gitlab().listMergeRequests(p.id, { state, scope });
});
handle('gl:mrForBranch', async (branch) => {
  const p = await currentProject();
  const list = await gitlab().listMergeRequests(p.id, { state: 'opened', sourceBranch: branch });
  return list[0] || null;
});
handle('gl:mr', async (iid) => {
  const p = await currentProject();
  const [mr, approvals] = await Promise.all([gitlab().getMergeRequest(p.id, iid), gitlab().getApprovals(p.id, iid)]);
  return { ...mr, approvals };
});
handle('gl:branches', async (search) => {
  const p = await currentProject();
  return (await gitlab().listBranches(p.id, search)).map((b) => ({ name: b.name, isDefault: b.default, protected: b.protected }));
});
handle('gl:members', async (q) => {
  const p = await currentProject();
  return (await gitlab().searchProjectMembers(p.id, q)).map((u) => ({ id: u.id, name: u.name, username: u.username, avatar: u.avatar_url }));
});
handle('gl:createMR', async (mr) => {
  const p = await currentProject();
  return gitlab().createMergeRequest(p.id, mr);
});

handle('shell:open', (url) => {
  if (!/^https?:\/\//.test(url)) throw new Error('Indirizzo non valido.');
  return shell.openExternal(url);
});

// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  settings = new Settings(app.getPath('userData'), safeStorage);
  git.setGitBinary(settings.data.gitPath);
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
