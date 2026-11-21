"""MothOS asyncio HTTP/1.1 + WebSocket server (stdlib only)."""
import asyncio
import concurrent.futures
import email.utils
import http
import json
import logging
import os
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import urllib.parse

import files
import logs as logs_mod
import terminal
import ws as wsmod
from auth import Auth
from config import APP_NAME, VERSION, Config
from monitor import Monitor
from updates import Services, Updates
from usb import USBManager
from util import ApiError, require_confirm
from vm import VMController, host_power

log = logging.getLogger("mothos.server")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
}

PUBLIC_API = {("GET", "/api/health"), ("POST", "/api/auth/login"), ("GET", "/api/auth/me"),
              ("POST", "/api/auth/logout"), ("POST", "/api/gpu/guest_report")}


def _is_lan_ip(ip):
    if not ip:
        return False
    return ip in ("127.0.0.1", "::1", "local") or ip.startswith(("192.168.", "10.", "172.", "fe80:", "::ffff:192.168.", "::ffff:10.", "::ffff:127."))


_TLS_LOCK = threading.Lock()

_CA_CNF = """[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no

[dn]
CN = MothOS Local CA
O = MothOS

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
"""

_SRV_CNF = """[req]
distinguished_name = dn
prompt = no

[dn]
CN = 192.168.18.10
O = MothOS
"""

_SRV_EXT = """basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = IP:192.168.18.10, IP:127.0.0.1, DNS:localhost, DNS:mac.local, DNS:mothos.local
"""


