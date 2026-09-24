'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, net, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const git = require('./src/git');
const { GitLab, parseRemote, matchesInstance, normalizeBaseUrl } = require('./src/gitlab');
const { Settings } = require('./src/settings');

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

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (cmd) => () => win && win.webContents.send('menu', cmd);
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
    { label: 'Modifica', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'Repository',
      submenu: [
        { label: 'Fetch', accelerator: 'CmdOrCtrl+Shift+F', click: send('fetch') },
        { label: 'Pull', accelerator: 'CmdOrCtrl+Shift+P', click: send('pull') },
        { label: 'Push', accelerator: 'CmdOrCtrl+P', click: send('push') },
        { type: 'separator' },
        { label: 'Nuovo branch…', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-branch') },
        { label: 'Nuova merge request…', accelerator: 'CmdOrCtrl+M', click: send('new-mr') },
        { type: 'separator' },
        { label: 'Mostra nella cartella', click: send('reveal') },
        { label: 'Apri su GitLab', click: send('open-gitlab') },
      ],
    },
    { label: 'Vista', submenu: [{ role: 'reload', label: 'Ricarica' }, { role: 'toggleDevTools', label: 'Strumenti sviluppatore' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
  ]));
}

// ---------------------------------------------------------------------------
// Impostazioni

handle('settings:get', () => settings.publicView());

handle('settings:save', ({ gitlabUrl, token, clearToken, useTokenForGit, gitPath }) => {
  if (gitlabUrl !== undefined) settings.data.gitlabUrl = normalizeBaseUrl(gitlabUrl);
  if (clearToken) settings.setToken(null);
  else if (token) settings.setToken(token.trim());
  if (useTokenForGit !== undefined) settings.data.useTokenForGit = !!useTokenForGit;
  if (gitPath !== undefined) { settings.data.gitPath = gitPath.trim(); git.setGitBinary(settings.data.gitPath); }
  settings.save();
  return settings.publicView();
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
handle('git:fetch', () => git.fetch(requireRepo(), gitAuth()));
handle('git:pull', () => git.pull(requireRepo(), gitAuth()));
handle('git:push', () => git.push(requireRepo(), gitAuth()));
handle('git:commitsBetween', async (target) => {
  const repo = requireRepo();
  const ref = `origin/${target}`;
  try { return await git.log(repo, { limit: 50, range: `${ref}..HEAD` }); } catch { return []; }
});

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
