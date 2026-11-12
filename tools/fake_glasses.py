"""Stands in for the Even plugin: streams a WAV as live 50 ms frames, prints what comes back.

    python3 -I tools/fake_glasses.py samples/zh.wav [--broker 127.0.0.1:8777] [--cmd inspect]

The WAV must be 16 kHz mono 16-bit. Against the phone app, first run
`adb forward tcp:8787 tcp:8777` and pass --broker 127.0.0.1:8787.
With --cmd it connects as role=ctl instead, sends one command such as
inspect, and prints replies for a few seconds.
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys
import time
import wave

FRAME = 800  # samples per frame = 50 ms, like the real glasses


class WS:
    def __init__(self, host, port, path):
        self.s = socket.create_connection((host, port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.s.sendall(
            f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        head = b""
        while b"\r\n\r\n" not in head:
            head += self.s.recv(1)
        assert b" 101 " in head.split(b"\r\n")[0], head
        self.buf = b""

    def send(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        head = struct.pack("!B", 0x80 | opcode)
        if n < 126:
            head += struct.pack("!B", 0x80 | n)
        elif n < 65536:
            head += struct.pack("!BH", 0x80 | 126, n)
        else:
            head += struct.pack("!BQ", 0x80 | 127, n)
        self.s.sendall(head + mask + bytes(b ^ mask[i & 3] for i, b in enumerate(payload)))

    def send_json(self, obj):
        self.send(0x1, json.dumps(obj).encode())

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, timeout):
        """Returns (opcode, payload) or None on timeout."""
        self.s.settimeout(timeout)
        try:
            b1, b2 = self._read(2)
        except (socket.timeout, BlockingIOError):
            return None
        n = b2 & 0x7F
        if n == 126:
            (n,) = struct.unpack("!H", self._read(2))
        elif n == 127:
            (n,) = struct.unpack("!Q", self._read(8))
        self.s.settimeout(None)
        return b1 & 0x0F, self._read(n)


def show(t0, data):
    msg = json.loads(data)
    if msg.get("t") == "reply":
        text = msg["text"]
        if msg.get("done"):
            print(f"{time.monotonic() - t0:6.2f}s reply DONE ({msg.get('reason')}), {len(text)} chars:\n{text}\n")
        else:
            print(f"{time.monotonic() - t0:6.2f}s reply {len(text)} chars")
    else:
        print(f"{time.monotonic() - t0:6.2f}s {json.dumps(msg, ensure_ascii=False)[:600]}")
    return msg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav", nargs="?")
    ap.add_argument("--broker", default="127.0.0.1:8777")
    ap.add_argument("--cmd")
    ap.add_argument("--json", help="extra JSON fields for --cmd")
    ap.add_argument("--timeout", type=float, default=90)
    a = ap.parse_args()
    host, port = a.broker.split(":")
    t0 = time.monotonic()
    if a.cmd:
        ws = WS(host, int(port), "/?role=ctl")
        ws.send_json({"t": a.cmd, **(json.loads(a.json) if a.json else {})})
        end = time.monotonic() + 5
        while time.monotonic() < end:
            m = ws.recv(0.5)
            if m and m[0] == 0x1:
                msg = json.loads(m[1])
                if msg.get("t") != "peer":
                    print(json.dumps(msg, ensure_ascii=False, indent=1))
        return

    w = wave.open(a.wav)
    assert (w.getframerate(), w.getnchannels(), w.getsampwidth()) == (16000, 1, 2), "need 16 kHz mono s16"
    pcm = w.readframes(w.getnframes())
    ws = WS(host, int(port), "/?role=glasses")
    # wait for the peer notice that says the page is there
    while True:
        m = ws.recv(5)
        if m is None:
            sys.exit("no peer notice from broker")
        if m[0] == 0x1 and json.loads(m[1]).get("t") == "peer":
            if not json.loads(m[1]).get("page"):
                sys.exit("page not connected to broker")
            break
    print(f"{time.monotonic() - t0:6.2f}s start, streaming {len(pcm) / 32000:.2f} s")
    ws.send_json({"t": "start"})
    start = time.monotonic()
    for i, off in enumerate(range(0, len(pcm), FRAME * 2)):
        ws.send(0x2, pcm[off : off + FRAME * 2])
        lag = start + (i + 1) * FRAME / 16000 - time.monotonic()
        if lag > 0:
            time.sleep(lag)
        while (m := ws.recv(0.001)) is not None:
            show(t0, m[1])
    stop_at = time.monotonic()
    ws.send_json({"t": "stop"})
    print(f"{time.monotonic() - t0:6.2f}s stop")
    first = None
    while time.monotonic() - stop_at < a.timeout:
        m = ws.recv(1)
        if m is None or m[0] != 0x1:
            continue
        msg = show(t0, m[1])
        if msg.get("t") == "reply" and msg.get("text") and first is None:
            first = time.monotonic() - stop_at
            print(f"        first reply text {first:.2f} s after stop")
        if msg.get("t") == "reply" and msg.get("done"):
            print(f"        done {time.monotonic() - stop_at:.2f} s after stop")
            return
        if msg.get("t") == "status" and msg.get("s") == "error":
            sys.exit(1)
    sys.exit("timed out")


if __name__ == "__main__":
    main()
