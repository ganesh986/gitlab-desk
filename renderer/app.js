'use strict';
/* global window, document, localStorage */
const { h, mount, api, busy, toast, modal, confirmDialog, ago, fullDate, debounce } = window.UI;
const { renderDiff } = window.Diff;

const $ = (id) => document.getElementById(id);

const S = {
  settings: null,
  repo: null,          // { path, name, remoteUrl, projectPath, onGitlab }
  status: null,
  tab: 'changes',
  selectedFile: null,  // file con il focus (quello di cui si vede il diff)
  selection: new Set(), // file selezionati nell'elenco (clic, Ctrl+clic, Maiusc+clic)
  pivot: null,         // punto di partenza per le selezioni con Maiusc
  excluded: new Set(), // file esclusi dal prossimo commit
  draft: { summary: '', description: '' },
  history: [],
  historyDone: false,
  selectedCommit: null,
  project: null,
  projectError: null,
  branchMr: null,
  mrs: [],
  mrFilter: 'opened',
  mrView: null,        // { kind: 'detail', iid } | { kind: 'new' }
  mrsError: null,
  me: null,
  stashes: [],
  compare: null,       // { branch, view: 'behind'|'ahead', counts, commits }
  squashSource: null,
  commitFile: null,    // file selezionato nel dettaglio del commit
  showStash: false,    // vista delle modifiche accantonate nel pannello principale
  stashFile: null,
};

const LABELS = {
  mrState: { opened: 'Aperta', merged: 'Unita', closed: 'Chiusa', locked: 'Bloccata' },
  pipeline: { success: 'Superata', failed: 'Fallita', running: 'In esecuzione', pending: 'In attesa', canceled: 'Annullata', skipped: 'Saltata', manual: 'In attesa di avvio manuale', created: 'Creata', scheduled: 'Programmata' },
  merge: {
    mergeable: 'Pronta per il merge', ci_must_pass: 'Deve passare la pipeline', ci_still_running: 'Pipeline in corso',
    not_approved: 'Servono approvazioni', draft_status: 'È una bozza', discussions_not_resolved: 'Discussioni da risolvere',
    broken_status: 'Ha conflitti', conflict: 'Ha conflitti', need_rebase: 'Serve un rebase', checking: 'Verifica in corso',
    unchecked: 'Verifica in corso', blocked_status: 'Bloccata da altre merge request', not_open: 'Non è aperta',
    requested_changes: 'Sono state richieste modifiche', jira_association_missing: 'Manca il riferimento Jira',
  },
};

// =========================================================================== avvio

async function init() {
  S.settings = await api('settings:get');
  bindChrome();
  const last = await api('repo:last').catch(() => null);
  if (last) await setRepo(last);
  else renderAll();
  if (!S.settings.gitlabUrl || !S.settings.hasToken) openSettings({ firstRun: true });
}

function bindChrome() {
  $('tb-repo').addEventListener('click', (e) => openRepoPicker(e.currentTarget));
  $('tb-branch').addEventListener('click', (e) => openBranchPicker(e.currentTarget));
  $('tb-settings').addEventListener('click', () => openSettings());
  $('tb-sync').addEventListener('click', (e) => syncAction(e.currentTarget));
  $('tb-mr').addEventListener('click', () => {
    if (S.branchMr) { S.mrView = { kind: 'detail', iid: S.branchMr.iid }; switchTab('mrs'); }
    else openNewMr();
  });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  setupSplitter();
  $('side-body').addEventListener('keydown', onFileListKey);
  $('side-body').addEventListener('keydown', onHistoryKey);

  window.desk.on('app:focus', debounce(() => { if (S.repo) refreshStatus(); }, 300));
  window.desk.on('menu', (cmd) => {
    if (!['add-repo', 'clone', 'settings'].includes(cmd) && !S.repo) return toast('Apri prima un repository.');
    const gl = (path) => (S.project ? api('shell:open', `${S.project.webUrl}${path}`) : toast(S.projectError || 'Progetto GitLab non disponibile.'));
    ({
      'add-repo': addLocalRepo,
      clone: openClone,
      settings: () => openSettings(),
      fetch: () => runNet('fetch'),
      pull: () => runNet('pull'),
      push: () => runNet('push'),
      'new-branch': () => openNewBranch(),
      'new-mr': () => { if (S.branchMr) { S.mrView = { kind: 'detail', iid: S.branchMr.iid }; switchTab('mrs'); } else openNewMr(); },
      'force-push': () => forcePush(),
      'workflow-mr': () => setWorkflow('mr'),
      'workflow-direct': () => setWorkflow('direct'),
      'integrate-default': integrateIntoDefault,
      'rename-branch': openRenameBranch,
      'delete-branch': openDeleteBranch,
      'discard-all': () => S.status && discardFiles(S.status.files),
      stash: stashAll,
      'update-from-default': updateFromDefault,
      compare: openCompare,
      merge: () => openMerge(),
      'squash-merge': () => openMerge({ squash: true }),
      rebase: openRebase,
      'compare-gitlab': () => gl(`/-/compare/${encodeURI(defaultBranch())}...${encodeURI(currentBranch())}`),
      'view-branch-gitlab': () => gl(`/-/tree/${encodeURI(currentBranch())}`),
      'tab-changes': () => switchTab('changes'),
      'tab-history': () => switchTab('history'),
      'tab-mrs': () => switchTab('mrs'),
      reveal: () => api('repo:reveal'),
      'open-gitlab': () => (S.project ? api('shell:open', S.project.webUrl) : toast(S.projectError || 'Progetto GitLab non disponibile.')),
    })[cmd]?.();
  });
}

// Pannello laterale ridimensionabile: trascina il divisore, frecce da tastiera, doppio clic per ripristinare.
function setupSplitter() {
  const splitter = $('splitter');
  const DEFAULT = 320;
  const MIN = 220;
  const maxWidth = () => Math.max(MIN, Math.min(900, window.innerWidth - 420));
  const clamp = (w) => Math.round(Math.min(maxWidth(), Math.max(MIN, w)));
  let width = DEFAULT;
  let preferred = DEFAULT; // larghezza scelta dall'utente, anche se la finestra ora è più stretta
  const apply = (w, save = true) => {
    if (save || document.body.classList.contains('resizing')) preferred = w;
    width = clamp(w);
    document.documentElement.style.setProperty('--side-width', `${width}px`);
    splitter.setAttribute('aria-valuenow', String(width));
    if (save) { try { localStorage.setItem('sideWidth', String(width)); } catch { /* ignora */ } }
  };
  let saved = NaN;
  try { saved = parseInt(localStorage.getItem('sideWidth'), 10); } catch { /* ignora */ }
  preferred = Number.isFinite(saved) ? saved : DEFAULT;
  apply(preferred, false);
  splitter.setAttribute('aria-valuemin', String(MIN));

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev) => apply(startW + ev.clientX - startX, false);
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      splitter.classList.remove('dragging');
      document.body.classList.remove('resizing');
      apply(width);
      preferred = width;
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  splitter.addEventListener('dblclick', () => apply(DEFAULT));
  splitter.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === 'ArrowLeft') { apply(width - step); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { apply(width + step); e.preventDefault(); }
    else if (e.key === 'Home') { apply(MIN); e.preventDefault(); }
    else if (e.key === 'End') { apply(maxWidth()); e.preventDefault(); }
  });
  // Se la finestra si restringe, il pannello non deve schiacciare l'area principale
  window.addEventListener('resize', debounce(() => { width = clamp(preferred); document.documentElement.style.setProperty('--side-width', `${width}px`); }, 100));
}

async function setRepo(info) {
  Object.assign(S, {
    repo: info, status: null, selectedFile: null, selection: new Set(), pivot: null, excluded: new Set(), draft: { summary: '', description: '' },
    history: [], historyDone: false, selectedCommit: null, project: null, projectError: null,
    branchMr: null, mrs: [], mrView: null, mrsError: null, stashes: [], compare: null, squashSource: null,
    localDefault: null, perms: null,
  });
  renderAll();
  S.localDefault = await api('git:defaultBranch').catch(() => null);
  await refreshStatus();
  loadProject();
  if (S.tab === 'history') loadHistory(true);
}

function switchTab(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === tab)));
  if (tab === 'history' && !S.history.length) loadHistory(true);
  if (tab === 'mrs') loadMrs();
  renderAll();
}

// =========================================================================== dati

async function refreshStatus() {
  if (!S.repo) return;
  try {
    const prevBranch = S.status ? S.status.branch : undefined;
    [S.status] = await Promise.all([api('git:status'), loadStashes()]);
    const paths = new Set(S.status.files.map((f) => f.path));
    for (const p of [...S.excluded]) if (!paths.has(p)) S.excluded.delete(p);
    if (S.selectedFile && !paths.has(S.selectedFile)) S.selectedFile = null;
    for (const p of [...S.selection]) if (!paths.has(p)) S.selection.delete(p);
    if (S.pivot && !paths.has(S.pivot)) S.pivot = null;
    if (prevBranch !== undefined && prevBranch !== S.status.branch) {
      S.branchMr = null;
      S.history = []; S.historyDone = false; S.selectedCommit = null; S.compare = null;
      if (S.tab === 'history') loadHistory(true);
      refreshBranchMr();
    }
  } catch (e) {
    toast(e.message, { type: 'error', timeout: 0 });
  }
  if (S.status && S.status.state === 'merging') prefillMergeMessage();
  if (S.status && !S.status.state && S.squashSource && !S.status.files.length) S.squashSource = null;
  if (S.compare && S.tab === 'history') loadCompare();
  renderToolbar();
  if (S.tab === 'changes') renderChanges();
  $('count-changes').textContent = S.status && S.status.files.length ? String(S.status.files.length) : '';
}

async function loadProject() {
  S.project = null;
  S.projectError = null;
  if (!S.settings.gitlabUrl || !S.settings.hasToken) S.projectError = 'Configura il server GitLab e il token nelle impostazioni.';
  else if (!S.repo.remoteUrl) S.projectError = 'Il repository non ha un remote "origin".';
  else if (!S.repo.onGitlab) S.projectError = 'Il remote "origin" non punta al server GitLab configurato.';
  else {
    try { S.project = await api('gl:project'); }
    catch (e) { S.projectError = e.message; }
  }
  if (S.project && !S.me) S.me = await api('gl:me').catch(() => null);
  await refreshBranchMr();
  renderAll();
}

async function refreshBranchMr() {
  S.branchMr = null;
  const b = S.status && S.status.branch;
  if (S.project && b && b !== S.project.defaultBranch && S.status.upstream) {
    S.branchMr = await api('gl:mrForBranch', b).catch(() => null);
  }
  // Permessi di push sul branch attuale (branch protetti)
  S.perms = null;
  if (S.project && b && S.status.upstream) {
    const info = await api('gl:branchInfo', b).catch(() => null);
    if (info && currentBranch() === b) S.perms = { branch: b, ...info };
  }
  renderToolbar();
  if (S.tab === 'changes') renderChanges();
}

async function loadHistory(reset) {
  if (reset) { S.history = []; S.historyDone = false; }
  try {
    const more = await api('git:log', { limit: 100, skip: S.history.length });
    S.history = S.history.concat(more);
    S.historyDone = more.length < 100;
  } catch (e) { toast(e.message, { type: 'error' }); }
  if (S.tab === 'history') renderHistory();
}

async function loadMrs() {
  if (!S.project) { renderAll(); return; }
  S.mrsError = null;
  try {
    const q = { opened: { state: 'opened' }, mine: { state: 'opened', scope: 'created_by_me' }, merged: { state: 'merged' } }[S.mrFilter];
    S.mrs = await api('gl:mrs', q);
    if (S.mrFilter === 'opened') $('count-mrs').textContent = S.mrs.length ? String(S.mrs.length) : '';
  } catch (e) { S.mrsError = e.message; S.mrs = []; }
  if (S.tab === 'mrs') renderMrs();
}

// =========================================================================== rendering

function renderAll() {
  renderToolbar();
  if (!S.repo) return renderWelcome();
  if (S.tab === 'changes') renderChanges();
  else if (S.tab === 'history') renderHistory();
  else renderMrs();
}

function renderToolbar() {
  const s = S.status;
  $('tb-repo-name').textContent = S.repo ? S.repo.name : 'Nessun repository';
  $('tb-branch').disabled = !S.repo;
  $('tb-branch-name').textContent = !s ? '—'
    : s.state === 'rebasing' ? `rebase di ${s.rebaseBranch || '…'}`
      : s.branch || `HEAD staccato (${(s.oid || '').slice(0, 7)})`;
  syncMenuState();

  const route = $('route');
  const sync = $('tb-sync');
  const mrBtn = $('tb-mr');
  route.hidden = !s || !s.branch;
  sync.disabled = !S.repo || !S.repo.remoteUrl;
  if (!s) { sync.textContent = 'Fetch'; mrBtn.hidden = true; return; }

  if (s.state) { // merge o rebase in corso: niente push/pull finché non è completato
    sync.textContent = 'Fetch';
    sync.dataset.action = 'fetch';
    route.hidden = true;
    mrBtn.hidden = true;
    return;
  }
  const counts = $('route-counts');
  mount(counts);
  route.classList.toggle('moving', !!(s.ahead || s.behind || (!s.upstream && s.hasHead)));
  if (!s.upstream) {
    counts.textContent = 'non pubblicato';
    sync.textContent = 'Pubblica branch';
    sync.dataset.action = 'push';
  } else {
    if (s.ahead) counts.appendChild(h('span', { class: 'ahead', title: 'Commit da pubblicare' }, `↑${s.ahead}`));
    if (s.ahead && s.behind) counts.appendChild(document.createTextNode(' '));
    if (s.behind) counts.appendChild(h('span', { class: 'behind', title: 'Commit da scaricare' }, `↓${s.behind}`));
    if (!s.ahead && !s.behind) counts.textContent = 'allineato';
    if (needsForcePush()) { sync.textContent = `Push forzato ↑${s.ahead}`; sync.dataset.action = 'force-push'; }
    else if (s.behind) { sync.textContent = `Pull ↓${s.behind}`; sync.dataset.action = 'pull'; }
    else if (s.ahead) { sync.textContent = `Push ↑${s.ahead}`; sync.dataset.action = 'push'; }
    else { sync.textContent = 'Fetch'; sync.dataset.action = 'fetch'; }
  }
  $('route-end').textContent = s.upstream || 'origin';

  const canMr = S.project && s.branch && s.branch !== S.project.defaultBranch && workflow() === 'mr';
  mrBtn.hidden = !canMr;
  mrBtn.disabled = false;
  mrBtn.textContent = S.branchMr ? `Merge request !${S.branchMr.iid}` : 'Crea merge request';
}

