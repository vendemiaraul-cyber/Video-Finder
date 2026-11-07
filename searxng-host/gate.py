"""MeoDeo gate: a tiny lock in front of SearXNG.

SearXNG listens only inside the container (127.0.0.1:8888). This gate
listens on the public port and passes a request through only when it
carries the secret key (header X-MeoDeo-Key, equal to the MEODEO_KEY
environment variable). Python standard library only.
"""
import hmac
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = os.environ.get("MEODEO_KEY", "")
UPSTREAM = os.environ.get("SEARXNG_UPSTREAM", "http://127.0.0.1:8888")
PORT = int(os.environ.get("PORT", "10000"))
PASS_HEADERS = ("content-type", "content-length", "cache-control")


class Gate(BaseHTTPRequestHandler):
    server_version = "MeoDeoGate"

    def _deny(self, code, text):
        body = text.encode()
        self.send_response(code)
        self.send_header("content-type", "text/plain; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/", "/healthz"):
            return self._deny(200, "MeoDeo SearXNG gate is running.\n")
        given = self.headers.get("x-meodeo-key", "")
        if not KEY or not hmac.compare_digest(given.encode(), KEY.encode()):
            return self._deny(401, "Missing or wrong MeoDeo key.\n")
        if not (self.path.startswith("/search") or self.path.startswith("/config")):
            return self._deny(404, "Not found.\n")
        req = urllib.request.Request(UPSTREAM + self.path, headers={
            "accept": self.headers.get("accept", "application/json"),
            # SearXNG's bot detection expects these on its own requests
            "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1",
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as up:
                status, headers, body = up.status, up.headers, up.read()
        except urllib.error.HTTPError as e:
            status, headers, body = e.code, e.headers, e.read()
        except Exception as e:  # SearXNG still starting, etc.
            return self._deny(503, f"SearXNG isn't ready: {e}\n")
        self.send_response(status)
        for h in PASS_HEADERS:
            if headers.get(h) and h != "content-length":
                self.send_header(h, headers.get(h))
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        pass  # keep search terms out of the logs


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Gate).serve_forever()
