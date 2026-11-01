"""Hero skin -> base hero table from HearthstoneJSON.

A Battlegrounds hero skin is its own card (BG22_HERO_001_SKIN_A "Scourgebound Bru'kan") whose
battlegroundsSkinParentId is the dbfId of the base hero (BG22_HERO_001 "Bru'kan"). The simulator
only knows base heroes, so logs are read with skins replaced by their base hero.

    python tools/gen_hero_skins.py [BUILD]      (default: latest)
writes web/data/hero_skins.json  {"<skin id>": "<base id>", ...}
"""

import json
import sys
import urllib.request
from pathlib import Path

build = sys.argv[1] if len(sys.argv) > 1 else "latest"
url = f"https://api.hearthstonejson.com/v1/{build}/enUS/cards.json"
req = urllib.request.Request(url, headers={"User-Agent": "bg_advisor (github.com/WSED0412/bg_advisor_web)"})
with urllib.request.urlopen(req) as r:
    cards = json.load(r)

by_dbf = {c["dbfId"]: c["id"] for c in cards}
skins = {c["id"]: by_dbf[c["battlegroundsSkinParentId"]]
         for c in cards if c.get("battlegroundsSkinParentId") in by_dbf}

out = Path(__file__).resolve().parent.parent / "web" / "data" / "hero_skins.json"
out.write_text(json.dumps(dict(sorted(skins.items())), separators=(",", ":")), encoding="utf-8")
print(f"{len(skins)} skins from {url} -> {out}")
