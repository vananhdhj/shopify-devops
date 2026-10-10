"""A tiny Alertmanager webhook receiver for the lab.

Every notification is printed as one JSON line per alert (readable with `kubectl logs`) and kept
in memory, newest last, at GET /alerts, so smoke tests and drills can assert that an alert really
was delivered and later resolved, without depending on the internet or on Discord.
"""

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

received = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        for alert in body.get("alerts", []):
            record = {
                "receivedAt": datetime.now(timezone.utc).isoformat(),
                "status": alert.get("status"),
                "alertname": alert.get("labels", {}).get("alertname"),
                "namespace": alert.get("labels", {}).get("namespace"),
                "startsAt": alert.get("startsAt"),
                "endsAt": alert.get("endsAt"),
            }
            received.append(record)
            del received[:-500]
            print(json.dumps(record), flush=True)
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path == "/alerts":
            payload = json.dumps(received).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)
        elif self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):  # the JSON lines above are the log
        pass


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
