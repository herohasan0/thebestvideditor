#!/bin/sh
# Starts the local server if it isn't running yet, then opens the editor in Google Chrome.
cd /
nc -z 127.0.0.1 5173 2>/dev/null || { nohup /usr/bin/python3 "$(dirname "$0")/serve.py" >/dev/null 2>&1 & sleep 1; }
open -a "Google Chrome" http://localhost:5173
