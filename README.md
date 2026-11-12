# G2 ChatGPT Relay

在 Even Realities G2 眼镜上用语音和 ChatGPT 对话：对着眼镜说话，ChatGPT 的文字回复显示在眼镜上。

*Talk to ChatGPT from Even Realities G2 glasses: speak into the glasses, read the reply on the lenses. It drives the chatgpt.com web page you are logged into on your own Android phone (ChatGPT's own dictation, your own account), so no API key is needed. Personal project, Android only; the docs are in Chinese.*

> **这是一个自用项目。** 眼镜插件没有在 Even Hub 上架，作者只把它作为私有测试版装在自己的账号上。代码按原样公开，不提供支持。
>
> **风险提示：** 这个项目通过脚本操作 chatgpt.com 网页（点击听写、发送，再读取回复）。OpenAI 的使用条款不允许用程序自动提取输出，风险由所用的 ChatGPT 账号承担，最坏情况是封号。建议只在自己需要时使用，不要拿它做全天自动对话。

## 它做什么

- **用 ChatGPT 自己的语音识别**：眼镜麦克风录下的声音送进 chatgpt.com 的「听写」功能，转成文字后发出。说出去的话和回复都留在你的 ChatGPT 聊天记录里，和在手机上手动打字没有区别。
- **在眼镜上看整段对话**：状态行显示当前对话和轮次，正文是对话记录（你说的话以 `›` 开头，下面是回复），回复流式显示，上下滑动翻页。
- **在眼镜上管理对话**：新建对话、列出 ChatGPT 侧边栏里最近的对话并切换过去，切换后显示这段对话最近几轮的记录。
- **只有文字**：不播放语音，也不使用 ChatGPT 的高级语音模式。

## 工作原理

```
G2 眼镜麦克风 ──BLE──▶ Even App 里的眼镜插件（plugin/）
                          │  ws://127.0.0.1:8777  16 kHz PCM 音频 + JSON 指令
                          ▼
                     G2 Relay App（android/），在同一台手机上
                       ├─ WebSocket 中转，只监听本机回环地址
                       └─ GeckoView 浏览器，里面是你登录的 chatgpt.com
                            内置扩展：把音频当成麦克风输入 → 点听写 → 点发送
                                      → 从网页读出回复文字
                          │
                          ▼
                     回复文字原路回到插件，显示在眼镜上
```

由两部分组成，都要装：

| 部分 | 运行在 | 作用 |
|---|---|---|
| 眼镜插件 `plugin/` | 手机上的 Even Realities App（Even Hub 插件，包名 `com.g2codeterminal.chatrelay`） | 采集眼镜麦克风的声音，显示对话，处理眼镜上的手势 |
| G2 Relay App `android/` | 同一台 Android 手机（包名 `com.g2codeterminal.relay`） | 内置 GeckoView 浏览器打开 chatgpt.com，内置扩展负责听写、发送和读取回复；前台服务让它在后台和锁屏时也能工作 |

插件和 App 之间只走手机内部的 `127.0.0.1:8777`，不经过任何外部服务器。

## 需要什么

- Even Realities G2 眼镜，以及装了 Even Realities App（2.2.10 或更新）的 **Android** 手机。本项目只做了 Android 版，不支持 iPhone。
- 一个 ChatGPT 账号，需要能用**邮箱加密码**登录。App 里的浏览器不支持用 Google 账号登录。
- 构建需要：
  - App：JDK 21 和 Android SDK（编译用 API 37.2，GeckoView 159 要求）；
  - 插件：Node.js 和 npm。

## 安装

### 1. G2 Relay App

可以从 [Releases](../../releases) 下载 `g2-relay-*.apk` 直接安装（debug 签名，只支持 arm64 手机）。也可以自己构建：

```bash
export JAVA_HOME=<JDK 21>  ANDROID_HOME=<Android SDK>
scripts/android.sh install    # 构建并用 adb 安装到 USB 连接的手机
```

### 2. 眼镜插件

Even App 只能安装来自 Even Hub 的插件，Releases 里的 `.ehpk` 不能直接装到手机上，所以有两种方式：

**方式一：开发模式（最简单）。** 电脑和手机连同一个网络：

```bash
cd plugin
npm install
npm run dev     # 开发服务器，端口 5173
npm run qr      # 另开一个终端：显示二维码
```

先用 Even 账号登录 <https://hub.evenrealities.com>，再彻底关掉并重新打开 Even App，Even Hub 页右上角会出现扫码入口，扫这个二维码就会从电脑加载插件。这种方式下电脑必须一直开着开发服务器。

**方式二：装成自己的私有测试版（脱离电脑使用）。** 先把 `plugin/app.json` 里的 `package_id` 改成你自己的、全局唯一的名字，然后：

```bash
cd plugin
npm install
npm run pack                    # 生成 chatrelay.ehpk
npx evenhub login               # 用 Even 账号登录，只需一次
npx evenhub create chatrelay.ehpk --name "<名称>" --tagline "<一句话>" --icon icon.png
npx evenhub testers add <你的 Even 账号邮箱> --package-id <你的 package_id>
npx evenhub promote <版本号> --to beta --package-id <你的 package_id>
```

上传的版本默认是 Private，只有加为测试者的账号能在 Even App 的 Even Hub 页里看到并安装。以后更新时，先改 `app.json` 里的版本号，再执行 `npm run pack`、`npx evenhub upload chatrelay.ehpk -m "<更新说明>"` 和 `promote`。

## 使用

### 第一次设置

1. 打开 G2 Relay，在里面登录 chatgpt.com。
2. 点「后台运行」，允许它忽略电池优化，否则锁屏后可能被系统停掉。
3. 在 Even App 里打开插件。App 顶部显示「眼镜 ✓ 页面 ✓」就是连好了。

之后 G2 Relay 可以留在后台或锁屏，插件仍然能用。如果插件提示「页面音频没激活」，在手机上点一下 G2 Relay 里的 chatgpt.com 页面就行。

### 眼镜上的操作

| 手势 | 作用 |
|---|---|
| 按住 | 说话，松开就发送 |
| 说话时双击 | 取消这次说话 |
| 上滑 / 下滑 | 翻看对话记录 |
| 双击 | 打开菜单 |
| 单击 | 不做任何事，免得误触开始说话 |

菜单（滑动选择，单击执行，双击返回）：

| 菜单项 | 作用 |
|---|---|
| 新对话 | 在 ChatGPT 里开一个新对话 |
| 历史对话 | 列出 ChatGPT 侧边栏里最近的对话（一页 8 个），选一个就切换过去；`●` 标出当前对话 |
| 退出 | 关闭插件（眼镜上会先确认） |
| 跳到最新一轮 / 回到开头 | 只移动眼镜上的显示位置 |
| 返回 | 回到对话 |

状态行会显示正在做什么：`● 听写中`、`… 转写中`、`▶ 输出中`、`■ 第 N 轮完成`，以及出错原因。

## 已知限制

- **依赖 chatgpt.com 的页面结构。** 扩展靠按钮文字和页面元素找到听写、发送和回复。ChatGPT 改版后可能失效，需要更新 `android/app/src/main/assets/relay/` 里的脚本。
- 切换到历史对话后，只能看到最近大约 5 轮，因为网页只加载这么多，更早的要往上滚动才会出现。
- 中转服务没有身份验证：同一台手机上的其他 App 也能连上 `127.0.0.1:8777`，向登录着的 chatgpt.com 页面发指令。只在你信任手机上已装 App 的情况下使用。
- App 是 debug 签名，只打包了 arm64 版本。

## 目录

| 路径 | 内容 |
|---|---|
| `plugin/` | 眼镜插件（TypeScript，Even Hub SDK 0.0.16） |
| `android/` | G2 Relay App（Kotlin，GeckoView 159） |
| `android/app/src/main/assets/relay/` | 注入 chatgpt.com 的扩展：合成麦克风、听写和发送、读取回复和对话列表 |
| `scripts/android.sh` | 构建、安装 App，看日志 |
| `tools/fake_relay.py` | 在电脑上假扮 G2 Relay 和 chatgpt.com，配合 Even Hub 模拟器调试插件界面 |
| `tools/fake_glasses.py` | 在电脑上假扮眼镜：推一段 WAV 给 App，或发调试命令 |
| `docs/可行性报告.md` | 可行性调研，以及各项实验的结果 |
| `docs/界面改造方案.md` | 眼镜界面的设计和实施记录 |

### 调试

不用手机调插件界面（需要 Even Hub 模拟器，`npm install` 已经装好）：

```bash
python3 -I tools/fake_relay.py   # 假的 App，监听 127.0.0.1:8777
cd plugin && npm run dev         # 另开一个终端
cd plugin && npm run simulate    # 再开一个终端：模拟器窗口
```

从电脑查看手机上 App 的状态：

```bash
adb forward tcp:8787 tcp:8777
python3 -I tools/fake_glasses.py --broker 127.0.0.1:8787 --cmd inspect
scripts/android.sh logs          # App 和页面的日志
```
