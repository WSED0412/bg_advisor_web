"""Serve web/ locally and receive the test hook's report (POST /report -> --out file).

    python tools/test_server.py --port 8790 --out result.json
    open http://127.0.0.1:8790/?log=testdata/.../Power.log&precision=quick&report=/report

With --fake-bridge, it also plays the HDT plugin (BridgeServer.cs) on 127.0.0.1, with the same
token rules, serving the Power.log files under --logs and keeping reports in memory:

    python tools/test_server.py --port 8790 --fake-bridge 47616 --token <43 characters> --logs web/testdata
    open http://127.0.0.1:8790/#/bridge/47616/<token>     (paired: the page reviews those logs)
    open http://127.0.0.1:8790/#/bridge/47616              (not paired: "open it from HDT once")
"""

import argparse
import functools
import hmac
import json
import sys
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"


class Handler(SimpleHTTPRequestHandler):
    # Keep-alive: closing after each response makes Windows reset some connections mid-body.
    protocol_version = "HTTP/1.1"
    out: Path = Path("result.json")
    done = threading.Event()
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".wasm": "application/wasm"}

    verbose = False

    def log_message(self, fmt, *args):
        if self.verbose:
            print("HTTP:", fmt % args, flush=True)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        # Lets the deployed site fetch local test logs (localhost only).
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        # Preflight from the deployed site (Private Network Access) for local test logs.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        if self.path.startswith("/log"):
            print("PAGE:", body.decode("utf-8", "replace"), flush=True)
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.out.write_bytes(body)
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()
        Handler.done.set()


class FakeBridge(SimpleHTTPRequestHandler):
    """The plugin's HTTP API (see plugin/src/BridgeServer.cs), for page tests without HDT."""
    protocol_version = "HTTP/1.1"
    token = ""
    version = "0.4.3"
    logs: Path = WEB / "testdata"
    reports: dict[str, bytes] = {}
    deleted: dict[str, bytes] = {}   # reports deleted by a page (the plugin's reports\deleted)
    game_ends = 0

    def log_message(self, fmt, *args):
        print("BRIDGE:", fmt % args, flush=True)

    def _origin_ok(self, origin):
        if not origin:
            return False
        u = urllib.parse.urlsplit(origin)
        return origin == "https://wsed0412.github.io" or (u.scheme == "http" and u.hostname in ("127.0.0.1", "localhost"))

    def _send(self, status, body=b"", ctype="application/json", preflight=False):
        self.send_response(status)
        if body:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = self.headers.get("Origin")
        if self._origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            if preflight:
                self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
                self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        return bool(self.token) and auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip(), self.token)

    def _listing(self):
        return {f"Logs/{p.parent.name}/Power.log": p for p in sorted(self.logs.glob("*/Power.log"))}

    def _gate(self):
        """False (and the answer sent) when the request may not go on."""
        port = self.server.server_address[1]
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            self._send(403, b"bad host", "text/plain")
            return False
        origin = self.headers.get("Origin")
        if origin and not self._origin_ok(origin):
            self._send(403, b"origin not allowed", "text/plain")
            return False
        return True

    def do_OPTIONS(self):
        if self._gate():
            self._send(204, preflight=True)

    def do_GET(self):
        if not self._gate():
            return
        url = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        port = self.server.server_address[1]
        if not self._authorized():
            if url.path == "/status":
                hello = {"name": "bg_advisor_bridge", "version": self.version, "port": port, "auth": "required"}
                return self._send(200, json.dumps(hello).encode())
            return self._send(401, b'{"error":"token"}')
        if url.path == "/status":
            st = {"name": "bg_advisor_bridge", "version": self.version, "port": port, "gameEnds": self.game_ends,
                  "logDir": str(self.logs), "logDirOk": True, "browser": None, "backupDir": "(fake bridge)",
                  "logBackups": 0, "reports": len(self.reports)}
            return self._send(200, json.dumps(st).encode())
        if url.path == "/logs":
            items = [{"source": k, "size": p.stat().st_size, "modified": "2026-01-01T00:00:00Z"}
                     for k, p in self._listing().items()]
            return self._send(200, json.dumps(items).encode())
        if url.path == "/log":
            p = self._listing().get(q.get("source", ""))
            return self._send(200, p.read_bytes(), "text/plain; charset=utf-8") if p else self._send(404)
        if url.path == "/reports":
            keys = self.deleted if q.get("deleted") == "1" else self.reports
            return self._send(200, json.dumps(sorted(keys)).encode())
        if url.path == "/report" and q.get("key") in self.reports:
            return self._send(200, self.reports[q["key"]])
        self._send(404)

    def _write(self):
        if not self._gate():
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))
        if not self._origin_ok(self.headers.get("Origin")):
            return self._send(403, b"origin required", "text/plain")
        if not self._authorized():
            return self._send(401, b'{"error":"token"}')
        key = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query)).get("key", "")
        if self.command == "DELETE":
            gone = self.reports.pop(key, None)
            if gone is not None:
                self.deleted[key] = gone
            return self._send(200, json.dumps({"deleted": gone is not None}).encode())
        self.reports[key] = body
        self.deleted.pop(key, None)  # made again: no longer deleted
        self._send(200, b'{"saved":true}')

    do_POST = _write
    do_DELETE = _write


class Server(ThreadingHTTPServer):
    # The default backlog (5) drops connections when a page loads many modules at once.
    request_queue_size = 128
    daemon_threads = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--out", default="result.json")
    ap.add_argument("--once", action="store_true", help="exit after the first report")
    ap.add_argument("--verbose", action="store_true", help="print every request")
    ap.add_argument("--fake-bridge", type=int, metavar="PORT",
                    help="also play the HDT plugin on this port (47613-47617; pick one HDT is not using)")
    ap.add_argument("--token", default="", help="the fake plugin's token (43 characters: [A-Za-z0-9_-])")
    ap.add_argument("--logs", default=str(WEB / "testdata"), help="folder whose */Power.log the fake plugin serves")
    a = ap.parse_args()
    if a.fake_bridge:
        FakeBridge.token = a.token
        FakeBridge.logs = Path(a.logs)
        bridge = Server(("127.0.0.1", a.fake_bridge), FakeBridge)
        threading.Thread(target=bridge.serve_forever, daemon=True).start()
        print(f"fake plugin on http://127.0.0.1:{a.fake_bridge}/ (logs: {a.logs})", flush=True)
    Handler.out = Path(a.out)
    Handler.verbose = a.verbose
    httpd = Server(("127.0.0.1", a.port), functools.partial(Handler, directory=str(WEB)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print(f"serving {WEB} on http://127.0.0.1:{a.port}/", flush=True)
    try:
        if a.once:
            Handler.done.wait()
        else:
            threading.Event().wait()
    except KeyboardInterrupt:
        pass
    httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
