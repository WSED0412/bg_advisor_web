**English** | [繁體中文](README.zh-TW.md)

# Battleground Advisor (web version)

**Live site: <https://wsed0412.github.io/bg_advisor_web/>**

Reads Hearthstone's `Power.log`, rebuilds every combat with the [TavernGym](https://github.com/MCG-NJU/AutoTavern)
simulator, and scores your Battlegrounds decisions. It works with a Hearthstone Deck Tracker (HDT) plugin: all analysis
runs in your browser, logs are never uploaded, and logs and reports are backed up on your own computer.

- **Positioning**: tries every arrangement and compares its win rate with yours (when no arrangement can win, it compares damage taken instead)
- **Targeted effects**: for spells, hero powers and battlecries that pick a friendly minion, every target is tried
- **Magnetic**: played alone vs. attached to each Mech
- **Play order**: when 2-5 cards are played in a row, every order is tried
- **N-turn strength** (reference only): for each buy or Discover, the result of up to 3 following combats with the other options swapped in
- **Where this game was lost**: the turns that cost the most health, and why (positioning, weak board, luck)
- **Tavern tier pace**: your and your opponents' tavern tier and health each turn, compared with common level-up timing
- **Health chart**: after each combat, a line chart of all eight players' health, and where your health ranks among the survivors
- **Luck** (not scored): how far actual results differ from simulated win rates, and whether each Discover offered better or worse options than average

Score: 91 and above is close to best, 70-90 could be better, below 70 is a clear mistake.

## How to use

The page reads Hearthstone's logs through the **Hearthstone Deck Tracker (HDT) plugin**; you do not pick a folder or upload a file.
Chrome, Edge, Brave and Firefox all work.