def _ensure_tls_cert(data_dir):
    """Ensure a 2-tier MothOS Local Root CA and a 390-day CA-signed server cert."""
    ca_crt = os.path.join(data_dir, "ca.crt")
    ca_key = os.path.join(data_dir, "ca.key")
    crt = os.path.join(data_dir, "tls.crt")
    key = os.path.join(data_dir, "tls.key")
    with _TLS_LOCK:
        if all(os.path.isfile(p) for p in (ca_crt, ca_key, crt, key)):
            return crt, key, ca_crt
        try:
            os.makedirs(data_dir, mode=0o700, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=data_dir) as tmp:
                ca_cnf = os.path.join(tmp, "ca.cnf")
                srv_cnf = os.path.join(tmp, "srv.cnf")
                srv_ext = os.path.join(tmp, "srv_ext.cnf")
                srv_csr = os.path.join(tmp, "srv.csr")
                ca_srl = os.path.join(tmp, "ca.srl")
                new_ca_crt = os.path.join(tmp, "ca.crt")
                new_ca_key = os.path.join(tmp, "ca.key")
                new_crt = os.path.join(tmp, "tls.crt")
                new_key = os.path.join(tmp, "tls.key")
                for p, text in ((ca_cnf, _CA_CNF), (srv_cnf, _SRV_CNF), (srv_ext, _SRV_EXT)):
                    with open(p, "w", encoding="utf-8") as fh:
                        fh.write(text)
                r1 = subprocess.run(
                    ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256",
                     "-days", "3650", "-keyout", new_ca_key, "-out", new_ca_crt, "-config", ca_cnf],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                if r1.returncode != 0:
                    return None, None, None
                r2 = subprocess.run(
                    ["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes",
                     "-keyout", new_key, "-out", srv_csr, "-config", srv_cnf],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                if r2.returncode != 0:
                    return None, None, None
                r3 = subprocess.run(
                    ["openssl", "x509", "-req", "-in", srv_csr, "-CA", new_ca_crt, "-CAkey", new_ca_key,
                     "-CAcreateserial", "-CAserial", ca_srl, "-out", new_crt, "-days", "390",
                     "-sha256", "-extfile", srv_ext],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                if r3.returncode != 0 or not os.path.isfile(new_crt):
                    return None, None, None
                os.replace(new_ca_key, ca_key)
                os.replace(new_ca_crt, ca_crt)
                os.replace(new_key, key)
                os.replace(new_crt, crt)
            for p, mode in ((ca_key, 0o600), (key, 0o600), (ca_crt, 0o644), (crt, 0o644)):
                try:
                    os.chmod(p, mode)
                except OSError:
                    pass
            return crt, key, ca_crt
        except Exception:
            pass
    return None, None, None

PLACEHOLDER_HTML = (b"<!doctype html><html lang='pt-BR'><head><meta charset='utf-8'>"
                    b"<title>MothOS</title></head><body style='background:#0b0b12;color:#eee;"
                    b"font-family:-apple-system,sans-serif;padding:2rem'><h1>MothOS</h1>"
                    b"<p>Frontend n&atilde;o encontrado. API dispon&iacute;vel em /api/health.</p>"
                    b"</body></html>")


class Request(object):
    def __init__(self, method, target, version, headers, reader, writer, client):
        self.method = method
        self.target = target
        self.version = version
        self.headers = headers
        self.reader = reader
        self.writer = writer
        self.client = client
        parts = urllib.parse.urlsplit(target)
        self.path = urllib.parse.unquote(parts.path) or "/"
        self.query = {}
        for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True):
            self.query.setdefault(k, v)
        self.cookies = {}
        for item in headers.get("cookie", "").split(";"):
            if "=" in item:
                k, _, v = item.strip().partition("=")
                self.cookies.setdefault(k.strip(), v.strip())
        self.body = b""
        self.body_consumed = True
        self._json = None

    def json(self):
        if self._json is None:
            if not self.body:
                self._json = {}
            else:
                try:
                    self._json = json.loads(self.body.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    raise ApiError(400, "invalid_json")
            if not isinstance(self._json, dict):
                raise ApiError(400, "invalid_json")
        return self._json


class Response(object):
    def __init__(self, status=200, body=b"", content_type="application/json; charset=utf-8", headers=None,
                 file_path=None, file_size=None):
        self.status = status
        self.body = body
        self.headers = list(headers or [])
        self.content_type = content_type
        self.file_path = file_path
        self.file_size = file_size

    @classmethod
    def json(cls, data, status=200, headers=None):
        return cls(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), headers=headers)


class MothServer(object):
    def __init__(self, cfg=None):
        self.cfg = cfg or Config()
        try:
            os.makedirs(self.cfg.data_dir, mode=0o700, exist_ok=True)
        except OSError:
            pass
        self.auth = Auth(self.cfg)
        self.vm = VMController(self.cfg)
        self.monitor = Monitor(self.cfg, self.vm)
        self.usb = USBManager(self.cfg, self.vm)
        self.updates = Updates(self.cfg)
        self.services = Services(self.cfg)
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="mothos")
        self.server = None
        self.servers = []
        self.loop = None
        self.routes = self._build_routes()

    # ================================================================ routing
    def _build_routes(self):
        r = {}

        def add(method, path, fn, stream=False):
            r[(method, path)] = (fn, stream)

        add("GET", "/api/health", self.h_health)
        add("GET", "/api/auth/me", self.h_me)
        add("POST", "/api/auth/login", self.h_login)
        add("POST", "/api/auth/logout", self.h_logout)
        add("GET", "/api/monitor", self.h_monitor)
        add("GET", "/api/vm/status", self.h_vm_status)
        add("POST", "/api/vm/action", self.h_vm_action)
        add("POST", "/api/vm/opencore", self.h_vm_opencore)
        add("POST", "/api/host/power", self.h_host_power)
        add("GET", "/api/usb/list", self.h_usb_list)
        add("POST", "/api/usb/attach", self.h_usb_attach)
        add("POST", "/api/usb/detach", self.h_usb_detach)
        add("POST", "/api/usb/bt", self.h_usb_bt)
        add("GET", "/api/files/bookmarks", self.h_bookmarks)
        add("GET", "/api/files/list", self.h_files_list)
        add("GET", "/api/files/read", self.h_files_read)
        add("POST", "/api/files/write", self.h_files_write)
        add("POST", "/api/files/mkdir", self.h_files_mkdir)
        add("POST", "/api/files/rename", self.h_files_rename)
        add("POST", "/api/files/delete", self.h_files_delete)
        add("GET", "/api/files/download", self.h_files_download)
        add("POST", "/api/files/upload", self.h_files_upload, stream=True)
        add("POST", "/api/files/exec", self.h_files_exec)
        add("GET", "/api/updates/status", self.h_updates_status)
        add("POST", "/api/updates/check", self.h_updates_check)
        add("POST", "/api/updates/upgrade", self.h_updates_upgrade)
        add("GET", "/api/services/list", self.h_services_list)
        add("POST", "/api/services/action", self.h_services_action)
        add("GET", "/api/logs", self.h_logs)
        add("POST", "/api/gpu/guest_report", self.h_gpu_guest_report)
        add("POST", "/api/gpu/action", self.h_gpu_action)
        add("POST", "/api/terminal/exec", self.h_terminal_exec)
        return r

    async def blocking(self, fn, *args):
        return await asyncio.get_running_loop().run_in_executor(self.executor, fn, *args)

    # ================================================================ handlers
    async def h_health(self, req):
        return {
            "status": "ok",
            "app": APP_NAME,
            "version": VERSION,
            "dev_mode": self.cfg.dev_mode,
            "https_ports": [p for (_, proto, p) in self.servers if proto == "https"],
            "has_ca": os.path.isfile(os.path.join(self.cfg.data_dir, "ca.crt")),
        }

    async def h_me(self, req):
        token, _ = self.auth.authenticate(req)
        return {"authenticated": bool(token)}

    async def h_login(self, req):
        ip = req.client
        if self.auth.is_locked(ip):
            raise ApiError(429, "too_many_attempts")
        body = req.json()
        if not self.auth.check_pin(body.get("pin")):
            self.auth.record_failure(ip)
            log.warning("login failed from %s", ip)
            await asyncio.sleep(0.3)
            raise ApiError(401, "invalid_pin")
        self.auth.clear_failures(ip)
        token, exp = self.auth.issue()
        log.info("login ok from %s", ip)
        expires = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp))
        return Response.json({"ok": True, "token": token, "expires_at": expires},
                             headers=[("Set-Cookie", self.auth.cookie_header(token))])

    async def h_logout(self, req):
        token, _ = self.auth.authenticate(req)
        if token:
            self.auth.revoke(token)
        return Response.json({"ok": True}, headers=[("Set-Cookie", self.auth.clear_cookie_header())])

    async def h_monitor(self, req):
        return await self.blocking(self.monitor.snapshot)

    async def h_vm_status(self, req):
        return await self.blocking(self.vm.status)

    async def h_vm_action(self, req):
        body = req.json()
        act = body.get("action")
        valid = ("start", "shutdown", "force_stop", "restart", "revert",
                 "confirm_watchdog", "toggle_vfio_default")
        if act not in valid:
            raise ApiError(400, "invalid_action")
        if act not in ("confirm_watchdog", "toggle_vfio_default"):
            require_confirm(body)
        log.info("vm action %s", act)
        return await self.blocking(self.vm.action, act)

    async def h_vm_opencore(self, req):
        body = req.json()
        return await self.blocking(self.vm.select_opencore, body.get("name"))

    async def h_host_power(self, req):
        body = req.json()
        if body.get("action") not in ("reboot", "shutdown", "boot_windows"):
            raise ApiError(400, "invalid_action")
        require_confirm(body)
        log.warning("host power action %s requested by %s", body["action"], req.client)
        loop = asyncio.get_running_loop()
        return await self.blocking(host_power, self.cfg, body["action"], loop)

    async def h_usb_list(self, req):
        return await self.blocking(self.usb.list)

    async def h_usb_attach(self, req):
        return await self.blocking(self.usb.attach, req.json())

    async def h_usb_detach(self, req):
        return await self.blocking(self.usb.detach, req.json())

    async def h_usb_bt(self, req):
        return await self.blocking(self.usb.bt, req.json())

    async def h_bookmarks(self, req):
        return files.bookmarks()

    async def h_files_list(self, req):
        return await self.blocking(files.list_dir, req.query.get("path", "/"))

    async def h_files_read(self, req):
        return await self.blocking(files.read_file, req.query.get("path"), self.cfg.max_read)

    async def h_files_write(self, req):
        return await self.blocking(files.write_file, req.json())

    async def h_files_mkdir(self, req):
        return await self.blocking(files.mkdir, req.json())

    async def h_files_rename(self, req):
        return await self.blocking(files.rename, req.json())

    async def h_files_delete(self, req):
        body = req.json()
        log.info("delete %s", body.get("path"))
        return await self.blocking(files.delete, body)

    async def h_files_download(self, req):
        path, size = await self.blocking(files.download_info, req.query.get("path"))
        return Response(200, content_type="application/octet-stream", file_path=path, file_size=size,
                        headers=[("Content-Disposition", files.content_disposition(os.path.basename(path)))])

    async def h_files_upload(self, req):
        result = await files.upload(req)
        log.info("upload %s (%d bytes)", result["path"], result["size"])
        return result

    async def h_files_exec(self, req):
        body = req.json()
        log.info("exec %s", body.get("path"))
        return await self.blocking(files.exec_file, self.cfg, body)

    async def h_updates_status(self, req):
        return self.updates.status()

    async def h_updates_check(self, req):
        return self.updates.check()

    async def h_updates_upgrade(self, req):
        require_confirm(req.json())
        return self.updates.upgrade()

    async def h_services_list(self, req):
        return await self.blocking(self.services.list)

    async def h_services_action(self, req):
        return await self.blocking(self.services.action, req.json())

    async def h_logs(self, req):
        q = req.query
        return await self.blocking(logs_mod.get_logs, self.cfg, q.get("source", "mothos"),
                                   q.get("lines", "150"), q.get("filter", ""))

    async def h_gpu_guest_report(self, req):
        if not self.auth.authenticate(req)[0] and not _is_lan_ip(req.client):
            raise ApiError(401, "unauthorized")
        return self.monitor.ingest_guest_gpu(req.json())

    async def h_gpu_action(self, req):
        body = req.json()
        return await self.blocking(self.monitor.gpu_action, body.get("action"))

    async def h_terminal_exec(self, req):
        body = req.json()
        cmd = body.get("command")
        log.info("terminal quick exec: %s", (cmd or "")[:80])
        return await self.blocking(terminal.exec_quick, self.cfg, cmd)

    # ================================================================ websockets
    async def ws_monitor(self, req, sock):
        async def reader():
            while True:
                msg = await sock.recv()
                if msg is None:
                    return
        rtask = asyncio.ensure_future(reader())
        try:
            while not sock.closed and not rtask.done():
                snap = await self.blocking(self.monitor.snapshot)
                await sock.send_json(snap)
                try:
                    await asyncio.wait_for(asyncio.shield(rtask), timeout=1.0)
                except asyncio.TimeoutError:
                    pass
        except wsmod.WebSocketClosed:
            pass
        finally:
            if not rtask.done():
                rtask.cancel()
            await sock.close()

    async def ws_terminal(self, req, sock):
        await terminal.run_terminal(self.cfg, sock)

    # ================================================================ static
    def _static(self, req):
        root = os.path.realpath(self.cfg.frontend_dir)
        rel = req.path.lstrip("/")
        index = os.path.join(root, "index.html")
        if not os.path.isfile(index):
            if rel in ("", "index.html"):
                return Response(200, PLACEHOLDER_HTML, "text/html; charset=utf-8")
            return Response(404, b"Not Found", "text/plain; charset=utf-8")
        full = os.path.realpath(os.path.join(root, rel)) if rel else index
        if full != root and not full.startswith(root + os.sep):
            return Response(404, b"Not Found", "text/plain; charset=utf-8")
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            last = rel.rsplit("/", 1)[-1]
            if "." in last:
                return Response(404, b"Not Found", "text/plain; charset=utf-8")
            full = index  # SPA fallback
        ext = os.path.splitext(full)[1].lower()
        ctype = MIME.get(ext, "application/octet-stream")
        st = os.stat(full)
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        headers = [("ETag", etag), ("Cache-Control", "no-cache"),
                   ("Last-Modified", email.utils.formatdate(st.st_mtime, usegmt=True))]
        if os.path.basename(full) == "sw.js":
            headers.append(("Service-Worker-Allowed", "/"))
        if req.headers.get("if-none-match") == etag:
            return Response(304, b"", ctype, headers=headers)
        if st.st_size > 2 * 1024 * 1024:
            return Response(200, content_type=ctype, headers=headers, file_path=full, file_size=st.st_size)
        with open(full, "rb") as fh:
            return Response(200, fh.read(), ctype, headers=headers)

    # ================================================================ http core
    async def _send(self, req, resp, keep_alive):
        phrase = http.HTTPStatus(resp.status).phrase if resp.status in http.HTTPStatus._value2member_map_ \
            else "Status"
        length = resp.file_size if resp.file_path else len(resp.body)
        lines = ["HTTP/1.1 %d %s" % (resp.status, phrase),
                 "Date: " + email.utils.formatdate(usegmt=True),
                 "Server: MothOS/" + VERSION,
                 "Content-Type: " + resp.content_type,
                 "Content-Length: %d" % length,
                 "X-Content-Type-Options: nosniff",
                 "Connection: " + ("keep-alive" if keep_alive else "close")]
        names = set(k.lower() for k, _ in resp.headers)
        if req.path.startswith("/api/") and "cache-control" not in names:
            lines.append("Cache-Control: no-store")
        for k, v in resp.headers:
            lines.append("%s: %s" % (k, v))
        req.writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("utf-8"))
        if req.method == "HEAD" or resp.status == 304:
            await req.writer.drain()
            return
        if resp.file_path:
            with open(resp.file_path, "rb") as fh:
                while True:
                    chunk = fh.read(256 * 1024)
                    if not chunk:
                        break
                    req.writer.write(chunk)
                    await req.writer.drain()
        else:
            req.writer.write(resp.body)
            await req.writer.drain()

    async def _read_body(self, req):
        if "chunked" in req.headers.get("transfer-encoding", "").lower():
            raise ApiError(411, "length_required")
        cl = req.headers.get("content-length", "0") or "0"
        if not cl.isdigit():
            raise ApiError(400, "bad_content_length")
        n = int(cl)
        if n > self.cfg.max_body:
            req.body_consumed = False
            raise ApiError(413, "payload_too_large")
        req.body = await req.reader.readexactly(n) if n else b""

    def _origin_ok(self, req):
        origin = req.headers.get("origin")
        if not origin:
            return True
        host = req.headers.get("host", "")
        o_parts = urllib.parse.urlsplit(origin)
        o_net = (o_parts.netloc or "").lower()
        o_host = (o_parts.hostname or "").lower()
        h_host = host.split(":", 1)[0].lower()
        return o_net == host.lower() or (bool(o_host) and o_host == h_host)

    async def _dispatch(self, req):
        """Handle one request. Returns True to keep the connection alive."""
        keep_alive = req.headers.get("connection", "").lower() != "close" and req.version == "HTTP/1.1"
        path = req.path

        # ---------------- WebSocket endpoints
        if path.startswith("/ws/"):
            handler = {"/ws/monitor": self.ws_monitor, "/ws/terminal": self.ws_terminal}.get(path)
            if handler is None:
                await self._send(req, Response.json({"error": "not_found"}, 404), False)
                return False
            token, source = self.auth.authenticate(req)
            if not token:
                await self._send(req, Response.json({"error": "unauthorized"}, 401), False)
                return False
            if source == "cookie" and not self._origin_ok(req):
                await self._send(req, Response.json({"error": "forbidden_origin"}, 403), False)
                return False
            if not wsmod.is_upgrade(req):
                await self._send(req, Response.json({"error": "upgrade_required"}, 426), False)
                return False
            try:
                sock = await wsmod.accept(req)
            except ValueError:
                await self._send(req, Response.json({"error": "bad_handshake"}, 400), False)
                return False
            try:
                await handler(req, sock)
            except Exception:
                log.exception("websocket handler error on %s", path)
            return False

        # ---------------- API endpoints
        if path.startswith("/api/"):
            entry = self.routes.get((req.method, path))
            try:
                if entry is None:
                    if any(p == path for (_, p) in self.routes):
                        raise ApiError(405, "method_not_allowed")
                    raise ApiError(404, "not_found")
                fn, stream = entry
                if stream:
                    req.body_consumed = False
                else:
                    await self._read_body(req)
                if (req.method, path) not in PUBLIC_API and not self.auth.authenticate(req)[0]:
                    raise ApiError(401, "unauthorized")
                result = await fn(req)
                resp = result if isinstance(result, Response) else Response.json(result)
            except ApiError as exc:
                resp = Response.json(exc.payload(), exc.status)
            except asyncio.IncompleteReadError:
                return False
            except Exception as exc:
                log.exception("handler error %s %s", req.method, path)
                resp = Response.json({"error": "internal_error", "detail": str(exc)}, 500)
            if not req.body_consumed:
                keep_alive = False
            await self._send(req, resp, keep_alive)
            return keep_alive

        if path == "/mothos-ca.crt":
            if req.method not in ("GET", "HEAD"):
                keep_alive = False
                await self._send(req, Response(405, b"Method Not Allowed", "text/plain; charset=utf-8"), keep_alive)
                return keep_alive
            _, _, ca_crt = await self.blocking(_ensure_tls_cert, self.cfg.data_dir)
            if not ca_crt or not os.path.isfile(ca_crt):
                resp = Response(404, b"CA certificate unavailable", "text/plain; charset=utf-8")
            else:
                with open(ca_crt, "rb") as fh:
                    resp = Response(
                        200,
                        fh.read(),
                        "application/x-x509-ca-cert",
                        headers=[
                            ("Content-Disposition", 'attachment; filename="mothos-ca.crt"'),
                            ("Cache-Control", "no-store"),
                        ],
                    )
            await self._send(req, resp, keep_alive)
            return keep_alive

        # ---------------- static frontend
        if req.method not in ("GET", "HEAD"):
            if req.headers.get("content-length", "0") not in ("", "0"):
                keep_alive = False
            await self._send(req, Response(405, b"Method Not Allowed", "text/plain; charset=utf-8"), keep_alive)
            return keep_alive
        try:
            resp = await self.blocking(self._static, req)
        except OSError:
            resp = Response(404, b"Not Found", "text/plain; charset=utf-8")
        await self._send(req, resp, keep_alive)
        return keep_alive

    async def _handle_conn(self, reader, writer):
        peer = writer.get_extra_info("peername")
        client = peer[0] if isinstance(peer, (tuple, list)) and peer else "local"
        is_ssl = writer.get_extra_info("ssl_object") is not None
        sock = writer.get_extra_info("socket")
        if sock is not None:
            try:
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            except OSError:
                pass
        try:
            while True:
                try:
                    first = await asyncio.wait_for(reader.read(1), timeout=75)
                    if not first:
                        break
                    # Fast-reject TLS ClientHello (0x16) on plain HTTP ports so Chrome
                    # HTTPS-First immediately falls back to http:// instead of hanging.
                    if not is_ssl and first == b"\x16":
                        try:
                            writer.write(b"\x15\x03\x03\x00\x02\x02\x28")
                            await writer.drain()
                            if sock is not None:
                                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                        except OSError:
                            pass
                        break
                    rest_head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15)
                    head = first + rest_head
                except (asyncio.IncompleteReadError, asyncio.TimeoutError, asyncio.LimitOverrunError,
                        ConnectionError, OSError):
                    break
                try:
                    text = head.decode("latin-1")
                    request_line, _, rest = text.partition("\r\n")
                    method, target, version = request_line.split(" ", 2)
                    headers = {}
                    for line in rest.split("\r\n"):
                        if ":" in line:
                            k, _, v = line.partition(":")
                            k = k.strip().lower()
                            v = v.strip()
                            headers[k] = (headers[k] + ", " + v) if k in headers and k != "cookie" \
                                else (headers[k] + "; " + v if k in headers else v)
                    version = version.strip()
                    if not version.startswith("HTTP/1."):
                        raise ValueError("bad version")
                except ValueError:
                    writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    await writer.drain()
                    break
                req = Request(method.upper(), target, version, headers, reader, writer, client)
                if not await self._dispatch(req):
                    break
        except (ConnectionError, OSError):
            pass
        except Exception:
            log.exception("connection error")
        finally:
            try:
                writer.close()
            except Exception:
                pass

    # ================================================================ lifecycle
    async def start(self, host=None, port=None):
        self.loop = asyncio.get_running_loop()
        bind_host = host if host is not None else self.cfg.host
        bind_port = port if port is not None else self.cfg.port
        self.server = await asyncio.start_server(
            self._handle_conn, bind_host, bind_port, limit=65536, reuse_address=True)
        self.servers = [(self.server, "http", bind_port)]

        if host is None and port is None and not self.cfg.dev_mode:
            alt = self.cfg.http_port_alt
            used_ports = {bind_port}
            if alt and alt not in used_ports:
                try:
                    s_alt = await asyncio.start_server(
                        self._handle_conn, bind_host, alt, limit=65536, reuse_address=True)
                    self.servers.append((s_alt, "http", alt))
                    used_ports.add(alt)
                except OSError as exc:
                    log.warning("Could not bind alt HTTP port %d: %s", alt, exc)
            https_ports = []
            for p in (self.cfg.https_port, self.cfg.https_port_alt):
                if p and p not in used_ports and p not in https_ports:
                    https_ports.append(p)
            if https_ports:
                crt, key, _ = _ensure_tls_cert(self.cfg.data_dir)
                if crt and key:
                    try:
                        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
                        ctx.load_cert_chain(crt, key)
                    except Exception as exc:
                        log.warning("Could not load TLS certificate: %s", exc)
                        ctx = None
                    if ctx is not None:
                        for https_p in https_ports:
                            try:
                                s_tls = await asyncio.start_server(
                                    self._handle_conn, bind_host, https_p, ssl=ctx,
                                    limit=65536, reuse_address=True)
                                self.servers.append((s_tls, "https", https_p))
                                used_ports.add(https_p)
                            except Exception as exc:
                                log.warning("Could not start HTTPS listener on %d: %s", https_p, exc)

        self.updates.initial_refresh()
        return self.server

    @property
    def port(self):
        if self.server and self.server.sockets:
            return self.server.sockets[0].getsockname()[1]
        return None

    async def close(self):
        for s, _, _ in self.servers:
            try:
                s.close()
                await s.wait_closed()
            except Exception:
                pass
        self.servers = []
        self.executor.shutdown(wait=False)


async def serve_forever(cfg):
    srv = MothServer(cfg)
    await srv.start()
    ports_desc = ", ".join("%s://%s:%d" % (proto, cfg.host, p) for (_, proto, p) in srv.servers)
    log.info("%s %s listening on %s (dev_mode=%s, frontend=%s)", APP_NAME, VERSION,
             ports_desc, cfg.dev_mode, cfg.frontend_dir)
    if cfg.forced_dev:
        log.warning("Non-Linux host detected: dev mode forced (host actions are simulated)")
    try:
        await asyncio.gather(*(s.serve_forever() for (s, _, _) in srv.servers))
    finally:
        await srv.close()
