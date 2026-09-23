window.__ModuleLoader__.load({
  id: 'dsh-paste-path',
  factory: (require) => {
    const module = { exports: {} }
    const css = "/* Toast 提示 */\n.dshpp-toast {\n  position: fixed;\n  right: 20px;\n  bottom: 84px;\n  max-width: 420px;\n  padding: 8px 14px;\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-3, #1e293b);\n  color: var(--dsw-alias-label-primary, #f8fafc);\n  font-size: 12px;\n  line-height: 18px;\n  pointer-events: none;\n  box-shadow: var(--dsw-shadow-lv3, 0 10px 15px -3px rgba(0, 0, 0, 0.3));\n  z-index: 1000;\n  animation: dshppFadeIn 150ms ease;\n  word-break: break-all;\n}\n\n.dshpp-toast.is-error {\n  background: #dc2626;\n  color: #ffffff;\n}\n\n/* 拖拽时输入框高亮（用 .dshpp-drag-over 类名，不依赖 data 属性的取值形式） */\n.dshpp-drag-over {\n  border-color: var(--dsw-alias-brand-primary, #2563eb) !important;\n  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.3) !important;\n  transition: all 120ms ease;\n}\n\n/* 隐藏原生可能弹出的全屏阻断蒙层 */\ndiv[role=\"status\"]:has(> div[class*=\"illustration\"]),\ndiv[class*=\"_mask\"]:has(div[class*=\"_illustration\"]),\ndiv[class*=\"BInVoG_mask\"] {\n  display: none !important;\n  opacity: 0 !important;\n  pointer-events: none !important;\n}\n\n@keyframes dshppFadeIn {\n  from { opacity: 0; transform: translateY(4px); }\n  to { opacity: 1; transform: translateY(0); }\n}\n"
    if (typeof document !== 'undefined') {
      const id = 'dsh-paste-path/ui.css'
      let tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(id) + ']')
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-paste-path'
        tag.dataset.pluginCss = id
        document.head.appendChild(tag)
      }
      tag.textContent = css
    }
/**
 * dsh-paste-path —— 把「目录 / macOS .app」变成输入框里的一行绝对路径。
 *
 * 设计原则（2026-09-17 定稿）：
 *   1. DSH 原生能处理的，一律交给原生，我们绝不插手。
 *      图片、以及一切有扩展名的普通文件（.md / .mp4 / .mov / .pdf / .zip …）
 *      官方 0.1.5 自带完整链路：上传字节 → 存只读副本 → 给模型一行保存路径。
 *   2. 官方做不到的只有两类：目录，和 macOS .app（本质也是目录）。
 *      浏览器只能对「普通文件」取字节流，对目录取字节必然 EISDIR 失败。
 *   3. 对这两类，我们只做一件事：把真实绝对路径插进输入框，**每条独占一行**。
 *      不画卡片、不接管发送、不碰编辑器私有 API。
 *
 * 三个关键实现细节（都是实测踩出来的，改动前务必先看 test/manual/probe.html）：
 *   - 「读内容」必须用 innerText 而不是 textContent：HTML 里换行是 <br>，
 *     textContent 不把 <br> 当字符，会把所有行黏成一行，去重与校验全部失效。
 *   - 「写内容」必须用 execCommand('insertText')：它在光标处真正改 DOM。
 *     只派发 beforeinput 在原生 DOM 上是空操作，在 DSH 里也只是碰巧被接住。
 *   - 写完必须读回校验，且比较时要折叠空白：innerText 会把超长行按视觉折行
 *     插进换行符，严格逐字符比较必然误判。
 */

const PASTE_ROUTE = "/dsh-paste-path/paste"
const DROP_ROUTE = "/dsh-paste-path/resolve-drop"
const DIAG_ROUTE = "/dsh-paste-path/diag"

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif", "heic", "heif"])
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/svg+xml",
  "image/avif",
  "image/heic",
  "image/heif",
])

/** 该名字看起来是图片吗（看 MIME 或扩展名）。 */
function isImageFile(name, type) {
  if (type && IMAGE_MIME_TYPES.has(String(type).toLowerCase())) return true
  if (name && typeof name === "string") {
    const base = String(name).split("/").pop() || ""
    const dot = base.lastIndexOf(".")
    if (dot > 0) return IMAGE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
  }
  return false
}

/**
 * macOS「包（bundle）」类扩展名：Finder 里看着像一个文件，**底层其实是目录**。
 *
 * 为什么必须显式列出：浏览器对目录取字节流会 EISDIR 失败，
 * 这类文件若被当成普通文件丢给官方，就会**静默消失**（不弹卡片、也不报错）。
 * 实测踩过：`Area ….screenstudio`（Screen Studio 工程）就是这么丢的。
 *
 * 判据取向（很重要）：**宁可误判成目录，也不要误判成文件**。
 *   - 误判成目录 → 结果是「输入框里多一行路径」，模型照样能读，无害；
 *   - 误判成文件 → 结果是「官方读目录失败」，用户看到东西凭空消失，有害。
 * 所以这张表只列「确定是包」的扩展名，`.lnk` 这类普通文件绝不能进来。
 */
const MACOS_BUNDLE_EXTENSIONS = new Set([
  // 应用与安装包
  "app", "applescript", "scpt", "workflow", "action", "prefpane", "qlgenerator", "mdimporter",
  // 设计 / 影音工程
  "screenstudio", "fcpbundle", "imovielibrary", "tvlibrary", "logicx", "band", "garageband",
  "song", "aupreset", "fcpcp", "motn", "moti", "theatre", "sparsebundle",
  // 文档 / 代码工程
  "rtfd", "xcodeproj", "xcworkspace", "playground", "sketch", "key", "numbers", "pages",
  "photoslibrary", "photolibrary", "aplibrary", "tvlibrary", "dtabase", "oo3",
  "framework", "bundle", "plugin", "kext", "vst", "component", "lproj", "pkg",
])

