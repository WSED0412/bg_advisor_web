// HTML for one reviewed game (same layout as bg_advisor/report.py).
//
// Format-2 reports are rendered in the chosen language (renderGame); older reports keep the
// Chinese text they were stored with (renderGameLegacy).

import { t, card } from './i18n.js';

const KW_ZH = { TAUNT: '嘲諷', DIVINE_SHIELD: '聖盾', REBORN: '復生', POISONOUS: '劇毒', VENOMOUS: '猛毒',
  STEALTH: '潛行', CLEAVE: '順劈', IMMUNE: '免疫', WINDFURY: '風怒', MEGA_WINDFURY: '超級風怒' };
const RESULT_ZH = { me: '勝', opp: '敗', tie: '和' };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = x => `${Math.round(x * 100)}%`;
const signed = x => (x >= 0 ? '+' : '') + x.toFixed(1);

export const scoreCls = s => (s === null || s === undefined ? 's-none' : s >= 91 ? 's-good' : s >= 70 ? 's-ok' : 's-bad');
export const scoreHtml = s => `<span class="score ${scoreCls(s)}">${s === null || s === undefined ? '—' : s}</span>`;
export const placeCls = p => (!p ? 'p-unk' : p <= 4 ? 'p-top' : 'p-bot');

function bar(o) {
  const w = o.win * 100, t = o.tie * 100, l = o.loss * 100;
  return `<span class="bar" title="勝 ${w.toFixed(0)}% 和 ${t.toFixed(0)}% 敗 ${l.toFixed(0)}%">`
    + `<i class="bw" style="width:${w.toFixed(1)}%"></i><i class="bt" style="width:${t.toFixed(1)}%"></i>`
    + `<i class="bl" style="width:${l.toFixed(1)}%"></i></span>`;
}

const otext = o => `勝 ${pct(o.win)}・和 ${pct(o.tie)}・敗 ${pct(o.loss)}<span class="mute">（淨傷害 ${signed(o.net_damage)}）</span>`;

