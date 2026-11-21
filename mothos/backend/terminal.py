"""Interactive /bin/bash PTY session bridged to a WebSocket."""
import asyncio
import codecs
import fcntl
import json
import logging
import os
import pty
import signal
import struct
import subprocess
import termios

from util import base_env, child_preexec, run_cmd, tail_text

log = logging.getLogger("mothos.terminal")


def _set_winsize(fd, rows, cols):
    rows = max(2, min(500, int(rows)))
    cols = max(10, min(1000, int(cols)))
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def _spawn_shell(cfg, cols=80, rows=24):
    master, slave = pty.openpty()
    try:
        _set_winsize(master, rows, cols)
    except (OSError, ValueError):
        pass
    shell = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
    env = base_env({"TERM": "xterm-256color", "COLORTERM": "truecolor",
                    "BASH_SILENCE_DEPRECATION_WARNING": "1", "MOTHOS_TERMINAL": "1"})
    env.pop("MOTHOS_PIN", None)
    env.pop("MOTHOS_SECRET", None)
    home = env.get("HOME") or "/root"
    # Spawn directly without systemd-run --scope so setsid() + TIOCSCTTY keep
    # the PTY controlling terminal attached for interactive bash (-i).
    cmd = [shell, "-i"]
    proc = subprocess.Popen(
        cmd, stdin=slave, stdout=slave, stderr=slave, env=env,
        cwd=home if os.path.isdir(home) else "/", close_fds=True,
        preexec_fn=child_preexec(new_session=True, ctty_fd=0))
    os.close(slave)
    fl = fcntl.fcntl(master, fcntl.F_GETFL)
    fcntl.fcntl(master, fcntl.F_SETFL, fl | os.O_NONBLOCK)
    return proc, master


def _kill(proc):
    if proc.poll() is not None:
        return
    for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
        except OSError:
            try:
                proc.send_signal(sig)
            except OSError:
                pass
        try:
            proc.wait(timeout=0.5)
            return
        except subprocess.TimeoutExpired:
            continue


async def run_terminal(cfg, ws):
    loop = asyncio.get_running_loop()
    try:
        proc, master = _spawn_shell(cfg)
    except OSError as exc:
        await ws.send_json({"type": "output", "data": "Falha ao abrir terminal: %s\r\n" % exc})
        await ws.send_json({"type": "exit", "code": -1})
        await ws.close()
        return
    log.info("terminal opened pid=%s", proc.pid)
    queue = asyncio.Queue()
    decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def on_readable():
        try:
            data = os.read(master, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            try:
                loop.remove_reader(master)
            except Exception:
                pass
            queue.put_nowait(None)
        else:
            queue.put_nowait(data)

    loop.add_reader(master, on_readable)

    async def pump_output():
        while True:
            data = await queue.get()
            if data is None:
                break
            # coalesce bursts into one frame
            while not queue.empty():
                nxt = queue.get_nowait()
                if nxt is None:
                    queue.put_nowait(None)
                    break
                data += nxt
                if len(data) > 256 * 1024:
                    break
            text = decoder.decode(data)
            if text:
                await ws.send_json({"type": "output", "data": text})
        code = await loop.run_in_executor(None, proc.wait)
        await ws.send_json({"type": "exit", "code": code})

    async def pump_input():
        while True:
            msg = await ws.recv()
            if msg is None:
                return
            if isinstance(msg, bytes):
                os.write(master, msg)
                continue
            try:
                obj = json.loads(msg)
            except ValueError:
                continue
            if not isinstance(obj, dict):
                continue
            t = obj.get("type")
            if t == "input" and isinstance(obj.get("data"), str):
                data = obj["data"].encode("utf-8")
                while data:
                    try:
                        n = os.write(master, data)
                        data = data[n:]
                    except BlockingIOError:
                        await asyncio.sleep(0.01)
                    except OSError:
                        return
            elif t == "resize":
                try:
                    _set_winsize(master, obj.get("rows", 24), obj.get("cols", 80))
                    os.killpg(proc.pid, signal.SIGWINCH)
                except (OSError, ValueError, TypeError):
                    pass
            elif t == "ping":
                await ws.send_json({"type": "pong"})

    out_task = asyncio.ensure_future(pump_output())
    in_task = asyncio.ensure_future(pump_input())
    try:
        await asyncio.wait([out_task, in_task], return_when=asyncio.FIRST_COMPLETED)
    except Exception:
        pass
    finally:
        for t in (out_task, in_task):
            if not t.done():
                t.cancel()
        try:
            loop.remove_reader(master)
        except Exception:
            pass
        await loop.run_in_executor(None, _kill, proc)
        try:
            os.close(master)
        except OSError:
            pass
        for t in (out_task, in_task):
            try:
                await t
            except BaseException:
                pass
        await ws.close()
        log.info("terminal closed pid=%s rc=%s", proc.pid, proc.returncode)


def exec_quick(cfg, command):
    """Run a quick non-interactive command and capture combined output."""
    if not isinstance(command, str) or not command.strip():
        from util import ApiError
        raise ApiError(400, "empty_command")
    if len(command) > 4000:
        from util import ApiError
        raise ApiError(400, "command_too_long")
    env = base_env({"TERM": "xterm-256color"})
    env.pop("MOTHOS_PIN", None)
    env.pop("MOTHOS_SECRET", None)
    cwd = "/root" if (not cfg.dev_mode and os.path.isdir("/root")) else os.getcwd()
    shell = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
    rc, out = run_cmd([shell, "-c", command], timeout=25, env=env, cwd=cwd)
    return {"ok": rc == 0, "returncode": rc, "output": tail_text(out, 64 * 1024)}
