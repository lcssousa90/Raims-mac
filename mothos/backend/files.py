"""File manager: full filesystem access with safe atomic edits, upload, exec."""
import datetime
import json
import os
import plistlib
import re
import secrets
import shutil
import stat
import urllib.parse

from util import ApiError, base_env, run_cmd, tail_text

BOOKMARKS = [
    {"label": "Root", "path": "/root"},
    {"label": "Pasta da VM", "path": "/root/.local/share/reims-ctl/vms/mac"},
    {"label": "GRUB", "path": "/etc/grub.d"},
    {"label": "Home mac", "path": "/home/mac"},
    {"label": "Temp", "path": "/tmp"},
    {"label": "Sistema (/)", "path": "/"},
]

# Deleting these directories themselves (not their contents) is refused.
PROTECTED_DELETE = {"/", "/bin", "/boot", "/dev", "/etc", "/home", "/lib", "/lib32", "/lib64", "/proc",
                    "/root", "/run", "/sbin", "/sys", "/usr", "/var", "/opt", "/srv", "/mnt", "/media"}

CHUNK = 64 * 1024


def norm_path(p, field="path"):
    if not isinstance(p, str) or not p or "\0" in p:
        raise ApiError(400, "invalid_path", detail="%s ausente ou inválido" % field)
    if not p.startswith("/"):
        raise ApiError(400, "invalid_path", detail="%s deve ser absoluto" % field)
    p = "/" + p.lstrip("/")
    return os.path.normpath(p)


def _oserror(exc, path=None):
    if isinstance(exc, FileNotFoundError):
        return ApiError(404, "not_found", detail=path or str(exc))
    if isinstance(exc, PermissionError):
        return ApiError(403, "permission_denied", detail=path or str(exc))
    if isinstance(exc, FileExistsError):
        return ApiError(409, "exists", detail=path or str(exc))
    if isinstance(exc, IsADirectoryError):
        return ApiError(400, "is_directory", detail=path or str(exc))
    if isinstance(exc, NotADirectoryError):
        return ApiError(400, "not_a_directory", detail=path or str(exc))
    return ApiError(500, "os_error", detail=str(exc))


def safe_basename(name):
    name = urllib.parse.unquote(str(name or "")).replace("\\", "/")
    name = name.rsplit("/", 1)[-1].strip().replace("\0", "")
    if not name or name in (".", "..") or len(name) > 255:
        raise ApiError(400, "invalid_filename")
    return name


def bookmarks():
    return {"bookmarks": [dict(b) for b in BOOKMARKS]}


def list_dir(path):
    path = norm_path(path)
    try:
        if not os.path.isdir(path):
            if os.path.exists(path):
                raise ApiError(400, "not_a_directory", detail=path)
            raise ApiError(404, "not_found", detail=path)
        entries = []
        with os.scandir(path) as it:
            for de in it:
                try:
                    lst = de.stat(follow_symlinks=False)
                    is_link = stat.S_ISLNK(lst.st_mode)
                    st = lst
                    if is_link:
                        try:
                            st = de.stat(follow_symlinks=True)
                        except OSError:
                            st = lst
                    entries.append({
                        "name": de.name,
                        "path": os.path.join(path, de.name),
                        "is_dir": stat.S_ISDIR(st.st_mode),
                        "size": st.st_size,
                        "mtime": st.st_mtime,
                        "mode": "%04o" % stat.S_IMODE(st.st_mode),
                        "is_symlink": is_link,
                    })
                except OSError:
                    continue
    except OSError as exc:
        raise _oserror(exc, path)
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    parent = None if path == "/" else (os.path.dirname(path) or "/")
    return {"path": path, "parent": parent, "entries": entries}


