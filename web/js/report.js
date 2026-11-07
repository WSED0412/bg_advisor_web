// HTML for one reviewed game (same layout as bg_advisor/report.py).
//
// Format-2 reports are rendered in the chosen language (renderGame); older reports keep the
// Chinese text they were stored with (renderGameLegacy).

import { t, card } from './i18n.js';

const KW_ZH = { TAUNT: '嘲諷', DIVINE_SHIELD: '聖盾', REBORN: '復生', POISONOUS: '劇毒', VENOMOUS: '猛毒',
  STEALTH: '潛行', CLEAVE: '順劈', IMMUNE: '免疫', WINDFURY: '風怒', MEGA_WINDFURY: '超級風怒' };
const RESULT_ZH = { me: '勝', opp: '敗', tie: '和' };

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Card art (tools/gen_art.py, from HearthstoneJSON): web/art/tiles/<id>.webp, a strip behind a
// minion's name; web/art/heroes/<id>.webp, a hero's portrait. A golden card uses its normal
// card's art. Ids from imported reports go into a URL, so only plain ids are used; a missing
// file just leaves the text as it was.
const ART = new URL('../art/', import.meta.url).href;
const artId = id => {
  const a = String(id || '').replace(/_G$/, '');
  return /^[A-Za-z0-9_]{1,80}$/.test(a) ? a : '';
};
const tileAttr = id => (artId(id) ? ` style="--art:url('${ART}tiles/${artId(id)}.webp')"` : '');

/** A hero's round portrait, or nothing (also when the file is missing). */
export function heroIcon(id, big = false) {
  const a = artId(id);
  return a ? `<img class="hero-ico${big ? ' big' : ''}" src="${ART}heroes/${a}.webp" alt="" loading="lazy" onerror="this.remove()">` : '';
}
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
    return `<div class="m art${m.golden ? ' gold' : ''}" data-card="${esc(m.card)}" tabindex="0"${tileAttr(m.card)}><span class="n">${esc(m.name)}</span>`
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
  const dmg = r.result !== 'tie' && r.damage ? `，${r.result === 'me' ? '造成' : '受到'} ${r.damage} 點傷害` : '';
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
    + `<p class="small"><a href="#" data-export="${esc(res.key)}" class="mute">匯出這份報告</a>　`
    + `<a href="#" data-delete="${esc(res.key)}" class="mute">刪除這份報告</a></p>`;
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
    return `<div class="m art${m.golden ? ' gold' : ''}" data-card="${esc(m.card)}" tabindex="0"${tileAttr(m.card)}><span class="n">${esc(card(m.card))}</span>`
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
const PICK_KINDS = ['buy', 'discover'];

function subject(d, withCards = false) {
  if (d.kind === 'buy' || d.kind === 'discover') {
    // Older reports (one round only) carry no span.
    const k = d.span ? d.span.length : ('score' in d ? 1 : 0);
    const sfx = k ? 'N' : 'Plain';
    if (d.kind === 'buy') return t('d.buy' + sfx, { k });
    return d.card ? t('d.discoverFrom' + sfx, { card: card(d.card), k }) : t('d.discover' + sfx, { k });
  }
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
  if (o.pos === undefined) return `${card(o.card)} ${o.atk}/${o.hp}`;  // a pick: the minion itself
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
  const tag = PICK_KINDS.includes(d.kind) ? `・${t('r.pickTag')}` : '';
  return `<h3>${esc(subject(d))} ${scoreHtml(d.score)} <span class="mute small">${esc(verdictOf(d.score) + tag)}</span></h3>`
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
  const dmg = !r.damage ? '' : r.result === 'me' ? t('r.dealt', { n: r.damage }) : r.result === 'opp' ? t('r.taken', { n: r.damage }) : '';
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
    + `<span class="mute">${heroIcon(r.opp_hero)}${esc(t('r.vs', { name, hero: card(r.opp_hero), tier: r.opp_tier ?? '?', dmg }))}</span></div>${ch}${changed}`
    + `<div class="small mute" style="margin-top:8px">${esc(t('r.oppBoard'))}</div>${board2(r.opp_board)}`
    + `<div class="small mute">${esc(t('r.myBoard', { tier: r.my_tier ?? '?', hp: r.my_health ?? '?' }))}</div>${board2(r.my_board)}`
    + `${positioning2(r)}${decs}${skipped}${notes2(r.notes)}</section>`;
}

/** The hero shown for a report (format 1 stored a Chinese name). */
export const heroName = res => (res.format >= 2 ? card(res.hero) : res.hero_name);