function renderWelcome() {
  mount($('side-body'));
  mount($('side-foot'));
  api('repo:recent').then((recent) => {
    mount($('main'), h('div', { class: 'empty' },
      h('h1', null, 'Scegli un repository su cui lavorare'),
      h('p', null, 'Aggiungi una cartella che contiene già un repository Git, oppure clona un progetto dal server GitLab aziendale.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: openClone }, 'Clona da GitLab'),
        h('button', { class: 'btn', onclick: addLocalRepo }, 'Aggiungi repository locale')),
      recent.length > 0 && h('div', { class: 'recent' },
        h('div', { class: 'group-label', style: 'padding-left:0' }, 'Aperti di recente'),
        recent.slice(0, 8).map((r) => h('div', { class: 'row', onclick: () => openRecent(r) },
          h('span', { class: 'grow' }, r.name, ' ', h('span', { class: 'sub' }, r.path)))))));
  });
}

// ------------------------------------------------------------------ Modifiche

function renderChanges({ keepMain = false } = {}) {
  const side = $('side-body');
  const foot = $('side-foot');
  const s = S.status;
  if (!s) { mount(side); mount(foot); mount($('main')); return; }

  const files = s.files;
  const included = files.filter((f) => !S.excluded.has(f.path));
  const allBox = h('input', {
    type: 'checkbox', 'aria-label': 'Includi tutti i file',
    checked: files.length > 0 && included.length === files.length,
    onchange: (e) => { S.excluded = e.target.checked ? new Set() : new Set(files.map((f) => f.path)); renderChanges({ keepMain: S.selection.size === 1 }); },
  });
  allBox.indeterminate = included.length > 0 && included.length < files.length;

  mount(side,
    inProgressBanner(),
    h('div', { class: 'list-head' },
      files.length > 0 && allBox,
      h('span', { class: 'grow' }, files.length ? `${files.length} file modificat${files.length === 1 ? 'o' : 'i'}` : 'Nessuna modifica'),
      files.length > 0 && !s.state && h('button', { class: 'link', onclick: () => discardFiles(files) }, 'Scarta tutto')),
    h('div', { class: 'file-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'File modificati' },
      files.map((f) => fileRow(f))));

  // Box di commit
  const onDefault = S.project && s.branch === S.project.defaultBranch && workflow() === 'mr';
  const blocked = pushBlocked();
  const summary = h('input', {
    type: 'text', placeholder: 'Titolo del commit (obbligatorio)', value: S.draft.summary, maxlength: 200,
    oninput: (e) => { S.draft.summary = e.target.value; commitBtn.disabled = !canCommit(); },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit(commitBtn); },
  });
  const desc = h('textarea', {
    placeholder: 'Descrizione (facoltativa)', value: S.draft.description,
    oninput: (e) => { S.draft.description = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doCommit(commitBtn); },
  });
  const canCommit = () => S.draft.summary.trim() && files.some((f) => !S.excluded.has(f.path));
  const commitBtn = h('button', { class: 'btn primary block', disabled: !canCommit(), onclick: (e) => doCommit(e.currentTarget) },
    s.state === 'merging' ? 'Completa il merge' : s.branch ? `Commit su ${s.branch}` : 'Commit');

  const bar = !s.state && stashBar();
  if (s.state === 'rebasing') {
    mount(foot, h('div', { class: 'commit-box' }, h('div', { class: 'hint' }, 'Durante il rebase i commit vengono ricreati da Git: risolvi i conflitti e usa "Continua rebase" qui sopra.')));
  } else mount(foot, bar, h('div', { class: 'commit-box' },
    onDefault && !blocked && h('div', { class: 'hint warn' },
      `Sei su ${s.branch}: per una merge request serve un branch di lavoro. `,
      h('button', { class: 'link', onclick: () => openNewBranch() }, 'Crea branch'),
      ' · ',
      h('button', { class: 'link', onclick: () => setWorkflow('direct') }, 'Lavoriamo senza merge request')),
    blocked && h('div', { class: 'hint warn' },
      `${s.branch} è protetto: con il tuo ruolo GitLab non puoi fare push qui. `,
      h('button', { class: 'link', onclick: () => openNewBranch() }, 'Crea un branch di lavoro')),
    summary, desc, commitBtn,
    !s.state && s.unpushed && s.unpushed.length > 0 && h('div', { class: 'hint' },
      h('button', { class: 'link', onclick: undoCommit }, 'Annulla ultimo commit'),
      ' (non ancora pubblicato)')));

  // Pannello principale
  if (keepMain) return;
  const stash = currentStash();
  if (S.showStash && stash && !s.state) { renderStashView(stash); return; }
  S.showStash = false;
  const selected = files.filter((f) => S.selection.has(f.path));
  if (selected.length === 1) renderFileDiff(selected[0]);
  else if (selected.length > 1) renderMultiSelection(selected);
  else renderChangesOverview();
}

// ----- selezione multipla

function selectFile(p, { shift = false, toggle = false } = {}) {
  const order = S.status.files.map((f) => f.path);
  if (shift && S.pivot && order.includes(S.pivot)) {
    const a = order.indexOf(S.pivot);
    const b = order.indexOf(p);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    S.selection = toggle ? new Set([...S.selection, ...range]) : new Set(range);
  } else if (toggle) {
    if (S.selection.has(p)) S.selection.delete(p); else S.selection.add(p);
    S.pivot = p;
  } else {
    S.selection = new Set([p]);
    S.pivot = p;
  }
  S.selectedFile = p;
  S.showStash = false;
  renderChanges();
}

function selectedFiles() {
  return S.status ? S.status.files.filter((f) => S.selection.has(f.path)) : [];
}

function setIncluded(files, include) {
  for (const f of files) { if (include) S.excluded.delete(f.path); else S.excluded.add(f.path); }
  renderChanges({ keepMain: S.selection.size === 1 });
}

// Tastiera sull'elenco: frecce (con Maiusc per estendere), Ctrl+A, Spazio per includere/escludere,
// tasto Menu o Maiusc+F10 per il menu contestuale
function onFileListKey(e) {
  if (S.tab !== 'changes' || !S.status || !S.status.files.length) return;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)) return;
  const order = S.status.files.map((f) => f.path);
  const cur = order.indexOf(S.selectedFile);
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = order[Math.max(0, Math.min(order.length - 1, cur < 0 ? 0 : cur + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (e.shiftKey) { if (!S.pivot) S.pivot = S.selectedFile || next; selectFile(next, { shift: true }); }
    else selectFile(next);
    scrollFocusedRow();
  } else if (mod && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    S.selection = new Set(order);
    renderChanges();
  } else if (e.key === ' ' && S.selection.size) {
    e.preventDefault();
    const sel = selectedFiles();
    setIncluded(sel, sel.some((f) => S.excluded.has(f.path)));
  } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    if (S.selection.size) openFileMenu();
  } else if (e.key === 'Escape' && S.selection.size) {
    S.selection = new Set();
    S.selectedFile = null;
    renderChanges();
  }
}

function scrollFocusedRow() {
  const row = document.querySelector('.file-list .row.focused');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

async function openFileMenu() {
  const files = selectedFiles();
  if (!files.length) return;
  let r;
  try {
    r = await api('files:contextMenu', {
      files,
      canInclude: files.some((f) => S.excluded.has(f.path)),
      canExclude: files.some((f) => !S.excluded.has(f.path)),
    });
  } catch (e) { toast(e.message, { type: 'error' }); return; }
  if (!r) return;
  switch (r.action) {
    case 'discard': discardFiles(files); break;
    case 'include': setIncluded(files, true); break;
    case 'exclude': setIncluded(files, false); break;
    case 'copied': toast('Copiato negli appunti.'); break;
    case 'settings': openSettings(); break;
    case 'error': toast(r.error, { type: 'error', timeout: 0 }); break;
    case 'ignored': {
      let msg = r.added.length
        ? `Aggiunt${r.added.length === 1 ? 'a' : 'e'} a .gitignore: ${r.added.slice(0, 5).join(', ')}${r.added.length > 5 ? '…' : ''}`
        : 'Le regole erano già presenti in .gitignore.';
      if (r.tracked) msg += `\n\n${r.tracked === 1 ? 'Un file è' : `${r.tracked} file sono`} già nel repository: Git continuerà a seguirl${r.tracked === 1 ? 'o' : 'i'} finché non ${r.tracked === 1 ? 'viene rimosso' : 'vengono rimossi'} con un commit.`;
      toast(msg, { type: 'success', timeout: r.tracked ? 9000 : 4500 });
      S.selection = new Set();
      S.selectedFile = null;
      await refreshStatus();
      break;
    }
    default: break;
  }
}

function editorButton(paths, small = true) {
  const name = S.settings.editorName;
  return h('button', {
    class: 'btn' + (small ? ' small' : ''),
    title: name ? `Apri in ${name}` : 'Scegli un editor nelle impostazioni',
    onclick: () => (name ? api('files:openInEditor', paths).catch((e) => toast(e.message, { type: 'error' })) : openSettings()),
  }, name ? `Apri in ${name}` : 'Apri nell\'editor');
}

function renderMultiSelection(files) {
  const nIncluded = files.filter((f) => !S.excluded.has(f.path)).length;
  const kinds = {};
  for (const f of files) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
  const kindLabel = { added: 'nuovi', modified: 'modificati', deleted: 'eliminati', renamed: 'rinominati', conflict: 'in conflitto' };
  const summary = Object.entries(kinds).map(([k, n]) => `${n} ${kindLabel[k] || k}`).join(', ');
  mount($('main'), h('div', { class: 'main-scroll' }, h('div', { class: 'empty' },
    h('h1', null, `${files.length} file selezionati`),
    h('p', null, `${summary}. ${nIncluded === files.length ? 'Sono tutti inclusi nel prossimo commit.' : nIncluded === 0 ? 'Nessuno è incluso nel prossimo commit.' : `${nIncluded} sono inclusi nel prossimo commit.`}`),
    h('div', { class: 'actions' },
      nIncluded < files.length && h('button', { class: 'btn primary', onclick: () => setIncluded(files, true) }, 'Includi tutti'),
      nIncluded > 0 && h('button', { class: 'btn', onclick: () => setIncluded(files, false) }, 'Escludi tutti'),
      editorButton(files.filter((f) => f.kind !== 'deleted').map((f) => f.path), false),
      h('button', { class: 'btn', onclick: openFileMenu }, 'Altre azioni…'),
      h('button', { class: 'btn danger', onclick: () => discardFiles(files) }, 'Scarta modifiche')),
    h('p', { class: 'hint', style: 'margin-top:18px' }, 'Suggerimento: Ctrl+clic aggiunge o toglie un file dalla selezione, Maiusc+clic seleziona un intervallo. Tasto destro per tutte le azioni.'))));
}

function fileRow(f) {
  const letter = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', conflict: '!' }[f.kind] || 'M';
  const title = { added: 'Nuovo', deleted: 'Eliminato', modified: 'Modificato', renamed: 'Rinominato', conflict: 'In conflitto' }[f.kind];
  const slash = f.path.lastIndexOf('/');
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
  const base = f.path.slice(slash + 1);
  return h('div', {
    class: 'row' + (S.selection.has(f.path) ? ' selected' : '') + (S.selectedFile === f.path ? ' focused' : ''),
    role: 'option',
    'aria-selected': String(S.selection.has(f.path)),
    title: f.origPath ? `${f.origPath} → ${f.path}` : f.path,
    onmousedown: (e) => { if (e.shiftKey) e.preventDefault(); }, // evita la selezione del testo con Maiusc+clic
    onclick: (e) => {
      if (e.target.tagName === 'INPUT') return;
      selectFile(f.path, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
      $('side-body').focus({ preventScroll: true });
    },
    oncontextmenu: (e) => {
      e.preventDefault();
      if (!S.selection.has(f.path)) { S.selection = new Set([f.path]); S.pivot = f.path; S.selectedFile = f.path; renderChanges(); }
      openFileMenu();
    },
  },
  h('input', {
    type: 'checkbox', 'aria-label': `Includi ${f.path}`, checked: !S.excluded.has(f.path),
    onchange: (e) => {
      // Se il file fa parte di una selezione multipla, la spunta vale per tutti i selezionati
      const targets = S.selection.has(f.path) && S.selection.size > 1 ? selectedFiles() : [f];
      setIncluded(targets, e.target.checked);
    },
  }),
  h('span', { class: 'file-name' }, h('bdi', null, h('span', { class: 'file-dir' }, dir), base)),
  h('span', { class: `kind ${f.kind}`, title }, letter));
}

async function renderFileDiff(file) {
  const main = $('main');
  const body = h('div', { class: 'main-scroll' }, h('div', { class: 'diff-message' }, 'Caricamento…'));
  mount(main,
    h('div', { class: 'main-head' },
      h('span', { class: 'title path' }, file.origPath ? `${file.origPath} → ${file.path}` : file.path),
      file.kind !== 'deleted' && editorButton([file.path]),
      h('button', { class: 'btn small danger', onclick: () => discardFiles([file]) }, 'Scarta modifiche')),
    body);
  try {
    const d = await api('git:diff', file);
    if (!S.selection.has(file.path) || S.selection.size !== 1) return;
    mount(body, renderDiff(d, { showFileHeaders: false }));
  } catch (e) { mount(body, h('div', { class: 'diff-message' }, e.message)); }
}

function renderChangesOverview() {
  const s = S.status;
  const items = [];
  if (s.state) {
    const conflicted = s.files.filter((f) => f.conflict);
    mount($('main'), h('div', { class: 'main-scroll' }, h('div', { class: 'empty' },
      h('h1', null, conflicted.length ? `${conflicted.length} file in conflitto` : 'Conflitti risolti'),
      h('p', null, conflicted.length
        ? 'In ogni file troverai blocchi delimitati da <<<<<<< e >>>>>>>: la parte sopra ======= è la tua versione, quella sotto arriva dall\'altro branch. Tieni ciò che serve, cancella i segni e salva.'
        : (s.state === 'merging' ? 'Controlla le modifiche e completa il merge con il pulsante in basso a sinistra.' : 'Continua il rebase dal pannello a sinistra.')),
      conflicted.length > 0 && h('div', { class: 'actions' },
        editorButton(conflicted.map((f) => f.path), false),
        h('button', { class: 'btn', onclick: () => { S.selection = new Set([conflicted[0].path]); S.selectedFile = conflicted[0].path; S.pivot = conflicted[0].path; renderChanges(); } }, 'Mostra il primo')))));
    return;
  }
  if (s.files.length) {
    items.push(h('div', { class: 'empty' },
      h('h1', null, `${s.files.length} file con modifiche`),
      h('p', null, 'Seleziona un file a sinistra per vedere cosa è cambiato. Togli la spunta ai file che non vuoi includere nel commit.')));
  } else {
    items.push(h('div', { class: 'empty' },
      h('h1', null, 'Nessuna modifica locale'),
      h('p', null, 'Quando modifichi i file del repository con il tuo editor, le modifiche compaiono qui.'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => api('repo:reveal') }, 'Mostra nella cartella'))));
  }
  const banners = [];
  if (s.branch && !s.upstream && s.hasHead) {
    const direct = workflow() === 'direct';
    banners.push(banner(direct ? '' : 'accent', 'Il branch non è ancora sul server',
      direct ? 'Pubblicalo se vuoi condividerlo con il team: per portarlo nel branch principale non è necessario.' : 'Pubblicalo per condividerlo e aprire una merge request.',
      h('button', { class: direct ? 'btn' : 'btn primary', onclick: (e) => runNet('push', e.currentTarget) }, 'Pubblica branch')));
  } else if (s.ahead && pushBlocked()) {
    banners.push(banner('warn', `Non puoi fare push su ${s.branch}`,
      `Il branch è protetto in GitLab e il tuo ruolo non può pubblicarci direttamente. Chiedi a un Maintainer di abilitarlo (Settings → Repository → Protected branches → "Allowed to push and merge"), oppure crea un branch di lavoro dai tuoi ${s.ahead} commit e apri una merge request.`,
      h('button', { class: 'btn', onclick: () => openNewBranch() }, 'Crea branch')));
  } else if (s.ahead) {
    banners.push(banner('accent', `${s.ahead} commit da pubblicare`, `Il branch ${s.branch} ha commit che il server non ha ancora.`,
      h('button', { class: 'btn primary', onclick: (e) => runNet('push', e.currentTarget) }, 'Push')));
  }
  if (s.behind) {
    banners.push(banner('', `${s.behind} commit da scaricare`, 'Sul server ci sono commit nuovi per questo branch.',
      h('button', { class: 'btn', onclick: (e) => runNet('pull', e.currentTarget) }, 'Pull')));
  }
  if (S.branchMr) {
    banners.push(banner('', `Merge request !${S.branchMr.iid} aperta`, S.branchMr.title,
      h('button', { class: 'btn', onclick: () => { S.mrView = { kind: 'detail', iid: S.branchMr.iid }; switchTab('mrs'); } }, 'Vedi dettagli')));
  } else if (workflow() === 'mr' && S.project && s.branch && s.upstream && s.branch !== S.project.defaultBranch && !s.ahead) {
    banners.push(banner('accent', 'Pronto per la revisione?', h('span', null, `Apri una merge request da ${s.branch} verso ${S.project.defaultBranch}. `,
      h('button', { class: 'link', onclick: () => setWorkflow('direct') }, 'Il progetto non usa merge request?')),
    h('button', { class: 'btn primary', onclick: openNewMr }, 'Crea merge request')));
  } else if (workflow() === 'direct' && s.branch && defaultBranch() && s.branch !== defaultBranch() && s.hasHead) {
    banners.push(banner('accent', `Pronto per portarlo su ${defaultBranch()}?`, h('span', null, `Unisci ${s.branch} in ${defaultBranch()} e pubblica il risultato, senza merge request. `,
      S.project && h('button', { class: 'link', onclick: () => setWorkflow('mr') }, 'Usate le merge request?')),
    h('button', { class: 'btn primary', onclick: integrateIntoDefault }, `Unisci in ${defaultBranch()}`)));
  }
  const stash = !s.files.length && currentStash();
  if (stash) banners.unshift(stashCard(stash));
  mount($('main'), h('div', { class: 'main-scroll' }, banners, items));
}

