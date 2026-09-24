'use strict';
// Test dei moduli Git e GitLab senza Electron: `npm test`
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('../src/git');
const { parseRemote, matchesInstance, GitLab } = require('../src/gitlab');

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

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} test superati${process.exitCode ? ', alcuni falliti' : ''}.`);
})();