/** "Where this game was lost": the combats with the most damage taken. */
function lossesHtml(s) {
  const ls = s.losses || [];
  if (!ls.length) return '';
  const items = ls.map(x => {
    const eq = x.equity === null || x.equity === undefined ? '' : t('r.lossEq', { eq: pct(x.equity) });
    const tiers = t('r.lossTiers', { mine: x.my_tier, opp: x.opp_tier }) + (x.behind ? t('r.lossBehind') : '') + t('r.lossTiersEnd');
    return `<li><a href="#" data-round="${x.round}">${esc(t('r.lossRound', { round: x.round }))}</a> `
      + `${esc(t('r.lossDmg', { dmg: x.damage }) + eq + t('r.colon') + t(`cause.${x.cause}`))}`
      + ` <span class="mute small">${esc(tiers)}</span></li>`;
  }).join('');
  return `<h3>${esc(t('r.losses'))} <span class="mute small">${esc(t('r.lossesSub', { dmg: s.damage_taken || 0 }))}</span></h3><ul>${items}</ul>`;
}

/** Luck: what the player did not choose, against what was expected (not in any score). */
function luckHtml(l) {
  if (!l) return '';
  const c = l.combat;
  let h = `<h3>${esc(t('r.luck'))} <span class="luck luck-${l.verdict}">${esc(t(`luck.${l.verdict}`))}</span></h3>`;
  if (c.rounds.length) {
    h += `<p>${esc(t('r.luckCombat', { exp: c.expected_wins.toFixed(1), real: c.wins.toFixed(1),
                                          expDmg: Math.round(c.expected_taken), dmg: c.taken }))}</p>`;
    const odd = c.rounds.filter(x => Math.abs(x.luck) >= 0.5).sort((a, b) => a.luck - b.luck || a.round - b.round);
    if (odd.length) {
      h += '<ul>' + odd.map(x => {
        const what = x.real === 0 ? 'lost' : x.real === 1 ? 'won' : x.luck < 0 ? 'tieDown' : 'tieUp';
        return `<li><a href="#" data-round="${x.round}">${esc(t('r.lossRound', { round: x.round }))}</a> `
          + `${esc(t('r.luckRound', { eq: pct(x.equity) }) + t(`luck.${what}`))}</li>`;
      }).join('') + '</ul>';
    }
  }
  const ds = l.discovers || [];
  if (ds.length) {
    const rows = ds.map(d => {
      const src = d.source ? card(d.source) : t('r.luckDiscover');
      const opts = d.offered.map(o => `${esc(card(o.card))} <span class="mute">${pct(o.equity)}</span>`).join('、');
      const verdictCell = d.flat ? `<span class="mute">${esc(t('r.luckFlat'))}</span>`
        : `<b>${pct(d.percentile)}</b> <span class="mute small">${esc(t('r.luckExpected', { eq: pct(d.expected_best) }))}</span>`;
      return `<tr><td><a href="#" data-round="${d.round}">R${d.round}</a></td><td>${esc(src)}</td><td>${opts}</td>`
        + `<td>${verdictCell}</td><td class="mute">${d.pool_size}</td></tr>`;
    }).join('');
    h += `<div class="tablewrap"><table><tr><th>${esc(t('r.tempoRound'))}</th><th>${esc(t('r.luckSource'))}</th>`
      + `<th>${esc(t('r.luckOffered'))}</th><th>${esc(t('r.luckPct'))}</th><th>${esc(t('r.luckPool'))}</th></tr>${rows}</table></div>`;
  }
  return h + `<p class="note">${esc(t('r.luckNote'))}</p>`;
}

/** Per player: health after each round (null once knocked out), in final standing order. */
function lifeRows(standings) {
  const rows = new Map();
  standings.forEach((st, i) => {
    for (const p of st.players) {
      if (!rows.has(p.pid)) rows.set(p.pid, { pid: p.pid, hero: p.hero, me: p.me, life: standings.map(() => null), out: null });
      const r = rows.get(p.pid);
      if (r.out === null) {
        r.life[i] = Math.max(0, p.life);
        if (p.life <= 0) r.out = i;
      }
      r.place = p.place;
      if (p.player) r.player = p.player;
    }
  });
  return [...rows.values()].sort((a, b) => (a.place || 9) - (b.place || 9) || (b.me - a.me));
}