function banner(kind, title, text, action) {
  return h('div', { class: `banner ${kind}` }, h('div', { class: 'text' }, h('strong', null, title), h('span', null, text)), action);
}

async function doCommit(btn) {
  const paths = S.status.files.filter((f) => !S.excluded.has(f.path)).flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  const ok = await busy(btn, async () => {
    const sha = await api('git:commit', { paths, summary: S.draft.summary, description: S.draft.description });
    document.querySelectorAll('#toasts .toast.error').forEach((t) => t.remove());
    toast(`Commit ${sha} creato.`, { type: 'success' });
    return true;
  });
  if (ok) {
    S.draft = { summary: '', description: '' };
    S.excluded = new Set();
    S.selectedFile = null;
    S.selection = new Set();
    S.history = [];
    await refreshStatus();
  }
}

async function undoCommit() {
  const ok = await confirmDialog({ title: 'Annullare l\'ultimo commit?', message: 'Il commit verrà rimosso, ma le sue modifiche resteranno nei file e potrai rifare il commit.', confirm: 'Annulla commit' });
  if (!ok) return;
  const [last] = await api('git:log', { limit: 1 }).catch(() => []);
  await busy(null, async () => {
    await api('git:undoCommit');
    if (last) S.draft = { summary: last.subject, description: last.body };
    toast('Ultimo commit annullato: le modifiche sono di nuovo nell\'elenco.', { type: 'success' });
  });
  S.history = [];
  refreshStatus();
}

async function discardFiles(files) {
  if (!files.length) return;
  const done = await busy(null, () => api('git:discard', files));
  if (done) { toast('Modifiche scartate.'); refreshStatus(); }
}

// ------------------------------------------------------------------ rete

async function syncAction(btn) {
  if (btn.dataset.action === 'force-push') return forcePush(btn);
  if (btn.dataset.action === 'pull' && needsForcePush()) return forcePush(btn);
  if (S.status && S.status.state && btn.dataset.action !== 'fetch') return toast(`Completa o annulla prima il ${S.status.state === 'merging' ? 'merge' : 'rebase'} in corso.`, { type: 'error' });
  return runNet(btn.dataset.action || 'fetch', btn);
}

async function runNet(action, btn = $('tb-sync')) {
  const labels = { fetch: 'Fetch completato.', pull: 'Pull completato: il branch è aggiornato.', push: 'Push completato.' };
  let pullConflict = false;
  const ok = await busy(btn, async () => {
    if (action === 'pull') await api('git:fetch');
    try { await api(`git:${action}`); }
    catch (e) {
      if (action === 'pull') {
        const st = await api('git:status').catch(() => null);
        if (st && st.state === 'merging' && st.conflicts) { pullConflict = true; return false; }
      }
      throw e;
    }
    return true;
  });
  await refreshStatus();
  if (pullConflict) { switchTab('changes'); toast(`Il pull ha prodotto conflitti in ${S.status.conflicts} file: risolvili e completa il merge.`, { type: 'error', timeout: 0 }); return; }
  if (!ok) return;
  S.history = [];
  if (S.tab === 'history') loadHistory(true);
  if (action === 'push') {
    await refreshBranchMr();
    const b = S.status.branch;
    if (b !== defaultBranch() && workflow() === 'direct' && defaultBranch()) {
      toast(`Branch ${b} pubblicato.`, { type: 'success', timeout: 9000, action: { label: `Unisci in ${defaultBranch()}`, run: integrateIntoDefault } });
      return;
    }
    if (S.project && !S.branchMr && b !== S.project.defaultBranch) {
      toast(`Branch ${b} pubblicato.`, { type: 'success', timeout: 9000, action: { label: 'Crea merge request', run: openNewMr } });
      return;
    }
  }
  if (action === 'fetch' && S.status.behind) {
    toast(`Ci sono ${S.status.behind} commit nuovi sul server.`, { action: { label: 'Pull', run: () => runNet('pull') } });
    return;
  }
  toast(labels[action], { type: 'success' });
}

// ------------------------------------------------------------------ Cronologia

function selectCommit(sha) {
  if (S.selectedCommit !== sha) S.commitFile = null;
  S.selectedCommit = sha;
  renderHistory();
  const row = document.querySelector('#side-body .commit-row.selected');
  if (row) row.scrollIntoView({ block: 'nearest' });
}