/** 名字是 macOS 包（底层目录）吗。 */
function isMacosBundle(name) {
  const base = String(name || "").split("/").pop() || ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0) return false
  return MACOS_BUNDLE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}

/** 名字带扩展名吗（macOS 包不算，它按目录处理）。 */
function hasFileExtension(name) {
  const base = String(name || "").split("/").pop() || ""
  if (isMacosBundle(base)) return false
  return /\.[A-Za-z0-9]{1,8}$/.test(base)
}

/**
 * 官方自己能处理吗（图片、以及一切带扩展名的普通文件）。
 *
 * 判据（与 isDirectoryLike 严格互补，两者恰好把所有文件二分开）：
 *   - 有 MIME 类型 → 官方处理
 *   - 或名字带扩展名   → 官方处理
 * 剩下的（无 MIME 且无扩展名）才是目录 / .app，归我们管。
 */
function isNativelySupported(file) {
  return !isDirectoryLike(file)
}

/**
 * 只有「目录 / .app」才归我们管。
 * 判据：以 .app 结尾；或既不是图片、MIME 又为空/octet-stream、且完全没有扩展名。
 * 有扩展名的普通文件一律放行给官方。
 */
function isDirectoryLike(file) {
  if (!file || !file.name) return false
  const name = String(file.name)
  // macOS 包（.app / .screenstudio / .fcpbundle …）底层都是目录，一律归我们。
  if (isMacosBundle(name)) return true
  if (isImageFile(name, file.type)) return false
  if (file.type && file.type !== "application/octet-stream") return false
  if (hasFileExtension(name)) return false
  return true
}

/**
 * 按 items 精确分类一次拖拽 / 粘贴里的文件。
 *
 * 为什么用 dataTransfer.items 逐项判断而不是只看 files：
 * macOS 从访达拖拽或 Cmd+C 时，dataTransfer.files 的顺序与可见顺序无关，
 * 只有 items 能按屏幕上的顺序对应到具体文件，也才能判断哪一项是目录。
 *
 * 粘贴时 webkitGetAsEntry 可能缺席（Chromium 对 clipboard 不如 drop 完整），
 * 这时退回 isDirectoryLike(file)——无扩展名 + 空 MIME 的项按目录处理。
 * getAsFile() 对目录偶尔返回 null，此时用 entry.name 凑一个占位，避免拦了事件却插不了路径。
 *
 * @returns { targets, natives } —— targets 是归我们管的目录/.app，
 *          natives 是官方能处理的图片/普通文件。
 */
function classifyTransfer(dataTransfer) {
  const targets = []
  const natives = []
  const seenT = new Set()
  const seenN = new Set()

  const take = (file, isDir) => {
    if (!file && !isDir) return
    const key = (file && file.name) || String(Math.random())
    if (isDir || (file && isDirectoryLike(file))) {
      if (seenT.has(key)) return
      seenT.add(key)
      targets.push(file)
      return
    }
    if (!file) return
    if (seenN.has(key)) return
    seenN.add(key)
    natives.push(file)
  }

  const items = dataTransfer && dataTransfer.items
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      if (item.kind !== "file") continue
      let isDir = false
      let entry = null
      if (typeof item.webkitGetAsEntry === "function") {
        entry = item.webkitGetAsEntry()
        if (entry && entry.isDirectory) isDir = true
      }
      const file = typeof item.getAsFile === "function" ? item.getAsFile() : null
      const named = file || (entry && entry.name ? { name: entry.name, type: "", size: 0 } : null)
      take(named, isDir)
    }
    return { targets, natives }
  }

  const files = Array.from((dataTransfer && dataTransfer.files) || [])
  for (const file of files) take(file, false)
  return { targets, natives }
}

/** 从一次拖拽里挑出所有目录 / .app。 */
function collectTargets(dataTransfer) {
  return classifyTransfer(dataTransfer).targets
}

/* ==========================================================================
   Toast
   ========================================================================== */
let toastTimer = null
function showToast(text, isError = false) {
  if (typeof document === "undefined") return
  let el = document.getElementById("dshpp-toast-el")
  if (!el) {
    el = document.createElement("div")
    el.id = "dshpp-toast-el"
    document.body.appendChild(el)
  }
  el.className = isError ? "dshpp-toast is-error" : "dshpp-toast"
  el.textContent = text
  el.style.display = "block"
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { if (el) el.style.display = "none" }, 3000)
}

/* ==========================================================================
   输入框：查找 / 读 / 写
   ========================================================================== */
function findComposer() {
  return (
    document.querySelector("div[data-composer-input]") ||
    document.querySelector("[data-composer-input]") ||
    document.querySelector("div[contenteditable='true']") ||
    document.querySelector("div[contenteditable]")
  )
}

function usableComposer(el) {
  if (!el) return null
  if (el.tagName === "TEXTAREA") return el
  if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return el
  return null
}

/**
 * 读输入框内容。
 * contenteditable 一律用 innerText：它会正确处理 <br> 与块级元素形成的逻辑换行。
 * （用 textContent 会把所有行黏成一行——这是本项目踩过的头号坑。）
 */
function readAll(el) {
  if (!el) return ""
  if (el.tagName === "TEXTAREA") return String(el.value || "")
  const rendered = el.innerText
  if (typeof rendered === "string" && rendered !== "") return rendered
  return String(el.textContent || "")
}

function caretToEnd(el) {
  try {
    const sel = window.getSelection()
    if (!sel) return
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  } catch {}
}

function fireInput(el) {
  try { el.dispatchEvent(new Event("input", { bubbles: true })) } catch {}
}

