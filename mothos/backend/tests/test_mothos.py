"""Comprehensive stdlib unittest suite for MothOS backend."""
import asyncio
import base64
import hashlib
import http.client
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import urllib.parse

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

os.environ["MOTHOS_QUIET"] = "1"

import logs as logs_mod
import ws as wsmod
from config import Config
from server import MothServer


class WSClient(object):
    """Minimal RFC 6455 blocking test client using stdlib socket."""

    def __init__(self, host, port, path, headers=None, timeout=5.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req_lines = [
            "GET %s HTTP/1.1" % path,
            "Host: %s:%d" % (host, port),
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: %s" % key,
            "Sec-WebSocket-Version: 13",
        ]
        for k, v in (headers or {}).items():
            req_lines.append("%s: %s" % (k, v))
        self.sock.sendall(("\r\n".join(req_lines) + "\r\n\r\n").encode("ascii"))
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        head, self._buf = buf.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        self.status = int(lines[0].split(" ", 2)[1])
        self.headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, _, v = line.partition(":")
                self.headers[k.strip().lower()] = v.strip()
        if self.status == 101:
            expected = base64.b64encode(
                hashlib.sha1((key + wsmod.GUID).encode("ascii")).digest()
            ).decode("ascii")
            assert self.headers.get("sec-websocket-accept") == expected

    def _read_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise EOFError("closed")
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def send_json(self, obj):
        payload = json.dumps(obj).encode("utf-8")
        mask = os.urandom(4)
        self.sock.sendall(wsmod.encode_frame(wsmod.OP_TEXT, payload, mask=mask))

    def recv_json(self):
        while True:
            head = self._read_exact(2)
            opcode = head[0] & 0x0F
            masked = bool(head[1] & 0x80)
            n = head[1] & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read_exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else None
            payload = self._read_exact(n) if n else b""
            if mask:
                payload = wsmod._unmask(payload, mask)
            if opcode == wsmod.OP_PING:
                self.sock.sendall(wsmod.encode_frame(wsmod.OP_PONG, payload, mask=os.urandom(4)))
                continue
            if opcode == wsmod.OP_CLOSE:
                return None
            if opcode == wsmod.OP_TEXT:
                return json.loads(payload.decode("utf-8"))

    def close(self):
        try:
            self.sock.sendall(wsmod.encode_frame(wsmod.OP_CLOSE, struct.pack("!H", 1000), mask=os.urandom(4)))
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class MothOSTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        logs_mod.setup_logging()
        cls.tmp_root = tempfile.mkdtemp(prefix="mothos_test_")
        cls.data_dir = os.path.join(cls.tmp_root, "data")
        cls.work_dir = os.path.join(cls.tmp_root, "work")
        os.makedirs(cls.work_dir, exist_ok=True)
        cls.frontend_dir = os.path.abspath(os.path.join(BACKEND_DIR, "..", "frontend"))

        env = {
            "MOTHOS_DEV_MODE": "1",
            "MOTHOS_HOST": "127.0.0.1",
            "MOTHOS_PORT": "0",
            "MOTHOS_PIN": "0000",
            "MOTHOS_DATA_DIR": cls.data_dir,
            "MOTHOS_FRONTEND_DIR": cls.frontend_dir,
        }
        cls.cfg = Config(env)
        cls.loop = asyncio.new_event_loop()
        cls.srv = MothServer(cls.cfg)
        cls._ready = threading.Event()

        def _run():
            asyncio.set_event_loop(cls.loop)
            cls.loop.run_until_complete(cls.srv.start("127.0.0.1", 0))
            cls.port = cls.srv.port
            cls._ready.set()
            cls.loop.run_forever()

        cls.thread = threading.Thread(target=_run, daemon=True)
        cls.thread.start()
        cls._ready.wait(timeout=5.0)
        assert hasattr(cls, "port") and cls.port

        # Obtain a reusable session token for non-auth tests
        status, data, hdrs = cls._raw_req("POST", "/api/auth/login", {"pin": "0000"})
        assert status == 200 and data.get("ok"), (status, data)
        cls.token = data["token"]
        cls.cookie = hdrs.get("set-cookie", "").split(";", 1)[0]

    @classmethod
    def tearDownClass(cls):
        if cls.loop.is_running():
            fut = asyncio.run_coroutine_threadsafe(cls.srv.close(), cls.loop)
            try:
                fut.result(timeout=5.0)
            except Exception:
                pass
            cls.loop.call_soon_threadsafe(cls.loop.stop)
        cls.thread.join(timeout=5.0)
        cls.loop.close()
        shutil.rmtree(cls.tmp_root, ignore_errors=True)

    @classmethod
    def _raw_req(cls, method, path, body=None, headers=None, raw_body=None):
        conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=10)
        hdrs = dict(headers or {})
        if raw_body is not None:
            payload = raw_body
        elif body is not None:
            payload = json.dumps(body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        else:
            payload = None
        try:
            conn.request(method, path, body=payload, headers=hdrs)
            resp = conn.getresponse()
            raw = resp.read()
            resp_hdrs = {k.lower(): v for k, v in resp.getheaders()}
            ctype = resp_hdrs.get("content-type", "")
            if "application/json" in ctype:
                parsed = json.loads(raw.decode("utf-8"))
            else:
                parsed = raw
            return resp.status, parsed, resp_hdrs
        finally:
            conn.close()

    def api(self, method, path, body=None, headers=None, auth="bearer", raw_body=None):
        hdrs = dict(headers or {})
        if auth == "bearer":
            hdrs["Authorization"] = "Bearer " + self.token
        elif auth == "cookie":
            hdrs["Cookie"] = self.cookie
        return self._raw_req(method, path, body=body, headers=hdrs, raw_body=raw_body)

    # ================================================================== Auth
    def test_01_auth_lifecycle(self):
        # Health is public
        st, data, _ = self.api("GET", "/api/health", auth=None)
        self.assertEqual(st, 200)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["app"], "MothOS")
        self.assertTrue(data["dev_mode"])

        # Unauthenticated /api/auth/me -> false, /api/monitor -> 401
        st, data, _ = self.api("GET", "/api/auth/me", auth=None)
        self.assertEqual(st, 200)
        self.assertFalse(data["authenticated"])

        st, data, _ = self.api("GET", "/api/monitor", auth=None)
        self.assertEqual(st, 401)
        self.assertEqual(data["error"], "unauthorized")

        # Wrong PIN -> 401
        st, data, _ = self.api("POST", "/api/auth/login", {"pin": "0000"}, auth=None)
        self.assertEqual(st, 401)
        self.assertEqual(data["error"], "invalid_pin")

        # Correct PIN -> 200 + token + Set-Cookie
        st, data, hdrs = self.api("POST", "/api/auth/login", {"pin": "0000"}, auth=None)
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        tok = data["token"]
        self.assertIn("expires_at", data)
        cookie_hdr = hdrs.get("set-cookie", "")
        self.assertIn("mothos_session=", cookie_hdr)
        self.assertIn("HttpOnly", cookie_hdr)
        cookie_pair = cookie_hdr.split(";", 1)[0]

        # Authenticated via Bearer
        st, data, _ = self.api("GET", "/api/auth/me", headers={"Authorization": "Bearer " + tok}, auth=None)
        self.assertEqual(st, 200)
        self.assertTrue(data["authenticated"])

        # Authenticated via Cookie
        st, data, _ = self.api("GET", "/api/auth/me", headers={"Cookie": cookie_pair}, auth=None)
        self.assertEqual(st, 200)
        self.assertTrue(data["authenticated"])

        # Logout revokes token & clears cookie
        st, data, hdrs = self.api("POST", "/api/auth/logout", headers={"Authorization": "Bearer " + tok}, auth=None)
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        self.assertIn("Max-Age=0", hdrs.get("set-cookie", ""))

        # Revoked token is now rejected
        st, _, _ = self.api("GET", "/api/monitor", headers={"Authorization": "Bearer " + tok}, auth=None)
        self.assertEqual(st, 401)

    # ================================================================== Static
    def test_02_static_and_spa(self):
        st, body, hdrs = self.api("GET", "/", auth=None)
        self.assertEqual(st, 200)
        self.assertIn("text/html", hdrs.get("content-type", ""))
        self.assertIn(b"MothOS", body)

        if os.path.isfile(os.path.join(self.frontend_dir, "manifest.webmanifest")):
            st, body, hdrs = self.api("GET", "/manifest.webmanifest", auth=None)
            self.assertEqual(st, 200)
            self.assertIn("application/manifest+json", hdrs.get("content-type", ""))

        if os.path.isfile(os.path.join(self.frontend_dir, "sw.js")):
            st, _, hdrs = self.api("GET", "/sw.js", auth=None)
            self.assertEqual(st, 200)
            self.assertIn("application/javascript", hdrs.get("content-type", ""))

        # Non-existent file with extension -> 404
        st, _, _ = self.api("GET", "/does-not-exist.js", auth=None)
        self.assertEqual(st, 404)

    # ================================================================== Monitor
    def test_03_monitor_http_and_ws(self):
        st, snap, _ = self.api("GET", "/api/monitor")
        self.assertEqual(st, 200)
        for key in ("timestamp", "hostname", "uptime_s", "load_avg", "cpu", "memory", "disk", "irqs", "vm"):
            self.assertIn(key, snap)
        self.assertEqual(len(snap["cpu"]["cores"]), 12)
        vcpu_ids = {c["id"] for c in snap["cpu"]["cores"] if c["role"] == "vcpu"}
        self.assertEqual(vcpu_ids, {1, 2, 3, 4, 7, 8, 9, 10})
        self.assertTrue(snap["irqs"]["vcpu_clean"])

        # Unauthenticated WS -> 401
        ws_unauth = WSClient("127.0.0.1", self.port, "/ws/monitor")
        self.assertEqual(ws_unauth.status, 401)
        ws_unauth.close()

        # Authenticated WS -> 101 + receives JSON frames
        ws = WSClient("127.0.0.1", self.port, "/ws/monitor?token=" + urllib.parse.quote(self.token))
        try:
            self.assertEqual(ws.status, 101)
            msg1 = ws.recv_json()
            self.assertIn("cpu", msg1)
            self.assertEqual(len(msg1["cpu"]["cores"]), 12)
        finally:
            ws.close()

    # ================================================================== VM & Power
    def test_04_vm_and_host_power(self):
        st, data, _ = self.api("GET", "/api/vm/status")
        self.assertEqual(st, 200)
        self.assertTrue(data["running"])
        self.assertGreaterEqual(len(data["available_opencores"]), 2)

        # Missing confirm -> 400
        st, data, _ = self.api("POST", "/api/vm/action", {"action": "shutdown"})
        self.assertEqual(st, 400)
        self.assertEqual(data["error"], "confirmation_required")

        # Valid shutdown -> start
        st, data, _ = self.api("POST", "/api/vm/action", {"action": "shutdown", "confirm": True})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        st, vmst, _ = self.api("GET", "/api/vm/status")
        self.assertFalse(vmst["running"])

        st, data, _ = self.api("POST", "/api/vm/action", {"action": "start", "confirm": True})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])

        # OpenCore switch + traversal rejection
        st, _, _ = self.api("POST", "/api/vm/opencore", {"name": "../evil.qcow2"})
        self.assertEqual(st, 400)

        st, data, _ = self.api("POST", "/api/vm/opencore", {"name": "opencore_nullmoth_v2.qcow2"})
        self.assertEqual(st, 200)
        self.assertEqual(data["selected"], "opencore_nullmoth_v2.qcow2")

        st, data, _ = self.api("POST", "/api/vm/opencore", {"name": "opencore_nullmoth_bt_v2.qcow2"})
        self.assertEqual(st, 200)

        # Host power requires confirm: true
        st, data, _ = self.api("POST", "/api/host/power", {"action": "boot_windows"})
        self.assertEqual(st, 400)
        self.assertEqual(data["error"], "confirmation_required")

        for act in ("boot_windows", "reboot", "shutdown"):
            st, data, _ = self.api("POST", "/api/host/power", {"action": act, "confirm": True})
            self.assertEqual(st, 200)
            self.assertTrue(data["ok"])
            self.assertEqual(data["action"], act)

    # ================================================================== USB & BT
    def test_05_usb_and_bt(self):
        st, data, _ = self.api("GET", "/api/usb/list")
        self.assertEqual(st, 200)
        self.assertIn("host_devices", data)
        self.assertIn("vm_devices", data)
        self.assertIn("bt", data)

        # Attach Logitech receiver
        st, data, _ = self.api("POST", "/api/usb/attach", {"vid": "0x046d", "pid": "0xc52b", "port": None})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["id"], "usb-046d-c52b")

        # Detach it
        st, data, _ = self.api("POST", "/api/usb/detach", {"id": "usb-046d-c52b"})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])

        # BT actions
        for act in ("detach", "preload_attach", "attach", "disable", "enable"):
            st, data, _ = self.api("POST", "/api/usb/bt", {"action": act})
            self.assertEqual(st, 200)
            self.assertTrue(data["ok"])
            self.assertIn("output", data)

        st, _, _ = self.api("POST", "/api/usb/bt", {"action": "bogus"})
        self.assertEqual(st, 400)

    # ================================================================== Files
    def test_06_file_manager(self):
        # Bookmarks
        st, data, _ = self.api("GET", "/api/files/bookmarks")
        self.assertEqual(st, 200)
        self.assertGreaterEqual(len(data["bookmarks"]), 6)

        # Mkdir
        sub = os.path.join(self.work_dir, "sub")
        st, data, _ = self.api("POST", "/api/files/mkdir", {"path": sub})
        self.assertEqual(st, 200)
        self.assertTrue(os.path.isdir(sub))

        # Write valid .sh
        sh_path = os.path.join(sub, "hello.sh")
        st, data, _ = self.api("POST", "/api/files/write", {
            "path": sh_path, "content": "#!/usr/bin/env bash\necho HELLO_MOTHOS\n",
            "backup": True, "validate": True
        })
        self.assertEqual(st, 200)
        self.assertEqual(data["validation"], "ok")
        self.assertIsNone(data["backup_path"])

        # Overwrite with invalid .sh -> 422, original file untouched
        st, data, _ = self.api("POST", "/api/files/write", {
            "path": sh_path, "content": "if true; then\n  echo broken\n",
            "backup": True, "validate": True
        })
        self.assertEqual(st, 422)
        self.assertEqual(data["error"], "validation_failed")
        with open(sh_path) as fh:
            self.assertIn("HELLO_MOTHOS", fh.read())

        # Overwrite with valid .sh -> creates .mothos_bak_*
        st, data, _ = self.api("POST", "/api/files/write", {
            "path": sh_path, "content": "#!/usr/bin/env bash\necho UPDATED_MOTHOS\n",
            "backup": True, "validate": True
        })
        self.assertEqual(st, 200)
        self.assertIsNotNone(data["backup_path"])
        self.assertIn(".mothos_bak_", data["backup_path"])
        self.assertTrue(os.path.isfile(data["backup_path"]))

        # JSON & plist validation
        st, data, _ = self.api("POST", "/api/files/write", {
            "path": os.path.join(sub, "bad.json"), "content": "{bad json", "validate": True
        })
        self.assertEqual(st, 422)

        plist_ok = '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>A</key><true/></dict></plist>'
        st, data, _ = self.api("POST", "/api/files/write", {
            "path": os.path.join(sub, "ok.plist"), "content": plist_ok, "validate": True
        })
        self.assertEqual(st, 200)
        self.assertEqual(data["validation"], "ok")

        st, data, _ = self.api("POST", "/api/files/write", {
            "path": os.path.join(sub, "bad.plist"), "content": "<plist><broken>", "validate": True
        })
        self.assertEqual(st, 422)

        # List & read
        st, data, _ = self.api("GET", "/api/files/list?path=" + urllib.parse.quote(sub))
        self.assertEqual(st, 200)
        names = [e["name"] for e in data["entries"]]
        self.assertIn("hello.sh", names)

        st, data, _ = self.api("GET", "/api/files/read?path=" + urllib.parse.quote(sh_path))
        self.assertEqual(st, 200)
        self.assertFalse(data["is_binary"])
        self.assertIn("UPDATED_MOTHOS", data["content"])

        # Exec .sh (confirm required)
        st, data, _ = self.api("POST", "/api/files/exec", {"path": sh_path})
        self.assertEqual(st, 400)
        st, data, _ = self.api("POST", "/api/files/exec", {"path": sh_path, "confirm": True})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        self.assertIn("UPDATED_MOTHOS", data["output"])

        # Exec .tar.gz
        tgz_path = os.path.join(sub, "bundle.tar.gz")
        inner_txt = os.path.join(self.work_dir, "inner.txt")
        with open(inner_txt, "w") as fh:
            fh.write("from-tar")
        with tarfile.open(tgz_path, "w:gz") as tf:
            tf.add(inner_txt, arcname="extracted.txt")
        st, data, _ = self.api("POST", "/api/files/exec", {"path": tgz_path, "confirm": True})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        self.assertTrue(os.path.isfile(os.path.join(sub, "extracted.txt")))

        # Upload raw X-Filename
        st, data, _ = self.api("POST", "/api/files/upload?dir=" + urllib.parse.quote(sub),
                               headers={"X-Filename": "raw.txt"}, raw_body=b"raw-bytes-123")
        self.assertEqual(st, 200)
        self.assertEqual(data["size"], 13)
        self.assertTrue(os.path.isfile(os.path.join(sub, "raw.txt")))

        # Upload multipart/form-data
        boundary = "----MothOSTestBoundary"
        mp = (
            "--%s\r\n"
            'Content-Disposition: form-data; name="file"; filename="multi.deb"\r\n'
            "Content-Type: application/octet-stream\r\n\r\n"
            "fake-deb-payload\r\n"
            "--%s--\r\n" % (boundary, boundary)
        ).encode("utf-8")
        st, data, _ = self.api("POST", "/api/files/upload?dir=" + urllib.parse.quote(sub),
                               headers={"Content-Type": "multipart/form-data; boundary=" + boundary},
                               raw_body=mp)
        self.assertEqual(st, 200)
        self.assertEqual(data["size"], len(b"fake-deb-payload"))
        deb_path = data["path"]
        self.assertTrue(deb_path.endswith("multi.deb"))

        # Exec .deb in dev mode
        st, data, _ = self.api("POST", "/api/files/exec", {"path": deb_path, "confirm": True})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        self.assertIn("dpkg -i", data["output"])

        # Download
        st, raw, hdrs = self.api("GET", "/api/files/download?path=" + urllib.parse.quote(os.path.join(sub, "raw.txt")))
        self.assertEqual(st, 200)
        self.assertEqual(raw, b"raw-bytes-123")
        self.assertIn("attachment;", hdrs.get("content-disposition", ""))

        # Rename
        renamed = os.path.join(sub, "raw_renamed.txt")
        st, data, _ = self.api("POST", "/api/files/rename",
                               {"old_path": os.path.join(sub, "raw.txt"), "new_path": renamed})
        self.assertEqual(st, 200)
        self.assertTrue(os.path.isfile(renamed))

        # Delete refuses /
        st, data, _ = self.api("POST", "/api/files/delete", {"path": "/", "confirm": True})
        self.assertEqual(st, 403)
        self.assertEqual(data["error"], "protected_path")

        # Delete requires confirm
        st, data, _ = self.api("POST", "/api/files/delete", {"path": renamed})
        self.assertEqual(st, 400)

        # Delete file & directory
        st, data, _ = self.api("POST", "/api/files/delete", {"path": renamed, "confirm": True})
        self.assertEqual(st, 200)
        self.assertFalse(os.path.exists(renamed))

        st, data, _ = self.api("POST", "/api/files/delete", {"path": sub, "confirm": True})
        self.assertEqual(st, 200)
        self.assertFalse(os.path.exists(sub))

    # ================================================================== Updates & Services
    def test_07_updates_and_services(self):
        st, data, _ = self.api("GET", "/api/updates/status")
        self.assertEqual(st, 200)
        self.assertGreater(data["upgradable_count"], 0)

        st, data, _ = self.api("POST", "/api/updates/check")
        self.assertEqual(st, 200)
        self.assertTrue(data["running"])
        for _ in range(30):
            time.sleep(0.1)
            _, s, _ = self.api("GET", "/api/updates/status")
            if not s["running"]:
                break
        self.assertFalse(s["running"])

        # Upgrade requires confirm
        st, _, _ = self.api("POST", "/api/updates/upgrade", {})
        self.assertEqual(st, 400)
        st, data, _ = self.api("POST", "/api/updates/upgrade", {"confirm": True})
        self.assertEqual(st, 200)
        for _ in range(30):
            time.sleep(0.1)
            _, s, _ = self.api("GET", "/api/updates/status")
            if not s["running"]:
                break
        self.assertEqual(s["upgradable_count"], 0)

        # Services list
        st, data, _ = self.api("GET", "/api/services/list")
        self.assertEqual(st, 200)
        by_name = {svc["name"]: svc for svc in data["services"]}
        self.assertTrue(by_name["mothos.service"]["protected"])
        self.assertTrue(by_name["sshd.service"]["protected"])
        self.assertTrue(by_name["NetworkManager.service"]["protected"])

        # Protected services reject stop/disable
        for svc in ("sshd.service", "NetworkManager.service", "mothos.service"):
            for act in ("stop", "disable"):
                st, data, _ = self.api("POST", "/api/services/action",
                                       {"name": svc, "action": act, "confirm": True})
                self.assertEqual(st, 403, (svc, act, st, data))

        # Non-protected service allows start/stop
        st, data, _ = self.api("POST", "/api/services/action",
                               {"name": "bluetooth.service", "action": "start", "confirm": True})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["service"]["active"], "active")

    # ================================================================== Logs
    def test_08_logs(self):
        for src in ("qemu", "dmesg", "watchdog", "mothos"):
            st, data, _ = self.api("GET", "/api/logs?source=%s&lines=20" % src)
            self.assertEqual(st, 200)
            self.assertEqual(data["source"], src)
            self.assertIsInstance(data["lines"], list)

        st, data, _ = self.api("GET", "/api/logs?source=qemu&lines=50&filter=vfio")
        self.assertEqual(st, 200)
        for line in data["lines"]:
            self.assertIn("vfio", line.lower())

        st, _, _ = self.api("GET", "/api/logs?source=invalid")
        self.assertEqual(st, 400)

    # ================================================================== Terminal WS
    def test_09_terminal_ws(self):
        ws = WSClient("127.0.0.1", self.port, "/ws/terminal?token=" + urllib.parse.quote(self.token), timeout=8.0)
        try:
            self.assertEqual(ws.status, 101)
            ws.send_json({"type": "resize", "cols": 100, "rows": 30})
            ws.send_json({"type": "input", "data": "echo MOTHOS_PTY_ECHO_OK\nexit 0\n"})
            collected = ""
            saw_exit = False
            deadline = time.time() + 6.0
            while time.time() < deadline:
                msg = ws.recv_json()
                if msg is None:
                    break
                if msg.get("type") == "output":
                    collected += msg.get("data", "")
                elif msg.get("type") == "exit":
                    saw_exit = True
                    self.assertEqual(msg.get("code"), 0)
                    break
            self.assertIn("MOTHOS_PTY_ECHO_OK", collected)
            self.assertTrue(saw_exit)
        finally:
            ws.close()

    # ================================================================== TLS fast-reject, GPU & Quick Exec
    def test_10_tls_fast_reject_gpu_and_quick_exec(self):
        # 1. TLS ClientHello (0x16) on plain HTTP port must fail fast with TLS alert (0x15)
        t0 = time.time()
        s = socket.create_connection(("127.0.0.1", self.port), timeout=2.0)
        try:
            s.sendall(b"\x16\x03\x01\x00\x20" + b"\x00" * 32)
            reply = s.recv(64)
        except OSError:
            reply = b""
        finally:
            s.close()
        dt = time.time() - t0
        self.assertLess(dt, 0.5)
        self.assertTrue(reply.startswith(b"\x15\x03\x03"), repr(reply))

        # 2. Guest GPU telemetry report -> monitor reflects guest_live
        st, data, _ = self.api("POST", "/api/gpu/guest_report", {
            "iop_flips": 1000, "surface_gpu_marks": 5000,
            "res_new": 12000, "res_free": 11500,
            "iop_flip_hit": 999, "iop_flip_miss": 1,
            "surface_gpu_timeouts": 0, "surface_gpu_wait_max_us": 12000,
            "gpuboost": 1, "windowserver_cpu": 22.5, "brave_gpu_cpu": 44.0,
        }, auth=None)
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])

        st, snap, _ = self.api("GET", "/api/monitor")
        self.assertEqual(st, 200)
        self.assertIn("gpu", snap)
        gpu = snap["gpu"]
        for key in ("load_pct", "fps", "irq_per_sec", "pcie_speed", "pcie_width", "guest_live", "flip_hit_pct"):
            self.assertIn(key, gpu)
        self.assertTrue(gpu["guest_live"])
        self.assertTrue(gpu["gpuboost"])
        self.assertEqual(gpu["active_resources"], 500)

        # 3. GPU & CPU tuning actions
        for act in ("optimize_pcie", "repin_irqs", "cpu_turbo", "cpu_balanced"):
            st, data, _ = self.api("POST", "/api/gpu/action", {"action": act})
            self.assertEqual(st, 200)
            self.assertTrue(data["ok"])

        st, _, _ = self.api("POST", "/api/gpu/action", {"action": "nope"})
        self.assertEqual(st, 400)

        # 4. Watchdog & VFIO toggle actions
        for act in ("confirm_watchdog", "toggle_vfio_default"):
            st, data, _ = self.api("POST", "/api/vm/action", {"action": act})
            self.assertEqual(st, 200)
            self.assertTrue(data["ok"])

        # 5. Terminal quick exec
        st, data, _ = self.api("POST", "/api/terminal/exec", {"command": "echo QUICK_EXEC_OK_42"})
        self.assertEqual(st, 200)
        self.assertTrue(data["ok"])
        self.assertIn("QUICK_EXEC_OK_42", data["output"])

    # ================================================================== PWA Manifest, PNG Icons & CA Cert
    def test_11_pwa_manifest_icons_and_ca_cert(self):
        # 1. Manifest JSON + PNG icons (any & maskable)
        st, body, hdrs = self.api("GET", "/manifest.webmanifest", auth=None)
        self.assertEqual(st, 200)
        self.assertIn("application/manifest+json", hdrs.get("content-type", ""))
        manifest = json.loads(body.decode("utf-8"))
        self.assertEqual(manifest.get("display"), "standalone")
        icons = manifest.get("icons", [])
        png_pairs = {(i.get("sizes"), i.get("purpose"), i.get("type")) for i in icons}
        for sz in ("192x192", "512x512"):
            for purpose in ("any", "maskable"):
                self.assertIn((sz, purpose, "image/png"), png_pairs)

        # 2. PNG files served cleanly with PNG magic header
        for icon_path in (
            "/icons/icon-192.png",
            "/icons/icon-512.png",
            "/icons/icon-maskable-192.png",
            "/icons/icon-maskable-512.png",
        ):
            st, png_data, hdrs = self.api("GET", icon_path, auth=None)
            self.assertEqual(st, 200, icon_path)
            self.assertEqual(hdrs.get("content-type"), "image/png")
            self.assertTrue(png_data.startswith(b"\x89PNG\r\n\x1a\n"), icon_path)

        # 3. Public /mothos-ca.crt generates 2-tier PKI and validates leaf cert
        st, ca_body, hdrs = self.api("GET", "/mothos-ca.crt", auth=None)
        self.assertEqual(st, 200)
        self.assertEqual(hdrs.get("content-type"), "application/x-x509-ca-cert")
        self.assertIn(b"BEGIN CERTIFICATE", ca_body)

        ca_path = os.path.join(self.data_dir, "ca.crt")
        tls_path = os.path.join(self.data_dir, "tls.crt")
        self.assertTrue(os.path.isfile(ca_path))
        self.assertTrue(os.path.isfile(tls_path))

        res = subprocess.run(
            ["openssl", "verify", "-CAfile", ca_path, tls_path],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

        st, health, _ = self.api("GET", "/api/health", auth=None)
        self.assertEqual(st, 200)
        self.assertTrue(health.get("has_ca"))
        self.assertIsInstance(health.get("https_ports"), list)


if __name__ == "__main__":
    unittest.main()