function board(ms) {
  if (!ms || !ms.length) return '<div class="note">（沒有隨從）</div>';
  return `<div class="board">${ms.map(m => {
    const kws = m.keywords.map(k => KW_ZH[k] || k).join('・');
    return `<div class="m${m.golden ? ' gold' : ''}" title="${esc(m.card)}"><span class="n">${esc(m.name)}</span>`
      + `<span class="st">${m.atk}/${m.hp}</span>${kws ? ` <span class="kw">${esc(kws)}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

function order(names, other = null) {
  return `<div class="order">${names.map((n, i) => {
    const diff = other !== null && (i >= other.length || other[i] !== n);
    return `<span class="${diff ? 'diff' : ''}">${i + 1}. ${esc(n)}</span>`;
  }).join('')}</div>`;
}

function positioning(r) {
  const p = r.positioning;
  if (!p) {
    const sim = r.sim_outcome;
    const extra = sim ? `<div class="row"><span class="lbl">模擬</span>${bar(sim)}<span>${otext(sim)}</span></div>` : '';
    return r.positioning_skip
      ? `<h3>站位 ${scoreHtml(null)}</h3><div class="note">${esc(r.positioning_skip)}</div>${extra}` : extra;
  }
  const same = p.mine.join('\u0001') === p.best.join('\u0001');
  let h = `<h3>站位 ${scoreHtml(p.score)} <span class="mute small">${esc(p.verdict)}・共 ${p.arrangements} 種排法</span></h3>`
    + `<div class="row"><span class="lbl">你的</span>${order(p.mine)}</div>`
    + `<div class="row"><span class="lbl"></span>${bar(p.mine_outcome)}<span>${otext(p.mine_outcome)}</span></div>`;
  if (!same) {
    h += `<div class="row"><span class="lbl">最佳</span>${order(p.best, p.mine)}</div>`
      + `<div class="row"><span class="lbl"></span>${bar(p.best_outcome)}<span>${otext(p.best_outcome)}</span></div>`;
    const alts = p.alternatives.map((a, i) => {
      const more = a.count - 1;
      return `<tr class="${a.mine ? 'mine' : ''}${i === 0 ? ' best' : ''}"><td>${i + 1}</td><td>${bar(a.outcome)}</td>`
        + `<td>${otext(a.outcome)}</td><td>${esc(a.names.join(' | '))}${a.mine ? ' ← 你的' : ''}`
        + `${more ? `<span class="mute">（另有 ${more} 種排法結果相同）</span>` : ''}</td></tr>`;
    }).join('');
    h += `<details><summary>其他排法</summary><div class="tablewrap"><table>${alts}</table></div></details>`;
  }
  return h;
}

function decision(d) {
  const rows = d.options.map((o, i) => `<tr class="${o.mine ? 'mine' : ''}${i === 0 ? ' best' : ''}">`
    + `<td>${esc(o.label)}${o.mine ? ' ← 你的' : ''}</td><td>${bar(o.outcome)}</td><td>${otext(o.outcome)}</td></tr>`).join('');
  const notes = (d.notes || []).map(n => `<div class="note">注意：${esc(n)}</div>`).join('');
  return `<h3>${esc(d.title)} ${scoreHtml(d.score)} <span class="mute small">${esc(d.verdict)}</span></h3>`
    + `<div class="tablewrap"><table>${rows}</table></div>${notes}`;
}

function round(r) {
  if (!('result' in r)) {
    return `<section class="card" id="r${r.round}"><div class="top"><h2>第 ${r.round} 回合</h2></div><div class="note">沒有戰鬥紀錄</div></section>`;
  }
  const res = RESULT_ZH[r.result] || '?';
  const dmg = r.result !== 'tie' ? `，${r.result === 'me' ? '造成' : '受到'} ${r.damage} 點傷害` : '';
  let ch = '';
  if (r.chance !== undefined && r.chance !== null) {
    ch = `<div class="note">實際結果在模擬中的機率：${pct(r.chance)}${r.chance < 0.10 ? '（偏低，這場模擬可能不準）' : ''}</div>`;
  }
  const changed = r.changed_cards ? `<div class="warn">這場有數值和模擬器不同的隨從：${esc(r.changed_cards.join('、'))}</div>` : '';
  const notes = (r.notes || []).map(n => `<div class="note">注意：${esc(n)}</div>`).join('');
  const decs = (r.decisions || []).map(decision).join('');
  let skipped = '';
  if (r.skipped && r.skipped.length) {
    skipped = `<details><summary>沒有評分的決策（${r.skipped.length}）</summary><ul class="small">`
      + r.skipped.map(s => `<li>${esc(s.title)}：${esc(s.reason)}</li>`).join('') + '</ul></details>';
  }
  return `<section class="card" id="r${r.round}">`
    + `<div class="top"><h2>第 ${r.round} 回合 <span class="pill r-${r.result}">${res}</span></h2>`
    + `<span class="mute">vs ${esc(r.opponent)}（${esc(r.opp_hero_name)}，${r.opp_tier ?? '?'}星旅店）${dmg}</span></div>${ch}${changed}`
    + `<div class="small mute" style="margin-top:8px">對手陣容</div>${board(r.opp_board)}`
    + `<div class="small mute">你的陣容（${r.my_tier ?? '?'}星旅店，血量 ${r.my_health ?? '?'}）</div>${board(r.my_board)}`
    + `${positioning(r)}${decs}${skipped}${notes}</section>`;
}

/** Format-1 reports (Chinese text stored in the report). */
function renderGameLegacy(res) {
  const s = res.summary || {};
  const place = res.place || 0;
  const rounds = res.rounds;
  const strip = rounds.map(r => `<a href="#" data-round="${r.round}"><span class="dot r-${r.result || 'tie'}"></span>`
    + `R${r.round}${r.positioning ? ' ' + scoreHtml(r.positioning.score) : ''}</a>`).join('');
  const misses = s.misplays || [];
  const missHtml = misses.length
    ? misses.map(m => `<li><a href="#" data-round="${m.round}">第 ${m.round} 回合 ${esc(m.what)}</a>（${m.score} 分）</li>`).join('')
    : '<li>沒有明顯失誤</li>';
  let warn = '';
  if (res.card_changes && res.card_changes.length) {
    warn += `<div class="warn">紀錄檔裡有隨從數值和模擬器不同（可能是改版或熱修），相關回合的模擬可能有偏差：<ul>`
      + res.card_changes.map(c => `<li>${esc(c)}</li>`).join('') + '</ul></div>';
  }
  if (res.complete === false) warn += '<div class="warn">這局的紀錄檔沒有結束標記（還在進行或中途離開），報告可能不完整。</div>';
  if (res.precision === 'quick') warn += '<div class="note">這份報告用「快速」模式分析，分數的誤差比較大。</div>';
  const tile = (label, val, sub) => `<div class="tile"><span class="mute small">${label}</span><b>${val}</b><span class="mute small">${sub}</span></div>`;
  const pa = s.positioning_avg, da = s.decisions_avg;
  const tiles = tile('站位平均', pa ?? '—', `${s.positioning_n || 0} 個回合有評分`)
    + tile('其他決策平均', da ?? '—', `${s.decisions_n || 0} 個決策`)
    + tile('明顯失誤', misses.length, '70 分以下')
    + tile('回合數', rounds.filter(r => 'result' in r).length, '有戰鬥紀錄');
  return `<a href="#/" class="small mute">← 所有對局</a>`
    + `<section class="card"><div class="top"><div><h1>${esc(res.hero_name)}</h1>`
    + `<div class="mute small">${esc(res.date)}・${esc(res.player)}・客戶端 ${res.build}</div></div>`
    + `<div class="place ${placeCls(place)}">${place ? `第 ${place} 名` : '名次不明'}</div></div>`
    + `<div class="tiles">${tiles}</div><div class="strip">${strip}</div>`
    + `<h3>需要注意的地方</h3><ul>${missHtml}</ul>${warn}</section>`
    + rounds.map(round).join('')
    + `<p class="note">分數：91 以上接近最佳、70–90 還可以更好、70 以下明顯失誤。勝率是和「當回合實際遇到的對手陣容」模擬對戰的結果，`
    + `平手算半場勝；怎麼排都很難贏的回合改用受到的傷害評分。決策是用做決定當下的陣容評估。</p>`
    + `<p class="small"><a href="#" data-delete="${esc(res.key)}" class="mute">刪除這份報告</a></p>`;
}

// ---------------------------------------------------------------- format 2 (any language)

const verdictOf = score => t(score === null || score === undefined ? 'verdict.none'
  : score >= 91 ? 'verdict.good' : score >= 70 ? 'verdict.ok' : 'verdict.bad');

const otext2 = o => esc(t('r.outcome', { w: pct(o.win), t: pct(o.tie), l: pct(o.loss) }))
  + `<span class="mute">${esc(t('r.netDamage', { d: signed(o.net_damage) }))}</span>`;

function board2(ms) {
  if (!ms || !ms.length) return `<div class="note">${esc(t('r.noMinions'))}</div>`;
  return `<div class="board">${ms.map(m => {
    const kws = m.keywords.map(k => t(`r.kw.${k}`)).join('・');
    return `<div class="m${m.golden ? ' gold' : ''}" title="${esc(m.card)}"><span class="n">${esc(card(m.card))}</span>`
      + `<span class="st">${m.atk}/${m.hp}</span>${kws ? ` <span class="kw">${esc(kws)}</span>` : ''}</div>`;
  }).join('')}</div>`;
}

function order2(ids, other = null) {
  return `<div class="order">${ids.map((id, i) => {
    const diff = other !== null && (i >= other.length || other[i] !== id);
    return `<span class="${diff ? 'diff' : ''}">${i + 1}. ${esc(card(id))}</span>`;
  }).join('')}</div>`;
}

const noteText = n => (typeof n === 'string' ? n : t(`note.${n.code}`, { card: card(n.card) }));
const notes2 = ns => (ns || []).map(n => `<div class="note">${esc(t('r.note', { text: noteText(n) }))}</div>`).join('');

/** "Target of X" / "Where to put X" / "Play order (A → B)" / "Positioning". */
function subject(d, withCards = false) {
  if (d.kind === 'target') return t('d.target', { card: card(d.card) });
  if (d.kind === 'magnetize') return t('d.magnetize', { card: card(d.card) });
  if (d.kind === 'order') {
    return withCards && d.cards ? t('d.orderOf', { cards: d.cards.map(card).join(t('d.then')) }) : t('d.order');
  }
  return t('r.positioning');
}

function optionText(kind, o) {
  if (!o) return '';
  if (o.alone) return t('d.alone');
  if (o.cards) return o.cards.map(card).join(t('d.then'));
  return t(kind === 'magnetize' ? 'd.attach' : 'd.slot', { card: card(o.card), pos: o.pos });
}

function positioning2(r) {
  const p = r.positioning;
  if (!p) {
    const sim = r.sim_outcome;
    const extra = sim ? `<div class="row"><span class="lbl">${esc(t('r.sim'))}</span>${bar(sim)}<span>${otext2(sim)}</span></div>` : '';
    if (!r.pos_skip) return extra;
    return `<h3>${esc(t('r.positioning'))} ${scoreHtml(null)}</h3>`
      + `<div class="note">${esc(t(`pos.skip.${r.pos_skip.code}`, r.pos_skip))}</div>${extra}`;
  }
  const same = p.mine_cards.join() === p.best_cards.join();
  let h = `<h3>${esc(t('r.positioning'))} ${scoreHtml(p.score)} <span class="mute small">${esc(verdictOf(p.score))}・${esc(t('r.arrangements', { n: p.arrangements }))}</span></h3>`
    + `<div class="row"><span class="lbl">${esc(t('r.yours'))}</span>${order2(p.mine_cards)}</div>`
    + `<div class="row"><span class="lbl"></span>${bar(p.mine_outcome)}<span>${otext2(p.mine_outcome)}</span></div>`;
  if (!same) {
    h += `<div class="row"><span class="lbl">${esc(t('r.best'))}</span>${order2(p.best_cards, p.mine_cards)}</div>`
      + `<div class="row"><span class="lbl"></span>${bar(p.best_outcome)}<span>${otext2(p.best_outcome)}</span></div>`;
    const alts = p.alternatives.map((a, i) => {
      const more = a.count - 1;
      return `<tr class="${a.mine ? 'mine' : ''}${i === 0 ? ' best' : ''}"><td>${i + 1}</td><td>${bar(a.outcome)}</td>`
        + `<td>${otext2(a.outcome)}</td><td>${esc(a.cards.map(card).join(' | '))}${a.mine ? esc(t('r.mine')) : ''}`
        + `${more ? `<span class="mute">${esc(t('r.sameResult', { n: more }))}</span>` : ''}</td></tr>`;
    }).join('');
    h += `<details><summary>${esc(t('r.otherOrders'))}</summary><div class="tablewrap"><table>${alts}</table></div></details>`;
  }
  return h;
}

function decision2(d) {
  const rows = d.options.map((o, i) => `<tr class="${o.mine ? 'mine' : ''}${i === 0 ? ' best' : ''}">`
    + `<td>${esc(optionText(d.kind, o.opt))}${o.mine ? esc(t('r.mine')) : ''}</td><td>${bar(o.outcome)}</td><td>${otext2(o.outcome)}</td></tr>`).join('');
  return `<h3>${esc(subject(d))} ${scoreHtml(d.score)} <span class="mute small">${esc(verdictOf(d.score))}</span></h3>`
    + `<div class="tablewrap"><table>${rows}</table></div>${notes2(d.notes)}`;
}

function skipParams(s) {
  const p = { ...(s.params || {}) };
  for (const k of ['card', 'sim', 'real']) if (p[k]) p[k] = card(p[k]);
  return p;
}

function round2(r) {
  if (!('result' in r)) {
    return `<section class="card" id="r${r.round}"><div class="top"><h2>${esc(t('r.round', { round: r.round }))}</h2></div>`
      + `<div class="note">${esc(t('r.noCombat'))}</div></section>`;
  }
  const dmg = r.result === 'me' ? t('r.dealt', { n: r.damage }) : r.result === 'opp' ? t('r.taken', { n: r.damage }) : '';
  let ch = '';
  if (r.chance !== undefined && r.chance !== null) {
    ch = `<div class="note">${esc(t('r.chance', { p: pct(r.chance) }) + (r.chance < 0.10 ? t('r.chanceLow') : ''))}</div>`;
  }
  const changed = r.changed_ids ? `<div class="warn">${esc(t('r.changedHere', { names: r.changed_ids.map(card).join(t('r.listSep')) }))}</div>` : '';
  const decs = (r.decisions || []).map(decision2).join('');
  let skipped = '';
  if (r.skipped && r.skipped.length) {
    skipped = `<details><summary>${esc(t('r.skippedDecisions', { n: r.skipped.length }))}</summary><ul class="small">`
      + r.skipped.map(s => `<li>${esc(subject(s, true))}${esc(t('r.colon'))}${esc(t(`skip.${s.code}`, skipParams(s)))}</li>`).join('') + '</ul></details>';
  }
  const name = r.ghost ? t('r.ghost') : r.opponent;
  return `<section class="card" id="r${r.round}">`
    + `<div class="top"><h2>${esc(t('r.round', { round: r.round }))} <span class="pill r-${r.result}">${esc(t(`r.result.${r.result}`))}</span></h2>`
    + `<span class="mute">${esc(t('r.vs', { name, hero: card(r.opp_hero), tier: r.opp_tier ?? '?', dmg }))}</span></div>${ch}${changed}`
    + `<div class="small mute" style="margin-top:8px">${esc(t('r.oppBoard'))}</div>${board2(r.opp_board)}`
    + `<div class="small mute">${esc(t('r.myBoard', { tier: r.my_tier ?? '?', hp: r.my_health ?? '?' }))}</div>${board2(r.my_board)}`
    + `${positioning2(r)}${decs}${skipped}${notes2(r.notes)}</section>`;
}

/** The hero shown for a report (format 1 stored a Chinese name). */
export const heroName = res => (res.format >= 2 ? card(res.hero) : res.hero_name);

export function renderGame(res) {
  if (!(res.format >= 2)) return renderGameLegacy(res);
  const s = res.summary || {};
  const place = res.place || 0;
  const rounds = res.rounds;
  const strip = rounds.map(r => `<a href="#" data-round="${r.round}"><span class="dot r-${r.result || 'tie'}"></span>`
    + `R${r.round}${r.positioning ? ' ' + scoreHtml(r.positioning.score) : ''}</a>`).join('');
  const misses = s.misplays || [];
  const missHtml = misses.length
    ? misses.map(m => `<li><a href="#" data-round="${m.round}">${esc(t('r.miss', { round: m.round, what: subject(m), score: m.score }))}</a></li>`).join('')
    : `<li>${esc(t('r.noMisses'))}</li>`;
  let warn = '';
  if (res.changes && res.changes.length) {
    const st = x => t('r.stats', { atk: x[0], hp: x[1], tier: x[2] });
    warn += `<div class="warn">${esc(t('r.cardChanges'))}<ul>`
      + res.changes.map(c => `<li>${esc(t('r.cardChange', { name: card(c.card), engine: st(c.engine), client: st(c.client) }))}</li>`).join('')
      + '</ul></div>';
  }
  if (res.complete === false) warn += `<div class="warn">${esc(t('r.incomplete'))}</div>`;
  if (res.precision === 'quick') warn += `<div class="note">${esc(t('r.quick'))}</div>`;
  const tile = (label, val, sub) => `<div class="tile"><span class="mute small">${esc(label)}</span><b>${val}</b><span class="mute small">${esc(sub)}</span></div>`;
  const pa = s.positioning_avg, da = s.decisions_avg;
  const tiles = tile(t('r.tile.pos'), pa ?? '—', t('r.tile.pos.sub', { n: s.positioning_n || 0 }))
    + tile(t('r.tile.dec'), da ?? '—', t('r.tile.dec.sub', { n: s.decisions_n || 0 }))
    + tile(t('r.tile.miss'), misses.length, t('r.tile.miss.sub'))
    + tile(t('r.tile.rounds'), rounds.filter(r => 'result' in r).length, t('r.tile.rounds.sub'));
  return `<a href="#/" class="small mute">${esc(t('r.back'))}</a>`
    + `<section class="card"><div class="top"><div><h1>${esc(heroName(res))}</h1>`
    + `<div class="mute small">${esc(res.date)}・${esc(res.player)}・${esc(t('r.client', { build: res.build }))}</div></div>`
    + `<div class="place ${placeCls(place)}">${esc(place ? t('r.place', { place }) : t('r.placeUnknown'))}</div></div>`
    + `<div class="tiles">${tiles}</div><div class="strip">${strip}</div>`
    + `<h3>${esc(t('r.attention'))}</h3><ul>${missHtml}</ul>${warn}</section>`
    + rounds.map(round2).join('')
    + `<p class="note">${esc(t('r.footer'))}</p>`
    + `<p class="small"><a href="#" data-delete="${esc(res.key)}" class="mute">${esc(t('r.delete'))}</a></p>`;
}