1. Download `plugin/BgAdvisorBridge.dll` from the site, right-click it › Properties › tick "Unblock".
2. Put it in `%AppData%\HearthstoneDeckTracker\Plugins`, restart HDT, and enable "Battleground Advisor" under Options › Tracker › Plugins.
3. Pick Battleground Advisor in the plugin list and press "Open review page" (the first time you must open the page from HDT, so that it receives the plugin's access token);
   allow "access to devices on the local network" when the browser asks. Afterwards you can also open <https://wsed0412.github.io/bg_advisor_web/> directly and press "Connect HDT plugin".

After each Battlegrounds game, HDT opens that game's report automatically (if the page is already open, it analyses in that tab).
The plugin serves `Power.log` only on `127.0.0.1` for this site (other sites and other computers cannot read it) and uploads nothing.
Hearthstone's `log.config` must have `[Power]` logging on (HDT sets this up for you).

### Backups

Since plugin 0.3.0, data is backed up in **Documents\BG Advisor**:

| Folder | Contents |
|---|---|
| `logs\` | the `Power.log` of every session with a Battlegrounds game (gzip). Updated when HDT starts and after each game; Hearthstone itself keeps only the last few logs, these stay |
| `reports\` | every report the page makes (JSON), saved as soon as the analysis finishes |
| `reports\deleted\` | reports deleted in the page are moved here instead of being erased |

- When the page connects to the plugin, reports missing on either side are filled in from the other: after clearing browser data, switching browsers or moving to another computer (copy the whole folder), reconnecting restores them.
- "Analyse all games in the backup" on the page analyses every backed-up game that has no report yet (after a simulator or scoring update you can delete the reports first and re-analyse).
- For an off-site backup, put `Documents\BG Advisor` in OneDrive or another synced drive.

### Importing and exporting reports

- "Export all reports" above the report list saves every report into one JSON file; "Export this report" at the bottom of a report saves only that one.
- "Import reports" reads these files back (several at once is fine) and needs no plugin. Use it to share reports or move them to another browser.
- Existing reports are never overwritten; reports from someone else are marked "Imported (player name)" in the list. With the plugin connected, imported reports are also saved to the backup.
- Exporting asks whether to hide your BattleTag (for example `Name#1234`); choose to hide it when sharing. Opponents' names are not replaced. The log itself is never exported.
- Imported files are checked for format and characters that could be read as HTML are escaped, so a file from someone else cannot run code in the page.

### Privacy and security

As of the current code (plugin 0.4.0):

**Files the plugin reads**
- `Hearthstone_*\Power.log` and `Power.log` in Hearthstone's `Logs` folder (the install location set in HDT; `C:\Program Files (x86)\Hearthstone\Logs` if it cannot be found).
  The page can read only the files in that listing, nothing else on the computer.
- Browser install paths in the Windows registry: after a game the plugin opens the report in Windows' default browser, and only if that fails in the browser the page last ran in.

**Files the plugin writes**
- `Documents\BG Advisor\logs\<session>.Power.log.gz`: only logs that contain a Battlegrounds game.
- `Documents\BG Advisor\reports\<key>.json`: reports from the page; deleted ones move to `reports\deleted`, they are not erased.
- `%AppData%\HearthstoneDeckTracker\BgAdvisor.txt`: only which browser the page last ran in (used only if the default browser fails).
- `%AppData%\HearthstoneDeckTracker\BgAdvisorToken.txt`: the plugin's access token (below).

**Network**
- The plugin listens only on `127.0.0.1`, ports 47613-47617, so other computers cannot reach it, and it never connects to any site by itself.
- The page downloads only its own files from GitHub Pages (code, simulator, card names, `plugin/version.json`) and reads logs from the local plugin.
  There is no analytics, advertising or third-party code; GitHub sees your IP address like any web site.
- Analysis runs in the browser; logs and reports are never uploaded. Reports are kept in the browser's IndexedDB (readable only by this site) and in the backup folder above.

**What a report contains**: your BattleTag, opponents' names as they appear in the log, heroes, each turn's boards and scores.

**Export**: it asks whether to hide your BattleTag; if you say yes, your name (with and without `#1234`) is replaced by `Player`, also in the report key. Opponents' names are kept.

**Who can use the plugin**
- **Token**: on first start the plugin makes a token from 32 bytes of cryptographically secure random data (43 characters), stores it in `BgAdvisorToken.txt` and reuses it.
  When the plugin opens the page it puts the token in the address `#/bridge/<port>/<token>`; the page saves it in the browser (IndexedDB) and removes it from the address at once.
- Reading logs and reading, writing or deleting backed-up reports all need `Authorization: Bearer <token>`; the plugin compares it in constant time and answers 401 otherwise.
  Without a token `/status` returns only the plugin's name and version, with no paths, and the page asks you to open it from HDT once.
  So a page served by another program on this computer (localhost on any port) cannot read the logs or change the backup, even if its origin were allowed.
- Requests are still accepted only when `Host` is `127.0.0.1` or `localhost` (against DNS rebinding), and in the browser only this site and local pages may read responses; requests from other sites are refused.
- **Resetting the token**: HDT's plugin menu has "Reset web connection", which makes a new token and opens the page with the new address;
  old pages are refused from then on and must be reopened from HDT. You can also delete `BgAdvisorToken.txt` and restart HDT.
- **Limits**: the token also stays in the browser's site data and history (the `#` part of the address); a local program that can read those could read the log directly anyway.
  The site `wsed0412.github.io` shares one origin with the same GitHub account's other GitHub Pages sites, and their code can read the token this site stores.
- Plugins before 0.4.0 have no token: any local web page could read the logs and change the backup. Please update.

**Checking the downloaded plugin**: `sha256` in `plugin/version.json` is the SHA-256 of the DLL on the site (written by `plugin\build.ps1 -Publish`; CI checks the two match).
After downloading, run in PowerShell:

```powershell
(Get-FileHash "$env:USERPROFILE\Downloads\BgAdvisorBridge.dll" -Algorithm SHA256).Hash
```

and compare it with the SHA-256 shown in the page's install instructions (case-insensitive). The DLL is not code-signed, so Windows asks you to unblock it
and antivirus software may flag it. You can build it from source (next section); the build is deterministic (`/deterministic`), so the result should be byte-identical to the DLL on the site.

### Updating and building the plugin

Build it yourself: `powershell -ExecutionPolicy Bypass -File plugin\build.ps1 -Install` (needs Visual Studio Build Tools).

The plugin rarely needs updating: card data, scoring and the interface all live on the site, so refresh the page after a site update. When a new plugin version does ship,
the page compares it with `web/plugin/version.json` on connect; an old version shows an update notice, and a version below `min` pauses automatic analysis and asks you to update.
To publish a new plugin: change `Version` in `BridgeServer.cs`, then run `plugin\build.ps1 -Publish` (add `-MinCompatible <new version>` for incompatible changes).

## What affects the score and what does not

The **positioning average**, **other decisions average** and **clear mistakes** at the top of a report come only from these two kinds of decisions:

| Scored | How it is judged |
|---|---|
| Positioning | every arrangement is tried and its win rate compared with yours |
| Targets, magnetic, play order | every option is tried and its win rate compared with your choice |

When no choice can win (best win rate below 5%), damage taken is compared instead.

### Shown, but not in the averages or clear mistakes

- **N-turn strength (which minion to buy, which card to Discover)**: over up to 3 combats after that minion, it is swapped for the other options (same position, same buffs up to that point) and the results of those combats are added up. Copies of the same minion in later turns are followed through the links in the log. Battlecry effects are not included and the opponents stay the ones you actually met, so this is for reference only and is labelled "reference, not in the average".
- **Where this game was lost**: lost combats ranked by damage taken, with the top 3 and the reason: a different arrangement often wins (the best arrangement's win rate is 10 points or more higher), nothing could win (best win rate below 30%), bad luck (your win rate was 50% or more) or an even fight.
- **Tavern tier pace**: your and your opponents' tavern tier and pre-combat health each turn against common timing (tier 2 on turn 2, tier 3 on turn 5, tier 4 on turn 7, tier 5 on turn 9, tier 6 on turn 11). This is a rule of thumb; being behind only turns the number red and costs no points.
- **Health chart**: after each combat, the health (with armor) of all eight players is read from each player's leaderboard hero in the log and drawn as lines: your line is thick, others are grey, × marks the turn someone was eliminated; each line ends with its hero, and players you fought are labelled with their name (opponent names in `Power.log` are sometimes carried over from the previous opponent, so names are shown only when consistent across the whole game); hover the chart to see everyone's health that turn. "Show numbers" expands a per-turn health table and "your health rank (among survivors)".
- **Luck** (not scored): kept apart from decisions; it only answers "was this game lucky?".
  - Combat: each combat is simulated with your actual board, the win rates add up to "expected wins and expected damage taken" which are compared with the actual result; turns where a 50%+ simulated win was lost (or a sub-50% one won) are listed.
  - Discover: from this game's minion types and the options' tiers it works out which minions the Discover could have shown, puts each one in the place of the minion you took, plays its first combat, and ranks the three options you were offered among all possible triples (50% is average). It compares strength only, not battlecries, economy effects or tavern buffs; Discovers whose choice does not affect combat are left out.
- **Decisions that do not change this combat**: when every option plays out to the same result (for example, which of two minions is played first), the report says "does not affect this combat" and gives no score.
- **Positioning with only one arrangement**: for example one minion on the board, or all minions identical.

### Skipped, listed under "Unscored decisions"

- Targeted cards whose effect is to get a card (for example Chef's Choice: you choose which card you get later, which does not change this combat).
- Targets or magnetic choices with only one legal option.
- A run of plays that plays cards just obtained in that same run (the simulator's obtained cards differ from yours).
- Runs of more than 5 plays (too many orders) and play orders that include a hero power.
- A minion bought or discovered that never fought later (sold, or used to combine).
- Cards the simulator does not know, or choices the simulator cannot reproduce.

### What the simulation rebuilds

Each combat is rebuilt from the log, for both sides:

- **Hero and the hero power actually held** (powers swapped mid-game are swapped in)
- **Trinkets and quest rewards**
- **Minions**: actual stats and keywords from the log (auras are corrected, not counted twice)
- **Spells cast in the recruit phase that take effect when combat starts** (for example Nozdormu's whelps)
- **Some "this game" counters**: Blood Gem bonus, Undead Attack bonus, Beetle bonus, Volumizer bonus, Elementals played this game, spells cast this game
- **Minion types in this game**: worked out from the minions seen this game, so "summon a random minion" in combat draws from the right types

Not rebuilt yet: the Eternal Knight bonus, health given to Undead by Slaughter and other counters (their tags in the log are not mapped yet), the stack counts of trinkets and hero powers, and this game's god and Dark Paradox forms (no data for these was seen in the log). Hero powers, trinkets and spells the simulator does not know are listed as warnings in the report.

### How randomness is handled

- **Random effects in combat** (deathrattle summons, random targets, ...): each option is simulated hundreds to thousands of times, each with different random numbers.
- **Random effects in the recruit phase** ("give a random friendly minion +2/+2", ...): targets, magnetic and play order replay the recruit action in the simulator 20 times per option, with different random numbers each time, and fight 50 combats each time (fewer in quick mode). All options share the same set of random numbers.
- **Simulation noise**: each positioning candidate is simulated 4000 times (500 in quick mode). All arrangements start from the same random numbers, but once one attack differs the numbers no longer line up, so luck does not cancel out. Two evenly matched arrangements show roughly ±1.1 percentage points of noise in win rate (one standard deviation), about ±3 positioning score points (about ±9 in quick mode). The best arrangement is the highest of several candidates, so its win rate is slightly overestimated and your score tends to be slightly underestimated.
- **Positioning pre-screen**: when there are more than 200 arrangements, each is first simulated 200 times and the top 24 plus yours are kept. Tested on 15 real boards, 3 boards lost the true best arrangement in the screen, by at most 0.39 percentage points.
- **Discover**: if the simulator's options include the card you really got, that one is picked; if not, the card you really got is put into the hand.
- Positioning and strength scores use the board that actually went into combat in the log, so recruit-phase randomness is already the real outcome.

### Not rated at all

Refreshing, freezing, selling minions, hero choice, trinket choice, discovering spells or trinkets, and the exact quality of level-up timing (only the pace comparison above). These need a forecast of the next several turns, which the current method of "simulate the combats that actually happened" cannot measure.

### Does not change the score, but warns

- When the **probability of the actual result in the simulation** is low (< 10%), the simulation of that turn may be inaccurate.
- When the log has **minions whose stats differ from the simulator's** (patches or hotfixes), they are listed.
- **Quick mode** scores have larger error.

## Architecture

| Location | Contents |
|---|---|
| `engine/` | WebAssembly interface to TavernGym (plain C ABI, no wasm-bindgen) |
| `web/js/powerlog.js`, `bglog.js` | parse Power.log, extract combat boards and plays |
| `web/js/scene.js`, `simcore.js`, `sim.js` | rebuild the position, parallel simulation (one simulator per Web Worker) |
| `web/js/scoring.js`, `positioning.js`, `decisions.js`, `luck.js`, `review.js` | scoring, luck |
| `web/js/app.js`, `report.js`, `store.js`, `share.js` | interface (plugin connection, backup sync), reports, IndexedDB, import and export |
| `plugin/` | HDT plugin (C#): local bridge server that opens the page when a game ends; backs up logs and reports (`Backup.cs`) |

Pushing to `main` makes GitHub Actions build the WebAssembly and deploy to GitHub Pages.

Local development:

```sh
cd engine && cargo build --release          # needs: rustup target add wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/taverngym_wasm.wasm ../web/engine/taverngym.wasm
python tools/test_server.py --port 8790     # http://127.0.0.1:8790/
```

The scoring logic is ported from the Python version, bg_advisor; both use the same simulator and the same random seeds and give identical results.

Hearthstone, its card data and card art belong to Blizzard Entertainment; this project is not affiliated with Blizzard. Card art in reports comes from [HearthstoneJSON](https://hearthstonejson.com/) and is stored in the site's `web/art/` (update it with `python tools/gen_art.py`), so browsing never contacts another site.
This project is released under the MIT license (see [LICENSE](LICENSE)); TavernGym is MIT-licensed too.
