'use strict';
// Test dei moduli Git e GitLab senza Electron: `npm test`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');
const { parseRemote, matchesInstance, GitLab } = require('../src/gitlab');
const gi = require('../src/gitignore');

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; }
}

(async () => {
  console.log('Parsing URL remoti');
  await t('https', () => assert.deepStrictEqual(parseRemote('https://gitlab.azienda.it/team/sub/app.git'), { host: 'gitlab.azienda.it', path: 'team/sub/app', protocol: 'https' }));
  await t('https con utente', () => assert.strictEqual(parseRemote('https://mario@gitlab.azienda.it/team/app').path, 'team/app'));
  await t('https con prefisso', () => assert.strictEqual(parseRemote('https://srv.it/gitlab/team/app.git', 'https://srv.it/gitlab').path, 'team/app'));
  await t('scp ssh', () => assert.deepStrictEqual(parseRemote('git@gitlab.azienda.it:team/app.git'), { host: 'gitlab.azienda.it', path: 'team/app', protocol: 'ssh' }));
  await t('ssh con porta', () => assert.strictEqual(parseRemote('ssh://git@gitlab.azienda.it:2222/team/app.git').path, 'team/app'));
  await t('host corrispondente', () => assert.ok(matchesInstance(parseRemote('git@gitlab.azienda.it:a/b.git'), 'gitlab.azienda.it')));
  await t('host diverso', () => assert.ok(!matchesInstance(parseRemote('git@github.com:a/b.git'), 'https://gitlab.azienda.it')));

  console.log('Client GitLab (fetch simulato)');
  await t('richiesta con token e query', async () => {
    let seen;
    const gl = new GitLab({ baseUrl: 'gitlab.azienda.it/', token: 'glpat-x', fetchImpl: async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, text: async () => '[]' }; } });
    await gl.listMergeRequests(42, { sourceBranch: 'feat/a' });
    assert.ok(seen.url.startsWith('https://gitlab.azienda.it/api/v4/projects/42/merge_requests?'));
    assert.ok(seen.url.includes('source_branch=feat%2Fa'));
    assert.strictEqual(seen.opts.headers['PRIVATE-TOKEN'], 'glpat-x');
  });
  await t('draft e errore 409', async () => {
    let body;
    const gl = new GitLab({ baseUrl: 'https://g.it', token: 't', fetchImpl: async (u, o) => { body = JSON.parse(o.body); return { ok: false, status: 409, text: async () => '{"message":["Another open merge request already exists for this source branch"]}' }; } });
    await assert.rejects(gl.createMergeRequest(1, { sourceBranch: 'a', targetBranch: 'main', title: 'Prova', draft: true }), /Esiste già/);
    assert.strictEqual(body.title, 'Draft: Prova');
  });

  console.log('Operazioni Git su repository temporaneo');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const bare = path.join(tmp, 'remote.git');
  const repo = path.join(tmp, 'work');
  await git.run(tmp, ['init', '-q', '--bare', '-b', 'main', bare]);
  await git.run(tmp, ['init', '-q', '-b', 'main', repo]);
  await git.run(repo, ['config', 'user.name', 'Test']);
  await git.run(repo, ['config', 'user.email', 't@t.it']);
  await git.run(repo, ['remote', 'add', 'origin', bare]);

  await t('status repo vuoto', async () => {
    fs.writeFileSync(path.join(repo, 'leggimi.md'), 'ciao\n');
    fs.writeFileSync(path.join(repo, 'file con spazi.txt'), 'x\n');
    const s = await git.status(repo);
    assert.strictEqual(s.branch, 'main');
    assert.strictEqual(s.hasHead, false);
    assert.strictEqual(s.files.length, 2);
    assert.ok(s.files.every((f) => f.untracked));
  });
  await t('diff file nuovo', async () => {
    const d = await git.fileDiff(repo, { path: 'leggimi.md', untracked: true });
    assert.ok(d.patch.includes('+ciao'));
  });
  await t('primo commit solo file selezionato', async () => {
    await git.commit(repo, { paths: ['leggimi.md'], summary: 'Primo commit' });
    const s = await git.status(repo);
    assert.strictEqual(s.files.length, 1);
    assert.strictEqual(s.files[0].path, 'file con spazi.txt');
  });
  await t('push pubblica il branch', async () => {
    await git.push(repo, null);
    const s = await git.status(repo);
    assert.strictEqual(s.upstream, 'origin/main');
    assert.strictEqual(s.ahead, 0);
  });
  await t('modifica, rinomina, diff tracciato', async () => {
    fs.appendFileSync(path.join(repo, 'leggimi.md'), 'riga 2\n');
    const s = await git.status(repo);
    const f = s.files.find((x) => x.path === 'leggimi.md');
    assert.strictEqual(f.kind, 'modified');
    const d = await git.fileDiff(repo, f);
    assert.ok(d.patch.includes('+riga 2'));
  });
  await t('nuovo branch e commit descrittivo', async () => {
    await git.createBranch(repo, 'feature/prova');
    await git.commit(repo, { paths: ['leggimi.md', 'file con spazi.txt'], summary: 'Aggiunge riga', description: 'Dettagli' });
    const s = await git.status(repo);
    assert.strictEqual(s.branch, 'feature/prova');
    assert.strictEqual(s.files.length, 0);
    assert.strictEqual(s.upstream, null);
    const l = await git.log(repo, { range: 'origin/main..HEAD' });
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].body, 'Dettagli');
  });
  await t('nome branch non valido', () => assert.rejects(git.createBranch(repo, 'nome con spazi'), /non è un nome di branch valido/));
  await t('annulla ultimo commit', async () => {
    await git.undoLastCommit(repo);
    const s = await git.status(repo);
    assert.strictEqual(s.files.length, 2);
  });
  await t('scarta modifiche', async () => {
    await git.discard(repo, (await git.status(repo)).files);
    assert.strictEqual((await git.status(repo)).files.length, 0);
  });
  await t('branch e checkout remoto', async () => {
    await git.fetch(repo, null);
    const b = await git.branches(repo);
    assert.ok(b.local.find((x) => x.name === 'feature/prova').current);
    assert.ok(b.remote.some((x) => x.name === 'origin/main'));
    await git.checkout(repo, 'main');
    assert.strictEqual((await git.status(repo)).branch, 'main');
  });
  await t('show commit', async () => {
    const [c] = await git.log(repo, { limit: 1 });
    const d = await git.showCommit(repo, c.sha);
    assert.ok(d.patch.includes('leggimi.md'));
  });
  await t('auth solo verso host GitLab', () => {
    const env = git.authEnv('https://gitlab.azienda.it/a/b.git', { baseUrl: 'https://gitlab.azienda.it', token: 'abc' });
    assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.https://gitlab.azienda.it/.extraHeader');
    assert.deepStrictEqual(git.authEnv('https://github.com/a/b.git', { baseUrl: 'https://gitlab.azienda.it', token: 'abc' }), {});
  });

  console.log('.gitignore');
  await t('regole per file ed estensioni', () => {
    assert.strictEqual(gi.patternForPath('docs/bozza [1].pdf'), '/docs/bozza \\[1\\].pdf');
    assert.strictEqual(gi.patternForExtension('.pdf'), '*.pdf');
    assert.strictEqual(gi.extensionOf('a/b/report.final.PDF'), 'PDF');
    assert.strictEqual(gi.extensionOf('.env'), null);
    assert.strictEqual(gi.extensionOf('Makefile'), null);
  });
  await t('aggiunta senza duplicati e file ignorati da git', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/'); // senza a capo finale
    fs.writeFileSync(path.join(repo, 'bozza.pdf'), 'x');
    fs.mkdirSync(path.join(repo, 'out'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'out', 'a b.log'), 'x');
    assert.deepStrictEqual(gi.addPatterns(repo, ['*.pdf', '/out/a b.log']), ['*.pdf', '/out/a b.log']);
    assert.deepStrictEqual(gi.addPatterns(repo, ['*.pdf']), []);
    assert.strictEqual(fs.readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'node_modules/\n*.pdf\n/out/a b.log\n');
    const s = await git.status(repo);
    assert.deepStrictEqual(s.files.map((f) => f.path), ['.gitignore']);
  });

  console.log('Branch: merge, squash, rebase, stash');
  const w = (f, c) => fs.writeFileSync(path.join(repo, f), c);
  const commitAll = async (msg) => { const st = await git.status(repo); await git.commit(repo, { paths: st.files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path])), summary: msg }); };
  await commitAll('Aggiunge .gitignore');
  console.log('Indice preparato fuori dall\'app');
  await t('il commit non svuota l\'indice e non scrive "reset: moving to HEAD"', async () => {
    w('fuori-a.txt', 'a\n'); w('fuori-b.txt', 'b\n'); await commitAll('base fuori');
    const reflogBefore = await git.run(repo, ['reflog', '--format=%gs']);
    // preparato a mano da terminale: rimozione dall'indice di fuori-b.txt
    await git.run(repo, ['rm', '-q', '--cached', 'fuori-b.txt']);
    w('fuori-a.txt', 'a2\n');
    await git.commit(repo, { paths: ['fuori-a.txt'], summary: 'solo fuori-a' });
    const reflogAfter = await git.run(repo, ['reflog', '--format=%gs']);
    const added = reflogAfter.split('\n').length - reflogBefore.split('\n').length;
    assert.strictEqual(added, 1, 'una sola voce nuova nel reflog: il commit');
    assert.ok(!/reset: moving to HEAD/.test(reflogAfter.split('\n')[0]));
    const staged = await git.run(repo, ['diff', '--cached', '--name-status']);
    assert.match(staged, /^D\tfuori-b\.txt$/m, 'la rimozione preparata a mano è ancora nell\'indice');
    const [c] = await git.log(repo, { limit: 1 });
    assert.deepStrictEqual((await git.commitFiles(repo, c.sha)).files.map((f) => f.path), ['fuori-a.txt'], 'nel commit solo il file scelto');
    // la rimozione preparata a mano viene committata quando la si include
    await git.commit(repo, { paths: ['fuori-b.txt'], summary: 'smette di tracciare fuori-b' });
    assert.ok(fs.existsSync(path.join(repo, 'fuori-b.txt')));
    assert.strictEqual((await git.run(repo, ['ls-files', 'fuori-b.txt'])).trim(), '');
    fs.rmSync(path.join(repo, 'fuori-b.txt'));
  });
  await t('annulla ultimo commit senza toccare il resto dell\'indice', async () => {
    w('u1.txt', '1\n'); w('u2.txt', '2\n'); await commitAll('base u');
    await git.run(repo, ['rm', '-q', '--cached', 'u2.txt']);
    w('u1.txt', 'uno\n'); await git.commit(repo, { paths: ['u1.txt'], summary: 'cambia u1' });
    await git.undoLastCommit(repo);
    const staged = await git.run(repo, ['diff', '--cached', '--name-status']);
    assert.match(staged, /^D\tu2\.txt$/m, 'la rimozione di u2 resta preparata');
    assert.ok(!/u1\.txt/.test(staged), 'u1 torna tra le modifiche non preparate');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'u1.txt'), 'utf8'), 'uno\n');
    await git.run(repo, ['reset', '-q', '--', 'u2.txt']);
    await git.discard(repo, (await git.status(repo)).files);
  });

  console.log('File tracciati finiti nel .gitignore');
  await t('commit di un file tracciato dentro una cartella appena ignorata', async () => {
    fs.mkdirSync(path.join(repo, 'Shared/obj/Debug'), { recursive: true });
    w('Shared/obj/Debug/x.cache', 'a\n'); w('nuovo-file.txt', 'n\n');
    await commitAll('Aggiunge obj');
    fs.appendFileSync(path.join(repo, '.gitignore'), 'obj/\n');
    w('Shared/obj/Debug/x.cache', 'b\n');
    w('altro-nuovo.txt', 'z\n');
    const s = await git.status(repo);
    const cache = s.files.find((f) => f.path === 'Shared/obj/Debug/x.cache');
    assert.ok(cache.ignoredButTracked, 'il file è segnalato come tracciato ma ignorato');
    assert.strictEqual(s.ignoredTracked, 1);
    assert.deepStrictEqual(await git.listIgnoredTracked(repo), ['Shared/obj/Debug/x.cache']);
    await git.commit(repo, { paths: s.files.map((f) => f.path), summary: 'Aggiorna cache e gitignore' });
    assert.strictEqual((await git.status(repo)).files.length, 0, 'tutto incluso nel commit');
  });
  await t('smetti di tracciare: esce dal repository ma resta sul disco', async () => {
    w('Shared/obj/Debug/x.cache', 'c\n');
    await git.untrackFiles(repo, ['Shared/obj/Debug/x.cache']);
    let s = await git.status(repo);
    const f = s.files.find((x) => x.path === 'Shared/obj/Debug/x.cache');
    assert.ok(f && f.untracking, 'compare come file in uscita dal repository');
    await git.commit(repo, { paths: ['Shared/obj/Debug/x.cache'], summary: 'Smette di tracciare obj' });
    assert.ok(fs.existsSync(path.join(repo, 'Shared/obj/Debug/x.cache')), 'il file resta sul disco');
    assert.strictEqual((await git.run(repo, ['ls-files', 'Shared/obj'])).trim(), '', 'non è più nel repository');
    s = await git.status(repo);
    assert.strictEqual(s.files.length, 0, 'ignorato: non compare più tra le modifiche');
  });
  await t('annullare "smetti di tracciare" non tocca il file sul disco', async () => {
    w('tieni.txt', 'versione committata\n'); await commitAll('tieni');
    w('tieni.txt', 'modifica locale\n');
    await git.untrackFiles(repo, ['tieni.txt']);
    const s = await git.status(repo);
    await git.discard(repo, s.files.filter((f) => f.path === 'tieni.txt'));
    assert.strictEqual(fs.readFileSync(path.join(repo, 'tieni.txt'), 'utf8'), 'modifica locale\n');
    assert.ok((await git.run(repo, ['ls-files', 'tieni.txt'])).includes('tieni.txt'), 'di nuovo tracciato');
    await git.discard(repo, (await git.status(repo)).files);
  });

  await t('confronto e anteprima merge senza conflitti', async () => {
    await git.createBranch(repo, 'feat/a');
    w('a.txt', 'uno\n'); await commitAll('A1');
    w('b.txt', 'due\n'); await commitAll('A2');
    await git.checkout(repo, 'main');
    assert.deepStrictEqual(await git.compare(repo, 'feat/a'), { ahead: 0, behind: 2 });
    const p = await git.mergePreview(repo, 'feat/a');
    assert.strictEqual(p.incoming, 2); assert.ok(p.fastForward);
  });
  await t('merge pulito', async () => {
    const r = await git.merge(repo, 'feat/a');
    assert.strictEqual(r.conflicts, false);
    assert.ok(fs.existsSync(path.join(repo, 'b.txt')));
  });
  await t('merge con modifiche locali bloccato', async () => {
    w('sporco.txt', 'x');
    await assert.rejects(git.merge(repo, 'feat/a'), (e) => e.code === 'DIRTY');
  });
  await t('stash, elenco e ripristino', async () => {
    assert.strictEqual(await git.stashAll(repo, 'main'), 1);
    assert.strictEqual((await git.status(repo)).files.length, 0);
    const list = await git.stashList(repo);
    assert.strictEqual(list.length, 1); assert.strictEqual(list[0].branch, 'main');
    assert.deepStrictEqual(await git.stashFiles(repo, list[0].ref), ['sporco.txt']);
    await git.stashPop(repo, list[0].ref);
    assert.strictEqual((await git.status(repo)).files.length, 1);
    await git.discard(repo, (await git.status(repo)).files);
  });
  await t('contenuto dello stash: file modificati e nuovi', async () => {
    w('a.txt', 'uno modificato\n');
    w('nuovo.txt', 'file nuovo\n');
    await git.stashAll(repo);
    const [st] = await git.stashList(repo);
    assert.ok(/^[0-9a-f]{40}$/.test(st.sha));
    const d = await git.stashDetails(repo, st.sha);
    const byPath = Object.fromEntries(d.files.map((f) => [f.path, f]));
    assert.strictEqual(byPath['a.txt'].kind, 'modified');
    assert.ok(byPath['nuovo.txt'].untracked);
    assert.ok((await git.stashFileDiff(repo, st.sha, byPath['a.txt'])).patch.includes('+uno modificato'));
    assert.ok((await git.stashFileDiff(repo, st.sha, byPath['nuovo.txt'])).patch.includes('+file nuovo'));
    await git.stashPop(repo, st.ref);
    assert.strictEqual((await git.status(repo)).files.length, 2);
    await git.discard(repo, (await git.status(repo)).files);
  });
  await t('conflitto previsto, merge, blocco dei segni e completamento', async () => {
    await git.createBranch(repo, 'feat/b');
    w('a.txt', 'versione B\n'); await commitAll('B');
    await git.checkout(repo, 'main');
    w('a.txt', 'versione main\n'); await commitAll('M');
    const p = await git.mergePreview(repo, 'feat/b');
    assert.deepStrictEqual(p.conflicts, ['a.txt']);
    const r = await git.merge(repo, 'feat/b');
    assert.ok(r.conflicts);
    const s = await git.status(repo);
    assert.strictEqual(s.state, 'merging'); assert.strictEqual(s.conflicts, 1);
    const msg = await git.pendingMessage(repo);
    assert.match(msg.summary, /Merge branch 'feat\/b'/);
    await assert.rejects(git.commit(repo, { paths: ['a.txt'], summary: msg.summary }), /segni di conflitto/);
    w('a.txt', 'versione risolta\n');
    await git.commit(repo, { paths: ['a.txt'], summary: msg.summary });
    const [last] = await git.log(repo, { limit: 1 });
    const parents = (await git.run(repo, ['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(' ');
    assert.strictEqual(parents.length, 3, 'deve essere un vero commit di merge');
    assert.strictEqual((await git.status(repo)).state, null);
    assert.ok(last);
  });
  console.log('Conflitti risolti nell\'editor');
  const makeConflict = async (branch, file, mine, theirs, eol = '\n') => {
    await git.createBranch(repo, branch);
    w(file, theirs.join(eol) + eol); await commitAll(`${branch} lato loro`);
    await git.checkout(repo, 'main');
    w(file, mine.join(eol) + eol); await commitAll(`${branch} lato mio`);
    const r = await git.merge(repo, branch);
    assert.ok(r.conflicts, 'deve esserci un conflitto');
  };
  await t('file con a capo Windows risolto nell\'editor: riconosciuto e completabile', async () => {
    w('win.cs', 'base\r\n'); await commitAll('base win');
    await makeConflict('feat/win', 'win.cs', ['mia riga'], ['loro riga'], '\r\n');
    let s = await git.status(repo);
    assert.strictEqual(s.unmerged, 1); assert.strictEqual(s.conflicts, 1);
    w('win.cs', 'mia riga\r\nloro riga\r\n'); // come lo salverebbe un editor su Windows
    s = await git.status(repo);
    assert.strictEqual(s.unmerged, 1, 'Git lo considera ancora in conflitto finché non viene aggiunto');
    assert.strictEqual(s.conflicts, 0, 'ma l\'app lo riconosce come risolto');
    assert.ok(s.files.find((f) => f.path === 'win.cs').resolved);
    await git.commit(repo, { paths: ['win.cs'], summary: '' }); // titolo vuoto: si usa quello proposto da Git
    const [last] = await git.log(repo, { limit: 1 });
    assert.match(last.subject, /Merge branch 'feat\/win'/);
    assert.strictEqual((await git.status(repo)).state, null);
  });
  await t('segni di conflitto ancora presenti, anche in UTF-16', async () => {
    fs.writeFileSync(path.join(repo, 'u16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> altro\r\n', 'utf16le')]));
    fs.writeFileSync(path.join(repo, 'bom.txt'), '\uFEFF<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> altro\n');
    fs.writeFileSync(path.join(repo, 'pulito.txt'), 'ciao\n======= non è un conflitto\n');
    assert.deepStrictEqual(git.filesWithMarkers(repo, ['u16.txt', 'bom.txt', 'pulito.txt']), ['u16.txt', 'bom.txt']);
    for (const f of ['u16.txt', 'bom.txt', 'pulito.txt']) fs.rmSync(path.join(repo, f));
  });
  await t('risoluzione rapida: mia versione, versione in arrivo, segna come risolto', async () => {
    w('q1.txt', 'base\n'); w('q2.txt', 'base\n'); w('q3.txt', 'base\n'); await commitAll('base q');
    await git.createBranch(repo, 'feat/q');
    w('q1.txt', 'loro\n'); w('q2.txt', 'loro\n'); w('q3.txt', 'loro\n'); await commitAll('q loro');
    await git.checkout(repo, 'main');
    w('q1.txt', 'mio\n'); w('q2.txt', 'mio\n'); w('q3.txt', 'mio\n'); await commitAll('q mio');
    assert.ok((await git.merge(repo, 'feat/q')).conflicts);
    await git.resolveConflict(repo, 'q1.txt', 'ours');
    await git.resolveConflict(repo, 'q2.txt', 'theirs');
    // q3: il contenuto risolto contiene davvero righe simili ai segni (es. documentazione)
    w('q3.txt', '<<<<<<< esempio nella documentazione\n>>>>>>> fine esempio\n');
    let s = await git.status(repo);
    assert.strictEqual(s.conflicts, 1, 'q3 sembra ancora in conflitto');
    await git.resolveConflict(repo, 'q3.txt', 'resolved');
    s = await git.status(repo);
    assert.strictEqual(s.unmerged, 0);
    await git.commit(repo, { paths: s.files.map((f) => f.path), summary: 'Merge q' });
    assert.strictEqual(fs.readFileSync(path.join(repo, 'q1.txt'), 'utf8'), 'mio\n');
    assert.strictEqual(fs.readFileSync(path.join(repo, 'q2.txt'), 'utf8'), 'loro\n');
    assert.strictEqual((await git.status(repo)).state, null);
  });
  await t('conflitto modificato/eliminato: scelta della versione', async () => {
    w('del.txt', 'base\n'); await commitAll('base del');
    await git.createBranch(repo, 'feat/del');
    await git.run(repo, ['rm', '-q', 'del.txt']); await git.commit(repo, { paths: ['del.txt'], summary: 'elimina del' });
    await git.checkout(repo, 'main');
    w('del.txt', 'modificato\n'); await commitAll('modifica del');
    assert.ok((await git.merge(repo, 'feat/del')).conflicts);
    const s = await git.status(repo);
    const f = s.files.find((x) => x.path === 'del.txt');
    assert.strictEqual(f.resolved, false, 'serve una scelta esplicita');
    await git.resolveConflict(repo, 'del.txt', 'theirs'); // la loro versione: eliminato
    assert.ok(!fs.existsSync(path.join(repo, 'del.txt')));
    await git.commit(repo, { paths: [], summary: 'Merge del' });
    assert.strictEqual((await git.status(repo)).state, null);
  });
  await t('annulla merge', async () => {
    await git.createBranch(repo, 'feat/c');
    w('a.txt', 'C\n'); await commitAll('C');
    await git.checkout(repo, 'main');
    w('a.txt', 'main2\n'); await commitAll('M2');
    assert.ok((await git.merge(repo, 'feat/c')).conflicts);
    await git.abortMerge(repo);
    const s = await git.status(repo);
    assert.strictEqual(s.state, null); assert.strictEqual(s.files.length, 0);
  });
  await t('squash e unisci', async () => {
    await git.createBranch(repo, 'feat/d');
    w('d1.txt', '1\n'); await commitAll('D1');
    w('d2.txt', '2\n'); await commitAll('D2');
    await git.checkout(repo, 'main');
    const r = await git.merge(repo, 'feat/d', { squash: true });
    assert.strictEqual(r.conflicts, false);
    const s = await git.status(repo);
    assert.strictEqual(s.files.length, 2);
    assert.strictEqual((await git.pendingMessage(repo)).kind, 'squash');
    await commitAll('Squash di feat/d');
    const parents = (await git.run(repo, ['rev-list', '--parents', '-n1', 'HEAD'])).trim().split(' ');
    assert.strictEqual(parents.length, 2);
  });
  await t('rebase con conflitto e continua', async () => {
    await git.checkout(repo, 'feat/c');
    const r = await git.rebase(repo, 'main');
    assert.ok(r.conflicts);
    const s = await git.status(repo);
    assert.strictEqual(s.state, 'rebasing'); assert.strictEqual(s.rebaseBranch, 'feat/c');
    await assert.rejects(git.rebaseContinue(repo), /segni di conflitto/);
    await assert.rejects(git.commit(repo, { paths: ['a.txt'], summary: 'x' }), /rebase/);
    w('a.txt', 'risolto rebase\n');
    const c = await git.rebaseContinue(repo);
    assert.ok(c.done);
    const after = await git.status(repo);
    assert.strictEqual(after.branch, 'feat/c'); assert.strictEqual(after.state, null);
    assert.deepStrictEqual(await git.compare(repo, 'main'), { ahead: 1, behind: 0 });
  });
  await t('branch riscritto con rebase riconosciuto', async () => {
    const bare2 = path.join(tmp, 'r2.git');
    await git.run(tmp, ['init', '-q', '--bare', '-b', 'main', bare2]);
    await git.run(repo, ['remote', 'set-url', 'origin', bare2]);
    await git.run(repo, ['push', '-q', 'origin', 'main']);
    await git.createBranch(repo, 'feat/f');
    w('f.txt', 'f\n'); await commitAll('F');
    await git.push(repo, null);
    await git.checkout(repo, 'main');
    w('g.txt', 'g\n'); await commitAll('G');
    await git.run(repo, ['push', '-q', 'origin', 'main']);
    await git.checkout(repo, 'feat/f');
    assert.strictEqual((await git.rebase(repo, 'main')).conflicts, false);
    let s = await git.status(repo);
    assert.ok(s.ahead && s.behind && s.rebased);
    await git.forcePush(repo, null);
    s = await git.status(repo);
    assert.strictEqual(s.ahead + s.behind, 0);
  });
  await t('file di un commit, rinomina, immagini e diff per file', async () => {
    fs.writeFileSync(path.join(repo, 'logo.png'), Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    w('vecchio nome.txt', 'contenuto invariato\nper la rinomina\n');
    await commitAll('Aggiunge logo');
    await git.run(repo, ['mv', 'vecchio nome.txt', 'nuovo nome.txt']);
    w('f.txt', 'f modificato\n');
    await git.run(repo, ['rm', '-q', 'g.txt']);
    await commitAll('Rinomina e modifica');
    const [c] = await git.log(repo, { limit: 1 });
    const { files, isMerge } = await git.commitFiles(repo, c.sha);
    assert.strictEqual(isMerge, false);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.strictEqual(byPath['nuovo nome.txt'].kind, 'renamed');
    assert.strictEqual(byPath['nuovo nome.txt'].origPath, 'vecchio nome.txt');
    assert.strictEqual(byPath['f.txt'].kind, 'modified');
    assert.strictEqual(byPath['g.txt'].kind, 'deleted');
    const d = await git.commitFileDiff(repo, c.sha, byPath['f.txt']);
    assert.ok(d.patch.includes('+f modificato'));
    const [, prev] = await git.log(repo, { limit: 2 });
    const img = await git.commitFileDiff(repo, prev.sha, { path: 'logo.png', kind: 'added' });
    assert.ok(img.image.after.startsWith('data:image/png;base64,'));
    assert.strictEqual(img.image.before, null);
    const first = (await git.run(repo, ['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n')[0];
    assert.ok((await git.commitFiles(repo, first)).files.length > 0, 'anche il primo commit ha i suoi file');
  });
  await t('annulla rebase', async () => {
    await git.createBranch(repo, 'feat/e', 'main~3');
    w('a.txt', 'E\n'); await commitAll('E');
    assert.ok((await git.rebase(repo, 'main')).conflicts);
    await git.rebaseAbort(repo);
    const s = await git.status(repo);
    assert.strictEqual(s.branch, 'feat/e'); assert.strictEqual(s.state, null);
  });
  await t('push da un branch creato da origin/main non tocca main', async () => {
    await git.checkout(repo, 'main');
    await git.run(repo, ['push', '-q', 'origin', 'main']);
    await git.fetch(repo, null);
    const mainBefore = (await git.run(repo, ['rev-parse', 'origin/main'])).trim();
    await git.createBranch(repo, 'feat/da-origin', 'origin/main');
    let s = await git.status(repo);
    assert.strictEqual(s.upstream, null, 'il nuovo branch non deve essere collegato a origin/main');
    w('x.txt', 'x\n'); await commitAll('X');
    await git.push(repo, null);
    await git.fetch(repo, null);
    assert.strictEqual((await git.run(repo, ['rev-parse', 'origin/main'])).trim(), mainBefore, 'main sul server non deve cambiare');
    s = await git.status(repo);
    assert.strictEqual(s.upstream, 'origin/feat/da-origin');
    assert.strictEqual(s.ahead + s.behind, 0);
  });
  await t('branch già collegato per errore a origin/main: push sul proprio nome', async () => {
    const mainBefore = (await git.run(repo, ['rev-parse', 'origin/main'])).trim();
    await git.run(repo, ['switch', '-q', '-c', 'feat/vecchio', '--track', 'origin/main']);
    w('y.txt', 'y\n'); await commitAll('Y');
    let s = await git.status(repo);
    assert.strictEqual(s.trackingOther, 'origin/main');
    assert.strictEqual(s.upstream, null);
    await assert.rejects(git.pull(repo, null), /non è ancora sul server/);
    await git.push(repo, null);
    await git.fetch(repo, null);
    assert.strictEqual((await git.run(repo, ['rev-parse', 'origin/main'])).trim(), mainBefore, 'main sul server non deve cambiare');
    s = await git.status(repo);
    assert.strictEqual(s.upstream, 'origin/feat/vecchio');
    assert.ok(!s.trackingOther, 'il collegamento viene corretto');
    await git.pull(repo, null);
    await git.checkout(repo, 'feat/e');
  });
  console.log('Azioni sui commit della cronologia');
  await t('revert di un commit', async () => {
    await git.checkout(repo, 'main');
    w('r.txt', 'riga\n'); await commitAll('Aggiunge r');
    const [c] = await git.log(repo, { limit: 1 });
    assert.strictEqual((await git.revertCommit(repo, c.sha)).conflicts, false);
    assert.ok(!fs.existsSync(path.join(repo, 'r.txt')));
    const [last] = await git.log(repo, { limit: 1 });
    assert.match(last.subject, /^Revert "Aggiunge r"/);
  });
  await t('revert con conflitto, completamento dal commit', async () => {
    w('k.txt', 'uno\n'); await commitAll('K1');
    const [k1] = await git.log(repo, { limit: 1 });
    w('k.txt', 'due\n'); await commitAll('K2');
    assert.ok((await git.revertCommit(repo, k1.sha)).conflicts);
    const s = await git.status(repo);
    assert.strictEqual(s.state, 'reverting');
    const msg = await git.pendingMessage(repo);
    w('k.txt', 'risolto\n');
    await git.commit(repo, { paths: ['k.txt'], summary: msg.summary });
    assert.strictEqual((await git.status(repo)).state, null);
  });
  await t('annulla un cherry-pick in conflitto', async () => {
    await git.createBranch(repo, 'feat/cp');
    w('k.txt', 'versione cp\n'); await commitAll('CP');
    const [cp] = await git.log(repo, { limit: 1 });
    await git.checkout(repo, 'main');
    w('k.txt', 'versione main\n'); await commitAll('M-K');
    assert.ok((await git.cherryPick(repo, cp.sha)).conflicts);
    assert.strictEqual((await git.status(repo)).state, 'cherry-picking');
    await git.abortMerge(repo);
    assert.strictEqual((await git.status(repo)).state, null);
  });
  await t('cherry-pick pulito', async () => {
    await git.checkout(repo, 'feat/cp');
    w('solo-cp.txt', 'x\n'); await commitAll('Solo CP');
    const [c] = await git.log(repo, { limit: 1 });
    await git.checkout(repo, 'main');
    assert.strictEqual((await git.cherryPick(repo, c.sha)).conflicts, false);
    assert.ok(fs.existsSync(path.join(repo, 'solo-cp.txt')));
  });
  await t('tag su un commit e tag visibili nella cronologia', async () => {
    const [c] = await git.log(repo, { limit: 1 });
    assert.strictEqual(await git.createTag(repo, 'v1.0.0', c.sha, 'Prima versione'), 'v1.0.0');
    await git.createTag(repo, 'leggero', c.sha);
    assert.deepStrictEqual((await git.tagsAt(repo, c.sha)).sort(), ['leggero', 'v1.0.0']);
    const [again] = await git.log(repo, { limit: 1 });
    assert.deepStrictEqual(again.tags.sort(), ['leggero', 'v1.0.0']);
    await assert.rejects(git.createTag(repo, 'v1.0.0', c.sha), /esiste già/);
    await assert.rejects(git.createTag(repo, 'con spazi', c.sha), /non è un nome di tag valido/);
    await git.pushTag(repo, 'v1.0.0', null);
    assert.ok((await git.run(repo, ['ls-remote', '--tags', 'origin'])).includes('refs/tags/v1.0.0'));
  });
  await t('reset a un commit non pubblicato', async () => {
    await git.push(repo, null);
    const [base] = await git.log(repo, { limit: 1 });
    w('l1.txt', '1\n'); await commitAll('L1');
    w('l2.txt', '2\n'); await commitAll('L2');
    assert.deepStrictEqual(await git.commitsAfter(repo, base.sha), { count: 2, pushed: 0 });
    assert.strictEqual(await git.resetToCommit(repo, base.sha), 2);
    const s = await git.status(repo);
    assert.deepStrictEqual(s.files.map((f) => f.path).sort(), ['l1.txt', 'l2.txt'], 'le modifiche restano nei file');
    const first = (await git.run(repo, ['rev-list', '--max-parents=0', 'HEAD'])).trim().split('\n')[0];
    await assert.rejects(git.resetToCommit(repo, first), /già sul server/);
    await git.discard(repo, s.files);
  });
  await t('riordina e unisci commit', async () => {
    w('o1.txt', '1\n'); await commitAll('O1');
    w('o2.txt', '2\n'); await commitAll('O2');
    w('o3.txt', '3\n'); await commitAll('O3');
    const all = await git.log(repo, { limit: 3 });
    const [o3, o2, o1] = all;
    const cand = await git.reorderCandidates(repo, o1.sha);
    assert.deepStrictEqual(cand.commits.map((c) => c.subject), ['O1', 'O2', 'O3']);
    // nuovo ordine: O3, O1, e O2 unito a O1
    const r = await git.rewriteCommits(repo, o1.sha, [{ sha: o3.sha, action: 'pick' }, { sha: o1.sha, action: 'pick' }, { sha: o2.sha, action: 'squash' }]);
    assert.strictEqual(r.conflicts, false);
    const after = await git.log(repo, { limit: 2 });
    assert.strictEqual(after[1].subject, 'O3');
    assert.strictEqual(after[0].subject, 'O1');
    assert.match(after[0].body, /O2/, 'il messaggio unito contiene anche O2');
    assert.strictEqual((await git.status(repo)).files.length, 0);
    for (const f of ['o1.txt', 'o2.txt', 'o3.txt']) assert.ok(fs.existsSync(path.join(repo, f)));
  });
  await t('rimuovi l\'ultimo commit locale mantenendo o eliminando le modifiche', async () => {
    w('rimuovi.txt', '1\n'); await commitAll('D1');
    let [c] = await git.log(repo, { limit: 1 });
    assert.ok(await git.isLocalOnly(repo, c.sha));
    await git.dropCommit(repo, c.sha, { keepChanges: true });
    assert.deepStrictEqual((await git.status(repo)).files.map((f) => f.path), ['rimuovi.txt']);
    await commitAll('D1 di nuovo');
    [c] = await git.log(repo, { limit: 1 });
    await git.dropCommit(repo, c.sha, { keepChanges: false });
    assert.strictEqual((await git.status(repo)).files.length, 0);
    assert.ok(!fs.existsSync(path.join(repo, 'rimuovi.txt')));
  });
  await t('rimuovi un commit locale in mezzo alla cronologia', async () => {
    w('m1.txt', '1\n'); await commitAll('M1');
    w('m2.txt', '2\n'); await commitAll('M2');
    w('m3.txt', '3\n'); await commitAll('M3');
    const [, m2] = await git.log(repo, { limit: 3 });
    const r = await git.dropCommit(repo, m2.sha);
    assert.strictEqual(r.conflicts, false);
    assert.deepStrictEqual((await git.log(repo, { limit: 2 })).map((x) => x.subject), ['M3', 'M1']);
    assert.ok(!fs.existsSync(path.join(repo, 'm2.txt')));
  });
  await t('un commit già sul server non si rimuove', async () => {
    await git.push(repo, null);
    const [c] = await git.log(repo, { limit: 1 });
    assert.ok(!(await git.isLocalOnly(repo, c.sha)));
    await assert.rejects(git.dropCommit(repo, c.sha), /già nel branch origin\/main sul server/);
  });
  await t('sposta i commit locali su un nuovo branch', async () => {
    const st0 = await git.status(repo);
    const serverHead = (await git.run(repo, ['rev-parse', st0.upstream])).trim();
    w('n1.txt', '1\n'); await commitAll('N1');
    w('n2.txt', '2\n'); await commitAll('N2');
    w('in-corso.txt', 'non committato\n');
    const r = await git.moveLocalCommits(repo, 'fix/spostati');
    assert.strictEqual(r.moved, 2);
    const s = await git.status(repo);
    assert.strictEqual(s.branch, 'fix/spostati');
    assert.strictEqual(s.upstream, null);
    assert.deepStrictEqual(s.files.map((f) => f.path), ['in-corso.txt'], 'le modifiche non committate seguono');
    assert.deepStrictEqual((await git.log(repo, { limit: 2 })).map((x) => x.subject), ['N2', 'N1']);
    assert.strictEqual((await git.run(repo, ['rev-parse', r.from])).trim(), serverHead, 'il branch di partenza torna come sul server');
    await assert.rejects(git.moveLocalCommits(repo, 'altro'), /mai stato pubblicato/);
    await git.discard(repo, s.files);
    await git.checkout(repo, r.from);
  });
  await t('commit non su origin/master ma presente in un altro riferimento remoto: si può rimuovere', async () => {
    await git.checkout(repo, 'main');
    await git.push(repo, null);
    w('pw1.txt', 'password vecchia\n'); await commitAll('ultime password');
    const [c] = await git.log(repo, { limit: 1 });
    // lo stesso commit finisce su un altro branch del server (o resta in un riferimento vecchio)
    await git.run(repo, ['push', '-q', 'origin', `${c.sha}:refs/heads/vecchio-branch`]);
    await git.fetch(repo, null);
    const s = await git.status(repo);
    assert.strictEqual(s.ahead, 1, 'per main il commit è ancora da pubblicare');
    assert.ok(await git.isLocalOnly(repo, c.sha), 'non è su origin/main: si considera locale');
    const r = await git.dropCommit(repo, c.sha, { keepChanges: false });
    assert.deepStrictEqual(r.alsoOn, ['origin/vecchio-branch'], 'l\'app segnala dove altro si trova');
    assert.strictEqual((await git.status(repo)).ahead, 0);
    await git.run(repo, ['push', '-q', 'origin', '--delete', 'vecchio-branch']);
    await git.fetch(repo, null);
  });
  await t('checkout di un commit (HEAD staccato)', async () => {
    const [, prev] = await git.log(repo, { limit: 2 });
    await git.checkoutCommit(repo, prev.sha);
    const s = await git.status(repo);
    assert.strictEqual(s.branch, null);
    assert.strictEqual(s.oid, prev.sha);
    await git.checkout(repo, 'feat/e');
  });
  await t('branch principale del remote', async () => {
    assert.strictEqual(await git.remoteDefaultBranch(repo), 'main');
  });
  await t('rinomina branch', async () => {
    const r = await git.renameBranch(repo, 'feat/e', 'feat/e-nuovo');
    assert.strictEqual(r.name, 'feat/e-nuovo');
    assert.strictEqual((await git.status(repo)).branch, 'feat/e-nuovo');
    await assert.rejects(git.renameBranch(repo, 'feat/e-nuovo', 'nome non valido'), /non è un nome/);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} test superati${process.exitCode ? ', alcuni falliti' : ''}.`);
})();