/**
 * 比对用的宽松归一：**去掉所有空白**。
 *
 * innerText 会把超长路径按**视觉折行**插进换行符，严格逐字符比较必然误判。
 * 这里直接抹掉空白而不是压成空格——压成空格会让
 * 「/Applications/青椒云\n电脑.app」变成「/Applications/青椒云 电脑.app」，与原文仍不相等。
 * 抹掉之后，真实换行、视觉折行、以及原文本来就没有的空白，在比较上等价。
 */
function squash(text) {
  return String(text || "").replace(/\s+/g, "")
}

/** 目标文本是否已经整段落到输入框里（忽略空白差异）。 */
function readbackMatches(actual, target) {
  const a = squash(actual)
  const t = squash(target)
  return a === t || a === t.replace(/\s+$/, "")
}

/**
 * 从输入框内容里剥掉「已知路径行」，剩下的就是用户自己打的文字。
 * 只认记账里登记过的路径，避免把用户的普通句子误当路径。
 */
function userTextOf(text) {
  const lines = String(text || "").split("\n")
  const kept = []
  for (const line of lines) {
    const t = line.trim()
    if (t !== "" && managedPaths.includes(t)) continue
    kept.push(line)
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop()
  while (kept.length > 0 && kept[0].trim() === "") kept.shift()
  return kept.join("\n")
}

/** 光标是否在输入框内容末尾。 */
function caretAtEnd(el) {
  try {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)
    if (!range.collapsed) return false
    const probe = range.cloneRange()
    probe.selectNodeContents(el)
    probe.setStart(range.endContainer, range.endOffset)
    return probe.toString() === ""
  } catch {
    return false
  }
}

/**
 * 在光标处插入一个「逻辑换行」。
 *
 * 注意：execCommand('insertText', false, "\n") 在 Chromium 里会把 \n 当成**空格**，
 * 不会产生换行——这是本项目踩过的第二个大坑（所有路径挤成一行）。
 * 真正的换行只有两条路：官方 insertLineBreak 命令，或者自己插 <br> 元素。
 */
function insertLineBreakAtCaret(el) {
  const before = readAll(el)

  try {
    if (typeof document.execCommand === "function") {
      document.execCommand("insertLineBreak")
      if (readAll(el) !== before) return true
    }
  } catch {}

  try {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const range = sel.getRangeAt(0)
    range.deleteContents()
    const br = document.createRange().createContextualFragment("<br>").firstChild
    if (!br) return false
    range.insertNode(br)
    // 末尾的 <br> 会被浏览器吞掉，补一个零宽字符再插一个 <br> 稳定结构
    const tail = document.createTextNode("\u200B")
    br.parentNode.insertBefore(tail, br.nextSibling)
    const next = document.createRange()
    next.setStart(tail, 1)
    next.collapse(true)
    sel.removeAllRanges()
    sel.addRange(next)
    fireInput(el)
    return readAll(el) !== before
  } catch {
    return false
  }
}

/**
 * 把多行文本追加到输入框末尾，**逐行写入**，每行之间用真正的换行分隔。
 *
 * 只用真正会改 DOM 的通道，并在每步之后读回确认：
 *   1. execCommand('insertText')：官方插入命令，等价于用户打字。
 *   2. beforeinput 交给编辑器自己处理（某些编辑器接管了这个事件）。
 *   3. 最后手段：直接改 DOM 再派发 input，让编辑器重新同步。
 * 返回是否真的写进去了。
 */
/**
 * 把文本追加到输入框末尾。
 *
 * 通道选择（按确定性排序，每步之后读回确认）：
 *   1. execCommand('insertText')：官方插入命令，真正在光标处改 DOM。
 *   2. beforeinput 交给编辑器自己处理（某些编辑器接管了这个事件）。
 *   3. 直接改 DOM 再派发 input，让编辑器重新同步。
 *
 * 注意：execCommand 的 insertText 会把 "\n" 当**空格**，所以换行必须单独插。
 */
function writeAtEnd(el, text, wantBlankLine) {
  if (!text) return true
  const before = readAll(el)

  if (el.tagName === "TEXTAREA") {
    el.focus()
    try { el.setSelectionRange(el.value.length, el.value.length) } catch {}
    const body = before.replace(/\s+$/, "")
    el.value = body === "" ? text : body + "\n" + text
    fireInput(el)
    return readAll(el) !== before
  }

  el.focus()
  caretToEnd(el)

  const lines = String(text).split("\n")

  // 输入框本来就有内容 → 先补换行，否则新内容会黏在上一行尾巴上。
  const hadContent = before.replace(/[\s\u200B]+/g, "") !== ""
  if (hadContent) {
    const separators = wantBlankLine ? 2 : 1
    for (let i = 0; i < separators; i += 1) insertLineBreakAtCaret(el)
  }

  let wroteAnything = false
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) insertLineBreakAtCaret(el)

    const line = lines[i]
    if (line === "") continue
    const snapshot = readAll(el)

    let done = false
    try {
      if (typeof document.execCommand === "function") {
        document.execCommand("insertText", false, line)
        done = readAll(el) !== snapshot
      }
    } catch {}

    if (!done) {
      try {
        const ev = new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: "insertText",
          data: line,
        })
        el.dispatchEvent(ev)
        fireInput(el)
        done = readAll(el) !== snapshot
      } catch {}
    }

    if (!done) {
      try {
        const sel = window.getSelection()
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0)
          range.deleteContents()
          const node = document.createTextNode(line)
          range.insertNode(node)
          const next = document.createRange()
          next.setStart(node, node.length)
          next.collapse(true)
          sel.removeAllRanges()
          sel.addRange(next)
        } else {
          el.textContent = snapshot + line
        }
        fireInput(el)
        done = readAll(el) !== snapshot
      } catch {}
    }

    if (done) wroteAnything = true
  }

  if (!wroteAnything) {
    try {
      el.textContent = before + text
      fireInput(el)
      wroteAnything = readAll(el) !== before
    } catch {}
  }

  return wroteAnything
}

