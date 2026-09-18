# dsh-paste-path（目录 / .app 的绝对路径注入）

给 DeepSeek Harness (DSH) Web 补上官方做不到的那一格：**目录和 macOS `.app` 没法当附件上传**，
于是把它们变成输入框里的一行绝对路径。

## 设计原则（2026-09-17 定稿）

> **DSH 原生做得到的，交给原生；做不到的，只把路径作为一行文本插进输入框。**

不画卡片，不接管发送，不碰编辑器私有 API。

### 我们只管两类东西

| 拖进来的东西 | 谁来处理 | 结果 |
|---|---|---|
| 图片（PNG/JPG/WEBP/GIF…） | **官方原生** | 走多模态看图 |
| 有扩展名的普通文件（`.md` `.mp4` `.mov` `.pdf` `.zip` …） | **官方原生** | 上传字节 → 存只读副本 → 给模型一行保存路径 |
| **目录** | **本插件** | 输入框里多一行绝对路径 |
| **macOS 包（`.app` / `.screenstudio` / `.fcpbundle` / `.rtfd` / `.xcodeproj` …）** | **本插件** | 输入框里多一行绝对路径 |

为什么只有后两类归我们：在文件系统里它们**就是目录**。浏览器只能对「普通文件」
取字节流，对目录取字节会直接 `EISDIR` 失败。所以官方那条上传链路对它们永远走不通，
而路径是能拿到的——**只传路径，不传字节**。

⚠️ **macOS 的「包（bundle）」是最容易漏的一类。** 它们在 Finder 里看着像一个文件
（有的还有自己的图标和种类名），底层却是目录。实测踩过：`Area ….screenstudio`
（Screen Studio 工程）因为没被认出来，被当成普通文件丢给官方 → 官方取目录字节流失败
→ **该文件凭空消失**（不弹卡片、也不报错）。所以判据里显式维护了一张
macOS 包扩展名表（`MACOS_BUNDLE_EXTENSIONS`）。

**判据取向**：宁可误判成目录，也不要误判成文件。
- 误判成目录 → 结果是「多一行路径」，模型照样能读，**无害**；
- 误判成文件 → 结果是「官方读目录失败」，用户看到东西**凭空消失**，有害。

所以那张表只收「确定是包」的扩展名；`.lnk`（Windows 快捷方式，是普通文件）这类绝不能进去。

### 混合拖拽：一次拖拽里的文件会被精确分流

从访达一次选中「图片 + 文件夹 + 视频」拖进来时，**不会二选一**：

| 拖进来的 | 归属 | 结果 |
|---|---|---|
| 图片、带扩展名的普通文件 | 官方 | 照常显示成原生附件卡片 |
| 目录、`.app` | 本插件 | 输入框里各占一行绝对路径 |

做法：官方附件组件在 **`document` 冒泡阶段**监听 `drop`，只读 `event.dataTransfer.files`
且**不检查 `isTrusted`**（源码已确认）。所以插件在 `window` 捕获阶段先拦下整次拖拽，
把目录/.app 处理掉，再用一个**只含官方文件的新 `DataTransfer`** 补发一次 `drop`。

⚠️ 补发时**绝不能把原始 `DataTransfer` 整个递过去**——它里面还带着目录，
官方拿到后会去读目录的字节流（`EISDIR`）并弹红框「上传失败」。
这一点是实测抓出来的：第一版就是递了原始对象，测试页里直接看到官方收到了目录。

另外，拖拽过程中的 `dragenter` / `dragover` / `dragleave` **不做拦截**，
这样 DSH 官方的拖拽高亮与蒙层能正常显示；插件只在 `drop` 那一刻精确介入。

### 插入规则

- 每条路径**独占一行**；
- 已经存在的路径**不再追加**（一次拖拽会经由多个入口各触发一次，必须去重）；
- 路径统一**收拢到输入框末尾**，用户自己的文字留在上面，中间恰好一个空行；
- 插完把光标放到最后，用户接着打字就落在路径后面。

