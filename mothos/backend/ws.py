"""Minimal RFC 6455 WebSocket server implementation on asyncio streams."""
import asyncio
import base64
import hashlib
import json
import struct

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

MAX_MESSAGE = 4 * 1024 * 1024


def accept_key(key):
    digest = hashlib.sha1((key.strip() + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def _unmask(data, mask):
    n = len(data)
    if not n:
        return data
    m = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")


def encode_frame(opcode, payload, fin=True, mask=None):
    head = bytearray()
    head.append((0x80 if fin else 0) | opcode)
    n = len(payload)
    mbit = 0x80 if mask else 0
    if n < 126:
        head.append(mbit | n)
    elif n < 65536:
        head.append(mbit | 126)
        head += struct.pack("!H", n)
    else:
        head.append(mbit | 127)
        head += struct.pack("!Q", n)
    if mask:
        head += mask
        payload = _unmask(payload, mask)
    return bytes(head) + payload


def is_upgrade(req):
    return ("websocket" in req.headers.get("upgrade", "").lower()
            and "upgrade" in req.headers.get("connection", "").lower())


class WebSocketClosed(Exception):
    pass


class WebSocket(object):
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.closed = False
        self.close_code = None
        self._send_lock = asyncio.Lock()

    async def _read_frame(self):
        head = await self.reader.readexactly(2)
        fin = bool(head[0] & 0x80)
        opcode = head[0] & 0x0F
        masked = bool(head[1] & 0x80)
        n = head[1] & 0x7F
        if n == 126:
            n = struct.unpack("!H", await self.reader.readexactly(2))[0]
        elif n == 127:
            n = struct.unpack("!Q", await self.reader.readexactly(8))[0]
        if n > MAX_MESSAGE:
            raise WebSocketClosed("frame too large")
        mask = await self.reader.readexactly(4) if masked else None
        payload = await self.reader.readexactly(n) if n else b""
        if mask:
            payload = _unmask(payload, mask)
        return fin, opcode, payload

    async def recv(self):
        """Return next text (str) or binary (bytes) message, or None on close."""
        if self.closed:
            return None
        buf = bytearray()
        msg_op = None
        try:
            while True:
                fin, opcode, payload = await self._read_frame()
                if opcode == OP_PING:
                    await self._send(OP_PONG, payload)
                    continue
                if opcode == OP_PONG:
                    continue
                if opcode == OP_CLOSE:
                    code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                    self.close_code = code
                    await self.close(1000 if code == 1005 else code)
                    return None
                if opcode in (OP_TEXT, OP_BINARY):
                    msg_op = opcode
                    buf = bytearray(payload)
                elif opcode == OP_CONT and msg_op is not None:
                    buf += payload
                else:
                    await self.close(1002)
                    return None
                if len(buf) > MAX_MESSAGE:
                    await self.close(1009)
                    return None
                if fin:
                    if msg_op == OP_TEXT:
                        return bytes(buf).decode("utf-8", "replace")
                    return bytes(buf)
        except (asyncio.IncompleteReadError, ConnectionError, WebSocketClosed, OSError):
            self.closed = True
            return None

    async def _send(self, opcode, payload):
        if self.closed and opcode != OP_CLOSE:
            raise WebSocketClosed("closed")
        async with self._send_lock:
            try:
                self.writer.write(encode_frame(opcode, payload))
                await self.writer.drain()
            except (ConnectionError, OSError, RuntimeError):
                self.closed = True
                raise WebSocketClosed("connection lost")

    async def send_text(self, text):
        await self._send(OP_TEXT, text.encode("utf-8"))

    async def send_json(self, obj):
        await self.send_text(json.dumps(obj, separators=(",", ":")))

    async def close(self, code=1000, reason=""):
        if self.closed:
            return
        try:
            await self._send(OP_CLOSE, struct.pack("!H", code) + reason.encode("utf-8")[:120])
        except WebSocketClosed:
            pass
        self.closed = True


async def accept(req):
    """Complete the handshake. Returns WebSocket or raises ValueError."""
    key = req.headers.get("sec-websocket-key")
    if not key or not is_upgrade(req):
        raise ValueError("not a websocket upgrade")
    lines = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Accept: " + accept_key(key),
    ]
    req.writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
    await req.writer.drain()
    return WebSocket(req.reader, req.writer)