/**
 * ================== Lexical 编辑器（DSH 实际用的就是这个） ==================
 *
 * 为什么必须单独处理：DSH 的输入框是 Lexical 0.49 + @lexical/plain-text。
 * 在真实环境（Lexical 0.49 + Chromium）逐条实测，**只有编辑器 API 能产生真换行**：
 *
 *   execCommand('insertText', "A\nB")            → 被 Lexical 回灌成字面 \n，不是换行
 *   execCommand('insertText') + insertLineBreak  → 换行被丢弃，两条路径挤成一行
 *   派发 beforeinput(insertText / insertLineBreak) → 被 Lexical 接管，DOM 通道无效
 *   execCommand('insertHTML', "A<br>B")          → 无效
 *   insertFromPaste / paste 事件（含 text/html） → 被拒绝
 *   编辑器 API：insertParagraph() + insertText() → ✅ 真正的独立段落
 *
 * 而 Lexical 的辅助函数（$getRoot / $getSelection）在**模块作用域**里，
 * 从插件里既 import 不到、伪全局也拿不到（实测 moduleScope 全是 undefined）。
 * 可用的只有两个内部字段（均实测确认存在且可用）：
 *   el.__lexicalEditor                 → 编辑器实例（Lexical 自己挂在可编辑元素上的）
 *   editor._pendingEditorState         → { _nodeMap, _selection }，**是当前待提交状态**
 * 注意：必须用 _pendingEditorState，不能用 editor.getEditorState()——
 * 后者在更新事务内拿到的是**上一次提交的旧状态**，位置会错（实测踩过）。
 * 之后全部调用节点/选区的公开方法：getLastChild / getTextContent / selectEnd /
 * insertParagraph / insertText。
 */

function lexicalEditorOf(el) {
  try {
    const editor = el && el.__lexicalEditor
    if (editor && typeof editor.update === "function") return editor
  } catch {}
  return null
}

/** 从待提交状态里取根节点（root 是唯一没有父节点的节点）。 */
function pendingRoot(editor) {
  try {
    const pending = editor._pendingEditorState
    if (!pending || !pending._nodeMap) return null
    for (const node of pending._nodeMap.values()) {
      if (node && typeof node.getType === "function" && node.getType() === "root") return node
    }
  } catch {}
  return null
}

/** 从待提交状态里取选区（注意：必须在改动之后重新取，否则拿到旧对象）。 */
function pendingSelection(editor) {
  try {
    const pending = editor._pendingEditorState
    return pending ? pending._selection : null
  } catch {
    return null
  }
}

/**
 * 用编辑器 API 把若干行写成独立段落。
 * @returns 成功与否（false 时由调用方回落到通用 DOM 通道）
 */
function insertViaLexical(el, lines, blankBefore) {
  const editor = lexicalEditorOf(el)
  if (!editor) return false

  let ok = false
  try {
    editor.update(() => {
      const root = pendingRoot(editor)
      if (!root) return

      const sel = pendingSelection(editor)
      if (!sel || typeof sel.insertText !== "function") return

      // 先保证光标落在「一个全新的段首」，绝不在别人那一行里续写。
      // （这比"把光标精确推到行尾"可靠：后者在模型层实测推不动。）
      //
      // Lexical 的末尾天然会留一个空段落（用户打完字、回车之后都是这样），
      // 所以这里要**复用它**当分隔，而不是再叠一层——否则文字与路径之间会多出空行。
      const last = root.getLastChild()
      const lastText = last ? String(last.getTextContent() || "") : ""
      const lastIsBlank = lastText.trim() === ""

      if (lastIsBlank) {
        // 末尾已经是空段落：有文字时它正好充当空行；没文字时它就是新段首。
        if (!blankBefore) {
          // 没有任何文字，空段落直接当路径段用
        }
      } else {
        sel.insertParagraph()
        if (blankBefore) sel.insertParagraph()
      }

      for (let i = 0; i < lines.length; i += 1) {
        if (i > 0) sel.insertParagraph()
        sel.insertText(lines[i])
      }
      ok = true
    }, { discrete: true })
  } catch {
    return false
  }

  if (ok) {
    el.focus()
    caretToEnd(el)
    fireInput(el)
  }
  return ok
}

/* ==========================================================================
   路径登记与插入规划
   ========================================================================== */
const RECENT_INSERT_MS = 1500
const MAX_TRACKED = 200

/**
 * 本会话里由插件管过的路径。
 *
 * 额外记一份自己的账，而不是每次靠解析输入框来猜「哪一行是路径」：
 * 编辑器把长路径折行之后，从文本反推并不可靠。
 */
let managedPaths = []
let recentInserts = []

function rememberPaths(paths) {
  const now = Date.now()
  for (const path of paths) {
    if (!path) continue
    if (!managedPaths.includes(path)) managedPaths.push(path)
    recentInserts.push({ path, at: now })
  }
  if (managedPaths.length > MAX_TRACKED) managedPaths = managedPaths.slice(-MAX_TRACKED)
  recentInserts = recentInserts.filter((e) => now - e.at < RECENT_INSERT_MS)
}

/**
 * 这条路径已经在输入框里了吗。
 * 用「折叠空白后包含」判断：既能认出正常的一行，也能认出被视觉折行的长路径。
 */
function textHasPath(text, path) {
  const needle = squash(path)
  if (needle === "") return false
  return squash(text).includes(needle)
}