def read_file(path, max_read):
    path = norm_path(path)
    try:
        if os.path.isdir(path):
            raise ApiError(400, "is_directory", detail=path)
        st = os.stat(path)
        with open(path, "rb") as fh:
            data = fh.read(max_read + 1)
    except OSError as exc:
        raise _oserror(exc, path)
    truncated = len(data) > max_read or st.st_size > max_read
    data = data[:max_read]
    is_binary = b"\0" in data[:8192]
    if not is_binary:
        try:
            content = data.decode("utf-8")
        except UnicodeDecodeError as exc:
            # tolerate a multi-byte char cut by truncation
            if truncated and exc.start >= len(data) - 4:
                content = data[:exc.start].decode("utf-8", "replace")
            else:
                ratio = sum(1 for b in data[:8192] if b < 9 or (13 < b < 32)) / float(max(1, min(len(data), 8192)))
                is_binary = ratio > 0.1
                content = data.decode("utf-8", "replace")
    if is_binary:
        content = ""
    return {"path": path, "content": content, "size": st.st_size, "is_binary": is_binary,
            "truncated": truncated}


def _validate(path, tmp_path, content):
    """Return (status, detail). status in ok/skipped/failed."""
    lower = path.lower()
    if lower.endswith(".sh"):
        rc, out = run_cmd(["bash", "-n", tmp_path], timeout=20)
        if rc != 0:
            return "failed", out.replace(tmp_path, os.path.basename(path)).strip() or "bash -n falhou"
        return "ok", ""
    if lower.endswith(".json"):
        try:
            json.loads(content)
        except ValueError as exc:
            return "failed", "JSON inválido: %s" % exc
        return "ok", ""
    if lower.endswith(".plist"):
        try:
            plistlib.loads(content.encode("utf-8"))
        except Exception as exc:
            return "failed", "plist inválido: %s" % exc
        return "ok", ""
    return "skipped", ""


def write_file(body):
    path = norm_path(body.get("path"))
    content = body.get("content")
    if not isinstance(content, str):
        raise ApiError(400, "invalid_content")
    do_backup = body.get("backup", True) is not False
    do_validate = body.get("validate", True) is not False
    target = os.path.realpath(path) if os.path.islink(path) else path
    parent = os.path.dirname(target) or "/"
    if os.path.isdir(target):
        raise ApiError(400, "is_directory", detail=target)
    if not os.path.isdir(parent):
        raise ApiError(404, "parent_not_found", detail=parent)
    tmp = os.path.join(parent, ".%s.mothos_tmp_%s" % (os.path.basename(target)[:100], secrets.token_hex(4)))
    backup_path = None
    try:
        try:
            with open(tmp, "w", encoding="utf-8", newline="") as fh:
                fh.write(content)
                fh.flush()
                os.fsync(fh.fileno())
        except OSError as exc:
            raise _oserror(exc, parent)
        validation = "skipped"
        if do_validate:
            status_, detail = _validate(target, tmp, content)
            if status_ == "failed":
                raise ApiError(422, "validation_failed", detail=detail)
            validation = status_
        exists = os.path.exists(target)
        try:
            if exists:
                st = os.stat(target)
                os.chmod(tmp, stat.S_IMODE(st.st_mode))
                if hasattr(os, "chown") and os.geteuid() == 0:
                    try:
                        os.chown(tmp, st.st_uid, st.st_gid)
                    except OSError:
                        pass
                if do_backup:
                    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
                    backup_path = "%s.mothos_bak_%s" % (target, ts)
                    n = 1
                    while os.path.exists(backup_path):
                        backup_path = "%s.mothos_bak_%s_%d" % (target, ts, n)
                        n += 1
                    shutil.copy2(target, backup_path)
            elif target.lower().endswith(".sh"):
                os.chmod(tmp, 0o755)
            else:
                os.chmod(tmp, 0o644)
            os.replace(tmp, target)
        except OSError as exc:
            raise _oserror(exc, target)
        return {"ok": True, "path": target, "backup_path": backup_path, "validation": validation}
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def mkdir(body):
    path = norm_path(body.get("path"))
    try:
        os.makedirs(path, exist_ok=False)
    except OSError as exc:
        raise _oserror(exc, path)
    return {"ok": True, "path": path}