function onHistoryKey(e) {
  if (S.tab !== 'history' || e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const list = S.compare ? S.compare.commits : S.history;
  if (!list.length) return;
  e.preventDefault();
  const i = list.findIndex((c) => c.sha === S.selectedCommit);
  const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
  selectCommit(next.sha);
}

function renderHistory() {
  mount($('side-foot'));
  const unpushed = new Set((S.status && S.status.unpushed) || []);
  const cmp = S.compare;
  const commits = cmp ? cmp.commits : S.history;
  mount($('side-body'),
    S.status && S.status.branch && compareBar(),
    cmp && cmp.counts && !commits.length && h('div', { class: 'list-head' }, cmp.view === 'behind' ? `Nessun commit da ricevere da ${cmp.branch}.` : `Nessun commit che ${cmp.branch} non abbia già.`),
    !cmp && !S.history.length && h('div', { class: 'list-head' }, S.historyDone ? 'Nessun commit' : 'Caricamento…'),
    commits.map((c) => h('div', {
      class: 'commit-row row' + (S.selectedCommit === c.sha ? ' selected' : ''),
      onclick: () => { selectCommit(c.sha); $('side-body').focus({ preventScroll: true }); },
    },
    h('div', { class: 'subject' }, c.subject),
    h('div', { class: 'meta' },
      h('span', null, c.author),
      h('span', { title: fullDate(c.date) }, ago(c.date)),
      h('span', { class: 'sha' }, c.short),
      unpushed.has(c.sha) && h('span', { class: 'badge-local' }, 'da pubblicare')))),
    !cmp && !S.historyDone && S.history.length > 0 && h('div', { style: 'padding:10px' },
      h('button', { class: 'btn small block', onclick: (e) => busy(e.currentTarget, () => loadHistory(false)) }, 'Carica commit precedenti')));

  const c = commits.find((x) => x.sha === S.selectedCommit);
  if (!c) {
    mount($('main'), cmp
      ? h('div', { class: 'empty' }, h('h1', null, `Confronto con ${cmp.branch}`),
        h('p', null, cmp.counts ? `${cmp.branch} ha ${cmp.counts.behind} commit che non hai, tu ne hai ${cmp.counts.ahead} che ${cmp.branch} non ha. Seleziona un commit per vederne le modifiche.` : 'Caricamento…'))
      : h('div', { class: 'empty' }, h('h1', null, 'Cronologia del branch'), h('p', null, 'Seleziona un commit per vedere autore, messaggio e modifiche.')));
    return;
  }
  renderCommitView(c);
}

// ----- dettaglio di un commit: intestazione, elenco dei file e diff del file scelto

const commitFilesCache = new Map();

function kindBadge(kind) {
  const letter = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', conflict: '!' }[kind] || 'M';
  const title = { added: 'Nuovo', deleted: 'Eliminato', modified: 'Modificato', renamed: 'Rinominato', conflict: 'In conflitto' }[kind];
  return h('span', { class: `kind ${kind}`, title }, letter);
}

function fileLabel(p) {
  const slash = p.lastIndexOf('/');
  return h('span', { class: 'file-name' }, h('bdi', null, h('span', { class: 'file-dir' }, slash >= 0 ? p.slice(0, slash + 1) : ''), p.slice(slash + 1)));
}

// Elenco di file a sinistra e diff del file scelto a destra (usato da cronologia e stash)
function filesDiffSplit({ files, headText, getDiff, selected, onSelect, storageKey = 'commitFilesWidth' }) {
  const filesList = h('div', { class: 'commit-files-list', tabindex: '0', role: 'listbox', 'aria-label': 'File modificati' });
  const diffHead = h('div', { class: 'commit-diff-head' });
  const diffBody = h('div', { class: 'commit-diff-body' });
  const handle = h('div', { class: 'split-handle', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0', title: 'Trascina per ridimensionare, doppio clic per ripristinare' });
  const el = h('div', { class: 'commit-split' },
    h('div', { class: 'commit-files' }, h('div', { class: 'commit-files-head' }, headText), filesList),
    handle,
    h('div', { class: 'commit-diff' }, diffHead, diffBody));
  let current = files.some((f) => f.path === selected) ? selected : (files[0] && files[0].path);
  let token = 0;

  const drawList = () => mount(filesList, files.map((f) => h('div', {
    class: 'row' + (f.path === current ? ' selected' : ''),
    role: 'option', 'aria-selected': String(f.path === current),
    title: f.origPath ? `${f.origPath} → ${f.path}` : f.path,
    onclick: () => select(f.path),
    oncontextmenu: (e) => { e.preventDefault(); select(f.path); api('clipboard:write', f.path).then(() => toast(`Percorso copiato: ${f.path}`)); },
  }, fileLabel(f.path), kindBadge(f.kind))));

  const showDiff = async (f) => {
    const my = ++token;
    mount(diffHead, h('span', { class: 'path' }, f.origPath ? `${f.origPath} → ${f.path}` : f.path));
    mount(diffBody, h('div', { class: 'diff-message' }, 'Caricamento…'));
    try {
      const d = await getDiff(f);
      if (my !== token) return;
      mount(diffBody, d.image ? renderImageDiff(d.image) : renderDiff(d, { showFileHeaders: false }));
      diffBody.scrollTop = 0;
    } catch (e) { if (my === token) mount(diffBody, h('div', { class: 'diff-message' }, e.message)); }
  };
  const select = (p) => {
    current = p;
    if (onSelect) onSelect(p);
    drawList();
    const row = filesList.querySelector('.row.selected');
    if (row) row.scrollIntoView({ block: 'nearest' });
    showDiff(files.find((f) => f.path === p));
  };
  filesList.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const i = files.findIndex((f) => f.path === current);
    const next = files[Math.max(0, Math.min(files.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) select(next.path);
  });
  const start = (container) => {
    attachResizer(handle, { cssVar: '--files-width', storageKey, def: 340, min: 200, max: () => Math.max(240, container.clientWidth - 320) });
    if (!files.length) { mount(diffBody, h('div', { class: 'diff-message' }, 'Nessun file modificato.')); return; }
    select(current);
  };
  return { el, start };
}

async function renderCommitView(c) {
  const main = $('main');
  const bodyLines = (c.body || '').split('\n');
  const longBody = bodyLines.length > 4 || (c.body || '').length > 400;
  const bodyEl = c.body && h('pre', { class: 'body' + (longBody ? ' clamped' : '') }, c.body);
  const copyBtn = h('button', {
    class: 'icon-btn', title: 'Copia l\'identificativo completo del commit', 'aria-label': 'Copia SHA',
    onclick: async () => { await api('clipboard:write', c.sha); copyBtn.textContent = '✓'; setTimeout(() => { copyBtn.textContent = '⧉'; }, 1200); },
  }, '⧉');
  const splitSlot = h('div', { class: 'commit-split' }, h('div', { class: 'diff-message', style: 'flex:1' }, 'Caricamento…'));

  mount(main, h('div', { class: 'commit-view' },
    h('div', { class: 'commit-head' },
      h('h2', null, c.subject),
      h('div', { class: 'meta' },
        h('span', { class: 'author', title: c.email }, c.author),
        h('span', { class: 'sep' }, '·'),
        h('span', { class: 'mono' }, c.short), copyBtn,
        h('span', { class: 'sep' }, '·'),
        h('span', { title: fullDate(c.date) }, `${fullDate(c.date)} (${ago(c.date)})`),
        S.project && h('button', { class: 'btn small', style: 'margin-left:auto', onclick: () => api('shell:open', `${S.project.webUrl}/-/commit/${c.sha}`) }, 'Apri su GitLab')),
      bodyEl,
      longBody && h('button', { class: 'link', style: 'margin-top:4px', onclick: (e) => { const open = bodyEl.classList.toggle('clamped'); e.target.textContent = open ? 'Mostra tutto' : 'Mostra meno'; } }, 'Mostra tutto')),
    splitSlot));

  let data = commitFilesCache.get(c.sha);
  if (!data) {
    try { data = await api('git:commitFiles', c.sha); } catch (e) { mount(splitSlot, h('div', { class: 'diff-message', style: 'flex:1' }, e.message)); return; }
    commitFilesCache.set(c.sha, data);
    if (commitFilesCache.size > 50) commitFilesCache.delete(commitFilesCache.keys().next().value);
  }
  if (S.selectedCommit !== c.sha) return;
  const n = data.files.length;
  const split = filesDiffSplit({
    files: data.files,
    headText: [`${n} file modificat${n === 1 ? 'o' : 'i'}`, data.isMerge && h('span', { class: 'sub', title: 'Per i commit di merge vengono mostrate le modifiche rispetto al primo genitore' }, ' · merge')],
    selected: S.commitFile,
    onSelect: (p) => { S.commitFile = p; },
    getDiff: (f) => api('git:commitFileDiff', { sha: c.sha, file: f }),
  });
  splitSlot.replaceWith(split.el);
  split.start(main);
}

function renderImageDiff({ before, after }) {
  const pane = (label, src, cls) => h('figure', { class: `img-pane ${cls}` },
    h('figcaption', null, label),
    src ? h('div', { class: 'img-frame' }, h('img', { src, alt: label })) : h('div', { class: 'img-frame empty' }, '—'));
  return h('div', { class: 'img-diff' },
    before && pane('Prima', before, 'before'),
    pane(before ? 'Dopo' : 'Nuova immagine', after, 'after'));
}

// Divisore trascinabile generico: aggiorna una variabile CSS e ricorda la larghezza
function attachResizer(handle, { cssVar, storageKey, def, min, max }) {
  const root = document.documentElement;
  const clamp = (w) => Math.round(Math.min(max(), Math.max(min, w)));
  const read = () => { try { const v = parseInt(localStorage.getItem(storageKey), 10); return Number.isFinite(v) ? v : def; } catch { return def; } };
  let width = clamp(read());
  const apply = (w, save) => {
    width = clamp(w);
    root.style.setProperty(cssVar, `${width}px`);
    if (save) { try { localStorage.setItem(storageKey, String(width)); } catch { /* ignora */ } }
  };
  apply(width, false);
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    const move = (ev) => apply(startW + ev.clientX - startX, false);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging');
      document.body.classList.remove('resizing');
      apply(width, true);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => apply(def, true));
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 50 : 10;
    if (e.key === 'ArrowLeft') { apply(width - step, true); e.preventDefault(); }
    if (e.key === 'ArrowRight') { apply(width + step, true); e.preventDefault(); }
  });
}

// ------------------------------------------------------------------ Merge request

function renderMrs() {
  const side = $('side-body');
  if (!S.project) {
    mount(side, h('div', { class: 'banner', style: 'margin:12px' }, h('div', { class: 'text' },
      h('strong', null, 'Merge request non disponibili'),
      h('span', null, S.projectError || 'Caricamento del progetto…'))),
    !S.settings.hasToken && h('div', { style: 'padding:0 12px' }, h('button', { class: 'btn block', onclick: () => openSettings() }, 'Apri impostazioni')));
    mount($('side-foot'));
    mount($('main'), h('div', { class: 'empty' }, h('h1', null, 'Collega il progetto GitLab'),
      h('p', null, 'Le merge request si leggono dal server GitLab indicato nelle impostazioni, usando il remote "origin" di questo repository.')));
    return;
  }
  const seg = (key, label) => h('button', { 'aria-pressed': String(S.mrFilter === key), onclick: () => { S.mrFilter = key; S.mrs = []; renderMrs(); loadMrs(); } }, label);
  mount(side,
    h('div', { class: 'segmented' }, seg('opened', 'Aperte'), seg('mine', 'Create da me'), seg('merged', 'Unite')),
    S.mrsError && h('div', { class: 'status-line err', style: 'margin:10px' }, S.mrsError),
    !S.mrsError && !S.mrs.length && h('div', { class: 'list-head' }, 'Nessuna merge request'),
    S.mrs.map((mr) => h('div', {
      class: 'mr-row row' + (S.mrView && S.mrView.iid === mr.iid ? ' selected' : ''),
      onclick: () => { S.mrView = { kind: 'detail', iid: mr.iid }; renderMrs(); },
    },
    h('div', { class: 'subject' }, mr.draft && h('span', { class: 'draft' }, 'Bozza '), mr.title.replace(/^(Draft:\s*|\[Draft\]\s*)/i, '')),
    h('div', { class: 'meta' },
      h('span', null, `!${mr.iid}`),
      h('span', null, mr.author && mr.author.name),
      h('span', { title: fullDate(mr.updated_at) }, ago(mr.updated_at))),
    h('div', { class: 'meta' }, h('span', { class: 'branch' }, `${mr.source_branch} → ${mr.target_branch}`)))));
  mount($('side-foot'), h('div', { style: 'padding:10px' }, h('button', { class: 'btn primary block', onclick: openNewMr }, 'Nuova merge request')));

  if (S.mrView && S.mrView.kind === 'new') renderNewMr();
  else if (S.mrView && S.mrView.kind === 'detail') renderMrDetail(S.mrView.iid);
  else mount($('main'), h('div', { class: 'empty' }, h('h1', null, 'Merge request del progetto'), h('p', null, `Seleziona una merge request di ${S.project.path} per vederne stato, pipeline e approvazioni.`)));
}

async function renderMrDetail(iid) {
  const main = $('main');
  mount(main, h('div', { class: 'diff-message' }, 'Caricamento…'));
  let mr;
  try { mr = await api('gl:mr', iid); } catch (e) { mount(main, h('div', { class: 'diff-message' }, e.message)); return; }
  if (!S.mrView || S.mrView.iid !== iid) return;
  const pipe = mr.head_pipeline || mr.pipeline;
  const appr = mr.approvals;
  const onBranch = S.status && S.status.branch === mr.source_branch;
  mount(main, h('div', { class: 'main-scroll' }, h('div', { class: 'mr-detail' },
    h('h2', null, mr.title),
    h('div', { class: 'mr-flow' }, h('span', null, `!${mr.iid}`), h('span', { class: 'b' }, mr.source_branch), '→', h('span', { class: 'b' }, mr.target_branch)),
    h('dl', { class: 'facts' },
      h('dt', null, 'Stato'), h('dd', null, h('span', { class: `state ${mr.state}` }, LABELS.mrState[mr.state] || mr.state), mr.draft ? ' (bozza)' : ''),
      mr.state === 'opened' && [h('dt', null, 'Merge'), h('dd', null, LABELS.merge[mr.detailed_merge_status] || mr.detailed_merge_status || mr.merge_status || '—')],
      h('dt', null, 'Pipeline'), h('dd', null, pipe ? h('span', { class: `state ${pipe.status}` }, LABELS.pipeline[pipe.status] || pipe.status) : 'Nessuna'),
      appr && [h('dt', null, 'Approvazioni'), h('dd', null,
        appr.approved_by && appr.approved_by.length ? appr.approved_by.map((a) => a.user.name).join(', ') : 'Nessuna',
        appr.approvals_left ? ` (ne mancano ${appr.approvals_left})` : '')],
      mr.reviewers && mr.reviewers.length > 0 && [h('dt', null, 'Revisori'), h('dd', null, mr.reviewers.map((r) => r.name).join(', '))],
      h('dt', null, 'Autore'), h('dd', null, mr.author.name),
      h('dt', null, 'Creata'), h('dd', null, fullDate(mr.created_at)),
      h('dt', null, 'Aggiornata'), h('dd', null, `${ago(mr.updated_at)}`),
      mr.user_notes_count > 0 && [h('dt', null, 'Commenti'), h('dd', null, String(mr.user_notes_count))]),
    mr.description ? h('pre', { class: 'mr-desc' }, mr.description) : null,
    h('div', { class: 'mr-actions' },
      h('button', { class: 'btn primary', onclick: () => api('shell:open', mr.web_url) }, 'Apri su GitLab'),
      pipe && pipe.web_url && h('button', { class: 'btn', onclick: () => api('shell:open', pipe.web_url) }, 'Apri pipeline'),
      mr.state === 'opened' && !onBranch && h('button', {
        class: 'btn',
        onclick: async (e) => {
          const ok = await busy(e.currentTarget, async () => { await api('git:fetch'); return true; });
          if (ok) switchBranch(`origin/${mr.source_branch}`, { remote: true });
        },
      }, 'Passa a questo branch')))));
}

// Nuova merge request -----------------------------------------------------

function openNewMr() {
  if (!S.repo) return toast('Apri prima un repository.');
  if (!S.project) return toast(S.projectError || 'Progetto GitLab non disponibile.', { type: 'error' });
  S.mrView = { kind: 'new' };
  if (S.tab !== 'mrs') switchTab('mrs'); else renderMrs();
}

