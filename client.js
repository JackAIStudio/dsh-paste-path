window.__ModuleLoader__.load({
  id: 'dsh-paste-path',
  factory: (require) => {
    const module = { exports: {} }
    const css = ".dshpp-btn {\n  appearance: none;\n  display: inline-flex;\n  align-items: center;\n  gap: 5px;\n  height: 28px;\n  padding: 0 8px;\n  border: none;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--dsw-alias-label-secondary, #666);\n  font: inherit;\n  font-size: 13px;\n  font-weight: 500;\n  line-height: 28px;\n  cursor: pointer;\n  user-select: none;\n  white-space: nowrap;\n  transition: background-color 100ms ease, color 100ms ease;\n}\n\n.dshpp-btn:hover {\n  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.08));\n  color: var(--dsw-alias-label-primary, #111);\n}\n\n.dshpp-btn.is-ready {\n  color: var(--dsw-alias-brand-primary, #2563eb);\n}\n\n.dshpp-btn.is-ready:hover {\n  background: rgba(37, 99, 235, 0.08);\n}\n\n.dshpp-btn-icon {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  flex-shrink: 0;\n  opacity: 0.85;\n}\n\n.dshpp-btn-text {\n  font-size: 13px;\n  font-weight: 500;\n  line-height: 20px;\n}\n\n.dshpp-btn-shortcut {\n  font-size: 11px;\n  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;\n  color: var(--dsw-alias-label-tertiary, #999);\n  margin-left: 1px;\n  opacity: 0.8;\n}\n\n.dshpp-btn.is-ready .dshpp-btn-shortcut {\n  color: var(--dsw-alias-brand-primary, #2563eb);\n  opacity: 0.65;\n}\n\n.dshpp-toast {\n  position: fixed;\n  right: 20px;\n  bottom: 84px;\n  max-width: 420px;\n  padding: 8px 14px;\n  border-radius: 8px;\n  background: var(--dsw-alias-bg-layer-3, #1e293b);\n  color: var(--dsw-alias-label-primary, #f8fafc);\n  font-size: 12px;\n  line-height: 18px;\n  pointer-events: none;\n  box-shadow: var(--dsw-shadow-lv3, 0 10px 15px -3px rgba(0, 0, 0, 0.3));\n  z-index: 1000;\n  animation: dshppFadeIn 150ms ease;\n  word-break: break-all;\n}\n\n.dshpp-toast.is-error {\n  background: #dc2626;\n  color: #ffffff;\n}\n\n/* 拖拽时输入框高亮，轻巧优雅，不挡视线 */\n[data-composer-card].dshpp-drag-over,\ndiv[data-composer-input=\"true\"].dshpp-drag-over {\n  border-color: var(--dsw-alias-brand-primary, #2563eb) !important;\n  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.3) !important;\n  transition: all 120ms ease;\n}\n\n/* 彻底隐藏原生容易卡死且限制图片的全屏蒙层 */\ndiv[role=\"status\"]:has(> div[class*=\"illustration\"]),\ndiv[class*=\"_mask\"]:has(div[class*=\"_illustration\"]),\ndiv[class*=\"BInVoG_mask\"] {\n  display: none !important;\n  opacity: 0 !important;\n  pointer-events: none !important;\n}\n\n@keyframes dshppFadeIn {\n  from { opacity: 0; transform: translateY(4px); }\n  to { opacity: 1; transform: translateY(0); }\n}\n"
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
const React = require("react")
const PEEK_ROUTE = "/dsh-paste-path/peek"
const PASTE_ROUTE = "/dsh-paste-path/paste"
const DROP_ROUTE = "/dsh-paste-path/resolve-drop"

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"])
const IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/svg+xml",
])

function isImageFile(name, type) {
  if (type && IMAGE_MIME_TYPES.has(type.toLowerCase())) return true
  if (name && typeof name === "string") {
    const parts = name.split(".")
    if (parts.length > 1) {
      const ext = parts.pop().toLowerCase()
      if (IMAGE_EXTENSIONS.has(ext)) return true
    }
  }
  return false
}

function isTransferPureImages(dataTransfer) {
  if (!dataTransfer) return false
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    let hasFiles = false
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i]
      if (item.kind === "file") {
        hasFiles = true
        if (!item.type || !IMAGE_MIME_TYPES.has(item.type.toLowerCase())) {
          return false
        }
      }
    }
    return hasFiles
  }
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return Array.from(dataTransfer.files).every(f => isImageFile(f.name, f.type))
  }
  return false
}