## 用法

1. **拖拽**：从访达把文件夹或 `.app` 拖进输入框 → 该行出现绝对路径。
2. **📎 文件选择器**：选中 `.app` 时同样会转成路径行（选择器选不了目录，系统限制）。
3. **⌘⇧V / Ctrl+Shift+V**：先在访达 `Cmd+C` 复制，再按这个快捷键，兜底粘路径。

## 必须记住的实现约定

这些都是**实测踩出来的**，改错任何一条整个功能就静默失效。
`test/client.test.js` 里有测试专门守着它们，不要为了「写得漂亮」而绕过。

### 一、DSH 的输入框是 Lexical，真换行只能靠编辑器 API

DSH 用的是 **Lexical 0.49 + `@lexical/plain-text`**。在真实环境里逐条实测（见
`test/manual/lexical-e2e.html`），**只有编辑器 API 能产生真换行**：

| 通道 | 结果 |
|---|---|
| `execCommand('insertText', false, "A\nB")` | ❌ 被 Lexical 回灌成**字面 `\n`**，显示成空格 |
| `execCommand('insertText')` + `insertLineBreak` | ❌ 换行被丢弃，路径挤成一行 |
| 派发 `beforeinput`（`insertText` / `insertLineBreak`） | ❌ 被 Lexical 接管，DOM 通道无效 |
| `execCommand('insertHTML', "A<br>B")` | ❌ 无效 |
| `insertFromPaste` / `paste` 事件（含 `text/html`） | ❌ 被拒绝 |
| **编辑器 API：`insertParagraph()` + `insertText()`** | ✅ **真正的独立段落** |

所以插入**必须**优先走 `insertViaLexical()`，通用 DOM 通道只作为非 Lexical 环境的回落。

### 二、只能借用两个内部字段，且必须是 `_pendingEditorState`

Lexical 的辅助函数（`$getRoot` / `$getSelection` / `$isRangeSelection`）在**模块作用域**里，
插件既 `import` 不到、伪全局也拿不到（实测全是 `undefined`）。可用的只有：

- `el.__lexicalEditor` —— 编辑器实例（Lexical 自己挂在可编辑元素上的）
- `editor._pendingEditorState` —— `{ _nodeMap, _selection }`，**当前待提交状态**

⚠️ 必须用 `_pendingEditorState`，**不能**用 `editor.getEditorState()`：后者在一次更新事务内
拿到的是**上一次提交的旧状态**，节点位置会错（实测踩过，"路径插到文字前面去了"）。

之后所有操作都走节点/选区的公开方法：`getLastChild` / `getTextContent` /
`selectEnd` / `insertParagraph` / `insertText`。

### 三、前端**拿不到**拖入项的绝对路径，必须靠服务端找回来

这是个硬限制，不是 bug：

```
JackDSH 的 main/index.js:
  nodeIntegration: false      ← renderer 拿不到 node
  contextIsolation: true      ← 插件也拿不到 electron 模块
  preload.cjs 只暴露了 jackdshNative { 窗口缩放、Dock 角标 }
Electron 又移除了 File.path
```

所以插件在**纯前端层面永远拿不到**拖入目录 / `.app` / 包的绝对路径。
（真机日志证据：拖入 `.screenstudio` 与 `暂存` 时 `hasPath: false, path: null`。）

补回来的唯一位置是**同机运行的服务端**：它能直接读文件系统。
`fallbackFindPath` 分三级：

1. **`fastFindByName`**：在常见目录（下载 / 桌面 / 文稿 / 影片 / 图片 / 音乐 / iCloud Drive /
   应用程序目录…）按名字找，向下两层。实测 `.screenstudio` **86ms**、`暂存` **11ms** 命中。
2. `.app` 再确认一遍标准应用目录。
3. `mdfind` 兜底，并对候选排序（精确同名优先、路径浅的优先）。

