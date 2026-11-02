"""Card art for the report pages, from HearthstoneJSON (art.hearthstonejson.com).

    python tools/gen_art.py

writes web/art/tiles/<id>.webp  a card's art as a strip (about 3.5 KB): every card in
                                web/data/names_en.json (a golden card uses its normal card's art)
       web/art/heroes/<id>.webp a hero's art, square (about 16 KB)

Files already there are kept, so running it again only fetches new cards. The page shows the art
when a file exists and plain text when it does not.

Hearthstone's card art belongs to Blizzard Entertainment; it is shown here as in other
non-commercial fan tools.
"""

import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
BASE = "https://art.hearthstonejson.com/v1"
HERO_RE = re.compile(r"HERO_[0-9A-Za-z]+$")  # heroes, not their powers (…p) or Buddies


def fetch(url: str, out: Path) -> str:
    if out.exists():
        return "kept"
    req = urllib.request.Request(url, headers={"User-Agent": "bg_advisor_web art (github.com/WSED0412/bg_advisor_web)"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        return f"missing ({e.code})"
    except OSError as e:
        return f"failed ({e})"
    out.write_bytes(data)
    return "new"


def main() -> int:
    names = json.loads((WEB / "data" / "names_en.json").read_text("utf-8"))
    ids = sorted({re.sub(r"_G$", "", i) for i in names})
    heroes = [i for i in ids if HERO_RE.search(i) and "_Buddy" not in i]
    jobs = [(f"{BASE}/tiles/{i}.webp", WEB / "art" / "tiles" / f"{i}.webp") for i in ids]
    jobs += [(f"{BASE}/256x/{i}.webp", WEB / "art" / "heroes" / f"{i}.webp") for i in heroes]
    for d in ("tiles", "heroes"):
        (WEB / "art" / d).mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    missing = []
    with ThreadPoolExecutor(8) as pool:
        for (url, out), res in zip(jobs, pool.map(lambda j: fetch(*j), jobs)):
            key = res.split(" ")[0]
            counts[key] = counts.get(key, 0) + 1
            if key in ("missing", "failed"):
                missing.append(f"{out.parent.name}/{out.stem}: {res}")
    size = sum(f.stat().st_size for f in (WEB / "art").rglob("*.webp"))
    print(f"{len(ids)} cards, {len(heroes)} heroes: {counts}; web/art is {size / 1e6:.1f} MB")
    for m in missing[:30]:
        print("  ", m)
    if len(missing) > 30:
        print(f"   ... and {len(missing) - 30} more")
    return 0


if __name__ == "__main__":
    sys.exit(main())
