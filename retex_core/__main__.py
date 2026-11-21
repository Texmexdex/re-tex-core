"""CLI entry point for Re-Tex Core: python -m retex_core [--port 8770] [--demo] [--standalone] [--no-browser]."""
import argparse
import os
import threading
import time
import webbrowser
from pathlib import Path

import uvicorn


def main():
    ap = argparse.ArgumentParser(description="Re-Tex Core — Transient-Verified Stem Mashup DAW")
    ap.add_argument("--port", type=int, default=int(os.environ.get("RETEX_CORE_PORT", "8770")))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--standalone", action="store_true", help="Force standalone local ./data/ library")
    ap.add_argument("--demo", action="store_true", help="Launch an isolated royalty-free 2-track interactive demo")
    args = ap.parse_args()

    if args.standalone:
        os.environ["RETEX_CORE_STANDALONE"] = "1"
    if args.demo:
        os.environ["RETEX_CORE_STANDALONE"] = "1"
        if "RETEX_CORE_DATA" not in os.environ:
            os.environ["RETEX_CORE_DATA"] = str(Path(__file__).resolve().parent.parent / "data_demo")
        from . import demo
        demo.seed_demo()

    from .config import MODE, SHARED_SONGS
    url = f"http://{args.host}:{args.port}"
    print(f"Re-Tex Core ({MODE} mode · library: {SHARED_SONGS}) running at {url}")
    if not args.no_browser:
        def _open():
            time.sleep(0.9)
            webbrowser.open(url)
        threading.Thread(target=_open, daemon=True).start()

    uvicorn.run("retex_core.server:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