let toastState = null
const toastListeners = new Set()
let toastTimer = null

let peekReady = false
const peekListeners = new Set()
let peekInFlight = false
let remoteDisabled = false
let stopPeekHook = null

let dragDepth = 0

function emit(listeners) {
  for (const fn of listeners) fn()
}

function showToast(text, isError = false) {
  if (toastTimer !== null) clearTimeout(toastTimer)
  toastState = { text, isError }
  emit(toastListeners)
  toastTimer = setTimeout(() => {
    toastState = null
    emit(toastListeners)
  }, 3200)
}

function applyPeek(ready) {
  if (peekReady === ready) return
  peekReady = ready
  emit(peekListeners)
}

function setHighlightInput(active) {
  if (typeof document === "undefined") return
  const card = document.querySelector("[data-composer-card]") || document.querySelector("div[data-composer-input]")
  if (card) {
    if (active) card.classList.add("dshpp-drag-over")
    else card.classList.remove("dshpp-drag-over")
  }
}

let inResetDrag = false
function resetDrag() {
  if (inResetDrag) return
  inResetDrag = true
  try {
    dragDepth = 0
    setHighlightInput(false)
  } finally {
    inResetDrag = false
  }
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
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
    const err = new Error(data && data.error ? data.error : "HTTP " + res.status)
    err.status = res.status
    if (data && data.code) err.code = data.code
    throw err
  }
  return data
}

function refreshPeek() {
  if (peekInFlight || remoteDisabled) return
  peekInFlight = true
  requestJson(PEEK_ROUTE, { method: "GET" }).then(
    (res) => {
      peekInFlight = false
      applyPeek(Boolean(res && res.ready))
    },
    (err) => {
      peekInFlight = false
      if (err && (err.code === "remote-not-supported" || err.status === 403)) {
        remoteDisabled = true
        applyPeek(false)
        if (stopPeekHook !== null) stopPeekHook()
      }
    }
  )
}

function findComposerElement() {
  return (
    document.querySelector("div[data-composer-input]") ||
    document.querySelector("[data-composer-input]") ||
    document.querySelector("div[contenteditable]") ||
    document.querySelector("textarea[data-composer-input]") ||
    document.querySelector("textarea")
  )
}

function insertPathsToComposer(paths) {
  if (!paths || paths.length === 0) return 0
  const composer = findComposerElement()
  if (!composer) {
    showToast('未找到活动输入框', true)
    return 0
  }

  // 1. Focus input
  composer.focus()

  const cleanPaths = paths.map((p) => String(p || '').trim()).filter(Boolean)
  if (cleanPaths.length === 0) return 0

  // 2. Ensure cursor is in composer
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !composer.contains(sel.anchorNode)) {
    const range = document.createRange()
    range.selectNodeContents(composer)
    range.collapse(false)
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  let success = false

  // 策略 1: 标准富文本段落/换行 (每行独立包裹，绝不粘连)
  try {
    const brHtml = cleanPaths.join('<br>') + '<br>'
    success = document.execCommand('insertHTML', false, brHtml)
  } catch {
    success = false
  }

  // 策略 2: DOM Range 直接注入带 <br> 的 DocumentFragment
  if (!success) {
    try {
      const activeSel = window.getSelection()
      if (activeSel && activeSel.rangeCount > 0) {
        const range = activeSel.getRangeAt(0)
        range.deleteContents()
        const fragment = document.createDocumentFragment()
        for (let i = 0; i < cleanPaths.length; i++) {
          fragment.appendChild(document.createTextNode(cleanPaths[i]))
          fragment.appendChild(document.createElement('br'))
        }
        range.insertNode(fragment)
        range.collapse(false)
        activeSel.removeAllRanges()
        activeSel.addRange(range)
        composer.dispatchEvent(new Event('input', { bubbles: true }))
        success = true
      }
    } catch {
      success = false
    }
  }

  if (cleanPaths.length === 1) {
    showToast('已插入 ' + cleanPaths[0])
  } else {
    showToast('已插入 ' + cleanPaths.length + ' 个路径')
  }
  return cleanPaths.length
}

