'use strict';
// Impostazioni salvate in un file JSON nella cartella dati dell'utente.
// Il token è cifrato con safeStorage di Electron (DPAPI su Windows,
// Portachiavi su macOS, libsecret/kwallet su Linux).

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  gitlabUrl: '',
  tokenEnc: null,       // token cifrato (base64)
  tokenPlain: null,     // solo se la cifratura non è disponibile sul sistema
  useTokenForGit: true, // usa il token anche per push/pull via HTTPS
  gitPath: '',
  recentRepos: [],
  lastRepo: null,
};

class Settings {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'settings.json');
    this.safeStorage = safeStorage;
    this.data = { ...DEFAULTS };
    try { Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* primo avvio */ }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get encryptionAvailable() {
    try { return !!(this.safeStorage && this.safeStorage.isEncryptionAvailable()); } catch { return false; }
  }

  getToken() {
    if (this.data.tokenEnc && this.encryptionAvailable) {
      try { return this.safeStorage.decryptString(Buffer.from(this.data.tokenEnc, 'base64')); } catch { return null; }
    }
    return this.data.tokenPlain || null;
  }

  setToken(token) {
    if (!token) { this.data.tokenEnc = null; this.data.tokenPlain = null; return; }
    if (this.encryptionAvailable) {
      this.data.tokenEnc = this.safeStorage.encryptString(token).toString('base64');
      this.data.tokenPlain = null;
    } else {
      this.data.tokenPlain = token;
      this.data.tokenEnc = null;
    }
  }

  publicView() {
    return {
      gitlabUrl: this.data.gitlabUrl,
      hasToken: !!this.getToken(),
      useTokenForGit: this.data.useTokenForGit,
      gitPath: this.data.gitPath,
      encryptionAvailable: this.encryptionAvailable,
    };
  }

  addRecent(repoPath) {
    const list = this.data.recentRepos.filter((p) => p !== repoPath);
    list.unshift(repoPath);
    this.data.recentRepos = list.slice(0, 30);
    this.data.lastRepo = repoPath;
    this.save();
  }

  removeRecent(repoPath) {
    this.data.recentRepos = this.data.recentRepos.filter((p) => p !== repoPath);
    if (this.data.lastRepo === repoPath) this.data.lastRepo = null;
    this.save();
  }
}

module.exports = { Settings };
