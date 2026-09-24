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
  selectedFile: null,
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

  window.desk.on('app:focus', debounce(() => { if (S.repo) refreshStatus(); }, 300));
  window.desk.on('menu', (cmd) => {
    const needRepo = ['fetch', 'pull', 'push', 'new-branch', 'new-mr', 'reveal', 'open-gitlab'];
    if (needRepo.includes(cmd) && !S.repo) return toast('Apri prima un repository.');
    ({
      'add-repo': addLocalRepo,
      clone: openClone,
      settings: () => openSettings(),
      fetch: () => runNet('fetch'),
      pull: () => runNet('pull'),
      push: () => runNet('push'),
      'new-branch': () => openNewBranch(),
      'new-mr': openNewMr,
      reveal: () => api('repo:reveal'),
      'open-gitlab': () => (S.project ? api('shell:open', S.project.webUrl) : toast(S.projectError || 'Progetto GitLab non disponibile.')),
    })[cmd]?.();
  });
}

async function setRepo(info) {
  Object.assign(S, {
    repo: info, status: null, selectedFile: null, excluded: new Set(), draft: { summary: '', description: '' },
    history: [], historyDone: false, selectedCommit: null, project: null, projectError: null,
    branchMr: null, mrs: [], mrView: null, mrsError: null,
  });
  renderAll();
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
    S.status = await api('git:status');
    const paths = new Set(S.status.files.map((f) => f.path));
    for (const p of [...S.excluded]) if (!paths.has(p)) S.excluded.delete(p);
    if (S.selectedFile && !paths.has(S.selectedFile)) S.selectedFile = null;
    if (prevBranch !== undefined && prevBranch !== S.status.branch) {
      S.branchMr = null;
      S.history = []; S.historyDone = false; S.selectedCommit = null;
      if (S.tab === 'history') loadHistory(true);
      refreshBranchMr();
    }
  } catch (e) {
    toast(e.message, { type: 'error', timeout: 0 });
  }
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
  $('tb-branch-name').textContent = !s ? '—' : s.branch || `HEAD staccato (${(s.oid || '').slice(0, 7)})`;

  const route = $('route');
  const sync = $('tb-sync');
  const mrBtn = $('tb-mr');
  route.hidden = !s || !s.branch;
  sync.disabled = !S.repo || !S.repo.remoteUrl;
  if (!s) { sync.textContent = 'Fetch'; mrBtn.hidden = true; return; }

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
    if (s.behind) { sync.textContent = `Pull ↓${s.behind}`; sync.dataset.action = 'pull'; }
    else if (s.ahead) { sync.textContent = `Push ↑${s.ahead}`; sync.dataset.action = 'push'; }
    else { sync.textContent = 'Fetch'; sync.dataset.action = 'fetch'; }
  }
  $('route-end').textContent = s.upstream || 'origin';

  const canMr = S.project && s.branch && s.branch !== S.project.defaultBranch;
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

function renderChanges() {
  const side = $('side-body');
  const foot = $('side-foot');
  const s = S.status;
  if (!s) { mount(side); mount(foot); mount($('main')); return; }

  const files = s.files;
  const included = files.filter((f) => !S.excluded.has(f.path));
  const allBox = h('input', {
    type: 'checkbox', 'aria-label': 'Includi tutti i file',
    checked: files.length > 0 && included.length === files.length,
    onchange: (e) => { S.excluded = e.target.checked ? new Set() : new Set(files.map((f) => f.path)); renderChanges(); },
  });
  allBox.indeterminate = included.length > 0 && included.length < files.length;

  mount(side,
    s.state && h('div', { class: 'banner warn', style: 'margin:10px' },
      h('div', { class: 'text' },
        h('strong', null, s.state === 'merging' ? 'Merge in corso' : 'Rebase in corso'),
        h('span', null, 'Risolvi i file in conflitto nel tuo editor, poi fai commit.'))),
    h('div', { class: 'list-head' },
      files.length > 0 && allBox,
      h('span', { class: 'grow' }, files.length ? `${files.length} file modificat${files.length === 1 ? 'o' : 'i'}` : 'Nessuna modifica'),
      files.length > 0 && h('button', { class: 'link', onclick: () => discardFiles(files) }, 'Scarta tutto')),
    files.map((f) => fileRow(f)));

  // Box di commit
  const onDefault = S.project && s.branch === S.project.defaultBranch;
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
    s.branch ? `Commit su ${s.branch}` : 'Commit');

  mount(foot, h('div', { class: 'commit-box' },
    onDefault && h('div', { class: 'hint warn' },
      `Sei su ${s.branch}: per una merge request serve un branch di lavoro. `,
      h('button', { class: 'link', onclick: () => openNewBranch() }, 'Crea branch')),
    summary, desc, commitBtn,
    s.unpushed && s.unpushed.length > 0 && h('div', { class: 'hint' },
      h('button', { class: 'link', onclick: undoCommit }, 'Annulla ultimo commit'),
      ' (non ancora pubblicato)')));

  // Pannello principale
  const file = files.find((f) => f.path === S.selectedFile);
  if (file) renderFileDiff(file);
  else renderChangesOverview();
}

