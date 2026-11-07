"""Render the link preview image, web/og.png (1200x630), from tools/og_card.html.

    python tools/gen_og.py [path to msedge.exe or chrome.exe]

The page is copied into web/_og/ for a moment and served locally, so its ../art and ../data
paths load the site's own files; a headless browser renders it and the screenshot is taken over
the DevTools protocol (stdlib only).
"""

import base64
import functools
import html
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
BROWSERS = [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe"]
W, H = 1200, 630
# Cards from a real game's last round (attack / health as they fought).
BOARD = [("BG34_690", 75, 14), ("BG25_009", 65, 1), ("BG36_511_G", 147, 50), ("BG25_009", 65, 1),
         ("BG25_008", 140, 18), ("BG25_354", 3, 12), ("BG34_403", 110, 14)]


def board_html() -> str:
    names = json.loads((WEB / "data" / "names_en.json").read_text("utf-8"))
    cells = []
    for cid, atk, hp in BOARD:
        base = cid.removesuffix("_G")
        name = html.escape(names.get(cid) or names.get(base) or cid)
        gold = " gold" if cid != base else ""
        cells.append(f'<div class="m{gold}"><img src="../art/tiles/{base}.webp" alt="">'
                     f'<span class="n">{name}</span><span class="st">{atk}/{hp}</span></div>')
    return "".join(cells)


class DevTools:
    """A minimal WebSocket client for one page's DevTools endpoint."""

    def __init__(self, ws_url: str):
        host_port, path = ws_url[len("ws://"):].split("/", 1)
        host, port = host_port.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall((f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\n"
                        f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.next_id = 0

    def _send(self, obj):
        data = json.dumps(obj).encode()
        head = bytearray([0x81])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += n.to_bytes(2, "big")
        else:
            head.append(0x80 | 127)
            head += n.to_bytes(8, "big")
        mask = os.urandom(4)
        self.s.sendall(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def _need(self, k):
        while len(self.buf) < k:
            self.buf += self.s.recv(65536)

    def _recv(self):
        self._need(2)
        n, off = self.buf[1] & 0x7F, 2
        if n == 126:
            self._need(4)
            n, off = int.from_bytes(self.buf[2:4], "big"), 4
        elif n == 127:
            self._need(10)
            n, off = int.from_bytes(self.buf[2:10], "big"), 10
        self._need(off + n)
        data, self.buf = self.buf[off:off + n], self.buf[off + n:]
        return json.loads(data)

    def call(self, method, params=None):
        self.next_id += 1
        self._send({"id": self.next_id, "method": method, "params": params or {}})
        while True:
            m = self._recv()
            if m.get("id") == self.next_id:
                return m.get("result", {})


class QuietHandler(SimpleHTTPRequestHandler):
    # Keep-alive: closing after each response makes Windows reset some connections mid-body.
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    for attempt in range(3):
        try:
            return render()
        except (OSError, RuntimeError) as e:
            print(f"attempt {attempt + 1} failed: {e}")
    return 1


def render() -> int:
    browser = sys.argv[1] if len(sys.argv) > 1 else next((b for b in BROWSERS if Path(b).exists()), None)
    if not browser:
        print("no Edge or Chrome found: pass the browser's path")
        return 1
    tmp = WEB / "_og"
    tmp.mkdir(exist_ok=True)
    page = (ROOT / "tools" / "og_card.html").read_text("utf-8").replace("<!--BOARD-->", board_html())
    (tmp / "og_card.html").write_text(page, "utf-8")
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(WEB)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    out = WEB / "og.png"
    dbg = free_port()
    profile = tempfile.mkdtemp()
    proc = subprocess.Popen([browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                             f"--user-data-dir={profile}", f"--remote-debugging-port={dbg}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{dbg}/json"))
                break
            except OSError:
                time.sleep(0.3)
        else:
            raise RuntimeError("the browser did not start")
        dt = DevTools(next(p for p in pages if p["type"] == "page")["webSocketDebuggerUrl"])
        dt.call("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})
        url = f"http://127.0.0.1:{httpd.server_address[1]}/_og/og_card.html"
        for _ in range(5):  # load the page until every image really came in
            dt.call("Page.navigate", {"url": url})
            for _ in range(100):
                r = dt.call("Runtime.evaluate", {"expression": "document.readyState === 'complete'"
                                                               " && [...document.images].every(i => i.complete)"
                                                               " && document.fonts.status === 'loaded'",
                                                 "returnByValue": True})
                if r.get("result", {}).get("value"):
                    break
                time.sleep(0.2)
            r = dt.call("Runtime.evaluate", {
                "expression": "Promise.all([...document.images].map(i => i.decode().catch(() => 0)))"
                              ".then(() => [...document.images].filter(i => !i.naturalWidth).length)",
                "awaitPromise": True, "returnByValue": True})
            if r.get("result", {}).get("value") == 0:
                break
        else:
            raise RuntimeError("some images did not load")
        time.sleep(0.5)
        shot = dt.call("Page.captureScreenshot", {"format": "png", "clip": {"x": 0, "y": 0, "width": W, "height": H, "scale": 1}})
        out.write_bytes(base64.b64decode(shot["data"]))
    finally:
        proc.kill()
        httpd.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)
    print(f"wrote {out} ({out.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
