// A small card that shows a minion's effect text: hover it (mouse), focus it (keyboard) or
// click/tap it (touch). Only one card is open at a time. Minions in the reports are
// <div class="m" data-card="<card id>" tabindex="0">; the texts come from data/text_*.json
// (tools/gen_text.py) and are loaded the first time a card is opened.

import { card, getLang, onLangChange, t } from './i18n.js';

const base = new URL('../data/', import.meta.url);
const texts = { zh: null, en: null };   // lang -> {id: {x, t, r}} once loaded ({} if it failed)
const loading = {};

function load(lang) {
  if (texts[lang]) return Promise.resolve(texts[lang]);
  // A failed download is not remembered: the next card tries again.
  return (loading[lang] ||= fetch(new URL(lang === 'zh' ? 'text_zhTW.json' : 'text_en.json', base))
    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(d => (texts[lang] = d))
    .catch(() => { delete loading[lang]; return {}; }));
}

const escHtml = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * HearthstoneJSON text -> safe HTML: everything is escaped, then only <b> and <i> are
 * allowed back; "[x]" (a layout marker) is dropped and line breaks kept.
 */
export function effectHtml(raw) {
  const s = String(raw || '').replace(/\[x\]/g, '');
  return s.split(/(<\/?[bi]>)/i).map((part, i) => (i % 2 ? part : escHtml(part).replace(/\r?\n/g, '<br>'))).join('');
}

const baseId = id => String(id).replace(/_G$/, '');

let el = null, openFor = null, pinned = false, hideTimer = 0;

function ensureEl() {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'cardtip';
  el.setAttribute('role', 'tooltip');
  el.hidden = true;
  // The pointer may travel from the minion into the card (to read or select the text).
  el.addEventListener('pointerover', () => clearTimeout(hideTimer));
  el.addEventListener('pointerout', e => {
    if (!pinned && !el.contains(e.relatedTarget) && !(openFor && openFor.contains(e.relatedTarget))) hideSoon();
  });
  document.body.appendChild(el);
  return el;
}

function fill(id, lang) {
  const data = texts[lang] || {};
  const info = { ...data[baseId(id)], ...data[id] };   // a golden card inherits what its entry lacks
  const races = (info.r || []).map(r => t(`race.${r}`)).join('・');
  const meta = [info.t ? t('tip.tier', { n: info.t }) : '', races, /_G$/.test(id) ? t('tip.golden') : ''].filter(Boolean).join(' · ');
  el.innerHTML = `<div class="tn">${escHtml(card(id))}</div>`
    + (meta ? `<div class="tm">${escHtml(meta)}</div>` : '')
    + `<div class="tx">${info.x ? effectHtml(info.x) : `<span class="mute">${escHtml(t('tip.none'))}</span>`}</div>`;
}

function place(target) {
  const r = target.getBoundingClientRect();
  el.style.left = '0px'; el.style.top = '0px';
  const w = el.offsetWidth, h = el.offsetHeight, m = 8;
  const x = Math.min(Math.max(m, r.left + r.width / 2 - w / 2), document.documentElement.clientWidth - w - m);
  let y = r.bottom + 6;
  if (y + h > innerHeight - m && r.top - h - 6 > m) y = r.top - h - 6;   // no room below: above it
  el.style.left = `${x + scrollX}px`;
  el.style.top = `${y + scrollY}px`;
}

async function show(target) {
  const id = target.dataset.card;
  if (!id || !target.isConnected) { hide(); return; }
  ensureEl();
  clearTimeout(hideTimer);
  if (openFor && openFor !== target) openFor.removeAttribute('aria-describedby');
  openFor = target;
  target.setAttribute('aria-describedby', 'cardtip');
  const lang = getLang();
  await load(lang);
  if (openFor !== target || !target.isConnected) return;   // another card was opened meanwhile
  fill(id, lang);
  el.hidden = false;
  place(target);
}

function hide() {
  clearTimeout(hideTimer);
  if (openFor) openFor.removeAttribute('aria-describedby');
  openFor = null; pinned = false;
  if (el) el.hidden = true;
}

// A short delay, so the pointer can cross the gap between the minion and its card.
function hideSoon() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hide, 150);
}

export function initCardTip() {
  const find = e => (e.target instanceof Element ? e.target.closest('.m[data-card]') : null);
  document.addEventListener('pointerover', e => {
    if (e.pointerType === 'touch' || pinned) return;
    const m = find(e);
    if (m && m !== openFor) show(m);
  });
  document.addEventListener('pointerout', e => {
    if (e.pointerType === 'touch' || pinned) return;
    const m = find(e);
    if (m && m === openFor && !m.contains(e.relatedTarget) && !(el && el.contains(e.relatedTarget))) hideSoon();
  });
  // Keyboard: the card follows the focused minion and goes when the focus moves on.
  document.addEventListener('focusin', e => {
    const m = find(e);
    if (m) { if (m !== openFor) { pinned = false; show(m); } } else if (!(el && el.contains(e.target))) hide();
  });
  // Click or tap: keep the card open (a second click on it, or a click elsewhere, closes it).
  document.addEventListener('click', e => {
    const m = find(e);
    if (m && !(pinned && openFor === m)) { pinned = true; show(m); return; }
    if (!(el && el.contains(e.target))) hide();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
  addEventListener('scroll', () => { if (openFor && el && !el.hidden) place(openFor); }, { capture: true, passive: true });   // capture: a scrolling board does not bubble
  addEventListener('resize', hide);
  addEventListener('hashchange', hide);
  onLangChange(() => { if (openFor) show(openFor); });
}