function fileRow(f) {
  const letter = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R', conflict: '!' }[f.kind] || 'M';
  const title = { added: 'Nuovo', deleted: 'Eliminato', modified: 'Modificato', renamed: 'Rinominato', conflict: 'In conflitto' }[f.kind];
  const slash = f.path.lastIndexOf('/');
  const dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
  const base = f.path.slice(slash + 1);
  return h('div', {
    class: 'row' + (S.selectedFile === f.path ? ' selected' : ''),
    title: f.origPath ? `${f.origPath} → ${f.path}` : f.path,
    onclick: (e) => { if (e.target.tagName === 'INPUT') return; S.selectedFile = f.path; renderChanges(); },
    oncontextmenu: (e) => { e.preventDefault(); discardFiles([f]); },
  },
  h('input', {
    type: 'checkbox', 'aria-label': `Includi ${f.path}`, checked: !S.excluded.has(f.path),
    onchange: (e) => { if (e.target.checked) S.excluded.delete(f.path); else S.excluded.add(f.path); renderChanges(); },
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
      h('button', { class: 'btn small danger', onclick: () => discardFiles([file]) }, 'Scarta modifiche')),
    body);
  try {
    const d = await api('git:diff', file);
    if (S.selectedFile !== file.path) return;
    mount(body, renderDiff(d, { showFileHeaders: false }));
  } catch (e) { mount(body, h('div', { class: 'diff-message' }, e.message)); }
}

function renderChangesOverview() {
  const s = S.status;
  const items = [];
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
    banners.push(banner('accent', 'Il branch non è ancora sul server', 'Pubblicalo per condividerlo e aprire una merge request.',
      h('button', { class: 'btn primary', onclick: (e) => runNet('push', e.currentTarget) }, 'Pubblica branch')));
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
  } else if (S.project && s.branch && s.upstream && s.branch !== S.project.defaultBranch && !s.ahead) {
    banners.push(banner('accent', 'Pronto per la revisione?', `Apri una merge request da ${s.branch} verso ${S.project.defaultBranch}.`,
      h('button', { class: 'btn primary', onclick: openNewMr }, 'Crea merge request')));
  }
  mount($('main'), h('div', { class: 'main-scroll' }, banners, items));
}

function banner(kind, title, text, action) {
  return h('div', { class: `banner ${kind}` }, h('div', { class: 'text' }, h('strong', null, title), h('span', null, text)), action);
}

