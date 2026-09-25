'use strict';
// Espone al renderer solo un insieme ristretto di funzioni (niente Node.js diretto).
const { contextBridge, ipcRenderer } = require('electron');

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const channels = [
  'settings:get', 'settings:save', 'settings:test',
  'repo:recent', 'repo:last', 'repo:open', 'repo:pick', 'repo:forget', 'repo:reveal', 'repo:clone',
  'dialog:pickFolder',
  'git:status', 'git:diff', 'git:commit', 'git:undoCommit', 'git:discard', 'git:log', 'git:show',
  'git:branches', 'git:createBranch', 'git:checkout', 'git:deleteBranch',
  'git:fetch', 'git:pull', 'git:push', 'git:commitsBetween',
  'gl:project', 'gl:me', 'gl:searchProjects', 'gl:mrs', 'gl:mrForBranch', 'gl:mr', 'gl:branches', 'gl:members', 'gl:createMR',
  'git:renameBranch', 'git:deleteCurrentBranch', 'git:stash', 'git:stashList', 'git:stashFiles', 'git:stashDetails', 'git:stashFileDiff', 'git:stashPop', 'git:stashDrop',
  'git:compare', 'git:mergePreview', 'git:merge', 'git:abortMerge', 'git:rebase', 'git:rebaseContinue', 'git:rebaseAbort',
  'git:commitFiles', 'git:commitFileDiff', 'clipboard:write',
  'git:pendingMessage', 'git:forcePush', 'git:markers',
  'shell:open', 'dialog:pickFile', 'files:contextMenu', 'files:openInEditor',
];

const api = {};
for (const ch of channels) api[ch] = call(ch);
api.on = (event, cb) => {
  if (!['app:focus', 'menu'].includes(event)) return;
  ipcRenderer.on(event, (_e, ...args) => cb(...args));
};

api.setMenuState = (state) => ipcRenderer.send('menu:state', state);

contextBridge.exposeInMainWorld('desk', api);