def rename(body):
    old = norm_path(body.get("old_path"), "old_path")
    new = norm_path(body.get("new_path"), "new_path")
    if old == "/" or new == "/":
        raise ApiError(403, "protected_path")
    if not os.path.lexists(old):
        raise ApiError(404, "not_found", detail=old)
    if os.path.lexists(new):
        raise ApiError(409, "exists", detail=new)
    if not os.path.isdir(os.path.dirname(new) or "/"):
        raise ApiError(404, "parent_not_found", detail=os.path.dirname(new))
    try:
        shutil.move(old, new)
    except OSError as exc:
        raise _oserror(exc, old)
    return {"ok": True, "path": new}


def delete(body):
    path = norm_path(body.get("path"))
    if path in PROTECTED_DELETE:
        raise ApiError(403, "protected_path", detail="Recusado: %s não pode ser apagado" % path)
    if body.get("confirm") is not True:
        raise ApiError(400, "confirmation_required")
    if not os.path.lexists(path):
        raise ApiError(404, "not_found", detail=path)
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
    except OSError as exc:
        raise _oserror(exc, path)
    return {"ok": True}


def download_info(path):
    path = norm_path(path)
    if os.path.isdir(path):
        raise ApiError(400, "is_directory", detail=path)
    try:
        st = os.stat(path)
        with open(path, "rb"):
            pass
    except OSError as exc:
        raise _oserror(exc, path)
    return path, st.st_size


def content_disposition(name):
    ascii_name = name.encode("ascii", "replace").decode("ascii").replace('"', "_").replace("?", "_")
    return 'attachment; filename="%s"; filename*=UTF-8\'\'%s' % (ascii_name, urllib.parse.quote(name))


# ---------------------------------------------------------------------- upload
class _BodyReader(object):
    def __init__(self, reader, length):
        self.reader = reader
        self.remaining = length

    async def read(self):
        if self.remaining <= 0:
            return b""
        chunk = await self.reader.read(min(CHUNK, self.remaining))
        if not chunk:
            raise ApiError(400, "incomplete_body")
        self.remaining -= len(chunk)
        return chunk

    async def drain(self):
        while self.remaining > 0:
            await self.read()


def _boundary(ctype):
    m = re.search(r'boundary=(?:"([^"]+)"|([^;\s]+))', ctype, re.I)
    if not m:
        raise ApiError(400, "invalid_multipart")
    return (m.group(1) or m.group(2)).encode("latin-1")


def _disposition(header_blob):
    name = filename = None
    for line in header_blob.decode("utf-8", "replace").split("\r\n"):
        if line.lower().startswith("content-disposition"):
            m = re.search(r'[\s;]name="([^"]*)"', line)
            name = m.group(1) if m else None
            m = re.search(r"filename\*=UTF-8''([^;\s]+)", line, re.I)
            if m:
                filename = urllib.parse.unquote(m.group(1))
            else:
                m = re.search(r'filename="([^"]*)"', line)
                filename = m.group(1) if m else None
    return name, filename


async def _multipart_save(body, boundary, dir_path, tmp_path):
    delim = b"--" + boundary
    buf = b""
    while True:
        idx = buf.find(delim)
        if idx >= 0:
            buf = buf[idx + len(delim):]
            break
        chunk = await body.read()
        if not chunk:
            raise ApiError(400, "invalid_multipart")
        buf = buf[-len(delim):] + chunk
    saved = None
    end = b"\r\n" + delim
    while True:
        while len(buf) < 2:
            chunk = await body.read()
            if not chunk:
                raise ApiError(400, "invalid_multipart")
            buf += chunk
        if buf[:2] == b"--":
            break
        buf = buf[2:] if buf[:2] == b"\r\n" else buf
        while b"\r\n\r\n" not in buf:
            if len(buf) > 16384:
                raise ApiError(400, "invalid_multipart")
            chunk = await body.read()
            if not chunk:
                raise ApiError(400, "invalid_multipart")
            buf += chunk
        hdr, buf = buf.split(b"\r\n\r\n", 1)
        name, filename = _disposition(hdr)
        fh = None
        size = 0
        if saved is None and filename:
            # first part carrying a filename (normally the `file` field)
            fh = open(tmp_path, "wb")
        try:
            while True:
                idx = buf.find(end)
                if idx >= 0:
                    if fh:
                        fh.write(buf[:idx])
                        size += idx
                    buf = buf[idx + len(end):]
                    break
                keep = len(end) - 1
                if len(buf) > keep:
                    if fh:
                        fh.write(buf[:-keep])
                        size += len(buf) - keep
                    buf = buf[-keep:]
                chunk = await body.read()
                if not chunk:
                    raise ApiError(400, "invalid_multipart")
                buf += chunk
        finally:
            if fh:
                fh.close()
        if fh:
            saved = (filename, size)
    await body.drain()
    return saved