async function doCommit(btn) {
  const paths = S.status.files.filter((f) => !S.excluded.has(f.path)).flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
  const ok = await busy(btn, async () => {
    const sha = await api('git:commit', { paths, summary: S.draft.summary, description: S.draft.description });
    toast(`Commit ${sha} creato.`, { type: 'success' });
    return true;
  });
  if (ok) {
    S.draft = { summary: '', description: '' };
    S.excluded = new Set();
    S.selectedFile = null;
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

async function syncAction(btn) { runNet(btn.dataset.action || 'fetch', btn); }

async function runNet(action, btn = $('tb-sync')) {
  const labels = { fetch: 'Fetch completato.', pull: 'Pull completato: il branch è aggiornato.', push: 'Push completato.' };
  const ok = await busy(btn, async () => {
    if (action === 'pull') await api('git:fetch');
    await api(`git:${action}`);
    return true;
  });
  await refreshStatus();
  if (!ok) return;
  S.history = [];
  if (S.tab === 'history') loadHistory(true);
  if (action === 'push') {
    await refreshBranchMr();
    const b = S.status.branch;
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

function renderHistory() {
  mount($('side-foot'));
  const unpushed = new Set((S.status && S.status.unpushed) || []);
  mount($('side-body'),
    !S.history.length && h('div', { class: 'list-head' }, S.historyDone ? 'Nessun commit' : 'Caricamento…'),
    S.history.map((c) => h('div', {
      class: 'commit-row row' + (S.selectedCommit === c.sha ? ' selected' : ''),
      onclick: () => { S.selectedCommit = c.sha; renderHistory(); },
    },
    h('div', { class: 'subject' }, c.subject),
    h('div', { class: 'meta' },
      h('span', null, c.author),
      h('span', { title: fullDate(c.date) }, ago(c.date)),
      h('span', { class: 'sha' }, c.short),
      unpushed.has(c.sha) && h('span', { class: 'badge-local' }, 'da pubblicare')))),
    !S.historyDone && S.history.length > 0 && h('div', { style: 'padding:10px' },
      h('button', { class: 'btn small block', onclick: (e) => busy(e.currentTarget, () => loadHistory(false)) }, 'Carica commit precedenti')));

  const c = S.history.find((x) => x.sha === S.selectedCommit);
  if (!c) {
    mount($('main'), h('div', { class: 'empty' }, h('h1', null, 'Cronologia del branch'), h('p', null, 'Seleziona un commit per vedere autore, messaggio e modifiche.')));
    return;
  }
  const body = h('div', null, h('div', { class: 'diff-message' }, 'Caricamento…'));
  mount($('main'), h('div', { class: 'main-scroll' },
    h('div', { class: 'commit-detail' },
      h('h2', null, c.subject),
      h('div', { class: 'meta' }, `${c.author} <${c.email}>, ${fullDate(c.date)} — `, h('span', { class: 'mono' }, c.sha)),
      c.body && h('pre', { class: 'body' }, c.body),
      S.project && h('div', { style: 'margin-top:10px' },
        h('button', { class: 'btn small', onclick: () => api('shell:open', `${S.project.webUrl}/-/commit/${c.sha}`) }, 'Apri su GitLab'))),
    body));
  api('git:show', c.sha).then((d) => { if (S.selectedCommit === c.sha) mount(body, renderDiff(d)); })
    .catch((e) => mount(body, h('div', { class: 'diff-message' }, e.message)));
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
        onclick: (e) => busy(e.currentTarget, async () => {
          await api('git:fetch');
          await api('git:checkout', { name: `origin/${mr.source_branch}`, remote: true });
          toast(`Ora sei sul branch ${mr.source_branch}.`, { type: 'success' });
          await refreshStatus();
        }),
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
    const r = await busy(null, () => api('git:checkout', { name, remote }));
    if (r) { toast(`Ora sei sul branch ${r}.`, { type: 'success' }); refreshStatus(); }
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
        gitlabUrl: urlIn.value, token: tokenIn.value || undefined, useTokenForGit: useForGit.checked, gitPath: gitPath.value,
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
      h('details', null, h('summary', { style: 'cursor:pointer;color:var(--muted)' }, 'Avanzate'),
        h('div', { class: 'field', style: 'margin-top:10px' }, h('label', null, 'Percorso di Git'), gitPath,
          h('span', { class: 'help' }, 'Lascia vuoto per usare quello installato nel sistema. Su Windows di solito è C:\\Program Files\\Git\\cmd\\git.exe'))),
      result,
    ],
    footer: [test, h('div', { style: 'flex:1' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'), save],
  });
}

init().catch((e) => toast(`Avvio non riuscito: ${e.message}`, { type: 'error', timeout: 0 }));
