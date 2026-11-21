"""USB hot-plug through QMP (usb-host on xhci.0) and Bluetooth helper script."""
import glob
import os
import re

from util import ApiError, read_text, run_cmd
from vm import QMPError, qmp_error_text, qmp_session

_LSUSB_RE = re.compile(r"^Bus (\d+) Device (\d+): ID ([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$")
_INFO_USB_RE = re.compile(
    r"Device\s+[\d.]+,\s*Port\s+([\d.]+),\s*Speed\s+([^,]+?),\s*Product\s+(.*?)(?:,\s*ID:\s*(\S+))?\s*$")
_HEX4 = re.compile(r"^(?:0x)?([0-9a-fA-F]{4})$")
_DEV_ID = re.compile(r"^[A-Za-z0-9_.\-]{1,64}$")

BT_ACTIONS = {"attach": "attach", "detach": "detach", "preload_attach": "preload-attach",
              "enable": "enable", "disable": "disable"}


def norm_hex(value):
    m = _HEX4.match(str(value or "").strip())
    if not m:
        return None
    return m.group(1).lower()


def qmp_id(vid, pid):
    return "usb-%s-%s" % (vid, pid)


class USBManager(object):
    def __init__(self, cfg, vm):
        self.cfg = cfg
        self.vm = vm
        self.sim_vm = [
            {"id": "usb-8087-0029", "port": "2", "speed": "12 Mb/s", "product": "Intel AX200 Bluetooth",
             "vid": "8087", "pid": "0029"},
            {"id": "usb-compx-24g", "port": "1", "speed": "12 Mb/s", "product": "2.4G Wireless Receiver",
             "vid": "25a7", "pid": "fa70"},
        ]
        self.sim_host = [
            ("001", "002", "1022", "149c", "Advanced Micro Devices, Inc. [AMD] Matisse USB 3.0 Host Controller"),
            ("001", "010", "8087", "0029", "Intel Corp. AX200 Bluetooth"),
            ("001", "004", "25a7", "fa70", "Areson Technology Corp 2.4G Wireless Receiver"),
            ("001", "005", "046d", "c52b", "Logitech, Inc. Unifying Receiver"),
            ("002", "003", "0781", "5583", "SanDisk Corp. Ultra Fit"),
        ]
        self.sim_bt_enabled = True

    # ---------------------------------------------------------------- listing
    def _host_devices_raw(self):
        if self.cfg.dev_mode:
            return list(self.sim_host)
        rc, out = run_cmd(["lsusb"], timeout=10)
        devs = []
        if rc != 0:
            return devs
        for line in out.splitlines():
            m = _LSUSB_RE.match(line.strip())
            if m:
                devs.append((m.group(1), m.group(2), m.group(3).lower(), m.group(4).lower(),
                             m.group(5).strip()))
        return devs

    def _vm_devices(self):
        """List guest USB devices with (best effort) vid/pid via qom-get."""
        if self.cfg.dev_mode:
            return [dict(d) for d in self.sim_vm] if self.vm.sim["running"] else []
        if not os.path.exists(self.cfg.qmp_sock):
            return []
        try:
            r = qmp_session(self.cfg.qmp_sock, [{"execute": "human-monitor-command",
                                                 "arguments": {"command-line": "info usb"}}])[0]
        except QMPError:
            return []
        devs = []
        for line in str(r.get("return", "")).splitlines():
            m = _INFO_USB_RE.search(line.strip())
            if m:
                devs.append({"id": m.group(4) or "", "port": m.group(1), "speed": m.group(2).strip(),
                             "product": m.group(3).strip()})
        ids = [d["id"] for d in devs if d["id"]]
        if ids:
            cmds = []
            for i in ids:
                for prop in ("vendorid", "productid"):
                    cmds.append({"execute": "qom-get",
                                 "arguments": {"path": "/machine/peripheral/%s" % i, "property": prop}})
            try:
                replies = qmp_session(self.cfg.qmp_sock, cmds)
                vals = {}
                for idx, i in enumerate(ids):
                    v, p = replies[2 * idx].get("return"), replies[2 * idx + 1].get("return")
                    if isinstance(v, int) and isinstance(p, int) and (v or p):
                        vals[i] = ("%04x" % v, "%04x" % p)
                for d in devs:
                    if d["id"] in vals:
                        d["vid"], d["pid"] = vals[d["id"]]
            except QMPError:
                pass
        return devs

    def _bt_sysfs(self):
        vid, _, pid = self.cfg.bt_vidpid.partition(":")
        if self.cfg.dev_mode:
            return "/sys/bus/usb/devices/1-5"
        for d in glob.glob("/sys/bus/usb/devices/*"):
            if (read_text(os.path.join(d, "idVendor"), "") or "").strip().lower() == vid and \
                    (read_text(os.path.join(d, "idProduct"), "") or "").strip().lower() == pid:
                return d
        return None

    def _libusb_errors(self):
        if self.cfg.dev_mode:
            return 0
        text = read_text(self.cfg.qemu_log, "") or ""
        return sum(1 for line in text.splitlines()[-5000:] if "libusb" in line.lower())

    def list(self):
        vm_devs = self._vm_devices()
        attached_ids = set(d["id"] for d in vm_devs if d.get("id"))
        attached_pairs = set((d.get("vid"), d.get("pid")) for d in vm_devs if d.get("vid"))
        host = []
        for bus, dev, vid, pid, name in self._host_devices_raw():
            qid = qmp_id(vid, pid)
            host.append({"bus": bus, "dev": dev, "vid": "0x" + vid, "pid": "0x" + pid, "name": name,
                         "attached_to_vm": qid in attached_ids or (vid, pid) in attached_pairs,
                         "qmp_id": qid})
        bt_vid, _, bt_pid = self.cfg.bt_vidpid.partition(":")
        bt_attached = (bt_vid, bt_pid) in attached_pairs or qmp_id(bt_vid, bt_pid) in attached_ids
        vm_out = [{"id": d.get("id", ""), "port": d.get("port", ""), "speed": d.get("speed", ""),
                   "product": d.get("product", "")} for d in vm_devs]
        enabled = self.sim_bt_enabled if self.cfg.dev_mode else not os.path.exists(self.cfg.bt_flag)
        return {
            "host_devices": host,
            "vm_devices": vm_out,
            "bt": {"enabled": enabled and not (self.cfg.dev_mode and self.vm.sim["bt_disabled"]),
                   "attached": bt_attached, "sysfs": self._bt_sysfs(),
                   "libusb_errors": self._libusb_errors()},
        }

    # ---------------------------------------------------------------- actions
    def attach(self, body):
        vid, pid = norm_hex(body.get("vid")), norm_hex(body.get("pid"))
        if not vid or not pid:
            raise ApiError(400, "invalid_vid_pid")
        dev_id = qmp_id(vid, pid)
        port = body.get("port")
        if self.cfg.dev_mode:
            if not self.vm.sim["running"]:
                return {"ok": False, "id": dev_id, "message": "A VM não está em execução"}
            if any(d["id"] == dev_id for d in self.sim_vm):
                return {"ok": False, "id": dev_id, "message": "Dispositivo já anexado (%s)" % dev_id}
            name = next((h[4] for h in self.sim_host if h[2] == vid and h[3] == pid), "USB Device")
            self.sim_vm.append({"id": dev_id, "port": str(port or len(self.sim_vm) + 1), "speed": "480 Mb/s",
                                "product": name, "vid": vid, "pid": pid})
            return {"ok": True, "id": dev_id, "message": "Dispositivo %s:%s anexado à VM" % (vid, pid)}
        args = {"driver": "usb-host", "bus": self.cfg.usb_bus, "id": dev_id,
                "vendorid": int(vid, 16), "productid": int(pid, 16)}
        if port not in (None, ""):
            if not re.match(r"^[0-9.]{1,16}$", str(port)):
                raise ApiError(400, "invalid_port")
            args["port"] = str(port)
        try:
            r = qmp_session(self.cfg.qmp_sock, [{"execute": "device_add", "arguments": args}])[0]
        except QMPError as exc:
            return {"ok": False, "id": dev_id, "message": "Falha no QMP: %s" % exc}
        if "error" in r:
            return {"ok": False, "id": dev_id, "message": qmp_error_text(r)}
        return {"ok": True, "id": dev_id, "message": "Dispositivo %s:%s anexado à VM" % (vid, pid)}

    def detach(self, body):
        dev_id = body.get("id")
        if not isinstance(dev_id, str) or not _DEV_ID.match(dev_id):
            raise ApiError(400, "invalid_id")
        if self.cfg.dev_mode:
            before = len(self.sim_vm)
            self.sim_vm = [d for d in self.sim_vm if d["id"] != dev_id]
            if len(self.sim_vm) == before:
                return {"ok": False, "message": "Dispositivo %s não encontrado" % dev_id}
            return {"ok": True, "message": "Dispositivo %s removido da VM" % dev_id}
        try:
            r = qmp_session(self.cfg.qmp_sock, [{"execute": "device_del", "arguments": {"id": dev_id}}])[0]
        except QMPError as exc:
            return {"ok": False, "message": "Falha no QMP: %s" % exc}
        if "error" in r:
            return {"ok": False, "message": qmp_error_text(r)}
        return {"ok": True, "message": "Dispositivo %s removido da VM" % dev_id}

    def bt(self, body):
        action = body.get("action")
        arg = BT_ACTIONS.get(action)
        if not arg:
            raise ApiError(400, "invalid_action")
        if self.cfg.dev_mode:
            bt_id = qmp_id(*self.cfg.bt_vidpid.split(":"))
            if action in ("attach", "preload_attach"):
                if not any(d["id"] == bt_id for d in self.sim_vm):
                    self.sim_vm.append({"id": bt_id, "port": "2", "speed": "12 Mb/s",
                                        "product": "Intel AX200 Bluetooth", "vid": "8087", "pid": "0029"})
            elif action == "detach":
                self.sim_vm = [d for d in self.sim_vm if d["id"] != bt_id]
            elif action == "enable":
                self.sim_bt_enabled = True
            elif action == "disable":
                self.sim_bt_enabled = False
            return {"ok": True, "output": "[dev] %s %s\nOK: ação '%s' simulada com sucesso.\n" % (
                self.cfg.bt_script, arg, arg)}
        if not os.path.isfile(self.cfg.bt_script):
            return {"ok": False, "output": "Script não encontrado: %s" % self.cfg.bt_script}
        rc, out = run_cmd(["/bin/bash", self.cfg.bt_script, arg], timeout=90)
        return {"ok": rc == 0, "output": out}
