"""APT updates (background tasks) and systemd service management."""
import os
import re
import subprocess
import threading
import time

from util import ApiError, base_env, child_preexec, isolate_cmd, run_cmd, tail_text

_UPG_RE = re.compile(r"^([^/\s]+)/\S+\s+(\S+)\s+\S+\s+\[upgradable from:\s*([^\]]+)\]")
_SERVICE_RE = re.compile(r"^[A-Za-z0-9@._\-:]{1,128}$")

DEFAULT_SERVICES = [
    ("mothos.service", "MothOS"),
    ("sshd.service", "SSH"),
    ("NetworkManager.service", "NetworkManager"),
    ("bluetooth.service", "Bluetooth"),
    ("cron.service", "Cron"),
]
SERVICE_ACTIONS = ("start", "stop", "restart", "enable", "disable")


def parse_upgradable(text):
    pkgs = []
    for line in text.splitlines():
        m = _UPG_RE.match(line.strip())
        if m:
            pkgs.append({"name": m.group(1), "current": m.group(3).strip(), "candidate": m.group(2)})
    return pkgs


class Updates(object):
    OUTPUT_LIMIT = 64 * 1024

    def __init__(self, cfg):
        self.cfg = cfg
        self._lock = threading.Lock()
        self.state = {"running": False, "task": "idle", "output": "", "packages": [],
                      "last_check": None, "last_returncode": None}
        if cfg.dev_mode:
            self.state["packages"] = [
                {"name": "linux-image-amd64", "current": "6.12.38-1", "candidate": "6.12.41-1"},
                {"name": "openssl", "current": "3.5.1-1", "candidate": "3.5.1-1+deb13u1"},
                {"name": "qemu-system-x86", "current": "1:10.0.2+ds-2", "candidate": "1:10.0.3+ds-1"},
            ]

    def status(self):
        with self._lock:
            s = dict(self.state)
            s["packages"] = list(s["packages"])
        s["upgradable_count"] = len(s["packages"])
        return s

    def _append(self, text):
        with self._lock:
            self.state["output"] = tail_text(self.state["output"] + text, self.OUTPUT_LIMIT)

    def _begin(self, task):
        with self._lock:
            if self.state["running"]:
                raise ApiError(409, "busy", ok=False, running=True, task=self.state["task"])
            self.state.update(running=True, task=task, output="", last_returncode=None)

    def _finish(self, rc):
        with self._lock:
            self.state.update(running=False, task="idle", last_returncode=rc)

    def _stream(self, cmd, env=None, isolate=False, tag="apt"):
        self._append("$ %s\n" % " ".join(cmd))
        full = isolate_cmd(self.cfg, cmd, tag) if isolate else cmd
        try:
            proc = subprocess.Popen(full, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, env=env or base_env(),
                                    preexec_fn=child_preexec(new_session=True))
        except OSError as exc:
            self._append("erro: %s\n" % exc)
            return 127
        for raw in iter(proc.stdout.readline, b""):
            self._append(raw.decode("utf-8", "replace"))
        proc.stdout.close()
        return proc.wait()

    def _refresh_list(self):
        rc, out = run_cmd(["apt", "list", "--upgradable"], timeout=120,
                          env=base_env({"LANG": "C", "LC_ALL": "C"}))
        pkgs = parse_upgradable(out) if rc == 0 else []
        with self._lock:
            self.state["packages"] = pkgs
            self.state["last_check"] = time.time()
        return pkgs

    # -------------------------------------------------------------- tasks
    def _check_worker(self):
        rc = 1
        try:
            if self.cfg.dev_mode:
                for line in ["Hit:1 http://deb.debian.org/debian trixie InRelease",
                             "Get:2 http://security.debian.org/debian-security trixie-security InRelease [43.4 kB]",
                             "Fetched 43.4 kB in 1s (52.1 kB/s)", "Reading package lists... Done"]:
                    time.sleep(0.15)
                    self._append(line + "\n")
                with self._lock:
                    self.state["last_check"] = time.time()
                rc = 0
            else:
                rc = self._stream(["apt-get", "update"], env=base_env({"LANG": "C"}))
                pkgs = self._refresh_list()
                self._append("\n%d pacote(s) atualizável(is).\n" % len(pkgs))
        except Exception as exc:  # pragma: no cover
            self._append("erro: %s\n" % exc)
        finally:
            self._finish(rc)

    def _upgrade_worker(self):
        rc = 1
        try:
            if self.cfg.dev_mode:
                for p in self.status()["packages"]:
                    time.sleep(0.15)
                    self._append("Setting up %s (%s) ...\n" % (p["name"], p["candidate"]))
                with self._lock:
                    self.state["packages"] = []
                self._append("0 upgraded, 0 newly installed. Done.\n")
                rc = 0
            else:
                env = base_env({"DEBIAN_FRONTEND": "noninteractive", "LANG": "C",
                                "APT_LISTCHANGES_FRONTEND": "none"})
                rc = self._stream(["apt-get", "-y", "-o", "Dpkg::Options::=--force-confdef",
                                   "-o", "Dpkg::Options::=--force-confold", "upgrade"],
                                  env=env, isolate=True, tag="apt-upgrade")
                self._refresh_list()
        except Exception as exc:  # pragma: no cover
            self._append("erro: %s\n" % exc)
        finally:
            self._finish(rc)

    def check(self):
        self._begin("check")
        threading.Thread(target=self._check_worker, daemon=True).start()
        return {"ok": True, "running": True}

    def upgrade(self):
        self._begin("upgrade")
        threading.Thread(target=self._upgrade_worker, daemon=True).start()
        return {"ok": True, "running": True}

    def initial_refresh(self):
        """Populate package list at startup (no apt-get update)."""
        if self.cfg.dev_mode:
            return
        threading.Thread(target=self._refresh_list, daemon=True).start()