/**
 * 算出「插完之后应该是怎样」，以及哪些是真正的新增。
 *
 * 规则：
 *   - 每条路径独占一行；
 *   - 已存在的路径不再追加；
 *   - 路径统一收拢到末尾，用户文字留在上面，中间恰好一个空行。
 */
function planInsert(currentText, incoming, known) {
  const tracked = Array.isArray(known) ? known : managedPaths
  const fresh = []
  for (const path of incoming) {
    if (!path) continue
    if (fresh.includes(path)) continue
    if (textHasPath(currentText, path)) continue
    fresh.push(path)
  }

  const lines = String(currentText || "").split("\n")
  const textLines = []
  const pathLines = []
  let pendingBlank = 0

  const isTrackedPath = (line) => {
    const t = line.trim()
    if (t === "") return false
    if (pathLines.includes(t)) return true
    return tracked.includes(t)
  }

  for (const raw of lines) {
    if (raw.trim() === "") {
      pendingBlank += 1
      continue
    }
    if (pendingBlank > 0 && textLines.length > 0) {
      for (let i = 0; i < pendingBlank; i += 1) textLines.push("")
    }
    pendingBlank = 0
    if (isTrackedPath(raw)) pathLines.push(raw.trim())
    else textLines.push(raw)
  }

  while (textLines.length > 0 && textLines[textLines.length - 1].trim() === "") textLines.pop()

  const allPaths = pathLines.slice()
  for (const path of fresh) if (!allPaths.includes(path)) allPaths.push(path)

  const parts = []
  if (textLines.length > 0) parts.push(textLines.join("\n"))
  if (allPaths.length > 0) parts.push(allPaths.join("\n"))

  const target = parts.filter((p) => p !== "").join("\n\n")
  return { target, fresh, paths: allPaths }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 把路径写进输入框：每条独占一行，收拢到末尾。
 *
 * 编辑器对内容有自己的算账方式，可能需要一拍才稳定，所以写两轮、每轮后读回校验。
 * 返回真正新写入的条数。
 */
async function appendPathLines(paths) {
  const el = usableComposer(findComposer())
  if (!el) {
    showToast("没找到输入框，请点一下输入框再拖一次", true)
    return 0
  }

  const incoming = []
  for (const p of paths) {
    if (!p) continue
    if (incoming.includes(p)) continue
    incoming.push(p)
  }
  if (incoming.length === 0) return 0

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = readAll(el)
    const plan = planInsert(before, incoming)

    // 只追加「还没有的部分」，绝不整段重写输入框。
    const missing = plan.paths.filter((p) => !textHasPath(before, p))
    if (missing.length === 0) {
      showToast("这些路径已经在输入框里了")
      return 0
    }

    // 输入框里还有用户自己的文字 → 路径块与它之间留一个空行。
    // 只有路径时不留空行，避免无意义的空白。
    // 输入框里还有用户自己的文字 → 路径块与它之间留一个空行。
    // 只有路径时不留空行，避免无意义的空白。
    const blankBefore = userTextOf(before).trim() !== ""

    const freshToReport = plan.fresh.length > 0 ? plan.fresh : missing
    rememberPaths(freshToReport)

    // 首选编辑器 API：这是唯一能真正换行的通道（见 insertViaLexical 注释）。
    const usedEditor = insertViaLexical(el, missing, blankBefore)
    if (!usedEditor) {
      // 回落：非 Lexical 环境（例如纯 contenteditable / textarea）走通用 DOM 通道。
      let wantBlank = blankBefore
      for (const path of missing) {
        writeAtEnd(el, path, wantBlank)
        wantBlank = false
      }
    }

    await wait(0)
    const after = readAll(el)

    if (plan.paths.every((p) => textHasPath(after, p))) {
      reportDiag({
        event: "insert-ok",
        requested: missing,
        allPaths: plan.paths,
        after,
        written: freshToReport.length,
      })
      caretToEnd(el)
      showToast(
        freshToReport.length <= 1
          ? "已插入路径：" + plan.paths[plan.paths.length - 1]
          : "已插入 " + freshToReport.length + " 条路径"
      )
      return freshToReport.length
    }
  }

  reportDiag({ event: "insert-failed", requested: incoming, after: readAll(el) })
  showToast("路径没能写进输入框，请手动粘贴：" + squash(incoming[0]), true)
  return 0
}

/* ==========================================================================
   运行时诊断上报（只在真正出问题时才需要看）
   ========================================================================== */
/**
 * 把一次拖拽的真实数据报到服务端，落盘到 ~/.dsh/dsh-paste-path-diag.log。
 *
 * 为什么需要：macOS 原生拖拽在浏览器自动化里**无法模拟**
 * （BrowserSkill 的拦截层会直接返回 HTTP 501），所以只能让真实客户端把证据留下来。
 * 失败绝不影响主流程。
 */
function reportDiag(payload) {
  try {
    fetch(DIAG_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ at: new Date().toISOString(), ...payload }),
    }).catch(() => {})
  } catch {}
}

/** 描述一个 File 对象的关键属性（诊断用）。 */
function describeFile(file) {
  if (!file) return { name: null }
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    hasPath: typeof file.path === "string" && file.path !== "",
    path: typeof file.path === "string" ? file.path : null,
    isMacosBundle: isMacosBundle(file.name),
    hasFileExtension: hasFileExtension(file.name),
    isImage: isImageFile(file.name, file.type),
    isDirectoryLike: isDirectoryLike(file),
  }
}

/* ==========================================================================
   路径解析
   ========================================================================== */
async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { accept: "application/json", ...(options.headers || {}) },
  })
  let data
  try {
    data = await res.json()
  } catch {
    const err = new Error("HTTP " + res.status)
    err.status = res.status
    throw err
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || "HTTP " + res.status)
    err.status = res.status
    if (data && data.code) err.code = data.code
    throw err
  }
  return data
}

