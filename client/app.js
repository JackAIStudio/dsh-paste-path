const React = require('react')
const PEEK_ROUTE = '/dsh-paste-path/peek'
const PASTE_ROUTE = '/dsh-paste-path/paste'
const DROP_ROUTE = '/dsh-paste-path/resolve-drop'

const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
])

let toastState = null
const toastListeners = new Set()
let toastTimer = null

let peekReady = false
const peekListeners = new Set()
let peekInFlight = false
let remoteDisabled = false
let stopPeekHook = null

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

async function requestJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.headers || {}),
    },
  })
  let data
  try {
    data = await res.json()
  } catch {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  if (!res.ok) {
    const err = new Error(data && data.error ? data.error : `HTTP ${res.status}`)
    err.status = res.status
    if (data && data.code) err.code = data.code
    throw err
  }
  return data
}

function refreshPeek() {
  if (peekInFlight || remoteDisabled) return
  peekInFlight = true
  requestJson(PEEK_ROUTE, { method: 'GET' }).then(
    (res) => {
      peekInFlight = false
      applyPeek(Boolean(res && res.ready))
    },
    (err) => {
      peekInFlight = false
      if (err && (err.code === 'remote-not-supported' || err.status === 403)) {
        remoteDisabled = true
        applyPeek(false)
        if (stopPeekHook !== null) stopPeekHook()
      }
    }
  )
}

function findComposerElement() {
  return (
    document.querySelector('[data-composer-input="true"]') ||
    document.querySelector('div[role="textbox"][contenteditable="true"]') ||
    document.querySelector('textarea[data-composer-input="true"]')
  )
}

function insertPathsToComposer(paths) {
  if (!paths || paths.length === 0) return 0
  const composer = findComposerElement()
  if (!composer) {
    showToast('未找到活动输入框', true)
    return 0
  }

  // Focus the input
  if (document.activeElement !== composer) {
    composer.focus()
  }

  const cleanPaths = paths.map((p) => String(p || '').trim()).filter(Boolean)
  if (cleanPaths.length === 0) return 0

  const textToInsert = cleanPaths.join('\n')

  // Use document.execCommand('insertText') for Lexical / contenteditable standard flow
  let success = false
  try {
    if (document.queryCommandSupported && document.queryCommandSupported('insertText')) {
      success = document.execCommand('insertText', false, textToInsert)
    }
  } catch {
    success = false
  }

  // Fallback via InputEvent dispatch
  if (!success) {
    try {
      const event = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: textToInsert,
      })
      composer.dispatchEvent(event)
      success = true
    } catch {
      success = false
    }
  }

  if (success) {
    if (cleanPaths.length === 1) {
      showToast(`已插入 ${cleanPaths[0]}`)
    } else {
      showToast(`已插入 ${cleanPaths.length} 个路径`)
    }
    return cleanPaths.length
  } else {
    showToast('写入输入框失败', true)
    return 0
  }
}

let pasteInFlight = false
function doPastePaths() {
  if (pasteInFlight) return
  pasteInFlight = true
  requestJson(PASTE_ROUTE, { method: 'POST' }).then(
    (res) => {
      pasteInFlight = false
      const paths = res && Array.isArray(res.paths) ? res.paths : []
      if (paths.length === 0) {
        applyPeek(false)
        showToast(res && res.error ? res.error : '剪贴板里没有文件路径', true)
        return
      }
      insertPathsToComposer(paths)
      applyPeek(true)
    },
    (err) => {
      pasteInFlight = false
      showToast(err && err.message ? err.message : '读取剪贴板路径失败', true)
    }
  )
}

