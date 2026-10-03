# Serves this folder (and ../dist) on :5180 with the headers a host needs for SharedArrayBuffer.
import http.server, os
os.chdir(os.path.join(os.path.dirname(__file__), ".."))
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()
http.server.test(H, port=5180)
