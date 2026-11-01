// Interface language (Traditional Chinese / English) and card names.
//
// t(key, vars) looks up a string; "{name}" placeholders are filled from vars. A value may be a
// function of vars for plurals and such. card(id) is the card's name in the current language.

let lang = 'zh';
const names = { zh: {}, en: {} };
const listeners = [];

export const getLang = () => lang;

export function initLang(saved) {
  lang = saved === 'en' || saved === 'zh' ? saved : (/^zh/i.test(navigator.language || '') ? 'zh' : 'en');
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
}

export function setLang(l) {
  initLang(l);
  for (const fn of listeners) fn(lang);
}

export const onLangChange = fn => listeners.push(fn);

export async function loadNames(base = new URL('../data/', import.meta.url)) {
  const get = async f => {
    try { return await (await fetch(new URL(f, base))).json(); } catch { return {}; }
  };
  [names.zh, names.en] = await Promise.all([get('names_zhTW.json'), get('names_en.json')]);
}

/** A card's name in the current language (falls back to the other language, then the id). */
export const card = id => (id ? names[lang][id] || names.en[id] || names.zh[id] || id : '');

export function t(key, vars = {}) {
  let s = STR[lang][key];
  if (s === undefined) s = STR.zh[key];
  if (s === undefined) return key;
  if (typeof s === 'function') return s(vars);
  return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
}