async function renderNewMr() {
  const main = $('main');
  const s = S.status;
  const p = S.project;
  if (!s.branch || s.branch === p.defaultBranch) {
    mount(main, h('div', { class: 'empty' },
      h('h1', null, 'Serve un branch di lavoro'),
      h('p', null, `Una merge request porta le modifiche da un branch verso ${p.defaultBranch}. Crea un branch, fai i tuoi commit e torna qui.`),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => openNewBranch() }, 'Crea branch'))));
    return;
  }

  const form = {
    target: p.defaultBranch,
    title: '',
    description: '',
    descTouched: false,
    titleTouched: false,
    reviewers: [],
    assignMe: true,
    draft: false,
    removeSource: p.removeSourceBranchDefault,
    squash: ['default_on', 'always'].includes(p.squashOption),
  };

  const targetSel = h('select', { 'aria-label': 'Branch di destinazione' }, h('option', { value: p.defaultBranch }, p.defaultBranch));
  const titleIn = h('input', { type: 'text', maxlength: 255, oninput: (e) => { form.title = e.target.value; form.titleTouched = true; } });
  const descIn = h('textarea', { oninput: (e) => { form.description = e.target.value; form.descTouched = true; } });
  const chips = h('div', { class: 'chips' });
  const suggest = h('div', { class: 'suggest' });
  const reviewerIn = h('input', { type: 'search', placeholder: 'Cerca per nome o username' });
  const notes = h('div', { class: 'checks' });

  const renderChips = () => mount(chips, form.reviewers.map((u) => h('span', { class: 'chip' }, u.name,
    h('button', { 'aria-label': `Rimuovi ${u.name}`, onclick: () => { form.reviewers = form.reviewers.filter((x) => x.id !== u.id); renderChips(); } }, '✕'))));

  reviewerIn.addEventListener('input', debounce(async () => {
    const q = reviewerIn.value.trim();
    if (q.length < 2) { mount(suggest); return; }
    const users = await api('gl:members', q).catch(() => []);
    mount(suggest, users.filter((u) => !form.reviewers.some((r) => r.id === u.id) && (!S.me || u.id !== S.me.id)).map((u) => h('div', {
      class: 'row',
      onclick: () => { form.reviewers.push(u); renderChips(); reviewerIn.value = ''; mount(suggest); reviewerIn.focus(); },
    }, u.avatar && h('img', { class: 'avatar', src: u.avatar, alt: '' }), h('span', { class: 'grow' }, u.name, ' ', h('span', { class: 'sub' }, `@${u.username}`)))));
  }, 250));

  const check = (key, label) => h('label', null, h('input', { type: 'checkbox', checked: form[key], onchange: (e) => { form[key] = e.target.checked; } }), label);

  const humanize = (b) => {
    const t = b.replace(/^[^/]+\//, '').replace(/[-_]+/g, ' ').trim();
    return t.charAt(0).toUpperCase() + t.slice(1);
  };

  const fillFromCommits = async () => {
    const commits = await api('git:commitsBetween', form.target).catch(() => []);
    if (!form.titleTouched) {
      form.title = commits.length === 1 ? commits[0].subject : humanize(s.branch);
      titleIn.value = form.title;
    }
    if (!form.descTouched) {
      form.description = commits.length > 1 ? commits.slice().reverse().map((c) => `- ${c.subject}`).join('\n') + '\n' : (commits[0] && commits[0].body) || '';
      descIn.value = form.description;
    }
    const n = [];
    if (!s.upstream) n.push(h('div', { class: 'hint' }, `Il branch ${s.branch} verrà pubblicato sul server prima di creare la merge request.`));
    else if (s.ahead) n.push(h('div', { class: 'hint' }, `Prima di creare la merge request verranno pubblicati ${s.ahead} commit.`));
    if (s.files.length) n.push(h('div', { class: 'hint warn' }, `Hai ${s.files.length} file con modifiche non committate: non saranno incluse.`));
    if (!commits.length && s.upstream && !s.ahead) n.push(h('div', { class: 'hint warn' }, `Non risultano commit di differenza rispetto a origin/${form.target}. Fai un Fetch se il branch remoto è cambiato.`));
    mount(notes, n);
  };

  targetSel.addEventListener('change', () => { form.target = targetSel.value; fillFromCommits(); });

  const submit = h('button', { class: 'btn primary', onclick: (e) => createMr(e.currentTarget, form) }, 'Crea merge request');

  mount(main, h('div', { class: 'main-scroll' }, h('div', { class: 'form' },
    h('h2', null, 'Nuova merge request'),
    h('div', { class: 'field' },
      h('span', { class: 'label' }, 'Da quale branch, verso quale'),
      h('div', { class: 'flow-select' }, h('input', { type: 'text', value: s.branch, readonly: true, 'aria-label': 'Branch sorgente' }), h('span', { class: 'arrow' }, '→'), targetSel)),
    notes,
    h('div', { class: 'field' }, h('label', null, 'Titolo'), titleIn),
    h('div', { class: 'field' }, h('label', null, 'Descrizione'), descIn, h('span', { class: 'help' }, 'Supporta il Markdown di GitLab. Scrivi "Closes #123" per chiudere una issue al merge.')),
    h('div', { class: 'field' }, h('span', { class: 'label' }, 'Revisori'), chips, reviewerIn, suggest),
    h('div', { class: 'checks' },
      check('assignMe', 'Assegna a me'),
      check('draft', 'Segna come bozza (non ancora pronta per il merge)'),
      check('removeSource', 'Elimina il branch sorgente dopo il merge'),
      check('squash', 'Unisci i commit in uno solo al merge (squash)')),
    h('div', { class: 'mr-actions' }, submit, h('button', { class: 'btn', onclick: () => { S.mrView = null; renderMrs(); } }, 'Annulla')))));

  fillFromCommits();
  api('gl:branches').then((list) => {
    mount(targetSel, list.filter((b) => b.name !== s.branch)
      .sort((a, b) => (b.isDefault - a.isDefault) || a.name.localeCompare(b.name))
      .map((b) => h('option', { value: b.name, selected: b.name === form.target }, b.name + (b.protected ? '  (protetto)' : ''))));
  }).catch(() => {});
}

async function createMr(btn, form) {
  if (!form.title.trim()) return toast('Scrivi un titolo per la merge request.', { type: 'error' });
  const mr = await busy(btn, async () => {
    const s = await api('git:status');
    if (!s.upstream || s.ahead) await api('git:push');
    return api('gl:createMR', {
      sourceBranch: s.branch,
      targetBranch: form.target,
      title: form.title.trim(),
      description: form.description,
      draft: form.draft,
      removeSourceBranch: form.removeSource,
      squash: form.squash,
      assigneeIds: form.assignMe && S.me ? [S.me.id] : [],
      reviewerIds: form.reviewers.map((r) => r.id),
    });
  }, { errorPrefix: 'Merge request non creata.' });
  if (!mr) return;
  toast(`Merge request !${mr.iid} creata.`, { type: 'success', timeout: 9000, action: { label: 'Apri su GitLab', run: () => api('shell:open', mr.web_url) } });
  S.branchMr = mr;
  S.mrView = { kind: 'detail', iid: mr.iid };
  S.mrFilter = 'opened';
  await refreshStatus();
  loadMrs();
  renderMrs();
}

// =========================================================================== finestre

async function openRepoPicker(anchor) {
  const recent = await api('repo:recent');
  const filter = h('input', { type: 'search', class: 'filter', placeholder: 'Filtra repository' });
  const list = h('div');
  const draw = () => {
    const q = filter.value.toLowerCase();
    mount(list, recent.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)).map((r) => h('div', {
      class: 'row' + (S.repo && S.repo.path === r.path ? ' selected' : ''),
      onclick: () => { m.close(); openRecent(r); },
    },
    h('span', { class: 'grow' }, r.name, h('div', { class: 'sub' }, r.exists ? r.path : `Cartella non trovata: ${r.path}`)),
    h('span', { class: 'actions-right' }, h('button', {
      class: 'btn small', title: 'Rimuovi dall\'elenco',
      onclick: async (e) => { e.stopPropagation(); await api('repo:forget', r.path); recent.splice(recent.indexOf(r), 1); if (S.repo && S.repo.path === r.path) { S.repo = null; renderAll(); } draw(); },
    }, 'Rimuovi')))));
    if (!list.children.length) mount(list, h('div', { class: 'diff-message', style: 'padding:16px' }, 'Nessun repository in elenco.'));
  };
  filter.addEventListener('input', draw);
  draw();
  const m = modal({
    anchor, flush: true,
    body: [h('div', { style: 'padding-top:12px' }, filter), list],
    footer: [
      h('button', { class: 'btn', onclick: () => { m.close(); addLocalRepo(); } }, 'Aggiungi locale'),
      h('button', { class: 'btn primary', onclick: () => { m.close(); openClone(); } }, 'Clona'),
    ],
  });
}

async function openRecent(r) {
  if (!r.exists) return toast(`La cartella ${r.path} non esiste più. Rimuovila dall'elenco o clonala di nuovo.`, { type: 'error' });
  const info = await busy(null, () => api('repo:open', r.path));
  if (info) setRepo(info);
}

async function addLocalRepo() {
  const info = await busy(null, () => api('repo:pick'));
  if (info) setRepo(info);
}

async function openBranchPicker(anchor) {
  const data = await busy(null, () => api('git:branches'));
  if (!data) return;
  const localNames = new Set(data.local.map((b) => b.name));
  const remoteOnly = data.remote.filter((b) => !localNames.has(b.name.replace(/^[^/]+\//, '')));
  const filter = h('input', { type: 'search', class: 'filter', placeholder: 'Filtra branch' });
  const list = h('div');
  const go = async (name, remote) => {
    m.close();
    switchBranch(name, { remote });
  };
  const draw = () => {
    const q = filter.value.toLowerCase();
    const loc = data.local.filter((b) => b.name.toLowerCase().includes(q));
    const rem = remoteOnly.filter((b) => b.name.toLowerCase().includes(q));
    mount(list,
      loc.length > 0 && h('div', { class: 'group-label' }, 'Branch locali'),
      loc.map((b) => h('div', { class: 'row' + (b.current ? ' selected' : ''), onclick: () => !b.current && go(b.name, false) },
        h('span', { class: 'tick' }, b.current ? '✓' : ''),
        h('span', { class: 'grow mono' }, b.name),
        h('span', { class: 'sub' }, ago(b.date)),
        !b.current && h('span', { class: 'actions-right' }, h('button', {
          class: 'btn small danger', title: 'Elimina branch locale',
          onclick: async (e) => { e.stopPropagation(); const ok = await busy(null, () => api('git:deleteBranch', b.name)); if (ok) { data.local.splice(data.local.indexOf(b), 1); draw(); } },
        }, 'Elimina')))),
      rem.length > 0 && h('div', { class: 'group-label' }, 'Solo sul server'),
      rem.map((b) => h('div', { class: 'row', onclick: () => go(b.name, true) },
        h('span', { class: 'tick' }), h('span', { class: 'grow mono' }, b.name), h('span', { class: 'sub' }, ago(b.date)))));
  };
  filter.addEventListener('input', draw);
  draw();
  const m = modal({
    anchor, flush: true,
    body: [h('div', { style: 'padding-top:12px' }, filter), list],
    footer: [
      h('button', { class: 'btn', onclick: () => { m.close(); runNet('fetch'); } }, 'Aggiorna dal server'),
      h('button', { class: 'btn primary', onclick: () => { m.close(); openNewBranch(filter.value); } }, 'Nuovo branch'),
    ],
  });
  setTimeout(() => filter.focus(), 0);
}

function openNewBranch(initialName = '') {
  if (!S.repo) return;
  const s = S.status;
  const def = S.project ? S.project.defaultBranch : null;
  const name = h('input', { type: 'text', value: initialName.replace(/\s+/g, '-'), placeholder: 'es. feature/nuovo-report' });
  let from = def && s.branch === def ? 'default' : 'current';
  const radio = (value, label) => h('label', null, h('input', { type: 'radio', name: 'from', checked: from === value, onchange: () => { from = value; } }), label);
  const create = h('button', {
    class: 'btn primary',
    onclick: async () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      const r = await busy(create, async () => {
        let base;
        if (from === 'default' && def) { await api('git:fetch'); base = `origin/${def}`; }
        return api('git:createBranch', { name: n, from: base });
      });
      if (r) { m.close(); toast(`Branch ${r} creato. Ora puoi lavorarci.`, { type: 'success' }); refreshStatus(); }
    },
  }, 'Crea branch');
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create.click(); });
  const m = modal({
    title: 'Nuovo branch',
    body: [
      h('div', { class: 'field' }, h('label', null, 'Nome'), name, h('span', { class: 'help' }, 'Usa trattini al posto degli spazi. Molti team usano prefissi come feature/, fix/ o il numero della issue.')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Parti da'), h('div', { class: 'checks' },
        s.branch && radio('current', `Branch attuale (${s.branch})`),
        def && radio('default', `${def} aggiornato dal server (consigliato per un lavoro nuovo)`))),
      s.files.length > 0 && h('div', { class: 'status-line' }, `Le ${s.files.length} modifiche non committate verranno portate sul nuovo branch.`),
    ],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'), create],
  });
}

function openClone() {
  const configured = S.settings.gitlabUrl && S.settings.hasToken;
  let mode = configured ? 'projects' : 'url';
  let selected = null;
  let protocol = 'https';
  const search = h('input', { type: 'search', placeholder: 'Cerca tra i tuoi progetti' });
  const results = h('div', { class: 'suggest', style: 'max-height:240px' });
  const urlIn = h('input', { type: 'url', placeholder: 'https://gitlab.azienda.it/team/progetto.git' });
  const parentIn = h('input', { type: 'text', readonly: true, style: 'width:100%', value: localStorage.getItem('cloneParent') || '', placeholder: 'Scegli dove salvarlo' });
  const nameIn = h('input', { type: 'text', placeholder: 'Nome della cartella' });
  const protoWrap = h('div', { class: 'checks' });
  const pane = h('div', { class: 'field' });

  const effectiveUrl = () => (mode === 'url' ? urlIn.value.trim() : selected && (protocol === 'ssh' ? selected.sshUrl : selected.httpUrl));

  const doSearch = debounce(async () => {
    const list = await api('gl:searchProjects', search.value.trim()).catch((e) => { mount(results, h('div', { class: 'status-line err' }, e.message)); return null; });
    if (!list) return;
    mount(results, list.length ? list.map((p) => h('div', {
      class: 'row' + (selected && selected.id === p.id ? ' selected' : ''),
      onclick: () => { selected = p; nameIn.value = p.path.split('/').pop(); doSearch(); },
    }, h('span', { class: 'grow' }, p.name, h('div', { class: 'sub' }, p.path)), h('span', { class: 'sub' }, ago(p.lastActivity)))) : h('div', { class: 'diff-message', style: 'padding:14px' }, 'Nessun progetto trovato.'));
  }, 250);
  search.addEventListener('input', doSearch);
  urlIn.addEventListener('input', () => { const m = urlIn.value.trim().match(/([^/:]+?)(\.git)?\/?$/); if (m) nameIn.value = m[1]; });

  const drawPane = () => {
    mount(pane, mode === 'projects'
      ? [search, results]
      : [h('label', null, 'URL del repository'), urlIn]);
    mount(protoWrap, mode === 'projects' && ['https', 'ssh'].map((p) => h('label', null,
      h('input', { type: 'radio', name: 'proto', checked: protocol === p, onchange: () => { protocol = p; } }),
      p === 'https' ? 'HTTPS (usa il token delle impostazioni)' : 'SSH (usa la tua chiave SSH)')));
    tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.m === mode)));
    if (mode === 'projects') doSearch();
  };
  const tabs = h('div', { class: 'segmented', style: 'padding:0' },
    h('button', { dataset: { m: 'projects' }, disabled: !configured, onclick: () => { mode = 'projects'; drawPane(); } }, 'I miei progetti'),
    h('button', { dataset: { m: 'url' }, onclick: () => { mode = 'url'; drawPane(); } }, 'Da URL'));

  const cloneBtn = h('button', {
    class: 'btn primary',
    onclick: async () => {
      const url = effectiveUrl();
      if (!url) return toast('Scegli un progetto o inserisci un URL.', { type: 'error' });
      if (!parentIn.value) return toast('Scegli la cartella in cui clonare.', { type: 'error' });
      const info = await busy(cloneBtn, () => api('repo:clone', { url, parentDir: parentIn.value, name: nameIn.value.trim() }), { errorPrefix: 'Clonazione non riuscita.' });
      if (info) { m.close(); toast(`${info.name} clonato.`, { type: 'success' }); setRepo(info); }
    },
  }, 'Clona');

  const m = modal({
    title: 'Clona un repository',
    body: [
      tabs, pane, protoWrap,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Cartella di destinazione'),
        h('div', { class: 'inline' }, h('div', { style: 'flex:1' }, parentIn),
          h('button', { class: 'btn', onclick: async () => { const d = await api('dialog:pickFolder', 'Dove vuoi clonare il repository?'); if (d) { parentIn.value = d; localStorage.setItem('cloneParent', d); } } }, 'Scegli…'))),
      h('div', { class: 'field' }, h('label', null, 'Nome della cartella'), nameIn),
    ],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'), cloneBtn],
    width: 'min(620px, calc(100vw - 32px))',
  });
  drawPane();
}