⚠️ **只靠 `mdfind` 是不够的**：实测 `mdfind -name "Area …19:27:28.screenstudio"` 对
「下载」里没被 Spotlight 索引的目录是**零命中**；而 `mdfind -name 暂存` 有 18 条命中，
真路径埋在里面（目录不是普通文件，无法用体积比对筛）。所以第 1 级才是主力。

> 想彻底根治，需要在 JackDSH 的 `preload.cjs` 里用 `webUtils.getPathForFile(file)`
> 把真实路径暴露给前端。那是改 App 壳（要重新打包），插件侧已用服务端解析兜住。

### 四、`innerText` 读、去空白比对

- **读内容用 `innerText`**，不能用 `textContent`：contenteditable 里的换行是 `<br>`，
  而 `textContent` 不把 `<br>` 当字符——会把所有行黏成一行，去重与校验全部失效。
- **比对时去掉所有空白**（不是压成空格）：`innerText` 会把超长路径按视觉折行插进换行符，
  严格逐字符比较必然误判；压成空格则会让折行后的路径仍然对不上。
- Lexical 末尾天然留一个空段落，插入时**复用它**当分隔，不要再叠一层，否则多出空行。

## 后端路由

| 路由 | 作用 |
|---|---|
| `POST /dsh-paste-path/paste` | 读系统剪贴板里的文件路径（AppleScript + `NSPasteboard`） |
| `POST /dsh-paste-path/resolve-drop` | 浏览器环境按文件名还原绝对路径（剪贴板优先，再 `mdfind`） |
| `GET /dsh-paste-path/peek` | 探测剪贴板是否已有可用路径 |

全部仅限 127.0.0.1 回环访问，且变更类请求要求同源。

## 开发

```sh
npm run pack    # 改完 client/app.js 或 client/ui.css 后必须执行
npm test        # 打包 + 语法检查 + 纯逻辑单测
npm run probe   # 重新生成 test/manual/probe-lib.js
```

### 验证分三层

```sh
npm run probe
cd test/manual && python3 -m http.server 8899
```

**第一层：纯逻辑单测**（`test/client.test.js`）——路径判定、去重、插入规划。
只测不依赖 DOM 的纯函数。

**第二层：通用 DOM 行为实测**（`http://127.0.0.1:8899/probe.html`，8 个场景）。
验证 DOM 回落通道：空框连插、重复拖拽、超长带空格路径、文字在上、旧路径在前、
同批去重、清空后重插、光标落位。

**混合拖拽分流实测**（`http://127.0.0.1:8899/mixed-drag.html`）。
页面上装了一个与官方完全同构的 document 级 drop 监听器，然后派发一次
「图片 + 两个文件夹 + txt + mov」的真实 `DataTransfer` 拖拽，校验：
目录归插件且各占一行、图片/txt/mov 归官方、**目录没有混进官方**。

**第三层：真实 Lexical 端到端实测**（`http://127.0.0.1:8899/lexical-e2e.html`）
—— **这才是 DSH 里的行为真相**。它用**本机 DSH 自带的同一份 Lexical 0.49 +
plain-text**（构建时软链，不拷进仓库）跑**插件打包产物本体**，并额外校验
「编辑器模型状态与 DOM 一致」，防止出现「看着对、其实没进模型」。

> ⚠️ **不要用 DOM 桩去测插入行为。** 本项目试过：桩里全绿，真实 Chromium 里
> 路径根本插不进去——桩把最关键的行为假造了，反而给出错误的安全感。
> 同理，**光看屏幕上有字也不算通过**，必须同时校验编辑器模型状态。

### 调试接口

浏览器控制台可用 `window.__dshPastePath__`：

```js
__dshPastePath__.insert('/Applications/时钟.app')  // 插一行
__dshPastePath__.composerText()                    // 读输入框真实内容
__dshPastePath__.managedPaths()                    // 插件登记过的路径
__dshPastePath__.reset()                           // 清空插件记账
```