function normalizePath(raw) {
  if (!raw || typeof raw !== "string") return ""
  let p = raw.trim()
  if (p.startsWith("file://localhost")) p = p.slice(16)
  else if (p.startsWith("file://")) p = p.slice(7)
  try { p = decodeURIComponent(p) } catch {}
  if (typeof p.normalize === "function") p = p.normalize("NFC")
  return p.replace(/\/+$/, "")
}

/** 直接可从 File 对象拿到的真实路径（Electron 会给 file.path）。 */
/**
 * 拖入项的绝对路径 —— 由桌面壳通过 preload 暴露的 Electron 官方 API 提供。
 *
 * 为什么之前拿不到：Electron 32 起移除了非标的 `File.path`，而 JackDSH 的 renderer
 * 关着 nodeIntegration、开着 contextIsolation，所以页面**根本看不到**拖入项的路径。
 * 插件当时只能让同机服务端拿文件名去文件系统里搜（mdfind / 常见目录扫描）——
 * 搜不中就是「拖进去没反应」，这是猜，不是解决方案。
 *
 * 现在壳里用 webUtils.getPathForFile(file) 把真实路径桥出来：路径是精确的，
 * 不需要搜索，也不会认错同名文件。浏览器里打开（没有壳）时返回空，
 * 自动退回服务端按名字解析那条老路。
 */
function nativePathOf(file) {
  if (!file) return ""
  const bridge = typeof window !== "undefined" ? window.jackdshNative : null
  if (!bridge || typeof bridge.getPathForFile !== "function") return ""
  try {
    const value = bridge.getPathForFile(file)
    return typeof value === "string" ? value : ""
  } catch {
    return ""
  }
}

function directPaths(files) {
  const out = []
  for (const file of files) {
    if (!file) continue
    const candidate =
      nativePathOf(file) ||
      (typeof file.path === "string" && file.path) ||
      (typeof file.filepath === "string" && file.filepath) ||
      ""
    const clean = normalizePath(candidate)
    if (clean) out.push(clean)
  }
  return out
}

/** 后端把「文件名」还原成绝对路径：剪贴板优先，再按文件名 + 体积搜索。 */
async function resolveViaHost(files) {
  const payload = Array.from(files || [])
    .filter((f) => f && f.name)
    .map((f) => ({ name: f.name, size: f.size, type: f.type }))
  if (payload.length === 0) return []
  const res = await requestJson(DROP_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: payload }),
  })
  if (res && Array.isArray(res.paths)) return res.paths.map(normalizePath).filter(Boolean)
  return []
}

/**
 * 把「官方支持的那部分文件」原样交还给官方处理器。
 *
 * 背景：官方附件组件在 **document 冒泡阶段** 监听 drop，只读 event.dataTransfer.files，
 * 且**不检查 isTrusted**（源码已确认）。所以我们可以在 window 捕获阶段先拦下整次拖拽，
 * 把目录/.app 自己处理掉，再用**原始的 dataTransfer** 补发一次 drop，
 * 官方就会照常把图片/普通文件显示成原生附件卡片。
 *
 * 这样混合拖拽（图片 + 文件夹）不会二选一：该官方的归官方，该我们的归我们。
 * 也彻底避免了「把目录也交给官方 → 目录取字节 EISDIR → 红框上传失败」。
 */
let handingOff = false

/**
 * 造一个**只含官方支持文件**的新 DataTransfer。
 *
 * 关键：补发时必须给一个新的 DataTransfer，绝不能把原始对象整个递过去——
 * 原始对象里还带着目录，官方拿到后会去读目录的字节流（EISDIR）并弹红框「上传失败」。
 * （这一点是实测抓出来的：第一版就是把原始对象递过去，官方收到了目录。）
 */
function buildNativeTransfer(natives) {
  try {
    const next = new DataTransfer()
    for (const file of natives) {
      if (!file) continue
      try {
        next.items.add(file)
      } catch {}
    }
    if (next.files.length === 0) return null
    return next
  } catch {
    return null
  }
}

function handOffToNative(dataTransfer) {
  if (!dataTransfer) return false
  if (handingOff) return false
  handingOff = true
  try {
    let event
    try {
      event = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer,
      })
    } catch {
      event = new Event("drop", { bubbles: true, cancelable: true, composed: true })
    }
    // 某些实现不支持在构造参数里带 dataTransfer，兜底直接挂上去。
    try {
      if (!event.dataTransfer) {
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer, configurable: true })
      }
    } catch {}
    // 派发到 document：官方监听器就在这儿，且不会再次触发我们自己的 window 捕获。
    document.dispatchEvent(event)
    return true
  } catch {
    return false
  } finally {
    handingOff = false
  }
}

/** 拖拽 / 文件选择器的统一出口：拿到绝对路径 → 写进输入框。 */
async function attachTargets(targets) {
  const list = Array.from(targets || []).filter(Boolean)
  if (list.length === 0) return 0

  const direct = directPaths(list)
  if (direct.length > 0) return appendPathLines(direct)

  try {
    const resolved = await resolveViaHost(list)
    if (resolved.length === 0) {
      showToast("没识别出绝对路径。可先在访达里选中它按 Cmd+C，再拖进来或用 ⌘V", true)
      return 0
    }
    return appendPathLines(resolved)
  } catch (err) {
    showToast((err && err.message) || "解析路径失败", true)
    return 0
  }
}

/* ==========================================================================
   拖拽
   ========================================================================== */
let dragDepth = 0
let dropHandling = false

function setHighlight(active) {
  if (typeof document === "undefined") return
  const card = findComposerCard()
  if (!card) return
  if (active) card.classList.add("dshpp-drag-over")
  else card.classList.remove("dshpp-drag-over")
}

