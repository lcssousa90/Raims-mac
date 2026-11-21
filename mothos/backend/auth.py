"""PIN login + HMAC-SHA256 signed stateless session tokens."""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time

COOKIE_NAME = "mothos_session"


def _b64e(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64d(text):
    text = text + "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text.encode("ascii"))


class Auth(object):
    MAX_FAILURES = 10
    FAIL_WINDOW = 300.0

    def __init__(self, cfg):
        self.cfg = cfg
        self.secret = self._load_secret()
        self._revoked = {}
        self._failures = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ secret
    def _load_secret(self):
        if self.cfg.secret:
            return self.cfg.secret.encode("utf-8")
        path = os.path.join(self.cfg.data_dir, "secret.key")
        try:
            with open(path, "rb") as fh:
                data = fh.read().strip()
            if len(data) >= 32:
                return data
        except (OSError, IOError):
            pass
        data = secrets.token_hex(32).encode("ascii")
        try:
            os.makedirs(self.cfg.data_dir, mode=0o700, exist_ok=True)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as fh:
                fh.write(data)
        except OSError:
            pass  # in-memory secret only (sessions reset on restart)
        return data

    # ------------------------------------------------------------------ tokens
    def _sign(self, payload_b64):
        return _b64e(hmac.new(self.secret, payload_b64.encode("ascii"), hashlib.sha256).digest())

    def issue(self):
        exp = int(time.time()) + self.cfg.session_max_age
        payload = json.dumps({"exp": exp, "nonce": secrets.token_urlsafe(12)},
                             separators=(",", ":")).encode("utf-8")
        p = _b64e(payload)
        return p + "." + self._sign(p), exp

    def verify(self, token):
        if not token or not isinstance(token, str) or token.count(".") != 1 or len(token) > 512:
            return None
        p, sig = token.split(".", 1)
        try:
            if not hmac.compare_digest(self._sign(p), sig):
                return None
            payload = json.loads(_b64d(p).decode("utf-8"))
        except Exception:
            return None
        if not isinstance(payload, dict):
            return None
        try:
            if float(payload.get("exp", 0)) < time.time():
                return None
        except (TypeError, ValueError):
            return None
        with self._lock:
            if payload.get("nonce") in self._revoked:
                return None
        return payload

    def revoke(self, token):
        payload = self.verify(token)
        if not payload:
            return
        now = time.time()
        with self._lock:
            self._revoked[payload.get("nonce")] = float(payload.get("exp", now))
            for nonce, exp in list(self._revoked.items()):
                if exp < now:
                    del self._revoked[nonce]

    # ------------------------------------------------------------------ pin
    def check_pin(self, pin):
        if pin is None:
            return False
        return hmac.compare_digest(str(pin).encode("utf-8"), self.cfg.pin.encode("utf-8"))

    def is_locked(self, ip):
        now = time.time()
        with self._lock:
            hits = [t for t in self._failures.get(ip, []) if now - t < self.FAIL_WINDOW]
            self._failures[ip] = hits
            return len(hits) >= self.MAX_FAILURES

    def record_failure(self, ip):
        with self._lock:
            self._failures.setdefault(ip, []).append(time.time())

    def clear_failures(self, ip):
        with self._lock:
            self._failures.pop(ip, None)

    # ------------------------------------------------------------------ request
    @staticmethod
    def token_from_request(req):
        """Returns (token, source) from Bearer header, cookie or ?token=."""
        authz = req.headers.get("authorization", "")
        if authz.lower().startswith("bearer "):
            return authz[7:].strip(), "bearer"
        tok = req.query.get("token")
        if tok:
            return tok, "query"
        tok = req.cookies.get(COOKIE_NAME)
        if tok:
            return tok, "cookie"
        return None, None

    def authenticate(self, req):
        token, source = self.token_from_request(req)
        if token and self.verify(token):
            return token, source
        # Bearer may be stale while cookie is valid (or vice-versa): try cookie.
        cookie = req.cookies.get(COOKIE_NAME)
        if cookie and cookie != token and self.verify(cookie):
            return cookie, "cookie"
        return None, None

    def cookie_header(self, token):
        return "%s=%s; HttpOnly; SameSite=Lax; Path=/; Max-Age=%d" % (
            COOKIE_NAME, token, self.cfg.session_max_age)

    @staticmethod
    def clear_cookie_header():
        return "%s=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" % COOKIE_NAME