/** "Hero (player)" for a line of the chart; just the hero for a player I never fought. */
function lifeName(hero, player, me) {
  if (me) return t('r.lifeMe', { name: card(hero) });
  if (!player) return card(hero);
  return t('r.lifeWho', { hero: card(hero), player: player.length > 12 ? player.slice(0, 11) + '…' : player });
}

/** Rough width of a label in the chart's units (CJK characters are about twice as wide). */
function labelWidth(text, big) {
  let w = 0;
  for (const ch of text) w += ch.codePointAt(0) >= 0x1100 ? 11 : 6.3;
  return big ? w * 1.15 : w;
}

/** Label positions: each at its line's end, or the nearest free spot above or below it. */
function spreadLabels(labels, top, bottom, gap = 12) {
  const placed = [];
  for (const lb of [...labels].sort((a, b) => b.col - a.col || a.y - b.y)) {
    lb.w = labelWidth(lb.text, lb.me);
    const free = y => y >= top && y <= bottom
      && !placed.some(p => lb.x < p.x + p.w && p.x < lb.x + lb.w && Math.abs(p.y - y) < gap);
    const y0 = Math.min(Math.max(lb.y, top), bottom);
    for (let k = 0; k < 60; k++) {
      const y = y0 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * gap;  // 0, +1, -1, +2, -2... steps
      if (free(y)) { lb.y = y; break; }
    }
    placed.push(lb);
  }
  return labels;
}

/** My health's rank among the players still alive, after each round. */
function myRank(standings) {
  return standings.map(st => {
    const me = st.players.find(p => p.me);
    const alive = st.players.filter(p => p.life > 0);
    if (!me || me.life <= 0) return '—';
    return `${1 + alive.filter(p => p.life > me.life).length}/${alive.length}`;
  });
}

/** Every player's health after each round: mine highlighted, the others in grey. */
function lifeHtml(standings) {
  if (!standings || standings.length < 2) return '';
  const rows = lifeRows(standings);
  const rounds = standings.map(st => st.round);
  const [w, h, l, r, tp, b] = [800, 240, 30, 190, 10, 24];  // room on the right for the names
  let top = Math.max(10, ...rows.flatMap(x => x.life.filter(v => v !== null)));
  top = Math.ceil(top / 10) * 10;
  const px = i => l + (w - l - r) * i / (rounds.length - 1);
  const py = v => tp + (h - tp - b) * (1 - v / top);
  const f = v => v.toFixed(1);
  let grid = '';
  for (let v = 0; v <= top; v += 10) {
    grid += `<line x1="${l}" x2="${w - r}" y1="${f(py(v))}" y2="${f(py(v))}" class="lc-grid"/>`
      + `<text x="${l - 6}" y="${f(py(v) + 4)}" text-anchor="end" class="lc-ax">${v}</text>`;
  }
  const xs = rounds.map((n, i) => `<text x="${f(px(i))}" y="${h - 6}" text-anchor="middle" class="lc-ax">${n}</text>`).join('');
  let lines = '';
  const labels = [];
  for (const x of [...rows].sort((a, b) => a.me - b.me)) {  // mine drawn last, on top
    const pts = x.life.map((v, i) => (v === null ? null : [px(i), py(v), i])).filter(Boolean);
    if (!pts.length) continue;
    const cls = x.me ? 'lc-me' : 'lc-other';
    const name = lifeName(x.hero, x.player, x.me);
    lines += `<polyline points="${pts.map(([a, c]) => `${f(a)},${f(c)}`).join(' ')}" class="${cls}"><title>${esc(name)}</title></polyline>`;
    const [la, lc, li] = pts[pts.length - 1];
    if (x.out !== null) lines += `<path d="M${f(la - 4)},${f(lc - 4)}l8,8m0,-8l-8,8" class="${cls} lc-x"/>`;
    if (x.me) lines += pts.map(([a, c]) => `<circle cx="${f(a)}" cy="${f(c)}" r="3.5" class="lc-dot"/>`).join('');
    labels.push({ x: la + 8, y: lc + 4, col: li, me: x.me, text: name });
  }
  for (const lb of spreadLabels(labels, tp + 8, h - b)) {
    lines += `<text x="${f(lb.x)}" y="${f(lb.y)}" class="${lb.me ? 'lc-lbl' : 'lc-olbl'}">${esc(lb.text)}</text>`;
  }
  const step = (w - l - r) / (rounds.length - 1);
  const out = new Map(rows.map(x => [x.pid, x.out]));
  const who = new Map(rows.map(x => [x.pid, x.player]));
  const hits = standings.map((st, i) => {
    // The players still in the game, and those knocked out in this round.
    const ps = [...st.players].sort((a, b) => b.life - a.life).filter(p => p.life > 0 || out.get(p.pid) === i);
    const tip = [t('r.lifeAfter', { round: st.round }),
      ...ps.map(p => `${p.me ? '▶ ' : ''}${lifeName(p.hero, who.get(p.pid), p.me)}　${p.life > 0 ? p.life : t('r.lifeOut')}`)];
    return `<rect x="${f(px(i) - step / 2)}" y="${tp}" width="${f(step)}" height="${h - tp - b}" class="lc-hit">`
      + `<title>${esc(tip.join('\n'))}</title></rect>`;
  }).join('');
  const svg = `<svg viewBox="0 0 ${w} ${h}" class="lifechart" role="img" aria-label="${esc(t('r.lifeAria'))}">${grid}${xs}${lines}${hits}</svg>`;
  const body = rows.map(x => {
    const name = lifeName(x.hero, x.player, x.me);
    const place = x.place ? ` <span class="mute small">${esc(t('r.place', { place: x.place }))}</span>` : '';
    const cells = x.life.map((v, i) => `<td>${v === null ? '' : i === x.out ? '×' : v}</td>`).join('');
    return `<tr${x.me ? ' class="mine"' : ''}><th>${esc(name)}${place}</th>${cells}</tr>`;
  }).join('');
  return `<h3>${esc(t('r.life'))} <span class="mute small">${esc(t('r.lifeSub'))}</span></h3>${svg}`
    + `<p class="note">${esc(t('r.lifeNote'))}</p>`
    + `<details><summary>${esc(t('r.lifeTable'))}</summary><div class="tablewrap"><table class="tempo">`
    + `<tr><th>${esc(t('r.tempoRound'))}</th>${rounds.map(n => `<th>${n}</th>`).join('')}</tr>`
    + `<tr><th>${esc(t('r.lifeRank'))}</th>${myRank(standings).map(v => `<td>${v}</td>`).join('')}</tr>${body}</table></div></details>`;
}