function openSettings({ firstRun } = {}) {
  const st = S.settings;
  const urlIn = h('input', { type: 'url', value: st.gitlabUrl, placeholder: 'https://gitlab.azienda.it' });
  const tokenIn = h('input', { type: 'password', placeholder: st.hasToken ? 'Token salvato (lascia vuoto per non cambiarlo)' : 'glpat-…', autocomplete: 'off' });
  const useForGit = h('input', { type: 'checkbox', checked: st.useTokenForGit });
  const gitPath = h('input', { type: 'text', value: st.gitPath, placeholder: 'git (dal PATH di sistema)' });

  // Editor esterno: automatico, uno di quelli rilevati, oppure un programma a scelta
  const detected = st.detectedEditors || [];
  const isDetected = detected.some((e) => e.path === st.editorPath);
  const editorSel = h('select', null,
    h('option', { value: '' }, detected.length ? `Automatico (${detected[0].name})` : 'Automatico (nessun editor rilevato)'),
    detected.map((e) => h('option', { value: e.path, selected: st.editorPath === e.path }, e.name)),
    h('option', { value: '__custom', selected: !!st.editorPath && !isDetected }, 'Altro programma…'));
  const editorPath = h('input', { type: 'text', readonly: true, style: 'flex:1', value: st.editorPath && !isDetected ? st.editorPath : '', placeholder: 'Percorso del programma' });
  const editorPick = h('button', { class: 'btn', onclick: async () => { const f = await api('dialog:pickFile', 'Scegli il programma per aprire i file'); if (f) editorPath.value = f; } }, 'Scegli…');
  const customRow = h('div', { class: 'inline' }, editorPath, editorPick);
  const syncEditor = () => { customRow.hidden = editorSel.value !== '__custom'; };
  editorSel.addEventListener('change', syncEditor);
  syncEditor();
  const chosenEditor = () => (editorSel.value === '__custom' ? editorPath.value : editorSel.value);
  const result = h('div');

  const tokenLink = h('button', {
    class: 'link',
    onclick: () => {
      const base = urlIn.value.trim().replace(/\/+$/, '');
      if (!base) return urlIn.focus();
      const u = /^https?:\/\//.test(base) ? base : `https://${base}`;
      api('shell:open', `${u}/-/user_settings/personal_access_tokens?name=GitLab%20Desk&scopes=api,read_repository,write_repository`);
    },
  }, 'Crea un token su GitLab');

  const test = h('button', {
    class: 'btn',
    onclick: () => busy(test, async () => {
      try {
        const r = await api('settings:test', { gitlabUrl: urlIn.value.trim(), token: tokenIn.value.trim() || undefined });
        mount(result, h('div', { class: 'status-line ok' }, `Connesso come ${r.user.name} (@${r.user.username}).`,
          r.gitVersion ? ` ${r.gitVersion}.` : ' Attenzione: Git non è stato trovato sul sistema.'));
      } catch (e) { mount(result, h('div', { class: 'status-line err' }, e.message)); }
    }),
  }, 'Verifica connessione');

  const save = h('button', {
    class: 'btn primary',
    onclick: async () => {
      const saved = await busy(save, () => api('settings:save', {
        gitlabUrl: urlIn.value, token: tokenIn.value || undefined, useTokenForGit: useForGit.checked, gitPath: gitPath.value, editorPath: chosenEditor(),
      }));
      if (!saved) return;
      const changed = saved.gitlabUrl !== S.settings.gitlabUrl || tokenIn.value;
      S.settings = saved;
      m.close();
      toast('Impostazioni salvate.', { type: 'success' });
      if (S.repo && changed) {
        const info = await api('repo:open', S.repo.path).catch(() => null);
        if (info) { S.repo = info; S.project = null; S.me = null; loadProject(); }
      }
    },
  }, 'Salva');

  const m = modal({
    title: firstRun ? 'Collega il server GitLab aziendale' : 'Impostazioni',
    body: [
      firstRun && h('p', { style: 'margin:0;color:var(--muted)' }, 'Servono l\'indirizzo del server e un token personale. Il token viene salvato cifrato nel portachiavi del sistema.'),
      h('div', { class: 'field' }, h('label', null, 'Indirizzo del server GitLab'), urlIn),
      h('div', { class: 'field' }, h('label', null, 'Token di accesso personale'), tokenIn,
        h('span', { class: 'help' }, 'Scope necessari: api, read_repository, write_repository. ', tokenLink),
        st.hasToken && h('button', { class: 'link', style: 'align-self:flex-start', onclick: async () => { S.settings = await api('settings:save', { clearToken: true }); tokenIn.placeholder = 'glpat-…'; toast('Token rimosso.'); } }, 'Rimuovi il token salvato')),
      !st.encryptionAvailable && h('div', { class: 'status-line err' }, 'Il portachiavi di sistema non è disponibile: il token verrebbe salvato senza cifratura nella cartella dati dell\'app.'),
      h('div', { class: 'checks' }, h('label', null, useForGit, 'Usa il token anche per clone, pull e push via HTTPS')),
      h('div', { class: 'field' }, h('label', null, 'Editor per aprire i file'), editorSel, customRow,
        h('span', { class: 'help' }, 'Usato da "Apri in…" nel menu con il tasto destro sui file modificati.')),
      h('details', null, h('summary', { style: 'cursor:pointer;color:var(--muted)' }, 'Avanzate'),
        h('div', { class: 'field', style: 'margin-top:10px' }, h('label', null, 'Percorso di Git'), gitPath,
          h('span', { class: 'help' }, 'Lascia vuoto per usare quello installato nel sistema. Su Windows di solito è C:\\Program Files\\Git\\cmd\\git.exe'))),
      result,
    ],
    footer: [test, h('div', { style: 'flex:1' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'), save],
  });
}

// =========================================================================== branch: merge, rebase, stash, confronto

function currentBranch() { return S.status && S.status.branch; }
function defaultBranch() { return (S.project && S.project.defaultBranch) || S.localDefault || null; }

// Modo di lavoro per repository: 'mr' (merge request) o 'direct' (push diretto sul branch principale)
function workflow() {
  if (!S.repo) return 'mr';
  try { return localStorage.getItem(`workflow:${S.repo.path}`) || (S.project ? 'mr' : 'direct'); } catch { return 'mr'; }
}
function setWorkflow(mode) {
  try { localStorage.setItem(`workflow:${S.repo.path}`, mode); } catch { /* ignora */ }
  toast(mode === 'direct'
    ? `Modo di lavoro: push diretto su ${defaultBranch() || 'branch principale'}. Le merge request restano disponibili dal menu Branch.`
    : 'Modo di lavoro: con merge request.', { type: 'success' });
  renderAll();
}

// Il server ha detto che su questo branch non si può fare push?
function pushBlocked() {
  return !!(S.perms && S.status && S.perms.branch === S.status.branch && S.perms.exists && S.perms.canPush === false);
}

// Porta il branch attuale nel branch principale: aggiorna main, unisce, poi propone il push
async function integrateIntoDefault() {
  const cur = requireBranch();
  const def = defaultBranch();
  if (!cur) return;
  if (!def) return toast('Non riesco a capire qual è il branch principale del repository.', { type: 'error' });
  if (cur === def) return toast(`Sei già su ${def}.`);
  if (S.status.files.length) {
    const ok = await confirmDialog({ title: 'Modifiche in corso', message: `Hai modifiche non committate su ${cur}. Le accantono su ${cur} (stash) prima di continuare? Le ritroverai tornando su questo branch.`, confirm: 'Accantona e continua' });
    if (!ok || !(await stashAll())) return;
  }
  const ok = await confirmDialog({
    title: `Unire ${cur} in ${def}?`,
    message: `Passerai su ${def}, che verrà prima aggiornato dal server; poi ci verranno uniti i commit di ${cur}. Alla fine potrai controllare il risultato e fare push.`,
    confirm: `Unisci in ${def}`,
  });
  if (!ok) return;
  const r = await busy($('tb-sync'), async () => {
    await api('git:fetch');
    const { local } = await api('git:branches');
    await api('git:checkout', local.some((b) => b.name === def) ? { name: def } : { name: `origin/${def}`, remote: true });
    const st = await api('git:status');
    if (st.behind) await api('git:pull');
    return api('git:merge', { branch: cur });
  }, { errorPrefix: `Non è stato possibile unire ${cur} in ${def}.` });
  await refreshStatus();
  if (!r) return;
  switchTab('changes');
  if (r.conflicts) { toast(`Conflitti in ${r.count} file: risolvili e completa il merge, poi fai push.`, { type: 'error', timeout: 0 }); return; }
  if (r.upToDate) { toast(`${def} contiene già tutti i commit di ${cur}.`, { type: 'success' }); return; }
  toast(`${cur} unito in ${def}. Controlla e pubblica con Push.`, { type: 'success', timeout: 10000, action: { label: 'Push', run: () => runNet('push') } });
}

function syncMenuState() {
  if (!window.desk.setMenuState) return;
  const s = S.status;
  window.desk.setMenuState({
    hasRepo: !!S.repo,
    branch: s ? s.branch : null,
    defaultBranch: defaultBranch(),
    isDefault: !!(s && s.branch && s.branch === defaultBranch()),
    hasChanges: !!(s && s.files.length),
    inProgress: !!(s && s.state),
    published: !!(s && s.upstream),
    onGitlab: !!S.project,
    mrIid: S.branchMr ? S.branchMr.iid : null,
    workflow: workflow(),
  });
}

function requireBranch() {
  if (!S.repo || !S.status) { toast('Apri prima un repository.'); return null; }
  if (S.status.state) { toast(`C'è un ${S.status.state === 'merging' ? 'merge' : 'rebase'} in corso: completalo o annullalo prima.`, { type: 'error' }); return null; }
  if (!S.status.branch) { toast('Non sei su un branch.', { type: 'error' }); return null; }
  return S.status.branch;
}

// ----- push forzato dopo un rebase

const forceKey = () => `forcePush:${S.repo && S.repo.path}:${currentBranch()}`;
function needsForcePush() {
  const s = S.status;
  if (!s || !s.upstream || !s.ahead || !s.behind) return false;
  if (s.rebased) return true;
  try { return localStorage.getItem(forceKey()) === '1'; } catch { return false; }
}
function markForcePush(on) {
  try { if (on) localStorage.setItem(forceKey(), '1'); else localStorage.removeItem(forceKey()); } catch { /* ignora */ }
}

async function forcePush(btn) {
  const s = S.status;
  const ok = await confirmDialog({
    title: 'Push forzato',
    message: `Il branch ${s.branch} sul server verrà sostituito con la tua versione locale. Serve dopo un rebase. Se nel frattempo qualcun altro ha pubblicato commit su questo branch, il push si ferma e non perdi nulla.`,
    confirm: 'Forza il push',
    danger: true,
  });
  if (!ok) return;
  const done = await busy(btn, async () => { await api('git:forcePush'); return true; });
  if (done) { markForcePush(false); toast('Push forzato completato.', { type: 'success' }); }
  await refreshStatus();
}

// ----- stash

async function loadStashes() {
  S.stashes = await api('git:stashList').catch(() => []);
}

async function stashAll() {
  if (!S.status || !S.status.files.length) return toast('Non ci sono modifiche da accantonare.');
  const n = await busy(null, () => api('git:stash'));
  if (n) {
    toast(`${n} file accantonati. Li ritrovi nel pannello Modifiche, pronti da ripristinare.`, { type: 'success' });
    S.selection = new Set(); S.selectedFile = null;
    await refreshStatus();
  }
  return n;
}

// ----- merge o rebase in corso

async function prefillMergeMessage() {
  if (!S.status || S.draft.summary) return;
  const m = await api('git:pendingMessage').catch(() => null);
  if (m && m.summary && !S.draft.summary) {
    S.draft = { summary: m.kind === 'squash' && S.squashSource ? `Unisce ${S.squashSource} (squash)` : m.summary, description: m.kind === 'squash' ? '' : m.description };
    if (S.tab === 'changes') renderChanges({ keepMain: true });
  }
}

function inProgressBanner() {
  const s = S.status;
  if (!s || !s.state) return null;
  const conflicts = s.conflicts || 0;
  if (s.state === 'merging') {
    return h('div', { class: 'banner warn', style: 'margin:10px' }, h('div', { class: 'text' },
      h('strong', null, conflicts ? `Merge in corso: ${conflicts} file in conflitto` : 'Merge in corso: conflitti risolti'),
      h('span', null, conflicts
        ? 'Apri i file segnati con "!", scegli quale versione tenere, salva, poi clicca "Completa il merge".'
        : 'Controlla le modifiche e clicca "Completa il merge" per creare il commit.'),
      h('div', { class: 'inline', style: 'margin-top:8px' },
        conflicts > 0 && editorButton(s.files.filter((f) => f.conflict).map((f) => f.path)),
        h('button', { class: 'btn small danger', onclick: abortInProgress }, 'Annulla merge'))));
  }
  return h('div', { class: 'banner warn', style: 'margin:10px' }, h('div', { class: 'text' },
    h('strong', null, `Rebase di ${s.rebaseBranch || 'branch'} in corso${conflicts ? `: ${conflicts} file in conflitto` : ''}`),
    h('span', null, conflicts
      ? 'Risolvi i conflitti nei file segnati con "!", salva, poi clicca "Continua rebase".'
      : 'Clicca "Continua rebase" per procedere con i commit successivi.'),
    h('div', { class: 'inline', style: 'margin-top:8px' },
      h('button', { class: 'btn small primary', onclick: (e) => continueRebase(e.currentTarget) }, 'Continua rebase'),
      conflicts > 0 && editorButton(s.files.filter((f) => f.conflict).map((f) => f.path)),
      h('button', { class: 'btn small danger', onclick: abortInProgress }, 'Annulla rebase'))));
}

async function abortInProgress() {
  const what = S.status.state === 'merging' ? 'merge' : 'rebase';
  const ok = await confirmDialog({ title: `Annullare il ${what}?`, message: `Il branch torna com'era prima del ${what}. Le risoluzioni dei conflitti fatte finora andranno perse.`, confirm: `Annulla ${what}`, danger: true });
  if (!ok) return;
  const done = await busy(null, async () => { await api(what === 'merge' ? 'git:abortMerge' : 'git:rebaseAbort'); return true; });
  if (done) { S.draft = { summary: '', description: '' }; toast(`${what === 'merge' ? 'Merge' : 'Rebase'} annullato.`); await refreshStatus(); }
}

async function continueRebase(btn) {
  const r = await busy(btn, () => api('git:rebaseContinue'));
  if (!r) return;
  await refreshStatus();
  if (r.conflicts) toast(`Nuovi conflitti in ${r.count} file nel commit successivo: risolvili e continua.`, { type: 'error', timeout: 0 });
  else afterRebaseDone();
}

function afterRebaseDone() {
  const s = S.status;
  if (s.upstream && s.behind) {
    markForcePush(true);
    toast('Rebase completato. Il branch era già pubblicato: per aggiornarlo sul server serve un push forzato.', { type: 'success', timeout: 10000, action: { label: 'Push forzato', run: () => forcePush() } });
  } else {
    toast('Rebase completato.', { type: 'success' });
  }
  renderToolbar();
}

// ----- scelta del branch con anteprima (merge, squash, rebase, confronto)

async function pickBranch({ title, confirmLabel, preview, onConfirm, includeCurrent = false, initial }) {
  const data = await busy(null, () => api('git:branches'));
  if (!data) return;
  const cur = currentBranch();
  const items = [
    ...data.local.filter((b) => includeCurrent || b.name !== cur).map((b) => ({ ref: b.name, label: b.name, date: b.date, group: 'Branch locali' })),
    ...data.remote.map((b) => ({ ref: b.name, label: b.name, date: b.date, group: 'Sul server' })),
  ];
  let chosen = null;
  const filter = h('input', { type: 'search', class: 'filter', placeholder: 'Filtra branch' });
  const list = h('div', { class: 'pick-list' });
  const previewBox = h('div', { class: 'preview-box' }, h('span', { class: 'sub' }, 'Scegli un branch.'));
  const confirm = h('button', { class: 'btn primary', disabled: true, onclick: async () => { if (!chosen) return; const ok = await onConfirm(chosen, confirm); if (ok !== false) m.close(); } }, confirmLabel(null));
  let token = 0;
  const choose = async (it) => {
    chosen = it.ref;
    draw();
    confirm.textContent = confirmLabel(chosen);
    confirm.disabled = true;
    mount(previewBox, h('span', { class: 'sub' }, 'Verifica in corso…'));
    const my = ++token;
    try {
      const r = await preview(chosen);
      if (my !== token) return;
      mount(previewBox, r.node);
      confirm.disabled = !r.enabled;
    } catch (e) { if (my === token) mount(previewBox, h('div', { class: 'status-line err' }, e.message)); }
  };
  const draw = () => {
    const q = filter.value.toLowerCase();
    const shown = items.filter((it) => it.label.toLowerCase().includes(q));
    let group = null;
    mount(list, shown.flatMap((it) => {
      const out = [];
      if (it.group !== group) { group = it.group; out.push(h('div', { class: 'group-label' }, group)); }
      out.push(h('div', { class: 'row' + (chosen === it.ref ? ' selected' : ''), onclick: () => choose(it) },
        h('span', { class: 'tick' }, chosen === it.ref ? '✓' : ''), h('span', { class: 'grow mono' }, it.label), h('span', { class: 'sub' }, ago(it.date))));
      return out;
    }));
    if (!shown.length) mount(list, h('div', { class: 'diff-message', style: 'padding:14px' }, 'Nessun branch trovato.'));
  };
  filter.addEventListener('input', draw);
  filter.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = items.find((it) => it.label.toLowerCase().includes(filter.value.toLowerCase()));
    if (first && chosen !== first.ref) choose(first); else if (!confirm.disabled) confirm.click();
  });
  draw();
  const m = modal({
    title, flush: true,
    body: [h('div', { style: 'padding-top:4px' }, filter), list, previewBox],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'), confirm],
    width: 'min(560px, calc(100vw - 32px))',
  });
  const start = initial && items.find((it) => it.ref === initial);
  if (start) choose(start);
}

function dirtyNotice() {
  const n = S.status.files.length;
  if (!n) return null;
  const box = h('div', { class: 'status-line err' }, `Hai ${n} file con modifiche non committate. Accantonale o fai commit prima di continuare. `,
    h('button', { class: 'link', onclick: async (e) => { e.target.disabled = true; if (await stashAll()) { box.className = 'status-line ok'; box.textContent = 'Modifiche accantonate: ora puoi continuare. Selezionalo di nuovo per aggiornare l\'anteprima.'; } } }, 'Accantona le modifiche'));
  return box;
}

function openMerge({ squash = false, initial } = {}) {
  const cur = requireBranch();
  if (!cur) return;
  pickBranch({
    title: squash ? `Squash e unisci in ${cur}` : `Unisci in ${cur}`,
    initial: initial || (S.project && cur !== S.project.defaultBranch ? `origin/${S.project.defaultBranch}` : undefined),
    confirmLabel: (b) => (b ? `${squash ? 'Squash e unisci' : 'Unisci'} ${b} in ${cur}` : (squash ? 'Squash e unisci' : 'Unisci')),
    preview: async (b) => {
      const p = await api('git:mergePreview', b);
      const dirty = dirtyNotice();
      if (p.upToDate) return { node: h('div', { class: 'status-line ok' }, `${cur} contiene già tutti i commit di ${b}: non c'è niente da unire.`), enabled: false };
      const lines = [];
      const one = p.incoming === 1;
      lines.push(h('div', null, h('strong', null, `${p.incoming} commit`), ` di ${b} ${one ? 'verrà' : 'verranno'} ${squash ? (one ? 'aggiunto come un unico commit' : 'uniti in un unico commit') : (one ? 'unito' : 'uniti')} in ${cur}.`));
      if (p.conflicts === null) lines.push(h('div', { class: 'sub' }, 'Non è possibile prevedere i conflitti con questa versione di Git.'));
      else if (p.conflicts.length) {
        lines.push(h('div', { class: 'hint warn' }, `Ci saranno conflitti in ${p.conflicts.length} file: ${p.conflicts.slice(0, 4).join(', ')}${p.conflicts.length > 4 ? '…' : ''}. Potrai risolverli nell'editor prima di completare il merge.`));
      } else lines.push(h('div', { class: 'hint ok' }, p.fastForward && !squash ? 'Nessun conflitto: il branch avanzerà semplicemente fino a ' + b + '.' : 'Nessun conflitto previsto.'));
      if (dirty) lines.push(dirty);
      return { node: h('div', { class: 'checks' }, lines), enabled: true };
    },
    onConfirm: async (b, btn) => {
      if (S.status.files.length) { toast('Accantona o committa prima le modifiche in corso.', { type: 'error' }); return false; }
      if (b.startsWith('origin/')) await api('git:fetch').catch(() => {});
      const r = await busy(btn, () => api('git:merge', { branch: b, squash }));
      if (!r) return false;
      if (squash) S.squashSource = b;
      await refreshStatus();
      switchTab('changes');
      if (r.conflicts) toast(`Ci sono conflitti in ${r.count} file. Risolvili nei file segnati con "!" e poi completa il ${squash ? 'commit' : 'merge'}.`, { type: 'error', timeout: 0 });
      else if (squash) {
        const commits = await api('git:log', { limit: 50, range: `HEAD..${b}` }).catch(() => []);
        S.draft = { summary: `Unisce ${b} (squash)`, description: commits.reverse().map((c) => `- ${c.subject}`).join('\n') };
        renderChanges();
        toast('Modifiche pronte: controlla il messaggio e fai commit per completare lo squash.', { type: 'success', timeout: 8000 });
      } else toast(`${b} unito in ${cur}. Ricordati di fare push per pubblicare il risultato.`, { type: 'success', timeout: 7000, action: { label: 'Push', run: () => runNet('push') } });
      return true;
    },
  });
}

function openRebase() {
  const cur = requireBranch();
  if (!cur) return;
  pickBranch({
    title: `Rebase di ${cur}`,
    initial: S.project && cur !== S.project.defaultBranch ? `origin/${S.project.defaultBranch}` : undefined,
    confirmLabel: (b) => (b ? `Rebase su ${b}` : 'Rebase'),
    preview: async (b) => {
      const c = await api('git:compare', b);
      if (!c.behind) return { node: h('div', { class: 'status-line ok' }, `${cur} è già aggiornato rispetto a ${b}.`), enabled: false };
      const lines = [
        h('div', null, `${c.ahead === 1 ? 'Il tuo commit verrà riapplicato' : `I tuoi ${c.ahead} commit verranno riapplicati`} sopra ${c.behind === 1 ? 'il commit nuovo' : `i ${c.behind} commit nuovi`} di ${b}. La cronologia resta lineare, senza commit di merge.`),
      ];
      if (S.status.upstream) lines.push(h('div', { class: 'hint warn' }, 'Il branch è già pubblicato: dopo il rebase servirà un push forzato. Evitalo se altri colleghi lavorano su questo stesso branch.'));
      const dirty = dirtyNotice();
      if (dirty) lines.push(dirty);
      return { node: h('div', { class: 'checks' }, lines), enabled: true };
    },
    onConfirm: async (b, btn) => {
      if (S.status.files.length) { toast('Accantona o committa prima le modifiche in corso.', { type: 'error' }); return false; }
      if (b.startsWith('origin/')) await api('git:fetch').catch(() => {});
      const r = await busy(btn, () => api('git:rebase', b));
      if (!r) return false;
      await refreshStatus();
      switchTab('changes');
      if (r.conflicts) toast(`Conflitti in ${r.count} file durante il rebase: risolvili e clicca "Continua rebase".`, { type: 'error', timeout: 0 });
      else afterRebaseDone();
      return true;
    },
  });
}

async function updateFromDefault() {
  const cur = requireBranch();
  const def = defaultBranch();
  if (!cur || !def) return;
  if (cur === def) return toast(`Sei già su ${def}: usa Pull per aggiornarlo.`);
  if (S.status.files.length) {
    const ok = await confirmDialog({ title: 'Modifiche in corso', message: `Per aggiornare ${cur} da ${def} le modifiche non committate vanno messe da parte. Le accantono (stash)? Potrai ripristinarle subito dopo.`, confirm: 'Accantona e continua' });
    if (!ok || !(await stashAll())) return;
  }
  const r = await busy($('tb-sync'), async () => { await api('git:fetch'); return api('git:merge', { branch: `origin/${def}` }); });
  if (!r) return;
  await refreshStatus();
  if (r.conflicts) { switchTab('changes'); toast(`Conflitti in ${r.count} file con ${def}: risolvili e completa il merge.`, { type: 'error', timeout: 0 }); }
  else if (r.upToDate) toast(`${cur} è già aggiornato con ${def}.`, { type: 'success' });
  else toast(`${cur} aggiornato con le ultime modifiche di ${def}.`, { type: 'success', action: { label: 'Push', run: () => runNet('push') } });
}

// ----- rinomina ed elimina

function openRenameBranch() {
  const cur = requireBranch();
  if (!cur) return;
  const input = h('input', { type: 'text', value: cur });
  const save = h('button', {
    class: 'btn primary',
    onclick: async () => {
      const n = input.value.trim();
      if (!n || n === cur) return m.close();
      const r = await busy(save, () => api('git:renameBranch', { oldName: cur, newName: n }));
      if (!r) return;
      m.close();
      toast(r.wasPublished
        ? `Branch rinominato in ${r.name}. Sul server resta ${r.oldUpstream} con il vecchio nome: al prossimo push verrà pubblicato ${r.name}.`
        : `Branch rinominato in ${r.name}.`, { type: 'success', timeout: r.wasPublished ? 10000 : 4500 });
      await refreshStatus();
    },
  }, 'Rinomina');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  const m = modal({
    title: `Rinomina ${cur}`,
    body: [
      h('div', { class: 'field' }, h('label', null, 'Nuovo nome'), input),
      S.status.upstream && h('div', { class: 'status-line' }, 'Il branch è pubblicato: il rinomina vale solo sul tuo computer. Se esiste una merge request aperta, resta collegata al vecchio nome.'),
    ],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'), save],
  });
  setTimeout(() => input.select(), 0);
}

function openDeleteBranch() {
  const cur = requireBranch();
  if (!cur) return;
  const def = defaultBranch() || 'main';
  if (cur === def) return toast(`${def} è il branch principale del progetto: non si elimina da qui.`, { type: 'error' });
  const remote = h('input', { type: 'checkbox' });
  const del = h('button', {
    class: 'btn primary danger',
    onclick: async () => {
      const ok = await busy(del, () => api('git:deleteCurrentBranch', { name: cur, fallback: def, remote: remote.checked }));
      if (!ok) return;
      m.close();
      markForcePush(false);
      toast(`Branch ${cur} eliminato${remote.checked ? ' anche dal server' : ''}. Ora sei su ${def}.`, { type: 'success' });
      await refreshStatus();
    },
  }, 'Elimina');
  const m = modal({
    title: `Eliminare ${cur}?`,
    body: [
      h('p', { style: 'margin:0' }, `Passerai al branch ${def} e ${cur} verrà eliminato dal tuo computer.`),
      S.status.files.length > 0 && h('div', { class: 'status-line err' }, 'Hai modifiche non committate: fai commit, accantonale o scartale prima di eliminare il branch.'),
      S.status.upstream && h('div', { class: 'checks' }, h('label', null, remote, `Elimina anche ${S.status.upstream} dal server`)),
      S.status.ahead > 0 && h('div', { class: 'hint warn' }, `Attenzione: ${S.status.ahead} commit non sono mai stati pubblicati e andranno persi.`),
      !S.status.upstream && S.status.unpushed && S.status.unpushed.length > 0 && h('div', { class: 'hint warn' }, `Attenzione: il branch non è mai stato pubblicato, i suoi ${S.status.unpushed.length} commit andranno persi.`),
    ],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'), del],
  });
}

// ----- confronto con un altro branch (nella Cronologia)

function openCompare() {
  const cur = requireBranchLoose();
  if (!cur) return;
  pickBranch({
    title: `Confronta ${cur} con…`,
    confirmLabel: (b) => (b ? `Confronta con ${b}` : 'Confronta'),
    preview: async (b) => {
      const c = await api('git:compare', b);
      return { node: h('div', null, `${cur} ha ${c.ahead} commit che ${b} non ha, e ${b} ha ${c.behind} commit che ${cur} non ha.`), enabled: true };
    },
    onConfirm: async (b) => { await startCompare(b); return true; },
  });
}

function requireBranchLoose() {
  if (!S.repo || !S.status || !S.status.branch) { toast('Apri un repository e seleziona un branch.'); return null; }
  return S.status.branch;
}

async function startCompare(b, view) {
  S.compare = { branch: b, view: view || 'behind', counts: null, commits: [] };
  S.selectedCommit = null;
  if (S.tab !== 'history') switchTab('history');
  await loadCompare();
}

async function loadCompare() {
  const c = S.compare;
  if (!c) return;
  try {
    c.counts = await api('git:compare', c.branch);
    if (!c.counts[c.view === 'behind' ? 'behind' : 'ahead'] && c.counts[c.view === 'behind' ? 'ahead' : 'behind']) c.view = c.view === 'behind' ? 'ahead' : 'behind';
    c.commits = await api('git:log', { limit: 300, range: c.view === 'behind' ? `HEAD..${c.branch}` : `${c.branch}..HEAD` });
  } catch (e) { toast(e.message, { type: 'error' }); S.compare = null; }
  if (S.tab === 'history') renderHistory();
}

function compareBar() {
  const c = S.compare;
  const cur = currentBranch();
  if (!c) {
    return h('div', { class: 'compare-bar' }, h('button', { class: 'btn small block', onclick: openCompare }, 'Confronta con un branch…'));
  }
  const seg = (key, label) => h('button', { 'aria-pressed': String(c.view === key), onclick: () => { c.view = key; S.selectedCommit = null; loadCompare(); } }, label);
  return h('div', { class: 'compare-bar' },
    h('div', { class: 'inline' },
      h('span', { class: 'grow mono', title: c.branch }, `${cur} ↔ ${c.branch}`),
      h('button', { class: 'btn small', title: 'Chiudi il confronto', onclick: () => { S.compare = null; S.selectedCommit = null; renderHistory(); } }, '✕')),
    c.counts && h('div', { class: 'segmented', style: 'padding:8px 0 0;border:0' },
      seg('behind', `Da ricevere ↓${c.counts.behind}`),
      seg('ahead', `Solo qui ↑${c.counts.ahead}`)),
    c.counts && c.view === 'behind' && c.counts.behind > 0 && !S.status.state && h('button', {
      class: 'btn small primary block', style: 'margin-top:8px',
      onclick: () => openMerge({ initial: c.branch }),
    }, `Unisci ${c.branch} in ${cur}…`));
}


// =========================================================================== cambio branch e modifiche accantonate

function stashesForBranch(b = currentBranch()) {
  return (S.stashes || []).filter((x) => x.branch === b);
}
function currentStash() { return stashesForBranch()[0] || null; }

const stashDetailsCache = new Map();
async function stashDetails(st) {
  if (!stashDetailsCache.has(st.sha)) stashDetailsCache.set(st.sha, await api('git:stashDetails', st.sha));
  return stashDetailsCache.get(st.sha);
}

// Chiede cosa fare delle modifiche in corso prima di cambiare branch
function askSwitchChoice(from, to, count) {
  return new Promise((resolve) => {
    let choice = 'leave';
    let result = null;
    const option = (value, title, text) => h('label', { class: 'choice' + (choice === value ? ' checked' : '') },
      h('input', { type: 'radio', name: 'switch-choice', value, checked: choice === value, onchange: () => { choice = value; box.querySelectorAll('.choice').forEach((c) => c.classList.toggle('checked', c.querySelector('input').checked)); } }),
      h('span', null, h('strong', null, title), h('span', { class: 'sub' }, text)));
    const box = h('div', { class: 'choices' },
      option('leave', `Lascia le modifiche su ${from}`, 'Vengono accantonate su questo branch: le ritrovi quando ci torni.'),
      option('bring', `Porta le modifiche su ${to}`, 'Le modifiche in corso ti seguono sul nuovo branch.'));
    const go = h('button', { class: 'btn primary', onclick: () => { result = choice; m.close(); } }, 'Cambia branch');
    const m = modal({
      title: 'Cambia branch',
      body: [h('p', { style: 'margin:0' }, `Hai ${count === 1 ? 'un file modificato' : `${count} file modificati`} su ${from}. Cosa vuoi farne?`), box],
      footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'), go],
      onClose: () => resolve(result),
    });
    setTimeout(() => go.focus(), 0);
  });
}

async function switchBranch(name, { remote = false } = {}) {
  const s = S.status;
  if (!s) return;
  if (s.state) return toast(`Completa o annulla prima il ${s.state === 'merging' ? 'merge' : 'rebase'} in corso.`, { type: 'error' });
  const target = remote ? name.replace(/^[^/]+\//, '') : name;
  if (target === s.branch) return;
  let choice = null;
  if (s.files.length && s.branch) {
    choice = await askSwitchChoice(s.branch, target, s.files.length);
    if (!choice) return;
  }
  const from = s.branch;
  let stashed = false;
  const r = await busy($('tb-sync'), async () => {
    if (choice === 'leave') { await api('git:stash'); stashed = true; }
    try {
      return await api('git:checkout', { name, remote });
    } catch (e) {
      if (stashed) {
        // il cambio non è riuscito: rimetto le modifiche dov'erano
        const [st] = await api('git:stashList').catch(() => []);
        if (st && st.branch === from) await api('git:stashPop', st.ref).catch(() => {});
      }
      if (choice === 'bring' && /sovrascritte|overwritten/i.test(e.message)) {
        throw new Error(`Alcune modifiche toccano file che su ${target} sono diversi, quindi non possono essere portate sul nuovo branch. Riprova scegliendo "Lascia le modifiche su ${from}".`);
      }
      throw e;
    }
  });
  if (!r) { await refreshStatus(); return; }
  S.selection = new Set(); S.selectedFile = null; S.showStash = false;
  await refreshStatus();
  const waiting = currentStash();
  if (waiting) {
    toast(`Ora sei su ${r}. Qui hai delle modifiche accantonate.`, { type: 'success', timeout: 8000, action: { label: 'Visualizza', run: () => openStashView() } });
  } else {
    toast(stashed ? `Ora sei su ${r}. Le modifiche sono rimaste accantonate su ${from}.` : `Ora sei sul branch ${r}.`, { type: 'success' });
  }
}

function openStashView() {
  if (!currentStash()) return;
  S.showStash = true;
  S.selection = new Set(); S.selectedFile = null;
  if (S.tab !== 'changes') switchTab('changes'); else renderChanges();
}

function stashBar() {
  const list = stashesForBranch();
  if (!list.length) return null;
  return h('button', {
    class: 'stash-bar' + (S.showStash ? ' active' : ''),
    title: 'Mostra le modifiche accantonate su questo branch',
    onclick: () => { if (S.showStash) { S.showStash = false; renderChanges(); } else openStashView(); },
  },
  h('svg', { viewBox: '0 0 16 16', width: '15', height: '15', 'aria-hidden': 'true' },
    h('path', { fill: 'currentColor', d: 'M2 3.5A1.5 1.5 0 013.5 2h9A1.5 1.5 0 0114 3.5v2a.5.5 0 01-.5.5H13v6.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 013 12.5V6h-.5a.5.5 0 01-.5-.5v-2zM4 6v6.5a.5.5 0 00.5.5h7a.5.5 0 00.5-.5V6H4zm2 1.5h4v1H6v-1zM3.5 3a.5.5 0 00-.5.5V5h10V3.5a.5.5 0 00-.5-.5h-9z' })),
  h('span', { class: 'grow' }, 'Modifiche accantonate'),
  list.length > 1 && h('span', { class: 'count' }, String(list.length)),
  h('span', { class: 'chev' }, '›'));
}

function stashCard(st) {
  const text = h('span', null, 'Hai delle modifiche in corso che non hai ancora committato.');
  stashDetails(st).then((d) => { text.textContent = `Hai ${d.files.length === 1 ? 'una modifica' : `${d.files.length} modifiche`} in corso che non hai ancora committato.`; }).catch(() => {});
  return h('div', { class: 'banner accent', style: 'margin:16px' },
    h('div', { class: 'text' }, h('strong', null, 'Visualizza le modifiche accantonate'), text,
      h('span', { class: 'sub', style: 'display:block;margin-top:4px' }, 'Le trovi anche in fondo al pannello Modifiche, a sinistra.')),
    h('button', { class: 'btn primary', onclick: openStashView }, 'Visualizza'));
}

async function renderStashView(st) {
  const main = $('main');
  const list = stashesForBranch();
  const slot = h('div', { class: 'commit-split' }, h('div', { class: 'diff-message', style: 'flex:1' }, 'Caricamento…'));
  const dirty = S.status.files.length;
  const restore = h('button', {
    class: 'btn primary',
    title: dirty ? 'Hai altre modifiche in corso: fai commit o accantonale prima di ripristinare' : '',
    onclick: (e) => busy(e.currentTarget, async () => {
      if (S.status.files.length) {
        const ok = await confirmDialog({ title: 'Ripristinare le modifiche?', message: 'Hai già altre modifiche in corso: Git proverà a unirle a quelle accantonate. Se toccano gli stessi file potresti dover risolvere dei conflitti.', confirm: 'Ripristina' });
        if (!ok) return;
      }
      const r = await api('git:stashPop', st.ref);
      S.showStash = false;
      stashDetailsCache.delete(st.sha);
      toast(r.conflicts ? 'Modifiche ripristinate con conflitti: risolvili nei file segnati con "!".' : 'Modifiche ripristinate.', { type: r.conflicts ? 'error' : 'success', timeout: r.conflicts ? 0 : 4500 });
      await refreshStatus();
    }),
  }, 'Ripristina');
  const discard = h('button', {
    class: 'btn danger',
    onclick: async () => {
      const ok = await confirmDialog({ title: 'Eliminare le modifiche accantonate?', message: 'Le modifiche accantonate verranno cancellate definitivamente.', confirm: 'Elimina', danger: true });
      if (!ok) return;
      if (await busy(discard, async () => { await api('git:stashDrop', st.ref); return true; })) {
        stashDetailsCache.delete(st.sha);
        toast('Modifiche accantonate eliminate.');
        if (!stashesForBranch().filter((x) => x.sha !== st.sha).length) S.showStash = false;
        await refreshStatus();
      }
    },
  }, 'Elimina');
  const picker = list.length > 1 && h('select', {
    'aria-label': 'Scegli quale accantonamento vedere',
    onchange: (e) => { const chosen = list.find((x) => x.sha === e.target.value); if (chosen) renderStashView(chosen); },
  }, list.map((x, i) => h('option', { value: x.sha, selected: x.sha === st.sha }, `${i === 0 ? 'Più recente' : `#${i + 1}`} — ${fullDate(x.date)}`)));

  mount(main, h('div', { class: 'commit-view' },
    h('div', { class: 'commit-head' },
      h('h2', null, 'Modifiche accantonate'),
      h('div', { class: 'meta' },
        h('span', null, `Su ${st.branch}`), h('span', { class: 'sep' }, '·'),
        h('span', { title: fullDate(st.date) }, `${fullDate(st.date)} (${ago(st.date)})`),
        picker && [h('span', { class: 'sep' }, '·'), picker],
        h('span', { class: 'inline', style: 'margin-left:auto' }, restore, discard)),
      dirty > 0 && h('div', { class: 'hint warn', style: 'margin-top:6px' }, `Hai anche ${dirty} file con modifiche in corso: se ripristini, verranno unite a quelle accantonate.`)),
    slot));

  let d;
  try { d = await stashDetails(st); } catch (e) { mount(slot, h('div', { class: 'diff-message', style: 'flex:1' }, e.message)); return; }
  if (!S.showStash) return;
  const n = d.files.length;
  const split = filesDiffSplit({
    files: d.files,
    headText: `${n} file accantonat${n === 1 ? 'o' : 'i'}`,
    selected: S.stashFile,
    onSelect: (p) => { S.stashFile = p; },
    getDiff: (f) => api('git:stashFileDiff', { sha: st.sha, file: f }),
  });
  slot.replaceWith(split.el);
  split.start(main);
}

init().catch((e) => toast(`Avvio non riuscito: ${e.message}`, { type: 'error', timeout: 0 }));
