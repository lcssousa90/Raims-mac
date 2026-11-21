"""Shared helpers: API errors, subprocess runners, small parsers."""
import os
import shutil
import subprocess
import sys
import threading
import time


class ApiError(Exception):
    """Raised by handlers; converted to a JSON error response."""

    def __init__(self, status, error, **extra):
        Exception.__init__(self, error)
        self.status = status
        self.error = error
        self.extra = extra

    def payload(self):
        data = {"error": self.error}
        data.update(self.extra)
        return data


def require_confirm(body):
    if not isinstance(body, dict) or body.get("confirm") is not True:
        raise ApiError(400, "confirmation_required")


def tail_text(text, limit=200000):
    if len(text) > limit:
        return "...[truncated]...\n" + text[-limit:]
    return text


def read_text(path, default=None):
    try:
        with open(path, "r", errors="replace") as fh:
            return fh.read()
    except (OSError, IOError):
        return default


def parse_cpu_list(text):
    """'0,5-6,11' -> {0,5,6,11}"""
    out = set()
    for part in (text or "").strip().split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            if a.isdigit() and b.isdigit():
                out.update(range(int(a), int(b) + 1))
        elif part.isdigit():
            out.add(int(part))
    return out


# --------------------------------------------------------------------------
# Child process isolation
# --------------------------------------------------------------------------
_scope_ok = None
_scope_lock = threading.Lock()


def _host_affinity():
    """Affinity of PID 1 (what an SSH session would get), so children are not
    stuck on mothos.service CPUAffinity=0 5 6 11."""
    if not hasattr(os, "sched_getaffinity"):
        return None
    try:
        return os.sched_getaffinity(1)
    except OSError:
        return None


def child_preexec(new_session=True, ctty_fd=None):
    """Return a preexec_fn for Popen (Linux affinity reset, setsid, ctty)."""
    affinity = _host_affinity()

    def _fn():
        if new_session:
            try:
                os.setsid()
            except OSError:
                pass
        if ctty_fd is not None:
            try:
                import fcntl
                import termios
                fcntl.ioctl(ctty_fd, getattr(termios, "TIOCSCTTY", 0x540E), 0)
            except Exception:
                pass
        if affinity and hasattr(os, "sched_setaffinity"):
            try:
                os.sched_setaffinity(0, affinity)
            except OSError:
                pass
    return _fn


def scope_available(cfg):
    """True if `systemd-run --scope` works (production Linux host)."""
    global _scope_ok
    if cfg.dev_mode or not cfg.is_linux or not cfg.use_systemd_scope:
        return False
    with _scope_lock:
        if _scope_ok is None:
            ok = False
            if shutil.which("systemd-run") and os.path.isdir("/run/systemd/system"):
                try:
                    r = subprocess.run(["systemd-run", "--scope", "--quiet", "--collect", "/bin/true"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       stdin=subprocess.DEVNULL, timeout=10)
                    ok = r.returncode == 0
                except Exception:
                    ok = False
            _scope_ok = ok
        return _scope_ok


def isolate_cmd(cfg, cmd, tag="task"):
    """Wrap cmd in a transient systemd scope when available."""
    if scope_available(cfg):
        unit = "mothos-%s-%d-%d" % (tag, int(time.time()), os.getpid() % 10000)
        return ["systemd-run", "--scope", "--quiet", "--collect", "--unit=" + unit] + list(cmd)
    return list(cmd)


def base_env(extra=None):
    env = dict(os.environ)
    env.setdefault("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    if "/usr/sbin" not in env["PATH"]:
        env["PATH"] += ":/usr/sbin:/sbin"
    env.setdefault("LANG", "C.UTF-8")
    if extra:
        env.update(extra)
    return env


def run_cmd(cmd, timeout=60, env=None, cwd=None, cfg=None, isolate=False, tag="task", input_text=None):
    """Run a command, return (returncode, combined_output). Never raises for
    missing binaries / timeouts (returncode 127 / 124)."""
    if isolate and cfg is not None:
        cmd = isolate_cmd(cfg, cmd, tag)
    try:
        r = subprocess.run(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            input=input_text.encode() if input_text is not None else None,
            timeout=timeout, env=env or base_env(), cwd=cwd,
            preexec_fn=child_preexec(new_session=True) if sys.platform.startswith("linux") else None,
            start_new_session=not sys.platform.startswith("linux"))
        return r.returncode, r.stdout.decode("utf-8", "replace")
    except FileNotFoundError as exc:
        return 127, "command not found: %s" % (exc.filename or cmd[0])
    except subprocess.TimeoutExpired as exc:
        out = exc.output.decode("utf-8", "replace") if exc.output else ""
        return 124, out + "\n[timeout after %ss]" % timeout
    except OSError as exc:
        return 126, str(exc)


def spawn_detached(cfg, cmd, tag):
    """Start a long-running command fully detached (own session, own systemd
    scope so it survives mothos.service restarts and is not memory capped).
    Output goes to <data_dir>/logs/<tag>.log. Returns (ok, message)."""
    log_path = os.path.join(cfg.spawn_log_dir(), "%s.log" % tag)
    full = isolate_cmd(cfg, cmd, tag)
    try:
        logf = open(log_path, "ab")
    except OSError:
        logf = subprocess.DEVNULL
    try:
        if logf is not subprocess.DEVNULL:
            logf.write(("\n==== %s %s ====\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), " ".join(cmd))).encode())
            logf.flush()
        proc = subprocess.Popen(full, stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
                                close_fds=True, env=base_env(), cwd="/",
                                preexec_fn=child_preexec(new_session=True))
        # reap in background to avoid zombies
        threading.Thread(target=proc.wait, daemon=True).start()
        return True, "pid %d (log: %s)" % (proc.pid, log_path)
    except OSError as exc:
        return False, str(exc)
    finally:
        if logf is not subprocess.DEVNULL:
            logf.close()