let pasteInFlight = false
function doPastePaths() {
  if (pasteInFlight) return
  pasteInFlight = true
  requestJson(PASTE_ROUTE, { method: "POST" }).then(
    (res) => {
      pasteInFlight = false
      const paths = res && Array.isArray(res.paths) ? res.paths : []
      if (paths.length === 0) {
        applyPeek(false)
        showToast(res && res.error ? res.error : "剪贴板里没有文件路径。请在访达中选中文件按 Cmd+C 后再试。", true)
        return
      }
      insertPathsToComposer(paths)
      applyPeek(true)
    },
    (err) => {
      pasteInFlight = false
      showToast(err && err.message ? err.message : "读取剪贴板路径失败", true)
    }
  )
}

function hasDragFiles(e) {
  const dt = e.dataTransfer
  return Boolean(dt && dt.types && (dt.types.includes("Files") || dt.types.includes("public.file-url")))
}

function onGlobalDragEnter(e) {
  if (!hasDragFiles(e)) return
  if (isTransferPureImages(e.dataTransfer)) {
    return
  }
  e.preventDefault()
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation()
  else e.stopPropagation()
  dragDepth += 1
  setHighlightInput(true)
}

function onGlobalDragOver(e) {
  if (!hasDragFiles(e)) return
  if (isTransferPureImages(e.dataTransfer)) {
    return
  }
  e.preventDefault()
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation()
  else e.stopPropagation()
  e.dataTransfer.dropEffect = "copy"
  setHighlightInput(true)
}

function onGlobalDragLeave(e) {
  if (!hasDragFiles(e)) return
  if (isTransferPureImages(e.dataTransfer)) {
    return
  }
  e.preventDefault()
  if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation()
  else e.stopPropagation()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) {
    setHighlightInput(false)
  }
}

async function onGlobalDrop(e) {
  if (!hasDragFiles(e)) return
  const files = Array.from(e.dataTransfer.files || [])
  const isPureImages = files.length > 0 && files.every(f => isImageFile(f.name, f.type))
  if (isPureImages) {
    resetDrag()
    return
  }

  // Prevent native DSH attachments handler to avoid unsupportedType error
  e.preventDefault()
  if (typeof e.stopImmediatePropagation === "function") {
    e.stopImmediatePropagation()
  } else {
    e.stopPropagation()
  }
  resetDrag()

  // Try direct URI list if available
  let directPaths = []
  try {
    const uriList = e.dataTransfer.getData("text/uri-list") || ""
    if (uriList) {
      const parsed = uriList.split(/[\r\n]+/)
        .map(u => u.trim())
        .filter(u => u.startsWith("file://"))
        .map(u => decodeURIComponent(u.replace(/^file:\/\//, "")))
      if (parsed.length > 0) directPaths = parsed
    }
  } catch {}

  if (directPaths.length > 0) {
    insertPathsToComposer(directPaths)
    return
  }

  const filePayload = files.map((f) => ({
    name: f.name,
    size: f.size,
    type: f.type,
  }))

  if (filePayload.length === 0) {
    filePayload.push({ name: "", size: 0, type: "" })
  }

  try {
    const res = await requestJson(DROP_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ files: filePayload }),
    })
    const paths = res && Array.isArray(res.paths) ? res.paths : []
    if (paths.length > 0) {
      insertPathsToComposer(paths)
    } else {
      showToast("无法解析拖拽文件的绝对路径", true)
    }
  } catch (err) {
    showToast(err && err.message ? err.message : "解析拖拽路径失败", true)
  }
}

function onGlobalDragEnd() {
  resetDrag()
}

function onGlobalKeyDown(e) {
  if (!e || e.isComposing) return
  // Ctrl + V
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    if (typeof e.key === "string" && e.key.toLowerCase() === "v") {
      e.preventDefault()
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation()
      else e.stopPropagation()
      doPastePaths()
    }
  }
}

function onGlobalPaste(e) {
  const cd = e.clipboardData
  if (!cd) return
  const items = Array.from(cd.items || [])
  const hasFiles = items.some(item => item.kind === "file")
  if (hasFiles) {
    const files = Array.from(cd.files || [])
    const isPureImages = files.length > 0 && files.every(f => isImageFile(f.name, f.type))
    if (!isPureImages) {
      e.preventDefault()
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation()
      else e.stopPropagation()
      doPastePaths()
    }
  }
}