async def upload(req):
    dir_path = norm_path(req.query.get("dir") or "/tmp", "dir")
    cl = req.headers.get("content-length")
    if cl is None or not cl.isdigit():
        raise ApiError(411, "length_required")
    body = _BodyReader(req.reader, int(cl))
    req.body_consumed = False
    if not os.path.isdir(dir_path):
        raise ApiError(404, "not_found", detail=dir_path)
    tmp = os.path.join(dir_path, ".mothos_upload_%s" % secrets.token_hex(6))
    ctype = req.headers.get("content-type", "")
    try:
        if ctype.lower().startswith("multipart/form-data"):
            saved = await _multipart_save(body, _boundary(ctype), dir_path, tmp)
            if not saved:
                raise ApiError(400, "missing_file_field")
            name, size = safe_basename(saved[0]), saved[1]
        else:
            name = safe_basename(req.headers.get("x-filename") or req.query.get("filename"))
            size = 0
            try:
                fh = open(tmp, "wb")
            except OSError as exc:
                raise _oserror(exc, dir_path)
            with fh:
                while True:
                    chunk = await body.read()
                    if not chunk:
                        break
                    fh.write(chunk)
                    size += len(chunk)
        req.body_consumed = True
        final = os.path.join(dir_path, name)
        if os.path.isdir(final):
            raise ApiError(409, "exists", detail="%s é um diretório" % final)
        try:
            os.chmod(tmp, 0o755 if name.lower().endswith(".sh") else 0o644)
            os.replace(tmp, final)
        except OSError as exc:
            raise _oserror(exc, final)
        return {"ok": True, "path": final, "size": size}
    except OSError as exc:
        raise _oserror(exc, dir_path)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


# ---------------------------------------------------------------------- exec
def exec_file(cfg, body):
    path = norm_path(body.get("path"))
    if body.get("confirm") is not True:
        raise ApiError(400, "confirmation_required")
    if not os.path.isfile(path):
        raise ApiError(404, "not_found", detail=path)
    lower = path.lower()
    parent = os.path.dirname(path) or "/"
    if lower.endswith(".deb"):
        if cfg.dev_mode:
            return {"ok": True, "returncode": 0,
                    "output": "[dev] DEBIAN_FRONTEND=noninteractive dpkg -i %s\n"
                              "Selecting previously unselected package (simulado).\n"
                              "Setting up package ... done.\n" % path}
        env = base_env({"DEBIAN_FRONTEND": "noninteractive"})
        rc, out = run_cmd(["dpkg", "-i", path], timeout=1800, env=env, cfg=cfg, isolate=True, tag="dpkg")
    elif lower.endswith(".sh"):
        rc, out = run_cmd(["bash", path], timeout=1800, cwd=parent, cfg=cfg, isolate=True, tag="sh")
    elif lower.endswith(".tar.gz") or lower.endswith(".tgz"):
        rc, out = run_cmd(["tar", "-xzf", path, "-C", parent], timeout=900)
        if rc == 0 and not out.strip():
            out = "Extraído em %s" % parent
    else:
        raise ApiError(400, "unsupported_type", detail="Suportado: .deb, .sh, .tar.gz, .tgz")
    return {"ok": rc == 0, "returncode": rc, "output": tail_text(out)}