# ---------------------------------------------------------------------- services
class Services(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self.sim = {
            "mothos.service": ["active", "enabled"],
            "sshd.service": ["active", "enabled"],
            "NetworkManager.service": ["active", "enabled"],
            "bluetooth.service": ["inactive", "disabled"],
            "cron.service": ["active", "enabled"],
            "nullmoth-watchdog.service": ["inactive", "enabled"],
        }

    @staticmethod
    def normalize(name):
        if not isinstance(name, str) or not _SERVICE_RE.match(name) or name.startswith("-"):
            raise ApiError(400, "invalid_service")
        if "." not in name:
            name += ".service"
        return name

    def is_protected(self, name):
        return name in self.cfg.protected_services

    def _catalog(self):
        items = list(DEFAULT_SERVICES)
        for part in (self.cfg.extra_services or "").split(","):
            part = part.strip()
            if part:
                n, _, label = part.partition(":")
                items.append((self.normalize(n.strip()), label.strip() or n.strip()))
        if self.cfg.dev_mode:
            items.append(("nullmoth-watchdog.service", "NullMoth Watchdog"))
        else:
            rc, out = run_cmd(["systemctl", "list-unit-files", "--no-legend", "--plain", "--type=service",
                               "nullmoth*", "reims*", "mothos*"], timeout=10)
            if rc == 0:
                for line in out.splitlines():
                    parts = line.split()
                    if parts and parts[0].endswith(".service"):
                        items.append((parts[0], parts[0][:-8]))
        seen, out_items = set(), []
        for n, label in items:
            if n not in seen:
                seen.add(n)
                out_items.append((n, label))
        return out_items

    def info(self, name, label=None):
        label = label or name.rsplit(".", 1)[0]
        if self.cfg.dev_mode:
            active, enabled = self.sim.get(name, ["inactive", "disabled"])
        else:
            rc, out = run_cmd(["systemctl", "show", name, "--property=ActiveState,UnitFileState,LoadState"],
                              timeout=10)
            props = {}
            for line in out.splitlines():
                k, _, v = line.partition("=")
                props[k.strip()] = v.strip()
            active = props.get("ActiveState") or "unknown"
            enabled = props.get("UnitFileState") or ("not-found" if props.get("LoadState") == "not-found"
                                                     else "unknown")
        return {"name": name, "label": label, "active": active, "enabled": enabled,
                "protected": self.is_protected(name)}

    def list(self):
        return {"services": [self.info(n, label) for n, label in self._catalog()]}

    def action(self, body):
        name = self.normalize(body.get("name"))
        action = body.get("action")
        if action not in SERVICE_ACTIONS:
            raise ApiError(400, "invalid_action")
        if body.get("confirm") is not True:
            raise ApiError(400, "confirmation_required")
        if action in ("stop", "disable") and self.is_protected(name):
            raise ApiError(403, "protected_service", ok=False, service=self.info(name),
                           output="%s é protegido: '%s' bloqueado." % (name, action))
        label = dict(self._catalog()).get(name)
        if self.cfg.dev_mode:
            st = self.sim.setdefault(name, ["inactive", "disabled"])
            if action in ("start", "restart"):
                st[0] = "active"
            elif action == "stop":
                st[0] = "inactive"
            elif action == "enable":
                st[1] = "enabled"
            elif action == "disable":
                st[1] = "disabled"
            return {"ok": True, "service": self.info(name, label),
                    "output": "[dev] systemctl %s %s" % (action, name)}
        cmd = ["systemctl"]
        if name == "mothos.service" and action == "restart":
            cmd.append("--no-block")  # do not kill ourselves mid-response
        cmd += [action, name]
        rc, out = run_cmd(cmd, timeout=90)
        return {"ok": rc == 0, "service": self.info(name, label), "output": out.strip() or "OK"}
