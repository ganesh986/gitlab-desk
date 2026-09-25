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
