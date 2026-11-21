"""MothOS configuration (environment driven, stdlib only)."""
import os
import sys

APP_NAME = "MothOS"
VERSION = "2.1.0"

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))


def _bool(value, default=False):
    if value is None or value == "":
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def _int_list(value, default):
    if not value:
        return list(default)
    out = []
    for part in value.replace(" ", ",").split(","):
        part = part.strip()
        if part.isdigit():
            out.append(int(part))
    return out or list(default)


class Config(object):
    """Runtime settings. Every path can be overridden through env vars."""

    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.is_linux = sys.platform.startswith("linux")
        requested_dev = _bool(env.get("MOTHOS_DEV_MODE"), False)
        # Safety: never run real host actions (shutdown, grub-reboot...) on a
        # non-Linux workstation. Dev mode is forced there.
        self.forced_dev = (not self.is_linux) and not requested_dev
        self.dev_mode = requested_dev or not self.is_linux

        self.host = env.get("MOTHOS_HOST", "0.0.0.0")
        self.port = int(env.get("MOTHOS_PORT", "8090") or 8090)
        alt_default = "0" if self.dev_mode else "80"
        https_default = "0" if self.dev_mode else "8443"
        https_alt_default = "0" if self.dev_mode else "443"
        self.http_port_alt = int(env.get("MOTHOS_HTTP_PORT_ALT", alt_default) or 0)
        self.https_port = int(env.get("MOTHOS_HTTPS_PORT", https_default) or 0)
        self.https_port_alt = int(env.get("MOTHOS_HTTPS_PORT_ALT", https_alt_default) or 0)
        self.pin = str(env.get("MOTHOS_PIN", "0000") or "0000")
        self.secret = env.get("MOTHOS_SECRET", "") or ""
        self.session_max_age = int(env.get("MOTHOS_SESSION_MAX_AGE", "604800") or 604800)

        self.frontend_dir = os.path.abspath(
            env.get("MOTHOS_FRONTEND_DIR") or os.path.join(BACKEND_DIR, "..", "frontend"))
        default_data = "/var/lib/mothos" if (self.is_linux and not self.dev_mode) \
            else os.path.join(BACKEND_DIR, ".data")
        self.data_dir = os.path.abspath(env.get("MOTHOS_DATA_DIR") or default_data)

        # Host / VM layout (Debian 13 host 192.168.18.10)
        self.vm_dir = env.get("MOTHOS_VM_DIR", "/root/.local/share/reims-ctl/vms/mac")
        self.qmp_sock = env.get("MOTHOS_QMP_SOCK", os.path.join(self.vm_dir, "qmp.sock"))
        self.vm_disk = env.get("MOTHOS_VM_DISK", os.path.join(self.vm_dir, "disk.qcow2"))
        self.start_script = env.get("MOTHOS_START_SCRIPT", "/root/iniciar-nullmoth-vfio.sh")
        self.revert_script = env.get("MOTHOS_REVERT_SCRIPT", "/root/reverte-tudo.sh")
        self.bt_script = env.get("MOTHOS_BT_SCRIPT", "/root/bt-control.sh")
        self.bt_flag = env.get("MOTHOS_BT_FLAG", "/root/.nullmoth_disable_bt")
        self.vfio_flag = env.get("MOTHOS_VFIO_FLAG", "/root/.nullmoth_vfio_default")
        self.bt_vidpid = env.get("MOTHOS_BT_VIDPID", "8087:0029").lower()
        self.qemu_log = env.get("MOTHOS_QEMU_LOG", os.path.join(self.vm_dir, "logs", "qemu_nullmoth_vfio.log"))
        self.watchdog_log = env.get("MOTHOS_WATCHDOG_LOG", "/tmp/nullmoth_watchdog.log")
        self.bt_guard_log = env.get("MOTHOS_BT_GUARD_LOG", "/tmp/nullmoth_bt_guard.log")
        self.watchdog_unit = env.get("MOTHOS_WATCHDOG_UNIT", "nullmoth-watchdog.service")
        self.watchdog_pattern = env.get("MOTHOS_WATCHDOG_PATTERN", "watchdog")
        self.grub_entry = env.get("MOTHOS_GRUB_ENTRY", "windows-nvme")
        self.usb_bus = env.get("MOTHOS_USB_BUS", "xhci.0")

        self.vcpu_cores = _int_list(env.get("MOTHOS_VCPU_CORES"), [1, 2, 3, 4, 7, 8, 9, 10])
        self.irq_patterns = [p for p in (env.get("MOTHOS_IRQ_PATTERNS") or
                             "enp6s0,06:00.0,07:00.0,07:00.1,05:00.0,09:00.3").split(",") if p]

        self.protected_services = set(
            (env.get("MOTHOS_PROTECTED_SERVICES") or
             "sshd.service,ssh.service,NetworkManager.service,mothos.service").split(","))
        self.extra_services = env.get("MOTHOS_SERVICES", "")
        # Run long/heavy children (VM scripts, dpkg, apt, terminal) in a transient
        # systemd scope so they escape mothos.service MemoryMax/KillMode.
        self.use_systemd_scope = _bool(env.get("MOTHOS_SYSTEMD_SCOPE"), True)

        self.max_body = int(env.get("MOTHOS_MAX_BODY", str(32 * 1024 * 1024)))
        self.max_read = 512 * 1024

    def spawn_log_dir(self):
        path = os.path.join(self.data_dir, "logs")
        try:
            os.makedirs(path, exist_ok=True)
        except OSError:
            pass
        return path