/** Tavern tier per round against the opponent's and a common pace. */
function tempoHtml(s) {
  const tp = s.tempo || [];
  if (!tp.length) return '';
  const row = (label, cells) => `<tr><th>${esc(label)}</th>${cells}</tr>`;
  return `<h3>${esc(t('r.tempo'))}</h3><div class="tablewrap"><table class="tempo">`
    + row(t('r.tempoRound'), tp.map(x => `<th>${x.round}</th>`).join(''))
    + row(t('r.tempoMine'), tp.map(x => `<td${x.my_tier < x.typical ? ' class="behind"' : ''}>${x.my_tier}</td>`).join(''))
    + row(t('r.tempoOpp'), tp.map(x => `<td>${x.opp_tier || '—'}</td>`).join(''))
    + row(t('r.tempoTypical'), tp.map(x => `<td class="mute">${x.typical}</td>`).join(''))
    + row(t('r.tempoHealth'), tp.map(x => `<td>${x.health ?? '—'}</td>`).join(''))
    + `</table></div><p class="note">${esc(t('r.tempoNote'))}</p>`;
}

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
    + `<section class="card"><div class="top"><div><h1>${res.format >= 2 ? heroIcon(res.hero, true) : ''}${esc(heroName(res))}</h1>`
    + `<div class="mute small">${esc(res.date)}・${esc(res.player)}・${esc(t('r.client', { build: res.build }))}</div></div>`
    + `<div class="place ${placeCls(place)}">${esc(place ? t('r.place', { place }) : t('r.placeUnknown'))}</div></div>`
    + `<div class="tiles">${tiles}</div><div class="strip">${strip}</div>`
    + `<h3>${esc(t('r.attention'))}</h3><ul>${missHtml}</ul>${lossesHtml(s)}${lifeHtml(res.standings)}${luckHtml(res.luck)}${tempoHtml(s)}${warn}</section>`
    + rounds.map(round2).join('')
    + `<p class="note">${esc(t('r.footer'))}</p>`
    + `<p class="note">${esc(t('r.pickFooter'))}</p>`
    + `<details class="card help scoring"><summary>${esc(t('r.scoring.summary'))}</summary>${t('r.scoring.body')}</details>`
    + `<p class="small"><a href="#" data-export="${esc(res.key)}" class="mute">${esc(t('r.export'))}</a>　`
    + `<a href="#" data-delete="${esc(res.key)}" class="mute">${esc(t('r.delete'))}</a></p>`;
}
