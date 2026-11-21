"""Real-time host + VM metrics (Linux sysfs/procfs) with a dev-mode simulator."""
import glob
import math
import os
import random
import re
import shutil
import socket
import struct
import threading
import time

from util import ApiError, parse_cpu_list, read_text, run_cmd

GIB = 1024.0 ** 3
_CPPC_RE = re.compile(r"ref:(\d+)\s+del:(\d+)")


def _read_pcie_max_read_req(pci_addr="0000:07:00.0"):
    cfg_path = "/sys/bus/pci/devices/%s/config" % pci_addr
    try:
        with open(cfg_path, "rb") as fh:
            data = fh.read(256)
        if len(data) < 64:
            return "—"
        ptr = data[0x34] & 0xFC
        seen = set()
        while ptr and ptr not in seen and ptr + 10 <= len(data):
            seen.add(ptr)
            cap_id = data[ptr]
            nxt = data[ptr + 1] & 0xFC
            if cap_id == 0x10:
                devctl = struct.unpack("<H", data[ptr + 8:ptr + 10])[0]
                code = (devctl >> 12) & 0x7
                sizes = {0: "128B", 1: "256B", 2: "512B", 3: "1024B", 4: "2048B", 5: "4096B"}
                return sizes.get(code, "?")
            ptr = nxt
    except (OSError, IOError):
        pass
    return "—"


