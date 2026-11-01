"""Serve web/ locally and receive the test hook's report (POST /report -> --out file).

    python tools/test_server.py --port 8790 --out result.json
    open http://127.0.0.1:8790/?log=testdata/.../Power.log&precision=quick&report=/report
"""

import argparse
import functools
import sys
import threading
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
    a = ap.parse_args()
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