function PathButton() {
  const [ready, setReady] = React.useState(peekReady)

  React.useEffect(() => {
    const listener = () => setReady(peekReady)
    peekListeners.add(listener)
    return () => {
      peekListeners.delete(listener)
    }
  }, [])

  const onClick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    doPastePaths()
  }

  return React.createElement(
    "button",
    {
      type: "button",
      className: ready ? "dshpp-btn is-ready" : "dshpp-btn",
      title: "点击或按 Ctrl+V / Cmd+V 粘贴访达中选中的文件路径",
      onClick,
    },
    React.createElement(
      "span",
      { className: "dshpp-btn-icon" },
      React.createElement(
        "svg",
        {
          width: "14",
          height: "14",
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "2",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        },
        React.createElement("path", {
          d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
        }),
        React.createElement("rect", {
          x: "8",
          y: "2",
          width: "8",
          height: "4",
          rx: "1",
          ry: "1",
        })
      )
    ),
    React.createElement("span", { className: "dshpp-btn-text" }, "贴路径"),
    React.createElement("span", { className: "dshpp-btn-shortcut" }, "⌃V")
  )
}

function ToastOverlay() {
  const [toast, setToast] = React.useState(toastState)

  React.useEffect(() => {
    const toastListener = () => setToast(toastState)
    toastListeners.add(toastListener)
    return () => {
      toastListeners.delete(toastListener)
    }
  }, [])

  return toast !== null
    ? React.createElement(
        "div",
        { className: toast.isError ? "dshpp-toast is-error" : "dshpp-toast" },
        toast.text
      )
    : null
}

function apply(ctx) {
  const slots = ctx.slots || (typeof ctx.get === "function" ? ctx.get("slots") : undefined)

  let removeGlobalListeners = () => {}
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", onGlobalKeyDown, true)
    window.addEventListener("paste", onGlobalPaste, true)
    window.addEventListener("dragenter", onGlobalDragEnter, true)
    window.addEventListener("dragover", onGlobalDragOver, true)
    window.addEventListener("dragleave", onGlobalDragLeave, true)
    window.addEventListener("drop", onGlobalDrop, true)
    window.addEventListener("dragend", onGlobalDragEnd)

    removeGlobalListeners = () => {
      window.removeEventListener("keydown", onGlobalKeyDown, true)
      window.removeEventListener("paste", onGlobalPaste, true)
      window.removeEventListener("dragenter", onGlobalDragEnter, true)
      window.removeEventListener("dragover", onGlobalDragOver, true)
      window.removeEventListener("dragleave", onGlobalDragLeave, true)
      window.removeEventListener("drop", onGlobalDrop, true)
      window.removeEventListener("dragend", onGlobalDragEnd)
    }
  }

  let peekTimer = null
  const startPeek = () => {
    if (remoteDisabled || peekTimer !== null) return
    refreshPeek()
    peekTimer = setInterval(refreshPeek, 1500)
  }
  const stopPeek = () => {
    if (peekTimer === null) return
    clearInterval(peekTimer)
    peekTimer = null
  }
  const onVisibility = () => {
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden"
    if (hidden) stopPeek()
    else startPeek()
  }

  remoteDisabled = false
  stopPeekHook = stopPeek
  startPeek()
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", refreshPeek)
  }

  if (typeof ctx.effect === "function") {
    ctx.effect(() => () => {
      if (stopPeekHook === stopPeek) stopPeekHook = null
      stopPeek()
      removeGlobalListeners()
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility)
        window.removeEventListener("focus", refreshPeek)
      }
      if (toastTimer !== null) clearTimeout(toastTimer)
      toastListeners.clear()
      peekListeners.clear()
    })
  }

  if (slots && typeof slots.inject === "function") {
    slots.inject("conversation.input.left", () =>
      slots.register(
        { name: "conversation.input.left", id: "dsh-paste-path", order: 30, label: "贴路径" },
        () => React.createElement(PathButton, null)
      )
    )

    slots.inject("shell.overlay", () =>
      slots.register(
        { name: "shell.overlay", id: "dsh-paste-path-overlay", order: 90, label: "路径粘贴提示" },
        () => React.createElement(ToastOverlay, null)
      )
    )
  }
}

module.exports = { name: "dsh-paste-path", apply }
module.exports.inject = ["slots"]

    return module.exports
  },
})