/** 高亮挂在卡片上；找不到卡片就退回输入框本身。 */
function findComposerCard() {
  return (
    document.querySelector("[data-composer-card]") ||
    document.querySelector("[data-composer-input]") ||
    findComposer()
  )
}

function resetDrag() {
  dragDepth = 0
  setHighlight(false)
}

function hasDragFiles(e) {
  const dt = e.dataTransfer
  return Boolean(dt && dt.types && (dt.types.includes("Files") || dt.types.includes("public.file-url")))
}

/** 只要有目录/.app 参与，这一次拖拽就归我们管，官方完全不参与。 */
/**
 * 这次拖拽里有没有归我们管的目录 / .app。
 * 只用来决定是否给输入框加高亮——drop 的真正分流在 onDrop 里做。
 */
function ownsDrag(e) {
  return hasDragFiles(e) && collectTargets(e.dataTransfer).length > 0
}

function swallow(e) {
  e.preventDefault()
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation()
  else e.stopPropagation()
}

function onDragEnter(e) {
  dragDepth += 1
  if (ownsDrag(e)) setHighlight(true)
}

function onDragOver(e) {
  if (ownsDrag(e)) setHighlight(true)
}

function onDragLeave(e) {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) setHighlight(false)
}

async function onDrop(e) {
  // 补发给官方的合成 drop 不能再被我们处理一次。
  if (handingOff) return
  if (!hasDragFiles(e)) return

  const { targets, natives } = classifyTransfer(e.dataTransfer)
  reportDiag({
    event: "drop",
    rawFiles: Array.from((e.dataTransfer && e.dataTransfer.files) || []).map(describeFile),
    targetNames: targets.map((f) => (f && f.name) || null),
    nativeNames: natives.map((f) => (f && f.name) || null),
  })
  if (targets.length === 0) {
    // 没有目录/.app/包 → 完全交给官方，我们一步都不插手。
    resetDrag()
    return
  }

  // 有目录/.app → 整次拖拽由我们接管。
  // 必须拦死：官方若不慎拿到目录，会对目录取字节流（EISDIR）并弹红框「上传失败」。
  swallow(e)
  resetDrag()

  // 官方支持的部分（图片、普通文件）补发给官方，让它们照常显示成原生附件卡片。
  // 只递「只含官方文件」的新 DataTransfer，目录绝不能混进去。
  if (natives.length > 0) {
    const filtered = buildNativeTransfer(natives)
    if (filtered) handOffToNative(filtered)
  }

  // 同一次拖拽会被多个入口（window drop / 输入区 drop / input change）各触发一次，
  // 串行化之后交给 appendPathLines 的去重逻辑判断，避免重复插入。
  if (dropHandling) return
  dropHandling = true
  try {
    await attachTargets(targets)
  } finally {
    dropHandling = false
  }
}

/* ==========================================================================
   文件选择器（📎 按钮）
   ========================================================================== */
function onChange(e) {
  const target = e.target
  if (!(target instanceof HTMLInputElement) || target.type !== "file" || !target.files) return
  const targets = Array.from(target.files).filter(isDirectoryLike)
  if (targets.length === 0) return
  swallow(e)
  target.value = ""
  attachTargets(targets)
}

/* ==========================================================================
   粘贴（⌘V / Ctrl+V）
   ==========================================================================
   官方 Lexical PASTE_COMMAND 会把 clipboard 里 kind=file 的每一项都丢给
   intakeFiles 去上传。目录 / macOS 包没有字节流（EISDIR）→ 红框「上传失败」。
   拖拽已经在 onDrop 里分流过了；粘贴必须同样处理，否则访达 Cmd+C 再 Cmd+V
   目录就会失败，而拖同一项却成功。

   规则与 drop 完全对称：
     - 没有目录/.app → 一步都不插手（截图、.md、.png 继续走官方）
     - 有目录/.app → 整次粘贴由我们接管，目录插路径，普通文件补发给官方
*/
function eventInComposer(e) {
  const hit = (node) => {
    if (!node || typeof node.closest !== "function") return false
    return Boolean(node.closest("[data-composer-input], [data-composer-card]"))
  }
  if (hit(e && e.target)) return true
  if (typeof document !== "undefined" && hit(document.activeElement)) return true
  return false
}

async function onPaste(e) {
  // 补发给官方的合成 drop 不会走到这里；保险起见仍挡一下。
  if (handingOff) return
  const cd = e.clipboardData
  if (!cd) return
  if (!eventInComposer(e)) return

  const { targets, natives } = classifyTransfer(cd)
  reportDiag({
    event: "paste",
    rawFiles: Array.from((cd.files) || []).map(describeFile),
    targetNames: targets.map((f) => (f && f.name) || null),
    nativeNames: natives.map((f) => (f && f.name) || null),
  })
  if (targets.length === 0) {
    // 截图、普通文件、纯文本 → 完全交给官方。
    return
  }

  // 必须拦死：官方 PASTE_COMMAND 会对目录取字节流并弹红框「上传失败」。
  swallow(e)

  if (natives.length > 0) {
    const filtered = buildNativeTransfer(natives)
    if (filtered) handOffToNative(filtered)
  }

  if (pasteInFlight || dropHandling) return
  pasteInFlight = true
  try {
    const named = targets.filter((f) => f && f.name)
    if (named.length > 0) {
      await attachTargets(named)
      return
    }
    // 目录项没有 File 对象时，退回读系统剪贴板（NSFilenamesPboardType）。
    await pasteClipboardPathsUnlocked()
  } catch (err) {
    showToast((err && err.message) || "读取剪贴板路径失败", true)
  } finally {
    pasteInFlight = false
  }
}

/* ==========================================================================
   剪贴板：⌘⇧V / Ctrl+Shift+V 手动兜底
   ========================================================================== */