function isFilesOnlyImages(dataTransfer) {
  if (!dataTransfer) return false
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i]
      if (item.kind === 'file') {
        // If type is empty string, it could be a folder or non-standard extension
        if (!item.type || !IMAGE_TYPES.has(item.type.toLowerCase())) {
          return false
        }
      }
    }
    return true
  }
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i]
      if (!file.type || !IMAGE_TYPES.has(file.type.toLowerCase())) {
        return false
      }
    }
    return true
  }
  return false
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

  React.useEffect(() => {
    const onKeyDown = (event) => {
      if (!event || event.isComposing) return
      // Ctrl+V (not Cmd+V)
      if (event.ctrlKey && !event.metaKey && !event.altKey) {
        if (typeof event.key === 'string' && event.key.toLowerCase() === 'v') {
          event.preventDefault()
          event.stopPropagation()
          doPastePaths()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  const onClick = (e) => {
    e.preventDefault()
    e.stopPropagation()
    doPastePaths()
  }

  return React.createElement(
    'button',
    {
      type: 'button',
      className: ready ? 'dshpp-btn is-ready' : 'dshpp-btn',
      title: '点击或按 Ctrl+V 插入剪贴板中的文件绝对路径',
      onClick,
    },
    React.createElement(
      'span',
      { className: 'dshpp-btn-icon' },
      React.createElement(
        'svg',
        {
          width: '12',
          height: '12',
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '2',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        React.createElement('path', {
          d: 'M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2',
        }),
        React.createElement('rect', {
          x: '8',
          y: '2',
          width: '8',
          height: '4',
          rx: '1',
          ry: '1',
        })
      )
    ),
    React.createElement('kbd', null, 'Ctrl'),
    '+',
    React.createElement('kbd', null, 'V'),
    ' 贴路径'
  )
}

function DropOverlayContainer() {
  const [dragActive, setDragActive] = React.useState(false)
  const [toast, setToast] = React.useState(toastState)
  const dragDepth = React.useRef(0)

  React.useEffect(() => {
    const listener = () => setToast(toastState)
    toastListeners.add(listener)
    return () => {
      toastListeners.delete(listener)
    }
  }, [])

  React.useEffect(() => {
    const hasFiles = (e) => {
      const dt = e.dataTransfer
      return Boolean(dt && dt.types && (dt.types.includes('Files') || dt.types.includes('public.file-url')))
    }

    const reset = () => {
      dragDepth.current = 0
      setDragActive(false)
    }

    const onDragEnter = (e) => {
      if (!hasFiles(e)) return
      // If it is ONLY images, let DSH native image attachment handle it
      if (isFilesOnlyImages(e.dataTransfer)) {
        return
      }
      e.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    }

    const onDragOver = (e) => {
      if (!hasFiles(e)) return
      if (isFilesOnlyImages(e.dataTransfer)) {
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }

    const onDragLeave = (e) => {
      if (!hasFiles(e)) return
      if (isFilesOnlyImages(e.dataTransfer)) {
        return
      }
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) {
        setDragActive(false)
      }
    }

    const onDrop = async (e) => {
      if (!hasFiles(e)) return
      if (isFilesOnlyImages(e.dataTransfer)) {
        reset()
        return // Leave for native handler
      }
      e.preventDefault()
      e.stopPropagation()
      reset()

      const files = [...(e.dataTransfer.files || [])].map((f) => ({
        name: f.name,
        size: f.size,
        type: f.type,
      }))

      if (files.length === 0) {
        // Dragging a folder or special file where files array is empty in browser
        // Send empty array to trigger Finder selection resolution
        files.push({ name: '', size: 0, type: '' })
      }

      try {
        const res = await requestJson(DROP_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ files }),
        })
        const paths = res && Array.isArray(res.paths) ? res.paths : []
        if (paths.length > 0) {
          insertPathsToComposer(paths)
        } else {
          showToast('无法解析被拖拽文件的绝对路径', true)
        }
      } catch (err) {
        showToast(err && err.message ? err.message : '解析拖拽路径失败', true)
      }
    }

    window.addEventListener('dragenter', onDragEnter, true)
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('dragleave', onDragLeave, true)
    window.addEventListener('drop', onDrop, true)
    window.addEventListener('dragend', reset)

    return () => {
      window.removeEventListener('dragenter', onDragEnter, true)
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('dragleave', onDragLeave, true)
      window.removeEventListener('drop', onDrop, true)
      window.removeEventListener('dragend', reset)
    }
  }, [])

  return React.createElement(
    React.Fragment,
    null,
    dragActive &&
      React.createElement(
        'div',
        { className: 'dshpp-drop-overlay' },
        React.createElement(
          'div',
          { className: 'dshpp-drop-card' },
          React.createElement(
            'div',
            { className: 'dshpp-drop-card-icon' },
            React.createElement(
              'svg',
              {
                width: '36',
                height: '36',
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: '2',
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              },
              React.createElement('path', {
                d: 'M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z',
              }),
              React.createElement('polyline', { points: '13 2 13 9 20 9' }),
              React.createElement('line', { x1: '12', y1: '11', x2: '12', y2: '17' }),
              React.createElement('polyline', { points: '9 14 12 17 15 14' })
            )
          ),
          React.createElement('div', { className: 'dshpp-drop-card-title' }, '释放以填入绝对路径'),
          React.createElement(
            'div',
            { className: 'dshpp-drop-card-desc' },
            '自动将文件或文件夹在系统中的完整路径注入到输入框中'
          )
        )
      ),
    toast !== null &&
      React.createElement(
        'div',
        { className: toast.isError ? 'dshpp-toast is-error' : 'dshpp-toast' },
        toast.text
      )
  )
}

function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return

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
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (hidden) stopPeek()
    else startPeek()
  }

  remoteDisabled = false
  stopPeekHook = stopPeek
  startPeek()
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', refreshPeek)
  }

  ctx.effect(() => () => {
    if (stopPeekHook === stopPeek) stopPeekHook = null
    stopPeek()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', refreshPeek)
    }
    if (toastTimer !== null) clearTimeout(toastTimer)
    toastListeners.clear()
    peekListeners.clear()
  })

  // Register Button in composer input left tool row
  slots.inject('conversation.input.left', () =>
    slots.register(
      { name: 'conversation.input.left', id: 'dsh-paste-path', order: 30, label: '贴路径' },
      () => React.createElement(PathButton, null)
    )
  )

  // Register Global Drop Overlay & Toast in shell overlay
  slots.inject('shell.overlay', () =>
    slots.register(
      { name: 'shell.overlay', id: 'dsh-paste-path-overlay', order: 90, label: '拖拽路径与提示' },
      () => React.createElement(DropOverlayContainer, null)
    )
  )
}

module.exports = { name: 'dsh-paste-path', apply }
