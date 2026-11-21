"""Log sources (qemu, dmesg, watchdog, mothos) + in-memory MothOS log buffer."""
import collections
import logging
import os
import random
import shutil
import threading
import time

from util import ApiError, run_cmd

SOURCES = ("qemu", "dmesg", "watchdog", "mothos")
MAX_LINES = 5000

_ring = collections.deque(maxlen=3000)
_ring_lock = threading.Lock()


class RingHandler(logging.Handler):
    def emit(self, record):
        try:
            line = self.format(record)
        except Exception:
            return
        with _ring_lock:
            _ring.append(line)


def setup_logging(level=logging.INFO):
    root = logging.getLogger("mothos")
    if getattr(root, "_mothos_configured", False):
        return root
    root.setLevel(level)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", "%Y-%m-%d %H:%M:%S")
    ring = RingHandler()
    ring.setFormatter(fmt)
    root.addHandler(ring)
    if not os.environ.get("MOTHOS_QUIET"):
        stream = logging.StreamHandler()
        stream.setFormatter(fmt)
        root.addHandler(stream)
    root.propagate = False
    root._mothos_configured = True
    return root


def ring_lines():
    with _ring_lock:
        return list(_ring)


def _tail_file(path, lines):
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            block = 65536
            data = b""
            pos = size
            while pos > 0 and data.count(b"\n") <= lines:
                step = min(block, pos)
                pos -= step
                fh.seek(pos)
                data = fh.read(step) + data
                if len(data) > 8 * 1024 * 1024:
                    break
        return data.decode("utf-8", "replace").splitlines()[-lines:]
    except (OSError, IOError):
        return None


def _journal(args, lines):
    if not shutil.which("journalctl"):
        return None
    rc, out = run_cmd(["journalctl", "--no-pager", "-o", "short-iso", "-n", str(lines)] + args, timeout=20)
    if rc != 0:
        return None
    return [l for l in out.splitlines() if not l.startswith("-- ")]


def _dev_lines(source, n):
    now = time.time()
    samples = {
        "qemu": ["qemu-system-x86_64: vfio: 0000:07:00.0: BAR 1 mmaps enabled",
                 "qemu-system-x86_64: warning: host doesn't support requested feature: CPUID.07H:EBX.hle",
                 "char device redirected to /dev/pts/3 (label serial0)",
                 "libusb: warning [libusb_exit] device 1.10 still referenced",
                 "QMP: client connected (mothos)"],
        "dmesg": ["vfio-pci 0000:07:00.0: enabling device (0000 -> 0003)",
                  "kvm_amd: TSC scaling supported", "usb 1-5: new full-speed USB device number 10 using xhci_hcd",
                  "Bluetooth: hci0: Firmware loaded", "r8169 0000:06:00.0 enp6s0: Link is Up - 1Gbps/Full",
                  "AMD-Vi: Interrupt remapping enabled", "WARNING: CPU: 3 PID: 0 at kernel/irq: spurious IRQ"],
        "watchdog": ["watchdog: VM alive (QMP query-status: running)", "watchdog: vCPU threads pinned OK",
                     "watchdog: IRQ affinity verified (vcpu clean)", "watchdog: heartbeat ok"],
    }
    pool = samples.get(source, ["..."])
    rnd = random.Random(int(now) // 30 + hash(source) % 1000)
    out = []
    for i in range(n):
        ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now - (n - i) * 7))
        out.append("%s debian %s: %s" % (ts, source, rnd.choice(pool)))
    return out


def get_logs(cfg, source, lines=150, flt=""):
    if source not in SOURCES:
        raise ApiError(400, "invalid_source", detail="use: %s" % ", ".join(SOURCES))
    try:
        lines = int(lines)
    except (TypeError, ValueError):
        lines = 150
    lines = max(1, min(MAX_LINES, lines))
    flt = (flt or "").strip().lower()
    # When filtering, scan a larger window then keep the last N matches.
    window = min(MAX_LINES * 4, lines * 10) if flt else lines
    out = None
    if source == "mothos":
        if not cfg.dev_mode:
            out = _journal(["-u", "mothos.service"], window)
        if not out:
            out = ring_lines()
    elif cfg.dev_mode:
        out = _dev_lines(source, min(window, 400))
    elif source == "qemu":
        out = _tail_file(cfg.qemu_log, window)
        if out is None:
            out = _journal(["_COMM=qemu-system-x86"], window)
    elif source == "watchdog":
        out = _tail_file(cfg.watchdog_log, window)
        if out is None:
            out = _journal(["-u", cfg.watchdog_unit], window)
    elif source == "dmesg":
        rc, txt = run_cmd(["dmesg", "--ctime", "--color=never"], timeout=20)
        out = txt.splitlines() if rc == 0 else _journal(["-k"], window)
    out = out or []
    if flt:
        out = [l for l in out if flt in l.lower()]
    return {"source": source, "lines": out[-lines:]}
