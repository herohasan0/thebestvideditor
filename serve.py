# Serves this folder on http://localhost:5173 and tells the browser never to cache, so edits always show up.
import functools, http.server as h, os, sys

class Handler(h.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

here = os.path.dirname(os.path.abspath(__file__))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
h.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(Handler, directory=here)).serve_forever()
