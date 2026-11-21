"""VM control (QEMU process, QMP socket, OpenCore selection) and host power."""
import json
import os
import re
import signal
import socket
import subprocess
import threading
import time

from util import ApiError, base_env, run_cmd, spawn_detached

_BT_RE = re.compile(r"(^|[_\-.])bt([_\-.]|$)", re.I)
_SAFE_NAME = re.compile(r"^[A-Za-z0-9._\-]+$")


def is_bt_opencore(name):
    return bool(_BT_RE.search(name or ""))


# --------------------------------------------------------------------------- QMP
class QMPError(Exception):
    pass


def qmp_session(sock_path, commands, timeout=3.0):
    """Open QMP, negotiate capabilities and run commands.

    commands: list of dicts {"execute": ..., "arguments": {...}}
    returns list of reply dicts ({"return": ...} or {"error": ...})."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(sock_path)
        f = s.makefile("rwb")

        def read_reply():
            while True:
                line = f.readline()
                if not line:
                    raise QMPError("QMP connection closed")
                try:
                    msg = json.loads(line.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if "event" in msg:
                    continue
                return msg

        def send(obj):
            f.write((json.dumps(obj) + "\r\n").encode("utf-8"))
            f.flush()

        greeting = read_reply()
        if "QMP" not in greeting:
            raise QMPError("unexpected QMP greeting")
        send({"execute": "qmp_capabilities"})
        r = read_reply()
        if "error" in r:
            raise QMPError(r["error"].get("desc", "qmp_capabilities failed"))
        out = []
        for cmd in commands:
            send(cmd)
            out.append(read_reply())
        return out
    except (OSError, socket.timeout) as exc:
        raise QMPError(str(exc))
    finally:
        try:
            s.close()
        except OSError:
            pass


def qmp_command(sock_path, execute, arguments=None, timeout=3.0):
    cmd = {"execute": execute}
    if arguments:
        cmd["arguments"] = arguments
    return qmp_session(sock_path, [cmd], timeout)[0]


def qmp_error_text(reply):
    err = reply.get("error") if isinstance(reply, dict) else None
    if err:
        return "%s: %s" % (err.get("class", "Error"), err.get("desc", ""))
    return ""


# --------------------------------------------------------------------------- VM
class VMController(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self._lock = threading.Lock()
        self._pid_cache = (None, None, 0.0)
        self._qmp_cache = (False, 0.0)
        self._selected_path = os.path.join(cfg.data_dir, "selected_opencore")
        # dev-mode simulation state
        self.sim = {
            "running": True, "pid": 1720, "opencore": "opencore_nullmoth_bt_v2.qcow2",
            "bt_disabled": False, "vfio_default": True, "watchdog": False,
            "started_at": time.time() - 3600,
            "opencores": [("opencore_nullmoth_bt_v2.qcow2", 66.0),
                          ("opencore_nullmoth_v2.qcow2", 64.5),
                          ("opencore_nullmoth_bt_v1.qcow2", 65.2)],
        }

    # ---------------------------------------------------------------- process
    def _scan_qemu(self):
        best = (None, None)
        try:
            pids = [p for p in os.listdir("/proc") if p.isdigit()]
        except OSError:
            return best
        for pid in pids:
            try:
                with open("/proc/%s/cmdline" % pid, "rb") as fh:
                    raw = fh.read()
            except (OSError, IOError):
                continue
            if not raw:
                continue
            args = [a.decode("utf-8", "replace") for a in raw.split(b"\0") if a]
            if not args or "qemu-system" not in os.path.basename(args[0]):
                continue
            joined = " ".join(args)
            if self.cfg.vm_dir in joined or "qmp.sock" in joined:
                return int(pid), args
            if best[0] is None:
                best = (int(pid), args)
        return best

    def find_qemu(self):
        """(pid, argv) of the macOS VM QEMU process, cached 3s."""
        if self.cfg.dev_mode:
            if self.sim["running"]:
                return self.sim["pid"], ["qemu-system-x86_64", "-name", "mac"]
            return None, None
        with self._lock:
            pid, args, ts = self._pid_cache
            now = time.time()
            if pid and now - ts < 3.0 and os.path.exists("/proc/%d" % pid):
                return pid, args
            pid, args = self._scan_qemu()
            self._pid_cache = (pid, args, now)
            return pid, args

    def invalidate(self):
        with self._lock:
            self._pid_cache = (None, None, 0.0)
            self._qmp_cache = (False, 0.0)

    @staticmethod
    def opencore_from_args(args):
        for arg in args or []:
            for m in re.finditer(r"(?:file=)?([^,=\s]*opencore[^,\s]*\.qcow2)", arg, re.I):
                return os.path.basename(m.group(1))
        return None

    def qmp_connected(self):
        if self.cfg.dev_mode:
            return self.sim["running"]
        ok, ts = self._qmp_cache
        if time.time() - ts < 5.0:
            return ok
        ok = False
        if os.path.exists(self.cfg.qmp_sock):
            try:
                r = qmp_command(self.cfg.qmp_sock, "query-status", timeout=1.5)
                ok = "return" in r
            except QMPError:
                ok = False
        self._qmp_cache = (ok, time.time())
        return ok

    def watchdog_active(self):
        if self.cfg.dev_mode:
            return self.sim["watchdog"]
        if os.path.exists("/tmp/nullmoth_confirm_ok"):
            return False
        pid_file = "/tmp/nullmoth_watchdog.pid"
        if os.path.isfile(pid_file):
            try:
                with open(pid_file) as fh:
                    wpid = fh.read().strip()
                if wpid.isdigit() and os.path.exists("/proc/%s" % wpid):
                    return True
            except (OSError, IOError):
                pass
        pat = self.cfg.watchdog_pattern
        me = os.getpid()
        try:
            pids = [p for p in os.listdir("/proc") if p.isdigit()]
        except OSError:
            return False
        for pid in pids:
            if int(pid) == me:
                continue
            try:
                with open("/proc/%s/cmdline" % pid, "rb") as fh:
                    raw = fh.read().replace(b"\0", b" ").decode("utf-8", "replace")
            except (OSError, IOError):
                continue
            if raw and pat in raw and ("nullmoth" in raw or "/root/" in raw or "reims" in raw):
                return True
        return False

    # ---------------------------------------------------------------- opencore
    def list_opencores(self):
        if self.cfg.dev_mode:
            return [{"name": n, "size_mb": s} for n, s in self.sim["opencores"]]
        out = []
        try:
            names = sorted(os.listdir(self.cfg.vm_dir))
        except OSError:
            return out
        for name in names:
            if "opencore" in name.lower() and name.lower().endswith(".qcow2"):
                path = os.path.join(self.cfg.vm_dir, name)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                out.append({"name": name, "size_mb": round(st.st_blocks * 512 / 1048576.0, 1)})
        return out

    def _read_selected(self):
        try:
            with open(self._selected_path) as fh:
                return fh.read().strip() or None
        except (OSError, IOError):
            return None

    def bt_disabled(self):
        if self.cfg.dev_mode:
            return self.sim["bt_disabled"]
        return os.path.exists(self.cfg.bt_flag)

    def current_opencore(self, args=None, running=None):
        if self.cfg.dev_mode:
            return self.sim["opencore"]
        if args:
            oc = self.opencore_from_args(args)
            if oc:
                return oc
        names = [o["name"] for o in self.list_opencores()]
        sel = self._read_selected()
        if sel and sel in names:
            return sel
        want_bt = not self.bt_disabled()
        for n in names:
            if is_bt_opencore(n) == want_bt:
                return n
        return names[0] if names else None

    def status(self):
        pid, args = self.find_qemu()
        running = pid is not None
        current = self.current_opencore(args, running)
        cores = self.list_opencores()
        for c in cores:
            c["active"] = (c["name"] == current)
        if self.cfg.dev_mode:
            vfio = self.sim["vfio_default"]
        else:
            vfio = os.path.exists(self.cfg.vfio_flag)
        return {
            "running": running,
            "pid": pid,
            "opencore": current,
            "available_opencores": cores,
            "qmp_connected": self.qmp_connected() if running else False,
            "bt_disabled_flag": self.bt_disabled(),
            "vfio_default_flag": vfio,
            "watchdog_active": self.watchdog_active(),
        }

    def select_opencore(self, name):
        if not isinstance(name, str) or not name or "/" in name or "\\" in name \
                or name in (".", "..") or not _SAFE_NAME.match(name):
            raise ApiError(400, "invalid_name")
        names = [o["name"] for o in self.list_opencores()]
        if self.cfg.dev_mode:
            if name not in names:
                raise ApiError(404, "not_found", detail="OpenCore não encontrado")
            self.sim["opencore"] = name
            self.sim["bt_disabled"] = not is_bt_opencore(name)
        else:
            path = os.path.join(self.cfg.vm_dir, name)
            if not os.path.isfile(path):
                raise ApiError(404, "not_found", detail="OpenCore não encontrado em %s" % self.cfg.vm_dir)
            if is_bt_opencore(name):
                if os.path.exists(self.cfg.bt_flag):
                    os.remove(self.cfg.bt_flag)
            else:
                with open(self.cfg.bt_flag, "w") as fh:
                    fh.write("disabled by MothOS %s\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            try:
                os.makedirs(os.path.dirname(self._selected_path), exist_ok=True)
                with open(self._selected_path, "w") as fh:
                    fh.write(name + "\n")
            except OSError:
                pass
        bt = is_bt_opencore(name)
        return {
            "ok": True, "selected": name,
            "message": "OpenCore %s selecionado (Bluetooth %s). Reinicie a VM para aplicar." % (
                name, "ativado" if bt else "desativado"),
        }

    # ---------------------------------------------------------------- actions
    def action(self, action):
        handlers = {
            "start": self._start, "shutdown": self._shutdown, "force_stop": self._force_stop,
            "restart": self._restart, "revert": self._revert,
            "confirm_watchdog": self._confirm_watchdog,
            "toggle_vfio_default": self._toggle_vfio_default,
        }
        fn = handlers.get(action)
        if fn is None:
            raise ApiError(400, "invalid_action")
        ok, message = fn()
        self.invalidate()
        if not ok:
            raise ApiError(409 if "já" in message else 500, "action_failed",
                           ok=False, action=action, message=message)
        return {"ok": True, "action": action, "message": message}

    def _start(self):
        pid, _ = self.find_qemu()
        if pid:
            return False, "A VM já está em execução (PID %d)" % pid
        if self.cfg.dev_mode:
            self.sim.update(running=True, pid=1720 + int(time.time()) % 500, started_at=time.time())
            return True, "VM iniciada (simulação dev)"
        if not os.path.isfile(self.cfg.start_script):
            return False, "Script não encontrado: %s" % self.cfg.start_script
        ok, msg = spawn_detached(self.cfg, ["/bin/bash", self.cfg.start_script], "vm-start")
        return ok, ("Iniciando VM via %s (%s)" % (self.cfg.start_script, msg)) if ok else msg

    def _restart(self):
        if self.cfg.dev_mode:
            self.sim.update(running=True, pid=1720 + int(time.time()) % 500, started_at=time.time())
            return True, "VM reiniciada (simulação dev)"
        if not os.path.isfile(self.cfg.start_script):
            return False, "Script não encontrado: %s" % self.cfg.start_script
        ok, msg = spawn_detached(self.cfg, ["/bin/bash", self.cfg.start_script], "vm-restart")
        return ok, ("Reiniciando VM via %s (%s)" % (self.cfg.start_script, msg)) if ok else msg

    def _revert(self):
        if self.cfg.dev_mode:
            self.sim.update(running=False, pid=None)
            return True, "Revertendo host (simulação dev)"
        if not os.path.isfile(self.cfg.revert_script):
            return False, "Script não encontrado: %s" % self.cfg.revert_script
        ok, msg = spawn_detached(self.cfg, ["/bin/bash", self.cfg.revert_script], "revert")
        return ok, ("Executando %s (%s)" % (self.cfg.revert_script, msg)) if ok else msg

    def _shutdown(self):
        pid, _ = self.find_qemu()
        if self.cfg.dev_mode:
            if not pid:
                return False, "A VM não está em execução"
            self.sim.update(running=False, pid=None)
            return True, "ACPI powerdown enviado (simulação dev)"
        try:
            r = qmp_command(self.cfg.qmp_sock, "system_powerdown")
        except QMPError as exc:
            return False, "Falha no QMP: %s" % exc
        if "error" in r:
            return False, qmp_error_text(r)
        return True, "Sinal ACPI de desligamento enviado ao macOS"

    def _force_stop(self):
        pid, _ = self.find_qemu()
        if not pid:
            return False, "A VM não está em execução"
        if self.cfg.dev_mode:
            self.sim.update(running=False, pid=None)
            return True, "QEMU finalizado à força (simulação dev)"
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return True, "Processo já havia terminado"
        except OSError as exc:
            return False, str(exc)
        deadline = time.time() + 8.0
        while time.time() < deadline:
            if not os.path.exists("/proc/%d" % pid):
                return True, "QEMU (PID %d) finalizado com SIGTERM" % pid
            time.sleep(0.25)
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        return True, "QEMU (PID %d) finalizado com SIGKILL" % pid

    def _confirm_watchdog(self):
        if self.cfg.dev_mode:
            self.sim["watchdog"] = False
            return True, "Watchdog desarmado (simulação dev)"
        try:
            with open("/tmp/nullmoth_confirm_ok", "w") as fh:
                fh.write("confirmed by MothOS %s\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            return True, "Vídeo confirmado OK — Watchdog desarmado."
        except OSError as exc:
            return False, str(exc)

    def _toggle_vfio_default(self):
        if self.cfg.dev_mode:
            self.sim["vfio_default"] = not self.sim["vfio_default"]
            st = "ativado" if self.sim["vfio_default"] else "desativado"
            return True, "Modo VFIO permanente %s (simulação dev)" % st
        try:
            if os.path.exists(self.cfg.vfio_flag):
                os.remove(self.cfg.vfio_flag)
                return True, "Modo VFIO permanente desativado (watchdog voltará nos próximos boots)."
            with open(self.cfg.vfio_flag, "w") as fh:
                fh.write("enabled by MothOS %s\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            return True, "Modo VFIO permanente ativado (/root/.nullmoth_vfio_default)."
        except OSError as exc:
            return False, str(exc)


# --------------------------------------------------------------------------- host power
def host_power(cfg, action, loop):
    """Validate + execute host power action. Schedules shutdown after 1.5s."""
    if action not in ("reboot", "shutdown", "boot_windows"):
        raise ApiError(400, "invalid_action")
    messages = {
        "reboot": "Reiniciando o host Linux em instantes...",
        "shutdown": "Desligando o PC em instantes...",
        "boot_windows": "Próximo boot: Windows (%s). Reiniciando..." % cfg.grub_entry,
    }
    if cfg.dev_mode:
        return {"ok": True, "action": action, "message": messages[action] + " (simulação dev)"}
    if action == "boot_windows":
        rc, out = run_cmd(["grub-reboot", cfg.grub_entry], timeout=30)
        if rc != 0:
            raise ApiError(500, "grub_reboot_failed", ok=False, action=action,
                           message="grub-reboot falhou: %s" % out.strip())
    cmd = ["shutdown", "-h", "+0"] if action == "shutdown" else ["shutdown", "-r", "+0"]

    def _fire():
        try:
            subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, env=base_env(), start_new_session=True)
        except OSError:
            pass
    loop.call_later(1.5, _fire)
    return {"ok": True, "action": action, "message": messages[action]}
