"""Stands in for the G2 Relay app and chatgpt.com: a broker on 127.0.0.1:8777
that answers the glasses plugin like the page would, for trying the plugin in
the EvenHub simulator without a phone.

    python3 -I tools/fake_relay.py [--port 8777] [--turns 3] [--fail]

On connect it reports the page as present. {t: "get-history"} gets --turns
canned turns; start/stop play a dictation, a transcript and a streamed reply;
new-chat answers with an empty history; list-chats gets --chats fake chats
(a scheduled-task one, one with an image reply, long titles) and open-chat
switches to one. start with another {chat} than the open one is refused
with a resync, like the page does; refresh resends the history (--stuck:
never, so the plugin falls back to {t: "reload"}). --drift switches chats
behind the glasses' back after each reply, to try the refusal. --fail makes every stop
end in an error instead. Audio frames are counted and dropped. Standard
library only.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import struct
import time

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

QUESTIONS = ["帮我想个周报标题", "下午的会改到几点了", "明天的会要准备什么", "把第二点展开说说", "总结成三句话"]
REPLY = """明天的会主要准备三样东西：
1. 上周的测试数据，特别是电池续航和蓝牙延迟两项，最好整理成一页表格。
2. 眼镜项目的进度，按"已完成、进行中、有风险"三类列出来，每类不超过三条。
3. 需要大家决定的问题，比如插件界面要不要改成三段式布局。
另外建议提前十分钟到，先把投屏调好。如果时间允许，可以准备一个两分钟的演示，让大家直接在眼镜上看到新的对话界面。"""


TITLES = ["眼镜项目周会准备", "每日新闻摘要", "插件界面要不要改成三段式布局以及菜单和翻页手势怎么设计", "画一只戴眼镜的猫",
          "下午的会改到几点了", "Python 脚本报错 UnicodeDecodeError 怎么办", "周末去哪里爬山", "电池续航测试数据整理"]


def chat(i):
    """The turns of fake chat i: 1 is a scheduled task, 3 has an image reply."""
    if i == 1:
        return [{"user": "", "reply": f"今日摘要 {d}：" + REPLY[:80], "done": True} for d in range(3)]
    if i == 3:
        return [{"user": "画一只戴眼镜的猫", "reply": "[图片]", "done": True}]
    return canned(2 + i % 3)


def log(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def canned(n):
    return [{"user": QUESTIONS[i % len(QUESTIONS)], "reply": REPLY if i % 2 else REPLY[:60], "done": True} for i in range(n)]


async def ws_send(writer, opcode, payload=b""):
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 127, n)
    writer.write(head + payload)
    await writer.drain()


async def ws_messages(reader, writer):
    """Yields (opcode, payload) for complete text/binary messages."""
    buf, buf_op = bytearray(), None
    while True:
        b1, b2 = await reader.readexactly(2)
        fin, op = b1 & 0x80, b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            (n,) = struct.unpack("!H", await reader.readexactly(2))
        elif n == 127:
            (n,) = struct.unpack("!Q", await reader.readexactly(8))
        mask = await reader.readexactly(4) if b2 & 0x80 else None
        data = bytearray(await reader.readexactly(n))
        if mask:
            for i in range(n):
                data[i] ^= mask[i & 3]
        if op == 0x8:
            await ws_send(writer, 0x8, bytes(data[:2]))
            return
        if op == 0x9:
            await ws_send(writer, 0xA, bytes(data))
            continue
        if op == 0xA:
            continue
        if op in (0x1, 0x2):
            buf, buf_op = bytearray(), op
        buf += data
        if fin:
            yield buf_op, bytes(buf)


class Page:
    """The fake chatgpt.com side of one glasses connection."""

    def __init__(self, writer, args):
        self.w, self.args = writer, args
        self.turns = canned(args.turns)
        self.chat = 0
        self.frames = 0
        self.task = None

    async def send(self, **msg):
        await ws_send(self.w, 0x1, json.dumps(msg, ensure_ascii=False).encode())

    def chat_id(self):
        return f"fake-{self.chat}" if self.turns else None

    async def history(self, why):
        chat = self.chat_id()
        title = TITLES[self.chat % len(TITLES)] if self.turns else "ChatGPT"
        await self.send(t="history", why=why, chat=chat, title=title, turns=self.turns)

    async def answer(self):
        await self.send(t="status", s="finishing")
        await asyncio.sleep(0.4)
        await self.send(t="status", s="transcribing")
        await asyncio.sleep(0.8)
        if self.args.fail:
            return await self.send(t="status", s="error", error="send button not found or disabled")
        question = QUESTIONS[len(self.turns) % len(QUESTIONS)]
        await self.send(t="transcript", text=question)
        await self.send(t="status", s="sent")
        await asyncio.sleep(1.2)
        for i in range(0, len(REPLY), 12):
            await self.send(t="reply", n=len(self.turns) + 1, text=REPLY[: i + 12], done=False)
            await asyncio.sleep(0.25)
        self.turns.append({"user": question, "reply": REPLY, "done": True})
        await self.send(t="reply", n=len(self.turns), text=REPLY, done=True, reason="complete", chat=self.chat_id())
        if self.args.drift:
            self.chat = (self.chat + 1) % self.args.chats
            self.turns = chat(self.chat)
            log(f"drifted to fake-{self.chat} without telling the glasses")

    async def on(self, msg):
        t = msg.get("t")
        log(f"glasses → {msg}")
        if t == "get-history":
            await self.history("asked")
        elif t == "list-chats":
            await asyncio.sleep(0.6)
            chats = [{"id": f"fake-{i}", "title": TITLES[i % len(TITLES)], "current": bool(self.turns) and i == self.chat} for i in range(self.args.chats)]
            await self.send(t="chats", chats=chats)
        elif t == "open-chat":
            i = int(str(msg.get("id", "fake-0")).split("-")[-1])
            if i >= self.args.chats:
                return await self.send(t="status", s="error", error="chat not found in the sidebar")
            self.chat, self.turns = i, chat(i)
            await asyncio.sleep(1.0)
            await self.history("open-chat")
        elif t == "new-chat":
            self.turns = []
            await asyncio.sleep(0.5)
            await self.history("new-chat")
        elif t == "start":
            if "chat" in msg and msg["chat"] != self.chat_id():
                await self.send(t="status", s="error", error="page shows another chat")
                return await self.history("resync")
            self.frames = 0
            await asyncio.sleep(0.3)
            await self.send(t="status", s="listening")
        elif t == "stop":
            log(f"{self.frames} audio frames")
            self.task = asyncio.create_task(self.answer())
        elif t == "refresh":
            if not self.args.stuck:
                await asyncio.sleep(0.5)
                await self.history("refresh")
        elif t == "reload":
            log("reload asked: the app would reload chatgpt.com")
            await self.history("asked")
        elif t == "cancel":
            await self.send(t="status", s="idle", why="cancel")


async def handle(reader, writer, args):
    raw = await reader.readuntil(b"\r\n\r\n")
    lines = raw.decode("latin-1").split("\r\n")
    path = lines[0].split(" ")[1]
    headers = {k.strip().lower(): v.strip() for k, v in (l.split(":", 1) for l in lines[1:] if ":" in l)}
    accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + WS_GUID).encode()).digest()).decode()
    writer.write(f"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n".encode())
    await writer.drain()
    log(f"connected {path}")
    page = Page(writer, args)
    await page.send(t="peer", glasses=True, page=True)
    try:
        async for op, data in ws_messages(reader, writer):
            if op == 0x2:
                page.frames += 1
            else:
                await page.on(json.loads(data))
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    log("disconnected")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--turns", type=int, default=3)
    ap.add_argument("--chats", type=int, default=13)
    ap.add_argument("--fail", action="store_true")
    ap.add_argument("--stuck", action="store_true")
    ap.add_argument("--drift", action="store_true")
    args = ap.parse_args()
    server = await asyncio.start_server(lambda r, w: handle(r, w, args), "127.0.0.1", args.port)
    log(f"fake relay on 127.0.0.1:{args.port}")
    async with server:
        await server.serve_forever()


asyncio.run(main())