const STR = {
  zh: {
    'app.title': '英雄戰場復盤',
    'lang.switch': 'EN',
    'lang.switch.title': 'Switch to English',

    // status line
    'status.analyzing': '分析中…',
    'status.progress': '正在分析 {hero}：第 {round} 回合（{done}/{total}）',
    'status.loading': '載入模擬器…',
    'status.reading': '讀取紀錄檔…',
    'status.found': ({ n }) => (n ? `找到 ${n} 局新的對局` : '沒有新的英雄戰場對局'),
    'status.bridge': '已連線 HDT 外掛',
    'status.bridge.update': '・有新版外掛',
    'status.bridge.tooOld': '・外掛需要更新',
    'status.watching': '監看中：{dir}',
    'status.waitBridge': '等待 HDT 外掛…',
    'status.paused': '已暫停監看',
    'status.noFolder': '尚未設定紀錄檔資料夾',
    'status.searchBridge': '正在尋找 HDT 外掛…（瀏覽器若詢問「存取本機網路」請按允許）',

    // errors
    'err.worker': '分析程式出錯：{msg}',
    'err.folder': '無法開啟這個資料夾（{msg}）。如果是放在 Program Files 裡，請看下面的說明。',
    'err.noPowerLog': '「{dir}」裡找不到 Power.log。請選擇爐石安裝資料夾裡的 Logs 資料夾，並確認 log.config 有開啟 [Power] 紀錄。',
    'err.permission': '瀏覽器收回了讀取資料夾的權限，請按「繼續監看」。',
    'err.bridgeRead': '無法從外掛完整讀取 {source}',
    'err.noBridge': '找不到 HDT 外掛。請確認 Hearthstone Deck Tracker 有開著、「BG Advisor」外掛已啟用；如果瀏覽器曾詢問「存取本機網路／localhost」而被封鎖，請在網址列左邊的網站設定改回允許，再按一次「連線 HDT 外掛」。',
    'err.read': '無法讀取 {source}：{msg}',

    // setup card
    'btn.pickFolder': '選擇 Logs 資料夾',
    'btn.pickFile': '選擇 Power.log',
    'btn.analyzeAll': '分析資料夾裡所有對局',
    'btn.changeFolder': '更換資料夾',
    'btn.resume': '繼續監看',
    'btn.connectBridge': '連線 HDT 外掛',
    'btn.reconnect': '重新連線',
    'btn.forgetBridge': '不再使用外掛',
    'quick': '快速模式（較快、較不準）',
    'setup.first': '第一次使用：選擇爐石安裝資料夾裡的 <b>Logs</b> 資料夾（通常是 <code>C:\\Program Files (x86)\\Hearthstone\\Logs</code>）。之後開著這個分頁去打英雄戰場，每局結束就會自動分析。',
    'setup.lastFolder': '上次使用的資料夾：<b>{dir}</b>。瀏覽器需要你再按一次才能讀取。',
    'setup.brave': 'Brave 預設關閉了「讓網頁讀取資料夾」的功能，所以現在只能手動選擇或拖曳 Power.log。想要打完自動分析，可以開啟這個功能（只需要一次）：<ol><li>在網址列輸入 <code>brave://flags/#file-system-access-api</code></li><li>把「File System Access API」改成 <b>Enabled</b></li><li>按右下角的 <b>Relaunch</b> 重新啟動 Brave，再回到這個頁面</li></ol>',
    'setup.noWatch': '這個瀏覽器不支援自動監看資料夾（需要 Chrome、Edge，或開啟設定的 Brave）。可以在每局結束後，手動選擇或拖曳 Power.log 到這個頁面。',
    'setup.bridgeOn': '已連線 HDT 外掛（{version}）：每局英雄戰場結束後會自動分析，不需要設定資料夾。',
    'setup.bridgeNoLogs': '外掛找不到爐石的 Logs 資料夾，請確認 HDT 設定裡的爐石安裝路徑。',
    'setup.bridgeMissing': '找不到 HDT 外掛（連接埠 {port}）。請確認 Hearthstone Deck Tracker 有開著，而且「BG Advisor」外掛已啟用。如果瀏覽器問過「存取本機網路」而你按了封鎖，需要在網址列左邊的網站設定裡改回允許。',
    'setup.updateSteps': '<a href="{url}" download>下載新版外掛</a>，關閉 HDT，用它取代 <code>%AppData%\\HearthstoneDeckTracker\\Plugins\\BgAdvisorBridge.dll</code>（在新檔案上按右鍵 › 內容，勾選「解除封鎖」），再重新開啟 HDT。',
    'setup.tooOld': '外掛版本太舊（{version}），這個網頁需要 {min} 以上才能自動分析。',
    'setup.outdated': '有新版外掛：{version} → {latest}。',
    'plugin.summary': '有用 Hearthstone Deck Tracker？裝外掛就不用設定資料夾',
    'plugin.ready': '已經裝好外掛、HDT 也開著：',
    'plugin.steps': '<ol><li>下載 <a href="{url}" download>BgAdvisorBridge.dll</a>，在檔案上按右鍵 › 內容，勾選「解除封鎖」後按確定。</li><li>把它放進 <code>%AppData%\\HearthstoneDeckTracker\\Plugins</code>，重新啟動 HDT。</li><li>HDT 的 選項 › 追蹤器 › 外掛 裡啟用「BG Advisor」，再按一次「開啟復盤網頁」。</li><li>瀏覽器問「允許存取本機網路上的裝置」時按允許。</li></ol><p class="small mute">之後每局英雄戰場結束，HDT 會自動打開這局的報告。外掛只在本機 127.0.0.1 提供紀錄檔給這個網站，不會上傳任何東西。</p>',

    // list
    'list.empty': '還沒有報告。打完一局英雄戰場後會自動出現在這裡。',
    'list.rounds': '{n} 回合',
    'list.incomplete': '・未完成',
    'list.misses': ({ n }) => (n ? `明顯失誤 ${n} 個` : '沒有明顯失誤'),
    'list.positioning': '站位',
    'list.decisions': '決策',
    'list.notFound': '找不到這份報告。<a href="#/">回到列表</a>',
    'title.new': '● 新報告：{hero}｜英雄戰場復盤',
    'title.game': '{hero}{place}｜英雄戰場復盤',
    'title.place': ' 第 {place} 名',
    'confirm.delete': '刪除這份報告？',
    'drop': '放開以分析 Power.log',

    // report
    'r.back': '← 所有對局',
    'r.place': '第 {place} 名',
    'r.placeUnknown': '名次不明',
    'r.client': '客戶端 {build}',
    'r.tile.pos': '站位平均',
    'r.tile.pos.sub': '{n} 個回合有評分',
    'r.tile.dec': '其他決策平均',
    'r.tile.dec.sub': '{n} 個決策',
    'r.tile.miss': '明顯失誤',
    'r.tile.miss.sub': '70 分以下',
    'r.tile.rounds': '回合數',
    'r.tile.rounds.sub': '有戰鬥紀錄',
    'r.attention': '需要注意的地方',
    'r.noMisses': '沒有明顯失誤',
    'r.miss': '第 {round} 回合 {what}（{score} 分）',
    'r.cardChanges': '紀錄檔裡有隨從數值和模擬器不同（可能是改版或熱修），相關回合的模擬可能有偏差：',
    'r.cardChange': '{name}：模擬器 {engine}，你的客戶端 {client}',
    'r.stats': '{atk}/{hp}（{tier} 星）',
    'r.incomplete': '這局的紀錄檔沒有結束標記（還在進行或中途離開），報告可能不完整。',
    'r.quick': '這份報告用「快速」模式分析，分數的誤差比較大。',
    'r.round': '第 {round} 回合',
    'r.noCombat': '沒有戰鬥紀錄',
    'r.result.me': '勝', 'r.result.opp': '敗', 'r.result.tie': '和',
    'r.vs': 'vs {name}（{hero}，{tier}星旅店）{dmg}',
    'r.dealt': '，造成 {n} 點傷害',
    'r.taken': '，受到 {n} 點傷害',
    'r.ghost': '幽靈（已淘汰玩家）',
    'r.chance': '實際結果在模擬中的機率：{p}',
    'r.chanceLow': '（偏低，這場模擬可能不準）',
    'r.changedHere': '這場有數值和模擬器不同的隨從：{names}',
    'r.oppBoard': '對手陣容',
    'r.myBoard': '你的陣容（{tier}星旅店，血量 {hp}）',
    'r.noMinions': '（沒有隨從）',
    'r.colon': '：',
    'r.listSep': '、',
    'r.positioning': '站位',
    'r.arrangements': '共 {n} 種排法',
    'r.yours': '你的',
    'r.best': '最佳',
    'r.sim': '模擬',
    'r.otherOrders': '其他排法',
    'r.sameResult': '（另有 {n} 種排法結果相同）',
    'r.mine': ' ← 你的',
    'r.outcome': '勝 {w}・和 {t}・敗 {l}',
    'r.netDamage': '（淨傷害 {d}）',
    'r.skippedDecisions': '沒有評分的決策（{n}）',
    'r.note': '注意：{text}',
    'r.footer': '分數：91 以上接近最佳、70–90 還可以更好、70 以下明顯失誤。勝率是和「當回合實際遇到的對手陣容」模擬對戰的結果，平手算半場勝；怎麼排都很難贏的回合改用受到的傷害評分。決策是用做決定當下的陣容評估。',
    'r.delete': '刪除這份報告',
    'r.kw.TAUNT': '嘲諷', 'r.kw.DIVINE_SHIELD': '聖盾', 'r.kw.REBORN': '復生', 'r.kw.POISONOUS': '劇毒',
    'r.kw.VENOMOUS': '猛毒', 'r.kw.STEALTH': '潛行', 'r.kw.CLEAVE': '順劈', 'r.kw.IMMUNE': '免疫',
    'r.kw.WINDFURY': '風怒', 'r.kw.MEGA_WINDFURY': '超級風怒',

    'pos.skip.no_my_minions': '你場上沒有隨從',
    'pos.skip.no_opp_minions': '對手場上沒有隨從',
    'pos.skip.single_order': '只有一種排法，不評分',
    'pos.skip.sim_failed': '無法模擬（{msg}）',

    'verdict.good': '最佳或接近最佳',
    'verdict.ok': '還可以更好',
    'verdict.bad': '明顯失誤',
    'verdict.none': '不影響這場戰鬥',

    'd.target': '{card} 的目標',
    'd.magnetize': '{card} 放哪裡',
    'd.order': '出牌順序',
    'd.orderOf': '出牌順序（{cards}）',
    'd.alone': '單獨下場',
    'd.attach': '吸附到 {card}（位置 {pos}）',
    'd.slot': '{card}（位置 {pos}）',
    'd.then': ' → ',

    'skip.no_friendly_target': '沒有選擇友方目標',
    'skip.gets_cards': '{card} 的效果是拿牌，不影響這場戰鬥',
    'skip.unknown_card': '模擬器不認得 {card}',
    'skip.scene': '無法重建局面（{msg}）',
    'skip.hero_power_differs': '模擬器中的英雄技能（{sim}）和實際的（{real}）不同',
    'skip.cannot_play': '模擬器裡無法打出：{msg}',
    'skip.no_target_needed': '模擬器裡這張牌不需要選目標',
    'skip.one_target': '只有一個合法目標',
    'skip.target_illegal': '你選的目標在模擬器裡不合法',
    'skip.not_magnetic': '不是磁力隨從',
    'skip.cannot_reproduce': '無法在模擬器重現你的選擇（{msg}）',
    'skip.one_option': '只有一個可行選項',
    'skip.one_card': '只有一張牌',
    'skip.too_many': '超過 {n} 張牌，排列太多',
    'skip.has_hero_power': '包含英雄技能',
    'skip.has_discover': '包含拿牌或發現的牌，順序的影響無法只靠戰鬥判斷',
    'skip.target_new_minion': '目標是同一輪中剛打出的隨從',
    'skip.magnet_new_minion': '磁力吸附到同一輪中剛打出的隨從',

    'note.unknown_hero': '模擬器不認得英雄「{card}」，改用沒有戰鬥效果的英雄',
    'note.unknown_trinket': '模擬器不認得飾品「{card}」，沒有放進模擬',

    'grade.win': '{score} / 100（{verdict}，比最佳少 {gap} 個百分點）',
    'grade.damage': '{score} / 100（{verdict}；怎麼做都很難贏，比最佳多受 {gap} 點傷害）',

    // help
    'help.blocked.summary': '瀏覽器說「無法開啟這個資料夾」怎麼辦？',
    'help.blocked.body': '<p>Chrome、Edge 和 Brave 不允許網頁讀取 <code>Program Files</code> 裡的資料夾，而爐石預設把紀錄檔放在那裡。最簡單的辦法是改用 HDT 外掛（上面的說明）。不用 HDT 的話，可以把 Logs 資料夾搬到「文件」，再在原位置放一個連結，爐石會照常寫入，網頁也能讀取。只需要做一次：</p><ol><li>先完全關閉爐石。</li><li>在開始選單搜尋「命令提示字元」，按右鍵選「以系統管理員身分執行」，貼上下面三行（安裝位置不同請自行修改）：</li></ol><pre>robocopy "C:\\Program Files (x86)\\Hearthstone\\Logs" "%USERPROFILE%\\Documents\\HearthstoneLogs" /E /MOVE\nrmdir "C:\\Program Files (x86)\\Hearthstone\\Logs"\nmklink /J "C:\\Program Files (x86)\\Hearthstone\\Logs" "%USERPROFILE%\\Documents\\HearthstoneLogs"</pre><ol start="3"><li>回到這個頁面，選擇「文件 › HearthstoneLogs」資料夾。</li></ol><p class="small mute">想還原時，刪除那個連結（<code>rmdir "C:\\Program Files (x86)\\Hearthstone\\Logs"</code>），再把資料夾搬回去即可。不想改的話，也可以每局結束後用「選擇 Power.log」或直接把檔案拖進這個頁面。</p>',
    'help.about.summary': '這是什麼？資料會上傳嗎？',
    'help.about.body': '<p>這個網頁讀取爐石的 <code>Power.log</code>，重建每回合的戰鬥，用 <a href="https://github.com/MCG-NJU/AutoTavern">TavernGym</a> 模擬器把你的站位、指向性目標、磁力和出牌順序，和其他所有選擇比較勝率後打分數。</p><p>所有分析都在你的電腦上（瀏覽器裡）進行，紀錄檔和報告都不會上傳到任何地方；報告只存在這個瀏覽器裡。</p><p class="small mute">模擬器依 36.6.3（253932）版本建置；數值和你的客戶端不同的隨從會在報告中標出。Hearthstone 與卡片資料為 Blizzard Entertainment 所有，本網站與 Blizzard 無關。<a href="https://github.com/WSED0412/bg_advisor_web">原始碼</a></p>',
  },

  en: {
    'app.title': 'Battlegrounds Review',
    'lang.switch': '中文',
    'lang.switch.title': '切換成中文',

    'status.analyzing': 'Analyzing…',
    'status.progress': 'Analyzing {hero}: round {round} ({done}/{total})',
    'status.loading': 'Loading the simulator…',
    'status.reading': 'Reading the logs…',
    'status.found': ({ n }) => (n ? `Found ${n} new game${n > 1 ? 's' : ''}` : 'No new Battlegrounds games'),
    'status.bridge': 'Connected to the HDT plugin',
    'status.bridge.update': ' · plugin update available',
    'status.bridge.tooOld': ' · plugin must be updated',
    'status.watching': 'Watching: {dir}',
    'status.waitBridge': 'Waiting for the HDT plugin…',
    'status.paused': 'Watching paused',
    'status.noFolder': 'No log folder set yet',
    'status.searchBridge': 'Looking for the HDT plugin… (allow "local network" access if the browser asks)',

    'err.worker': 'The analysis failed: {msg}',
    'err.folder': 'This folder cannot be opened ({msg}). If it is under Program Files, see the help below.',
    'err.noPowerLog': 'No Power.log in "{dir}". Choose the Logs folder inside the Hearthstone installation, and make sure log.config enables [Power] logging.',
    'err.permission': 'The browser withdrew access to the folder. Click "Resume watching".',
    'err.bridgeRead': 'Could not read all of {source} from the plugin',
    'err.noBridge': 'The HDT plugin was not found. Make sure Hearthstone Deck Tracker is running and the "BG Advisor" plugin is enabled. If the browser asked about "local network / localhost" access and it was blocked, allow it in the site settings left of the address bar, then click "Connect to HDT plugin" again.',
    'err.read': 'Could not read {source}: {msg}',

    'btn.pickFolder': 'Choose the Logs folder',
    'btn.pickFile': 'Choose Power.log',
    'btn.analyzeAll': 'Analyze every game in the folder',
    'btn.changeFolder': 'Change folder',
    'btn.resume': 'Resume watching',
    'btn.connectBridge': 'Connect to HDT plugin',
    'btn.reconnect': 'Reconnect',
    'btn.forgetBridge': 'Stop using the plugin',
    'quick': 'Quick mode (faster, less precise)',
    'setup.first': 'First time: choose the <b>Logs</b> folder inside the Hearthstone installation (usually <code>C:\\Program Files (x86)\\Hearthstone\\Logs</code>). Then keep this tab open while you play: every game is analyzed when it ends.',
    'setup.lastFolder': 'Last folder used: <b>{dir}</b>. The browser needs one more click to read it.',
    'setup.brave': 'Brave turns off folder access for web pages by default, so for now you can only choose or drop Power.log by hand. To analyze games automatically, turn it on once:<ol><li>Type <code>brave://flags/#file-system-access-api</code> in the address bar</li><li>Set "File System Access API" to <b>Enabled</b></li><li>Click <b>Relaunch</b> at the bottom right, then come back to this page</li></ol>',
    'setup.noWatch': 'This browser cannot watch a folder (that needs Chrome, Edge, or Brave with a setting turned on). After each game, choose or drop Power.log on this page.',
    'setup.bridgeOn': 'Connected to the HDT plugin ({version}): every Battlegrounds game is analyzed when it ends, no folder needed.',
    'setup.bridgeNoLogs': "The plugin cannot find Hearthstone's Logs folder. Check the Hearthstone path in HDT's settings.",
    'setup.bridgeMissing': 'The HDT plugin was not found (port {port}). Make sure Hearthstone Deck Tracker is running and the "BG Advisor" plugin is enabled. If the browser asked about "local network" access and you blocked it, allow it again in the site settings left of the address bar.',
    'setup.updateSteps': '<a href="{url}" download>Download the new plugin</a>, close HDT, replace <code>%AppData%\\HearthstoneDeckTracker\\Plugins\\BgAdvisorBridge.dll</code> with it (right-click the new file › Properties › tick "Unblock"), then start HDT again.',
    'setup.tooOld': 'The plugin is too old ({version}); this page needs {min} or newer to analyze games automatically.',
    'setup.outdated': 'A new plugin is available: {version} → {latest}.',
    'plugin.summary': 'Using Hearthstone Deck Tracker? The plugin needs no folder setup',
    'plugin.ready': 'Plugin installed and HDT running: ',
    'plugin.steps': '<ol><li>Download <a href="{url}" download>BgAdvisorBridge.dll</a>, right-click it › Properties, tick "Unblock" and click OK.</li><li>Put it in <code>%AppData%\\HearthstoneDeckTracker\\Plugins</code> and restart HDT.</li><li>In HDT, Options › Tracker › Plugins, enable "BG Advisor", then click its "開啟復盤網頁" (open review page) button.</li><li>Allow "local network" access when the browser asks.</li></ol><p class="small mute">After that, HDT opens the report of every Battlegrounds game when it ends. The plugin only serves the logs to this site on 127.0.0.1 on your own computer and uploads nothing.</p>',

    'list.empty': 'No reports yet. They show up here after you finish a Battlegrounds game.',
    'list.rounds': '{n} rounds',
    'list.incomplete': ' · incomplete',
    'list.misses': ({ n }) => (n ? `${n} clear mistake${n > 1 ? 's' : ''}` : 'No clear mistakes'),
    'list.positioning': 'Positioning',
    'list.decisions': 'Decisions',
    'list.notFound': 'This report was not found. <a href="#/">Back to the list</a>',
    'title.new': '● New report: {hero} | Battlegrounds Review',
    'title.game': '{hero}{place} | Battlegrounds Review',
    'title.place': ' #{place}',
    'confirm.delete': 'Delete this report?',
    'drop': 'Drop to analyze Power.log',

    'r.back': '← All games',
    'r.place': '#{place}',
    'r.placeUnknown': 'Place unknown',
    'r.client': 'client {build}',
    'r.tile.pos': 'Positioning',
    'r.tile.pos.sub': '{n} rounds scored',
    'r.tile.dec': 'Other decisions',
    'r.tile.dec.sub': '{n} decisions',
    'r.tile.miss': 'Clear mistakes',
    'r.tile.miss.sub': 'below 70',
    'r.tile.rounds': 'Rounds',
    'r.tile.rounds.sub': 'with a combat',
    'r.attention': 'Worth a look',
    'r.noMisses': 'No clear mistakes',
    'r.miss': 'Round {round}: {what} ({score})',
    'r.cardChanges': 'Some minions in this log have different stats from the simulator (a patch or hotfix); those rounds may be simulated less accurately:',
    'r.cardChange': '{name}: simulator {engine}, your client {client}',
    'r.stats': '{atk}/{hp} (tier {tier})',
    'r.incomplete': 'This log has no end-of-game marker (still running, or left early); the report may be incomplete.',
    'r.quick': 'This report was made in quick mode; scores are less precise.',
    'r.round': 'Round {round}',
    'r.noCombat': 'No combat recorded',
    'r.result.me': 'Won', 'r.result.opp': 'Lost', 'r.result.tie': 'Tie',
    'r.vs': 'vs {name} ({hero}, tavern tier {tier}){dmg}',
    'r.dealt': ', dealt {n} damage',
    'r.taken': ', took {n} damage',
    'r.ghost': 'Ghost (eliminated player)',
    'r.chance': 'Chance of the actual result in the simulation: {p}',
    'r.chanceLow': ' (low: this combat may be simulated inaccurately)',
    'r.changedHere': 'Minions with stats different from the simulator: {names}',
    'r.oppBoard': "Opponent's warband",
    'r.myBoard': 'Your warband (tavern tier {tier}, health {hp})',
    'r.noMinions': '(no minions)',
    'r.colon': ': ',
    'r.listSep': ', ',
    'r.positioning': 'Positioning',
    'r.arrangements': '{n} possible orders',
    'r.yours': 'Yours',
    'r.best': 'Best',
    'r.sim': 'Simulated',
    'r.otherOrders': 'Other orders',
    'r.sameResult': ' ({n} more orders give the same result)',
    'r.mine': ' ← yours',
    'r.outcome': 'Win {w} · Tie {t} · Loss {l}',
    'r.netDamage': ' (net damage {d})',
    'r.skippedDecisions': 'Decisions not scored ({n})',
    'r.note': 'Note: {text}',
    'r.footer': 'Scores: 91+ best or close to it, 70–90 could be better, below 70 a clear mistake. Win rates come from simulating against the warband you actually faced that round; a tie counts as half a win. When every option is very likely to lose, the score uses damage taken instead. Decisions are judged with the board at the moment they were made.',
    'r.delete': 'Delete this report',
    'r.kw.TAUNT': 'Taunt', 'r.kw.DIVINE_SHIELD': 'Divine Shield', 'r.kw.REBORN': 'Reborn', 'r.kw.POISONOUS': 'Poisonous',
    'r.kw.VENOMOUS': 'Venomous', 'r.kw.STEALTH': 'Stealth', 'r.kw.CLEAVE': 'Cleave', 'r.kw.IMMUNE': 'Immune',
    'r.kw.WINDFURY': 'Windfury', 'r.kw.MEGA_WINDFURY': 'Mega-Windfury',

    'pos.skip.no_my_minions': 'You had no minions',
    'pos.skip.no_opp_minions': 'The opponent had no minions',
    'pos.skip.single_order': 'Only one possible order; not scored',
    'pos.skip.sim_failed': 'Could not be simulated ({msg})',

    'verdict.good': 'best or close to it',
    'verdict.ok': 'could be better',
    'verdict.bad': 'clear mistake',
    'verdict.none': 'no effect on this combat',

    'd.target': 'Target of {card}',
    'd.magnetize': 'Where to put {card}',
    'd.order': 'Play order',
    'd.orderOf': 'Play order ({cards})',
    'd.alone': 'Played on its own',
    'd.attach': 'Attached to {card} (slot {pos})',
    'd.slot': '{card} (slot {pos})',
    'd.then': ' → ',

    'skip.no_friendly_target': 'No friendly target was chosen',
    'skip.gets_cards': '{card} gives cards; it does not change this combat',
    'skip.unknown_card': 'The simulator does not know {card}',
    'skip.scene': 'The board could not be rebuilt ({msg})',
    'skip.hero_power_differs': "The simulator's Hero Power ({sim}) differs from the real one ({real})",
    'skip.cannot_play': 'Could not be played in the simulator: {msg}',
    'skip.no_target_needed': 'In the simulator this card needs no target',
    'skip.one_target': 'Only one legal target',
    'skip.target_illegal': 'Your target is not legal in the simulator',
    'skip.not_magnetic': 'Not a Magnetic minion',
    'skip.cannot_reproduce': 'Your choice could not be reproduced in the simulator ({msg})',
    'skip.one_option': 'Only one possible option',
    'skip.one_card': 'Only one card',
    'skip.too_many': 'More than {n} cards; too many orders',
    'skip.has_hero_power': 'Includes a Hero Power',
    'skip.has_discover': 'Includes cards that Discover or give cards; their order cannot be judged by combat alone',
    'skip.target_new_minion': 'The target was played in the same sequence',
    'skip.magnet_new_minion': 'Magnetized onto a minion played in the same sequence',

    'note.unknown_hero': 'The simulator does not know the hero "{card}"; a hero without combat effects was used',
    'note.unknown_trinket': 'The simulator does not know the trinket "{card}"; it was left out',

    'grade.win': '{score} / 100 ({verdict}; {gap} win-rate points below the best)',
    'grade.damage': '{score} / 100 ({verdict}; every option likely loses, {gap} more damage than the best)',

    'help.blocked.summary': 'The browser says "Can\'t open this folder"?',
    'help.blocked.body': '<p>Chrome, Edge and Brave do not let web pages read folders under <code>Program Files</code>, where Hearthstone keeps its logs. The easiest fix is the HDT plugin (see above). Without HDT, move the Logs folder to Documents and leave a link in its place; Hearthstone keeps writing there and the page can read it. Once only:</p><ol><li>Close Hearthstone completely.</li><li>Search the Start menu for "Command Prompt", right-click it and choose "Run as administrator", then paste these three lines (adjust the path if Hearthstone is installed elsewhere):</li></ol><pre>robocopy "C:\\Program Files (x86)\\Hearthstone\\Logs" "%USERPROFILE%\\Documents\\HearthstoneLogs" /E /MOVE\nrmdir "C:\\Program Files (x86)\\Hearthstone\\Logs"\nmklink /J "C:\\Program Files (x86)\\Hearthstone\\Logs" "%USERPROFILE%\\Documents\\HearthstoneLogs"</pre><ol start="3"><li>Back on this page, choose the Documents › HearthstoneLogs folder.</li></ol><p class="small mute">To undo it, delete the link (<code>rmdir "C:\\Program Files (x86)\\Hearthstone\\Logs"</code>) and move the folder back. Or skip all this and choose or drop Power.log on this page after each game.</p>',
    'help.about.summary': 'What is this? Is anything uploaded?',
    'help.about.body': '<p>This page reads Hearthstone\'s <code>Power.log</code>, rebuilds each combat and uses the <a href="https://github.com/MCG-NJU/AutoTavern">TavernGym</a> simulator to score your positioning, friendly targets, Magnetic placement and play order against every alternative.</p><p>Everything runs on your computer, inside the browser. Logs and reports are never uploaded; reports are stored only in this browser.</p><p class="small mute">The simulator is built for patch 36.6.3 (253932); minions whose stats differ in your client are flagged in the report. Hearthstone and its card data belong to Blizzard Entertainment; this site is not affiliated with Blizzard. <a href="https://github.com/WSED0412/bg_advisor_web">Source code</a></p>',
  },
};