let pasteInFlight = false
async function pasteClipboardPathsUnlocked() {
  const res = await requestJson(PASTE_ROUTE, { method: "POST" })
  const paths = Array.isArray(res && res.paths) ? res.paths.map(normalizePath).filter(Boolean) : []
  if (paths.length === 0) {
    showToast("剪贴板里没有文件路径。先在访达选中它按 Cmd+C，再按 ⌘V", true)
    return 0
  }
  return appendPathLines(paths)
}

async function pasteClipboardPaths() {
  if (pasteInFlight) return 0
  pasteInFlight = true
  try {
    return await pasteClipboardPathsUnlocked()
  } catch (err) {
    showToast((err && err.message) || "读取剪贴板路径失败", true)
    return 0
  } finally {
    pasteInFlight = false
  }
}

function onKeyDown(e) {
  if (e.key !== "V" && e.key !== "v") return
  if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
  if (e.isComposing) return
  const el = findComposer()
  if (!el || (el !== e.target && !el.contains(e.target))) return
  swallow(e)
  pasteClipboardPaths()
}

/* ==========================================================================
   安装
   ========================================================================== */
function apply(ctx) {
  let dispose = () => {}

  if (typeof window !== "undefined") {
    window.addEventListener("dragenter", onDragEnter, true)
    window.addEventListener("dragover", onDragOver, true)
    window.addEventListener("dragleave", onDragLeave, true)
    window.addEventListener("drop", onDrop, true)
    window.addEventListener("paste", onPaste, true)
    window.addEventListener("change", onChange, true)
    window.addEventListener("keydown", onKeyDown, true)

    dispose = () => {
      window.removeEventListener("dragenter", onDragEnter, true)
      window.removeEventListener("dragover", onDragOver, true)
      window.removeEventListener("dragleave", onDragLeave, true)
      window.removeEventListener("drop", onDrop, true)
      window.removeEventListener("paste", onPaste, true)
      window.removeEventListener("change", onChange, true)
      window.removeEventListener("keydown", onKeyDown, true)
      if (toastTimer !== null) clearTimeout(toastTimer)
    }

    window.__dshPastePath__ = {
      insert: (paths) => appendPathLines(Array.isArray(paths) ? paths : [paths]),
      paste: () => pasteClipboardPaths(),
      targets: (dataTransfer) => collectTargets(dataTransfer),
      classify: (dataTransfer) => classifyTransfer(dataTransfer),
      // 诊断用：完整跑一遍插路径流程，返回每一步的结果
      runTargets: async (dataTransfer) => {
        const { targets, natives } = classifyTransfer(dataTransfer)
        const before = readAll(usableComposer(findComposer()))
        const report = {
          targetNames: targets.map((f) => (f && f.name) || '(无名)'),
          nativeNames: natives.map((f) => (f && f.name) || '(无名)'),
          directPaths: directPaths(targets),
        }
        try {
          report.resolved = await resolveViaHost(targets.filter((f) => f && f.name))
        } catch (e) {
          report.resolveError = String((e && e.message) || e)
        }
        let written = 0
        try {
          written = await appendPathLines(report.directPaths.length > 0 ? report.directPaths : (report.resolved || []))
        } catch (e) {
          report.appendError = String((e && e.message) || e)
        }
        report.written = written
        report.after = readAll(usableComposer(findComposer()))
        report.changed = report.after !== before
        return report
      },
      judge: (dataTransfer) => {
        const dt = dataTransfer
        const rows = []
        const nameOf = (f) => (f && f.name) || '(无名)'
        const files = Array.from((dt && dt.files) || [])
        for (const file of files) {
          rows.push(
            nameOf(file) +
            ' | type=' + JSON.stringify(file.type) +
            ' | isMacosBundle=' + isMacosBundle(file.name) +
            ' | hasFileExtension=' + hasFileExtension(file.name) +
            ' | isImage=' + isImageFile(file.name, file.type) +
            ' | → 归插件=' + isDirectoryLike(file)
          )
        }
        return rows
      },
      composerText: () => readAll(usableComposer(findComposer())),
      type: async (text) => {
        const el = usableComposer(findComposer())
        if (!el) return null
        el.focus()
        caretToEnd(el)
        document.execCommand("insertText", false, text)
        fireInput(el)
        await wait(0)
        return readAll(el)
      },
      plan: (incoming) => planInsert(readAll(usableComposer(findComposer())), incoming),
      diag: () => diag.slice(),
      breakLine: () => {
        const el = usableComposer(findComposer())
        if (!el) return null
        const ok = insertLineBreakAtCaret(el)
        return { ok, innerText: readAll(el), html: el.innerHTML }
      },
      html: () => {
        const el = usableComposer(findComposer())
        return el ? String(el.innerHTML) : null
      },
      rawText: () => {
        const el = usableComposer(findComposer())
        return el ? String(el.textContent) : null
      },
      caretAtEnd: () => caretAtEnd(usableComposer(findComposer())),
      managedPaths: () => managedPaths.slice(),
      clear: () => {
        const el = usableComposer(findComposer())
        if (!el) return null
        el.innerHTML = ""
        fireInput(el)
        return readAll(el)
      },
      reset: () => { managedPaths = []; recentInserts = [] },
    }
  }

  if (typeof ctx.effect === "function") ctx.effect(() => dispose)
}

module.exports = { name: "dsh-paste-path", apply }
module.exports.inject = []
module.exports.__internals = {
  isImageFile,
  hasFileExtension,
  isMacosBundle,
  isDirectoryLike,
  isNativelySupported,
  classifyTransfer,
  buildNativeTransfer,
  collectTargets,
  squash,
  readbackMatches,
  textHasPath,
  planInsert,
  normalizePath,
  nativePathOf,
  directPaths,
}

    return module.exports
  },
})
