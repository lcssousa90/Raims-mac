#!/usr/bin/env python3
"""MothOS backend entrypoint."""
import asyncio
import os
import signal
import sys

# Ensure backend directory is importable regardless of cwd
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from config import Config
from logs import setup_logging
from server import serve_forever


def main():
    setup_logging()
    cfg = Config()

    async def _runner():
        loop = asyncio.get_running_loop()
        task = asyncio.ensure_future(serve_forever(cfg))
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, task.cancel)
            except (NotImplementedError, RuntimeError):
                pass
        try:
            await task
        except asyncio.CancelledError:
            pass

    try:
        asyncio.run(_runner())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
