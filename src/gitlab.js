'use strict';
// Client minimale per le API REST v4 di GitLab (gitlab.com o self-managed).
// La funzione fetch viene iniettata: nell'app è `net.fetch` di Electron,
// che usa i certificati e il proxy di sistema (utile in rete aziendale).

class GitLabError extends Error {
  constructor(message, status) { super(message); this.name = 'GitLabError'; this.status = status; }
}

function normalizeBaseUrl(url) {
  if (!url) return '';
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

/**
 * Ricava host e percorso del progetto dall'URL del remote.
 * Supporta: https://host/[prefisso/]gruppo/progetto.git
 *           ssh://git@host[:porta]/gruppo/progetto.git
 *           git@host:gruppo/progetto.git
 */
function parseRemote(remoteUrl, baseUrl) {
  if (!remoteUrl) return null;
  const r = remoteUrl.trim();
  let host, projectPath, protocol;
  const scp = r.match(/^(?:[^@\/]+@)?([^:\/]+):(?!\/\/)(.+)$/);
  if (/^[a-z+]+:\/\//i.test(r)) {
    let u;
    try { u = new URL(r); } catch { return null; }
    protocol = u.protocol.replace(':', '');
    host = u.hostname.toLowerCase();
    projectPath = decodeURIComponent(u.pathname);
    // Istanze installate in un sotto-percorso (es. https://server/gitlab/...)
    if (/^https?$/.test(protocol) && baseUrl) {
      try {
        const prefix = new URL(normalizeBaseUrl(baseUrl)).pathname.replace(/\/+$/, '');
        if (prefix && projectPath.startsWith(prefix + '/')) projectPath = projectPath.slice(prefix.length);
      } catch { /* ignore */ }
    }
  } else if (scp) {
    protocol = 'ssh';
    host = scp[1].toLowerCase();
    projectPath = scp[2];
  } else return null;
  projectPath = projectPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!projectPath.includes('/')) return null;
  return { host, path: projectPath, protocol };
}

function matchesInstance(remoteInfo, baseUrl) {
  if (!remoteInfo || !baseUrl) return false;
  try { return new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase() === remoteInfo.host; } catch { return false; }
}

class GitLab {
  constructor({ baseUrl, token, fetchImpl }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  get configured() { return !!(this.baseUrl && this.token); }

  async request(method, apiPath, { query, body } = {}) {
    if (!this.configured) throw new GitLabError('Configura indirizzo del server GitLab e token nelle impostazioni.', 0);
    const url = new URL(`${this.baseUrl}/api/v4${apiPath}`);
    if (query) for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, x));
      else url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await this.fetch(url.toString(), {
        method,
        headers: { 'PRIVATE-TOKEN': this.token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new GitLabError(`Impossibile contattare ${this.baseUrl}. Verifica l'indirizzo, la rete o la VPN. (${e.message})`, 0);
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* risposta non JSON */ }
    if (!res.ok) throw new GitLabError(explain(res.status, data, text), res.status);
    if (data === null && text && /<html/i.test(text)) {
      throw new GitLabError('Il server ha risposto con una pagina web invece che con le API: controlla che l\'indirizzo sia quello di GitLab.', res.status);
    }
    return data;
  }

  get(p, query) { return this.request('GET', p, { query }); }
  post(p, body) { return this.request('POST', p, { body }); }
  put(p, body) { return this.request('PUT', p, { body }); }

  currentUser() { return this.get('/user'); }

  getProject(pathOrId) {
    return this.get(`/projects/${encodeURIComponent(pathOrId)}`);
  }

  searchProjects(search) {
    return this.get('/projects', {
      membership: true, simple: true, order_by: 'last_activity_at', per_page: 30, search: search || undefined,
    });
  }

  listBranches(projectId, search) {
    return this.get(`/projects/${projectId}/repository/branches`, { per_page: 100, search: search || undefined });
  }

  listMergeRequests(projectId, { state = 'opened', scope, sourceBranch } = {}) {
    return this.get(`/projects/${projectId}/merge_requests`, {
      state, scope, source_branch: sourceBranch, order_by: 'updated_at', per_page: 50,
    });
  }

  getMergeRequest(projectId, iid) {
    return this.get(`/projects/${projectId}/merge_requests/${iid}`);
  }

  getApprovals(projectId, iid) {
    return this.get(`/projects/${projectId}/merge_requests/${iid}/approvals`).catch(() => null);
  }

  createMergeRequest(projectId, mr) {
    const body = {
      source_branch: mr.sourceBranch,
      target_branch: mr.targetBranch,
      title: mr.draft && !/^(draft:|\[draft\])/i.test(mr.title) ? `Draft: ${mr.title}` : mr.title,
      description: mr.description || '',
      remove_source_branch: !!mr.removeSourceBranch,
      squash: !!mr.squash,
    };
    if (mr.assigneeIds && mr.assigneeIds.length) body.assignee_ids = mr.assigneeIds;
    if (mr.reviewerIds && mr.reviewerIds.length) body.reviewer_ids = mr.reviewerIds;
    if (mr.labels && mr.labels.length) body.labels = mr.labels.join(',');
    return this.post(`/projects/${projectId}/merge_requests`, body);
  }

  searchProjectMembers(projectId, search) {
    return this.get(`/projects/${projectId}/users`, { search, per_page: 20 });
  }
}

function explain(status, data, text) {
  const msg = data && (data.message || data.error_description || data.error);
  const detail = typeof msg === 'string' ? msg : msg ? JSON.stringify(msg) : (text || '').slice(0, 200);
  if (status === 401) return 'Token non valido o scaduto. Creane uno nuovo su GitLab (Preferenze → Token di accesso) con scope "api".';
  if (status === 403) return `Permessi insufficienti per questa operazione. ${detail}`;
  if (status === 404) return 'Progetto o risorsa non trovati: verifica di avere accesso al progetto e che l\'indirizzo del server sia corretto.';
  if (status === 409) {
    if (/already exists/i.test(detail)) return 'Esiste già una merge request aperta per questo branch.';
    return detail;
  }
  if (status === 422) return `GitLab ha rifiutato i dati: ${detail}`;
  return `Errore ${status} da GitLab: ${detail}`;
}

module.exports = { GitLab, GitLabError, parseRemote, matchesInstance, normalizeBaseUrl };