def qcow2_virtual_size(path):
    """Virtual disk size from the qcow2 header (bytes 24..31, big endian)."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(32)
        if len(head) >= 32 and head[:4] == b"QFI\xfb":
            return struct.unpack(">Q", head[24:32])[0]
    except (OSError, IOError):
        pass
    return None


class Monitor(object):
    def __init__(self, cfg, vm):
        self.cfg = cfg
        self.vm = vm
        self._lock = threading.Lock()
        self._cache = None
        self._cache_t = 0.0
        self._prev_cppc = {}
        self._prev_stat = {}
        self._prev_irq = {}
        self._hwmon = None
        self._cpu_model = None
        self._vm_disk_cache = (None, 0.0)
        self._t0 = time.time()
        self._guest_lock = threading.Lock()
        self._guest_gpu = {}
        self._guest_gpu_ts = 0.0
        self._prev_guest_ctrs = None
        self._prev_gpu_irq = (None, 0.0)
        self._prev_audio_irq = (None, 0.0)
        self._dev_cpu_mode = "performance"

    # ------------------------------------------------------------------ public
    def snapshot(self):
        with self._lock:
            now = time.time()
            if self._cache is not None and now - self._cache_t < 0.5:
                return self._cache
            if self.cfg.dev_mode:
                snap = self._dev_snapshot()
            else:
                snap = self._linux_snapshot()
            self._cache = snap
            self._cache_t = time.time()
            return snap

    def role(self, cpu_id):
        return "vcpu" if cpu_id in self.cfg.vcpu_cores else "host"

    # ------------------------------------------------------------------ linux
    def _cpu_ids(self):
        ids = []
        for path in glob.glob("/sys/devices/system/cpu/cpu[0-9]*"):
            tail = os.path.basename(path)[3:]
            if tail.isdigit():
                ids.append(int(tail))
        return sorted(ids) or list(range(os.cpu_count() or 1))

    def _read_cppc(self, ids):
        out = {}
        for i in ids:
            base = "/sys/devices/system/cpu/cpu%d/acpi_cppc/" % i
            m = _CPPC_RE.search(read_text(base + "feedback_ctrs", "") or "")
            nominal = (read_text(base + "nominal_freq", "") or "").strip()
            if m and nominal.isdigit():
                out[i] = (int(m.group(1)), int(m.group(2)), int(nominal))
        return out

    @staticmethod
    def _read_stat():
        out = {}
        for line in (read_text("/proc/stat", "") or "").splitlines():
            if line.startswith("cpu") and line[3:4].isdigit():
                parts = line.split()
                vals = [int(v) for v in parts[1:9]]
                while len(vals) < 8:
                    vals.append(0)
                total = sum(vals)
                idle = vals[3] + vals[4]
                out[int(parts[0][3:])] = (total, idle)
        return out

    @staticmethod
    def _fallback_mhz(i):
        v = (read_text("/sys/devices/system/cpu/cpu%d/cpufreq/scaling_cur_freq" % i, "") or "").strip()
        if v.isdigit():
            return int(v) / 1000.0
        return 0.0

    def _temps(self):
        if self._hwmon is None:
            self._hwmon = ""
            for d in glob.glob("/sys/class/hwmon/hwmon*"):
                if (read_text(os.path.join(d, "name"), "") or "").strip() == "k10temp":
                    self._hwmon = d
                    break
        temps = {}
        if self._hwmon:
            for lbl in glob.glob(os.path.join(self._hwmon, "temp*_label")):
                label = (read_text(lbl, "") or "").strip()
                val = (read_text(lbl.replace("_label", "_input"), "") or "").strip()
                if val.lstrip("-").isdigit():
                    temps[label] = round(int(val) / 1000.0, 1)
        return temps.get("Tctl"), temps.get("Tccd1")

    def _cpu_model_name(self):
        if self._cpu_model is None:
            self._cpu_model = "Unknown CPU"
            for line in (read_text("/proc/cpuinfo", "") or "").splitlines():
                if line.startswith("model name"):
                    self._cpu_model = line.split(":", 1)[1].strip()
                    break
        return self._cpu_model

    def _cpu(self):
        ids = self._cpu_ids()
        cppc = self._read_cppc(ids)
        stat = self._read_stat()
        if not self._prev_stat:
            # first sample: take a short baseline so the first answer is real
            self._prev_cppc, self._prev_stat = cppc, stat
            time.sleep(0.15)
            cppc = self._read_cppc(ids)
            stat = self._read_stat()
        cores = []
        for i in ids:
            mhz = None
            if i in cppc and i in self._prev_cppc:
                r0, d0, _ = self._prev_cppc[i]
                r1, d1, nominal = cppc[i]
                dr, dd = r1 - r0, d1 - d0
                if dr > 0 and dd >= 0:
                    mhz = nominal * float(dd) / float(dr)
            if mhz is None:
                mhz = self._fallback_mhz(i)
            usage = 0.0
            if i in stat and i in self._prev_stat:
                dt = stat[i][0] - self._prev_stat[i][0]
                di = stat[i][1] - self._prev_stat[i][1]
                if dt > 0:
                    usage = max(0.0, min(100.0, 100.0 * (dt - di) / dt))
            cores.append({"id": i, "role": self.role(i), "mhz": round(mhz, 1),
                          "usage_pct": round(usage, 1)})
        self._prev_cppc, self._prev_stat = cppc, stat
        vmhz = [c["mhz"] for c in cores if c["role"] == "vcpu" and c["mhz"] > 0]
        avg_usage = sum(c["usage_pct"] for c in cores) / len(cores) if cores else 0.0
        tctl, tccd1 = self._temps()
        boost = (read_text("/sys/devices/system/cpu/cpufreq/boost", "") or "").strip()
        gov = (read_text("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", "") or "").strip() or None
        epp = (read_text("/sys/devices/system/cpu/cpu0/cpufreq/energy_performance_preference", "") or "").strip() or None
        return {
            "model": self._cpu_model_name(),
            "boost_enabled": boost == "1" if boost else None,
            "governor": gov,
            "epp": epp,
            "temp_tctl_c": tctl,
            "temp_tccd1_c": tccd1,
            "avg_vcpu_mhz": round(sum(vmhz) / len(vmhz), 1) if vmhz else 0.0,
            "avg_usage_pct": round(avg_usage, 1),
            "cores": cores,
        }

    @staticmethod
    def _memory():
        info = {}
        for line in (read_text("/proc/meminfo", "") or "").splitlines():
            key, _, rest = line.partition(":")
            parts = rest.split()
            if parts and parts[0].isdigit():
                info[key.strip()] = int(parts[0])
        total = info.get("MemTotal", 0) // 1024
        avail = info.get("MemAvailable", info.get("MemFree", 0)) // 1024
        swap_t = info.get("SwapTotal", 0) // 1024
        swap_f = info.get("SwapFree", 0) // 1024
        return {
            "total_mb": total, "used_mb": max(0, total - avail), "available_mb": avail,
            "swap_total_mb": swap_t, "swap_used_mb": max(0, swap_t - swap_f),
            "hugepages_total": info.get("HugePages_Total", 0),
            "hugepages_free": info.get("HugePages_Free", 0),
        }

    def _disk(self):
        out = {"root_total_gb": 0.0, "root_used_gb": 0.0, "root_free_gb": 0.0, "root_pct": 0.0,
               "vm_disk_gb": None, "vm_disk_virtual_gb": None}
        try:
            du = shutil.disk_usage("/")
            out.update(root_total_gb=round(du.total / GIB, 1), root_used_gb=round(du.used / GIB, 1),
                       root_free_gb=round(du.free / GIB, 1),
                       root_pct=round(100.0 * du.used / du.total, 1) if du.total else 0.0)
        except OSError:
            pass
        cached, ts = self._vm_disk_cache
        if cached is None or time.time() - ts > 10:
            try:
                st = os.stat(self.cfg.vm_disk)
                vsize = qcow2_virtual_size(self.cfg.vm_disk)
                cached = (round(st.st_blocks * 512 / GIB, 1), round(vsize / GIB, 1) if vsize else None)
            except OSError:
                cached = (None, None)
            self._vm_disk_cache = (cached, time.time())
        out["vm_disk_gb"], out["vm_disk_virtual_gb"] = cached
        return out

    def _irqs(self):
        text = read_text("/proc/interrupts", "") or ""
        lines = text.splitlines()
        items = []
        leaked = 0
        if not lines:
            return {"vcpu_clean": True, "vcpu_leaked_count": 0, "items": items}
        cols = []
        for h in lines[0].split():
            cols.append(int(h[3:]) if h.startswith("CPU") and h[3:].isdigit() else -1)
        vcpus = set(self.cfg.vcpu_cores)
        new_prev = {}
        for line in lines[1:]:
            parts = line.split()
            if not parts or not parts[0].endswith(":"):
                continue
            irq = parts[0][:-1]
            if not irq.isdigit():
                continue
            rest = " ".join(parts[1 + len(cols):])
            if not any(p in rest for p in self.cfg.irq_patterns):
                continue
            counts = []
            for v in parts[1:1 + len(cols)]:
                counts.append(int(v) if v.isdigit() else 0)
            on_vcpu = sum(c for idx, c in enumerate(counts) if idx < len(cols) and cols[idx] in vcpus)
            affinity = (read_text("/proc/irq/%s/smp_affinity_list" % irq, "") or "").strip()
            effective = (read_text("/proc/irq/%s/effective_affinity_list" % irq, "") or "").strip()
            eff_set = parse_cpu_list(effective) if effective else parse_cpu_list(affinity)
            prev = self._prev_irq.get(irq)
            is_leak = bool(eff_set & vcpus) or (prev is not None and on_vcpu > prev)
            new_prev[irq] = on_vcpu
            if is_leak:
                leaked += 1
            name = parts[-1] if len(parts) > 1 + len(cols) else rest
            items.append({"irq": irq, "name": name, "affinity": affinity, "effective": effective,
                          "total": sum(counts), "on_vcpu": on_vcpu, "leaked": is_leak})
        self._prev_irq = new_prev
        return {"vcpu_clean": leaked == 0, "vcpu_leaked_count": leaked, "items": items}

    def _vm(self):
        pid, args = self.vm.find_qemu()
        running = pid is not None
        return {
            "running": running,
            "pid": pid,
            "opencore": self.vm.current_opencore(args, running),
            "qmp_connected": self.vm.qmp_connected() if running else False,
            "watchdog_active": self.vm.watchdog_active(),
        }

    def _linux_snapshot(self):
        uptime = (read_text("/proc/uptime", "0") or "0").split()
        try:
            load = [round(x, 2) for x in os.getloadavg()]
        except OSError:
            load = [0.0, 0.0, 0.0]
        irqs = self._irqs()
        vm = self._vm()
        return {
            "timestamp": round(time.time(), 3),
            "hostname": socket.gethostname(),
            "uptime_s": int(float(uptime[0])) if uptime else 0,
            "load_avg": load,
            "cpu": self._cpu(),
            "memory": self._memory(),
            "disk": self._disk(),
            "irqs": irqs,
            "vm": vm,
            "gpu": self._gpu(irqs, vm),
        }

    # ------------------------------------------------------------------ gpu
    def ingest_guest_gpu(self, payload):
        if not isinstance(payload, dict):
            raise ApiError(400, "invalid_payload")
        now = time.time()

        def _num(key, default=0.0):
            try:
                return float(payload.get(key, default))
            except (TypeError, ValueError):
                return float(default)

        flips = _num("iop_flips", 0.0)
        marks = _num("surface_gpu_marks", 0.0)
        hit = _num("iop_flip_hit", 0.0)
        miss = _num("iop_flip_miss", 0.0)
        timeouts = int(_num("surface_gpu_timeouts", 0))
        wait_max_us = _num("surface_gpu_wait_max_us", 0.0)
        res_new = int(_num("res_new", 0))
        res_free = int(_num("res_free", 0))
        alloc_b = _num("vm_alloc_bytes", 0.0)
        dealloc_b = _num("vm_dealloc_bytes", 0.0)
        active_res = max(0, res_new - res_free)
        win_cpu = _num("windowserver_cpu", 0.0)
        brave_cpu = _num("brave_gpu_cpu", 0.0)
        gpuboost = payload.get("gpuboost")
        if gpuboost is not None:
            gpuboost = bool(gpuboost)

        with self._guest_lock:
            fps = _num("fps", -1.0)
            marks_ps = _num("marks_per_sec", -1.0)
            if self._prev_guest_ctrs is not None and fps < 0:
                p_flips, p_marks, p_t = self._prev_guest_ctrs
                dt = now - p_t
                if 0.1 <= dt <= 30.0:
                    fps = max(0.0, (flips - p_flips) / dt) if flips >= p_flips else 0.0
                    marks_ps = max(0.0, (marks - p_marks) / dt) if marks >= p_marks else 0.0
            self._prev_guest_ctrs = (flips, marks, now)
            if fps < 0:
                fps = 0.0
            if marks_ps < 0:
                marks_ps = 0.0
            flip_hit_pct = (100.0 * hit / (hit + miss)) if (hit + miss) > 0 else 100.0
            vram_used_mb = _num("vram_used_mb", -1.0)
            if vram_used_mb < 0:
                if dealloc_b > 0 and alloc_b >= dealloc_b:
                    vram_used_mb = (alloc_b - dealloc_b) / (1024.0 * 1024.0)
                else:
                    vram_used_mb = min(8192.0, max(256.0, active_res * 2.5 + 320.0))
            self._guest_gpu = {
                "fps": round(fps, 1),
                "marks_per_sec": round(marks_ps, 1),
                "active_resources": active_res,
                "vram_used_mb": round(vram_used_mb, 0),
                "flip_hit_pct": round(flip_hit_pct, 2),
                "gpu_timeouts": timeouts,
                "wait_max_ms": round(wait_max_us / 1000.0, 2),
                "gpuboost": gpuboost,
                "windowserver_cpu": round(win_cpu, 1),
                "brave_gpu_cpu": round(brave_cpu, 1),
                "pool_alloc_gb": round(alloc_b / GIB, 2) if alloc_b > 0 else 0.0,
            }
            self._guest_gpu_ts = now
        return {"ok": True}

    def _gpu(self, irqs_data, vm_data):
        now = time.time()
        base = "/sys/bus/pci/devices/0000:07:00.0/"
        driver = "unbound"
        try:
            drv_link = os.readlink(base + "driver")
            driver = os.path.basename(drv_link) or "unbound"
        except OSError:
            pass
        power_state = (read_text(base + "power_state", "?") or "?").strip()
        speed_raw = (read_text(base + "current_link_speed", "?") or "?").strip()
        pcie_speed = "16.0 GT/s PCIe 4.0" if speed_raw.startswith("16.0") else speed_raw
        width_raw = (read_text(base + "current_link_width", "?") or "?").strip()
        pcie_width = ("x" + width_raw) if width_raw.isdigit() else width_raw
        irq_num_s = (read_text(base + "irq", "") or "").strip()
        irq_num = int(irq_num_s) if irq_num_s.isdigit() else 68

        gpu_irq_total = 0
        audio_irq_total = 0
        for item in (irqs_data or {}).get("items", []):
            name = item.get("name", "")
            if "07:00.0" in name:
                gpu_irq_total = int(item.get("total", 0))
            elif "07:00.1" in name:
                audio_irq_total = int(item.get("total", 0))

        irq_ps = 0.0
        prev_tot, prev_t = self._prev_gpu_irq
        if prev_tot is not None and now - prev_t > 0.05 and gpu_irq_total >= prev_tot:
            irq_ps = (gpu_irq_total - prev_tot) / (now - prev_t)
        self._prev_gpu_irq = (gpu_irq_total, now)

        audio_ps = 0.0
        aprev, at = self._prev_audio_irq
        if aprev is not None and now - at > 0.05 and audio_irq_total >= aprev:
            audio_ps = (audio_irq_total - aprev) / (now - at)
        self._prev_audio_irq = (audio_irq_total, now)

        aer_errors = 0
        for fn in ("aer_dev_fatal", "aer_dev_nonfatal"):
            for line in (read_text(base + fn, "") or "").splitlines():
                parts = line.split()
                if len(parts) >= 2 and parts[-1].isdigit() and int(parts[-1]) > 0:
                    aer_errors += int(parts[-1])

        with self._guest_lock:
            guest = dict(self._guest_gpu)
            guest_age = now - self._guest_gpu_ts
        guest_live = bool(guest and guest_age < 12.0 and vm_data.get("running"))

        if guest_live:
            fps = guest["fps"]
            marks_ps = guest["marks_per_sec"]
            load_pct = min(100.0, max(1.0, max(marks_ps / 45.0, irq_ps / 22.0, (fps / 1.2) * 0.65)))
            vram_used = guest["vram_used_mb"]
            active_res = guest["active_resources"]
            flip_hit = guest["flip_hit_pct"]
            timeouts = guest["gpu_timeouts"]
            wait_max = guest["wait_max_ms"]
            gpuboost = guest["gpuboost"]
            win_cpu = guest["windowserver_cpu"]
            brave_cpu = guest["brave_gpu_cpu"]
            pool_gb = guest["pool_alloc_gb"]
        else:
            load_pct = min(100.0, irq_ps / 22.0) if vm_data.get("running") else 0.0
            fps = min(120.0, irq_ps / 15.0) if vm_data.get("running") else 0.0
            marks_ps = 0.0
            vram_used = 0.0
            active_res = 0
            flip_hit = None
            timeouts = 0
            wait_max = 0.0
            gpuboost = None
            win_cpu = 0.0
            brave_cpu = 0.0
            pool_gb = 0.0

        return {
            "model": "NVIDIA GeForce RTX 3070 (8 GB)",
            "driver": driver,
            "power_state": power_state,
            "pcie_speed": pcie_speed,
            "pcie_width": pcie_width,
            "max_read_req": _read_pcie_max_read_req("0000:07:00.0"),
            "irq": irq_num,
            "irq_total": gpu_irq_total,
            "irq_per_sec": round(irq_ps, 1),
            "audio_irq_per_sec": round(audio_ps, 1),
            "aer_errors": aer_errors,
            "load_pct": round(load_pct, 1),
            "fps": round(fps, 1),
            "marks_per_sec": round(marks_ps, 1),
            "vram_total_mb": 8192,
            "vram_used_mb": round(vram_used, 0),
            "active_resources": active_res,
            "flip_hit_pct": flip_hit,
            "gpu_timeouts": timeouts,
            "wait_max_ms": wait_max,
            "gpuboost": gpuboost,
            "windowserver_cpu": win_cpu,
            "brave_gpu_cpu": brave_cpu,
            "pool_alloc_gb": pool_gb,
            "guest_live": guest_live,
        }

    def gpu_action(self, action):
        valid = ("optimize_pcie", "repin_irqs", "cpu_turbo", "cpu_balanced")
        if action not in valid:
            raise ApiError(400, "invalid_action")
        if self.cfg.dev_mode:
            if action == "cpu_turbo":
                self._dev_cpu_mode = "performance"
            elif action == "cpu_balanced":
                self._dev_cpu_mode = "powersave"
            msgs = {
                "optimize_pcie": "PCIe MaxReadReq=4096B e IRQs 07:00.0 aplicados (simulação dev).",
                "repin_irqs": "Threads QEMU e IRQs isolados em 0,5,6,11 (simulação dev).",
                "cpu_turbo": "CPU em Modo Turbo Máximo (boost=1, governor=performance) (simulação dev).",
                "cpu_balanced": "CPU em Modo Equilibrado (boost=1, powersave) (simulação dev).",
            }
            return {"ok": True, "action": action, "message": msgs[action]}

        host_cpus = {0, 5, 6, 11}
        vcpu_map = [1, 7, 2, 8, 3, 9, 4, 10]

        def _pin_irqs():
            cnt = 0
            text = read_text("/proc/interrupts", "") or ""
            for line in text.splitlines()[1:]:
                if any(p in line for p in self.cfg.irq_patterns):
                    irq = line.split()[0].rstrip(":")
                    if irq.isdigit():
                        p = "/proc/irq/%s/smp_affinity_list" % irq
                        try:
                            with open(p, "w") as fh:
                                fh.write("0,5,6,11\n")
                            cnt += 1
                        except OSError:
                            pass
            return cnt

        def _pin_qemu():
            pid, _ = self.vm.find_qemu()
            if not pid:
                return 0
            cnt = 0
            task_dir = "/proc/%d/task" % pid
            try:
                tids = os.listdir(task_dir)
            except OSError:
                return 0
            for tid_s in tids:
                if not tid_s.isdigit():
                    continue
                comm = (read_text(os.path.join(task_dir, tid_s, "comm"), "") or "").strip()
                target = host_cpus
                if comm.startswith("CPU ") and comm.endswith("/KVM"):
                    idx_s = comm[4:-4].strip()
                    if idx_s.isdigit() and int(idx_s) < len(vcpu_map):
                        target = {vcpu_map[int(idx_s)]}
                try:
                    os.sched_setaffinity(int(tid_s), target)
                    cnt += 1
                except OSError:
                    pass
            return cnt

        if action == "optimize_pcie":
            rc, out = run_cmd(["setpci", "-s", "07:00.0", "CAP_EXP+0x08.w=5000:7000"], timeout=10)
            icnt = _pin_irqs()
            return {"ok": rc == 0, "action": action,
                    "message": "PCIe MaxReadReq=4096B aplicado (%s); %d IRQs fixadas em 0,5,6,11." % (
                        "OK" if rc == 0 else out.strip(), icnt)}
        if action == "repin_irqs":
            icnt = _pin_irqs()
            tcnt = _pin_qemu()
            return {"ok": True, "action": action,
                    "message": "%d IRQs e %d threads QEMU re-isoladas." % (icnt, tcnt)}

        gov = "performance" if action == "cpu_turbo" else "powersave"
        epp = "performance" if action == "cpu_turbo" else "balance_performance"
        for p in ["/sys/devices/system/cpu/cpufreq/boost"] + glob.glob("/sys/devices/system/cpu/cpu*/cpufreq/boost"):
            try:
                with open(p, "w") as fh:
                    fh.write("1\n")
            except OSError:
                pass
        for p in glob.glob("/sys/devices/system/cpu/cpu*/cpufreq/scaling_governor"):
            try:
                with open(p, "w") as fh:
                    fh.write(gov + "\n")
            except OSError:
                pass
        for p in glob.glob("/sys/devices/system/cpu/cpu*/cpufreq/energy_performance_preference"):
            try:
                with open(p, "w") as fh:
                    fh.write(epp + "\n")
            except OSError:
                pass
        return {"ok": True, "action": action,
                "message": "Modo CPU alterado: boost=1, governor=%s, EPP=%s." % (gov, epp)}

    # ------------------------------------------------------------------ dev
    def _dev_snapshot(self):
        t = time.time()
        vm_on = self.vm.sim["running"]
        wave = math.sin(t / 7.0)
        cores = []
        for i in range(12):
            if self.role(i) == "vcpu":
                if vm_on:
                    mhz = 4650 + 25 * math.sin(t / 3.0 + i) + random.uniform(-15, 15)
                    usage = 38 + 22 * math.sin(t / 5.0 + i * 0.7) + random.uniform(-6, 6)
                else:
                    mhz = 2200 + random.uniform(-150, 150)
                    usage = random.uniform(0, 3)
            else:
                mhz = 3700 + 250 * math.sin(t / 4.0 + i) + random.uniform(-60, 60)
                usage = 9 + 5 * math.sin(t / 6.0 + i) + random.uniform(-3, 3)
            cores.append({"id": i, "role": self.role(i), "mhz": round(mhz, 1),
                          "usage_pct": round(max(0.0, min(100.0, usage)), 1)})
        vmhz = [c["mhz"] for c in cores if c["role"] == "vcpu"]
        tctl = 54.5 + 4 * wave + random.uniform(-0.6, 0.6) if vm_on else 41 + random.uniform(-0.5, 0.5)
        used = 12400 + int(120 * wave) if vm_on else 2600 + int(60 * wave)
        irq_items = [
            {"irq": "68", "name": "vfio-msi[0](0000:07:00.0)", "affinity": "0,5-6,11", "effective": "0",
             "total": 738915 + int((t - self._t0) * 950), "on_vcpu": 0, "leaked": False},
            {"irq": "69", "name": "vfio-msi[0](0000:07:00.1)", "affinity": "0,5-6,11", "effective": "5",
             "total": 1203 + int((t - self._t0) * 2), "on_vcpu": 0, "leaked": False},
            {"irq": "70", "name": "vfio-msix[0](0000:09:00.3)", "affinity": "0,5-6,11", "effective": "6",
             "total": 412233 + int((t - self._t0) * 310), "on_vcpu": 0, "leaked": False},
            {"irq": "45", "name": "enp6s0", "affinity": "0,5-6,11", "effective": "11",
             "total": 98213 + int((t - self._t0) * 40), "on_vcpu": 0, "leaked": False},
        ]
        try:
            load = [round(x, 2) for x in os.getloadavg()]
        except OSError:
            load = [1.2, 0.9, 0.7]
        avg_usage = sum(c["usage_pct"] for c in cores) / len(cores)
        irqs_obj = {"vcpu_clean": True, "vcpu_leaked_count": 0, "items": irq_items}
        vm_obj = {
            "running": vm_on,
            "pid": self.vm.sim["pid"] if vm_on else None,
            "opencore": self.vm.sim["opencore"],
            "qmp_connected": vm_on,
            "watchdog_active": self.vm.sim["watchdog"],
        }
        with self._guest_lock:
            guest = dict(self._guest_gpu)
            guest_live = bool(guest and (t - self._guest_gpu_ts) < 12.0 and vm_on)
        if guest_live:
            gpu_load = min(100.0, max(1.0, max(guest["marks_per_sec"] / 45.0, guest["fps"] * 0.6)))
            gpu_obj = {
                "model": "NVIDIA GeForce RTX 3070 (8 GB)",
                "driver": "vfio-pci", "power_state": "D0",
                "pcie_speed": "16.0 GT/s PCIe 4.0", "pcie_width": "x16", "max_read_req": "4096B",
                "irq": 68, "irq_total": irq_items[0]["total"],
                "irq_per_sec": round(820 + 210 * wave, 1), "audio_irq_per_sec": 4.2, "aer_errors": 0,
                "load_pct": round(gpu_load, 1), "fps": guest["fps"],
                "marks_per_sec": guest["marks_per_sec"], "vram_total_mb": 8192,
                "vram_used_mb": guest["vram_used_mb"], "active_resources": guest["active_resources"],
                "flip_hit_pct": guest["flip_hit_pct"], "gpu_timeouts": guest["gpu_timeouts"],
                "wait_max_ms": guest["wait_max_ms"], "gpuboost": guest["gpuboost"],
                "windowserver_cpu": guest["windowserver_cpu"], "brave_gpu_cpu": guest["brave_gpu_cpu"],
                "pool_alloc_gb": guest["pool_alloc_gb"], "guest_live": True,
            }
        else:
            gpu_irq_ps = (840 + 260 * math.sin(t / 3.5) + random.uniform(-35, 35)) if vm_on else 0.0
            gpu_load = min(100.0, max(0.0, 38 + 18 * math.sin(t / 4.2) + random.uniform(-4, 4))) if vm_on else 0.0
            gpu_fps = max(0.0, 60.0 + 18 * math.sin(t / 5.0) + random.uniform(-3, 3)) if vm_on else 0.0
            gpu_obj = {
                "model": "NVIDIA GeForce RTX 3070 (8 GB)",
                "driver": "vfio-pci", "power_state": "D0",
                "pcie_speed": "16.0 GT/s PCIe 4.0", "pcie_width": "x16", "max_read_req": "4096B",
                "irq": 68, "irq_total": irq_items[0]["total"],
                "irq_per_sec": round(gpu_irq_ps, 1), "audio_irq_per_sec": 3.5 if vm_on else 0.0, "aer_errors": 0,
                "load_pct": round(gpu_load, 1), "fps": round(gpu_fps, 1),
                "marks_per_sec": round(gpu_load * 58.0, 1), "vram_total_mb": 8192,
                "vram_used_mb": 1680 + int(180 * wave) if vm_on else 0,
                "active_resources": 346 + int(25 * wave) if vm_on else 0,
                "flip_hit_pct": 99.97 if vm_on else None, "gpu_timeouts": 0,
                "wait_max_ms": round(11.5 + 3.2 * abs(wave), 2) if vm_on else 0.0,
                "gpuboost": True if vm_on else None,
                "windowserver_cpu": round(24.0 + 6.0 * wave, 1) if vm_on else 0.0,
                "brave_gpu_cpu": round(32.0 + 14.0 * abs(wave), 1) if vm_on else 0.0,
                "pool_alloc_gb": 16.03 if vm_on else 0.0, "guest_live": False,
            }
        return {
            "timestamp": round(t, 3),
            "hostname": "debian",
            "uptime_s": int(86400 * 2 + (t - self._t0)),
            "load_avg": load,
            "cpu": {
                "model": "AMD Ryzen 5 5600X 6-Core Processor",
                "boost_enabled": True,
                "governor": self._dev_cpu_mode,
                "epp": "performance" if self._dev_cpu_mode == "performance" else "balance_performance",
                "temp_tctl_c": round(tctl, 1),
                "temp_tccd1_c": round(tctl - 1.7 + random.uniform(-0.4, 0.4), 1),
                "avg_vcpu_mhz": round(sum(vmhz) / len(vmhz), 1),
                "avg_usage_pct": round(avg_usage, 1),
                "cores": cores,
            },
            "memory": {
                "total_mb": 15800, "used_mb": used, "available_mb": 15800 - used,
                "swap_total_mb": 8192, "swap_used_mb": 0,
                "hugepages_total": 6144, "hugepages_free": 0 if vm_on else 6144,
            },
            "disk": {
                "root_total_gb": 195.8, "root_used_gb": 80.1, "root_free_gb": 106.5, "root_pct": 43.0,
                "vm_disk_gb": 36.5, "vm_disk_virtual_gb": 128.0,
            },
            "irqs": irqs_obj,
            "vm": vm_obj,
            "gpu": gpu_obj,
        }
