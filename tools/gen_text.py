"""Card text for the hover/tap card in the reports, from HearthstoneJSON (api.hearthstonejson.com).

    python tools/gen_text.py

writes web/data/text_en.json and web/data/text_zhTW.json:
    {card id: {"x": effect text (HearthstoneJSON markup), "t": tavern tier, "r": [minion types]}}
for every card in web/data/names_en.json. Fields that a card does not have are left out.
The page loads these files only when a card is first hovered or tapped.

Server-side hotfixes (37.0.3) do not reach HearthstoneJSON's client data: HOTFIX then patches
the downloaded text to match the simulator. `--hotfix-only` applies HOTFIX to the existing
files without downloading.

Hearthstone's card data belongs to Blizzard Entertainment; it is shown here as in other
non-commercial fan tools.
"""

import json
import sys
import time
import urllib.request
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
URL = "https://api.hearthstonejson.com/v1/latest/{}/cards.json"
LOCALES = {"enUS": "text_en.json", "zhTW": "text_zhTW.json"}

# 37.0.3 server hotfix (2026-11-17): {card id: {"t": tier, locale: [(old, new) in "x"]}}. A
# replacement whose new text is already there (HearthstoneJSON caught up) is skipped.
_FELBOAR = {"enUS": [("cast 3 spells", "cast 4 spells"), ("(3 left!)", "(4 left!)")],
            "zhTW": [("施放3個法術", "施放4個法術"), ("還剩3個", "還剩4個")]}
HOTFIX = {
    "BG36_206": {"t": 5},  # Snarky Shark: Tier 4 -> 5
    "BG36_206_G": {"t": 5},
    "BG28_633": _FELBOAR,  # Felboar: after 4 spells (was 3)
    "BG28_633_G": _FELBOAR,
    "BG23_017": {"enUS": [("+2/+1", "+1/+1")], "zhTW": [("+2/+1", "+1/+1")]},  # Sanguine Champion
    "BG23_017_G": {"enUS": [("+4/+2", "+2/+2")], "zhTW": [("+4/+2", "+2/+2")]},
}


def apply_hotfix(out: dict, locale: str) -> None:
    for cid, fix in HOTFIX.items():
        e = out.get(cid)
        if e is None:
            continue
        if "t" in fix:
            e["t"] = fix["t"]
        for old, new in fix.get(locale, []):
            x = e.get("x", "")
            if new in x:
                continue
            if old not in x:
                raise SystemExit(f"{locale} {cid}: {old!r} not in {x!r}")
            e["x"] = x.replace(old, new)


def write(fname: str, out: dict) -> None:
    path = WEB / "data" / fname
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), sort_keys=True), "utf-8")
    print(f"{fname}: {len(out)} cards, {path.stat().st_size / 1e3:.0f} KB")


def download(locale: str) -> list:
    req = urllib.request.Request(URL.format(locale), headers={"User-Agent": "bg_advisor_web text (github.com/WSED0412/bg_advisor_web)"})
    for attempt in range(1, 5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
                want = r.headers.get("Content-Length")
            if want and int(want) != len(body):
                raise OSError(f"truncated download: {len(body)} of {want} bytes")
            return json.loads(body)
        except (OSError, ValueError) as e:  # network trouble, truncated or invalid JSON
            print(f"  {locale} attempt {attempt}: {e}")
            time.sleep(2 * attempt)
    raise SystemExit(f"could not download {locale}")


def main() -> int:
    if "--hotfix-only" in sys.argv:
        for locale, fname in LOCALES.items():
            out = json.loads((WEB / "data" / fname).read_text("utf-8"))
            apply_hotfix(out, locale)
            write(fname, out)
        return 0
    ids = json.loads((WEB / "data" / "names_en.json").read_text("utf-8"))
    for locale, fname in LOCALES.items():
        by_id = {c["id"]: c for c in download(locale)}
        out = {}
        for i in sorted(ids):
            c = by_id.get(i)
            if not c:
                continue
            e = {}
            if c.get("text"):
                e["x"] = c["text"]
            if c.get("techLevel"):
                e["t"] = c["techLevel"]
            races = c.get("races") or ([c["race"]] if c.get("race") else [])
            if races:
                e["r"] = races
            if e:
                out[i] = e
        apply_hotfix(out, locale)
        write(fname, out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
