"""CLI entry point for Re-Tex Core: python -m retex_core [--port 8770] [--no-browser]."""
import argparse
import threading
import time
import webbrowser

import uvicorn

from .config import PORT


def main():
    ap = argparse.ArgumentParser(description="Re-Tex Core — Transient-Verified Stem Mashup DAW")
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    url = f"http://{args.host}:{args.port}"
    print(f"Re-Tex Core running at {url}")
    if not args.no_browser:
        def _open():
            time.sleep(0.9)
            webbrowser.open(url)
        threading.Thread(target=_open, daemon=True).start()

    uvicorn.run("retex_core.server:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
