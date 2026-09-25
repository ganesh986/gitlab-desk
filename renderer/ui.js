(() => {
'use strict';
/* global window, document */
// Piccole utilità per costruire l'interfaccia senza innerHTML (niente rischio di iniezione).

const SVG_TAGS = new Set(['svg', 'path', 'g', 'circle', 'rect', 'line', 'polyline', 'polygon']);
function h(tag, attrs, ...children) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') { if (el instanceof SVGElement) el.setAttribute('class', v); else el.className = v; }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style') el.style.cssText = v; // compatibile con la CSP (niente attributi style)
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function mount(el, ...children) { clear(el); append(el, children); return el; }

// Chiamata IPC: restituisce i dati o lancia un Error con il messaggio leggibile.
async function api(channel, ...args) {
  const r = await window.desk[channel](...args);
  if (!r.ok) { const e = new Error(r.error); e.status = r.status; throw e; }
  return r.data;
}

// Esegue fn mostrando lo stato "occupato" sul bottone; gli errori diventano notifiche.
async function busy(button, fn, { errorPrefix } = {}) {
  if (button) { button.classList.add('busy'); button.disabled = true; }
  try { return await fn(); }
  catch (e) { toast(errorPrefix ? `${errorPrefix}\n${e.message}` : e.message, { type: 'error', timeout: 0 }); return undefined; }
  finally { if (button) { button.classList.remove('busy'); button.disabled = false; } }
}

function toast(message, { type = 'info', timeout = 4500, action } = {}) {
  const root = document.getElementById('toasts');
  const close = () => el.remove();
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('div', { class: 'msg' }, message),
    action && h('button', { class: 'act', onclick: () => { action.run(); close(); } }, action.label),
    h('button', { 'aria-label': 'Chiudi', onclick: close }, '✕'));
  root.appendChild(el);
  while (root.children.length > 4) root.firstChild.remove();
  if (timeout) setTimeout(close, timeout);
}

// Finestra modale. content: nodo; footer: array di bottoni. Restituisce { close }.
function modal({ title, body, footer, flush, onClose, anchor, width }) {
  const root = document.getElementById('modal-root');
  const previous = document.activeElement;
  const overlay = h('div', { class: 'overlay' + (anchor ? ' anchored' : '') });
  const box = h('div', { class: 'modal' + (anchor ? ' popover' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    title && h('div', { class: 'modal-head' }, title),
    h('div', { class: 'modal-body' + (flush ? ' flush' : '') }, body),
    footer && footer.length ? h('div', { class: 'modal-foot' }, footer) : null);
  if (width) box.style.width = width;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 368))}px`;
    box.style.top = `${r.bottom + 4}px`;
  }
  overlay.appendChild(box);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
    if (previous && previous.focus) previous.focus();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey, true);
  root.appendChild(overlay);
  const first = box.querySelector('input, textarea, select, button.primary, button');
  if (first) setTimeout(() => first.focus(), 0);
  return { close, box };
}

function confirmDialog({ title, message, confirm = 'Conferma', danger }) {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title,
      body: h('p', { style: 'margin:0' }, message),
      footer: [
        h('button', { class: 'btn', onclick: () => m.close() }, 'Annulla'),
        h('button', { class: 'btn primary' + (danger ? ' danger' : ''), onclick: () => { result = true; m.close(); } }, confirm),
      ],
      onClose: () => resolve(result),
    });
  });
}

const rtf = new Intl.RelativeTimeFormat('it', { numeric: 'auto' });
function ago(iso) {
  if (!iso) return '';
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const units = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];
  let v = s;
  for (const [size, unit] of units) {
    if (Math.abs(v) < size) return rtf.format(Math.round(v), unit);
    v /= size;
  }
  return '';
}
function fullDate(iso) {
  return iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

window.UI = { h, mount, clear, api, busy, toast, modal, confirmDialog, ago, fullDate, debounce };
})();
