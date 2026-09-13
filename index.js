import { spawn, execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isLoopbackAddress, isSameOriginMutation, parsePaths, normalizePathCandidate } from './paths.js'

const execFileAsync = promisify(execFile)

export const name = 'dsh-paste-path'
export const inject = []

const PEEK_ROUTE = '/dsh-paste-path/peek'
const PASTE_ROUTE = '/dsh-paste-path/paste'
const DROP_ROUTE = '/dsh-paste-path/resolve-drop'

const OSA_TIMEOUT_MS = 2500

const CHANGE_COUNT_SCRIPT = [
  'use framework "AppKit"',
  'use scripting additions',
  'set pb to current application\'s NSPasteboard\'s generalPasteboard',
  'return (pb\'s changeCount()) as text',
].join('\n')

const CLIPBOARD_APPLESCRIPT = [
  'use framework "AppKit"',
  'use framework "Foundation"',
  'use scripting additions',
  'set pb to current application\'s NSPasteboard\'s generalPasteboard',
  'set names to pb\'s propertyListForType:"NSFilenamesPboardType"',
  'set out to ""',
  'if names is not missing value then',
  '  set theList to names as list',
  '  repeat with p in theList',
  '    set out to out & (p as text) & linefeed',
  '  end repeat',
  'end if',
  'if out is "" then',
  '  set theText to pb\'s stringForType:"public.utf8-plain-text"',
  '  if theText is not missing value then set out to theText as text',
  'end if',
  'return out',
].join('\n')

const FINDER_SELECTION_JXA = `
(() => {
  try {
    const finder = Application("Finder");
    const selection = finder.selection();
    if (!selection || selection.length === 0) return "";
    return selection.map(item => {
      try { return item.url().replace(/^file:\\/\\//, ""); } catch(e) { return ""; }
    }).filter(Boolean).map(decodeURIComponent).join("\\n");
  } catch (e) {
    return "";
  }
})()
`

function writeToSystemClipboard(text) {
  return new Promise((resolve) => {
    try {
      const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', () => resolve())
      child.on('close', () => resolve())
      child.stdin.end(String(text || ''))
    } catch {
      resolve()
    }
  })
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

function readBodyJson(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function runScript(command, args, script) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, text: '', error: `${command} timed out` })
    }, OSA_TIMEOUT_MS)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      finish({ ok: false, text: '', error: errorMessage(error) })
    })
    child.on('close', (code) => {
      if (code === 0) finish({ ok: true, text: stdout, error: '' })
      else finish({ ok: false, text: stdout, error: stderr.trim() || `${command} exited ${code}` })
    })
    child.stdin.end(script)
  })
}

async function readChangeCount() {
  const ran = await runScript('osascript', [], CHANGE_COUNT_SCRIPT)
  if (!ran.ok) return null
  const n = Number(String(ran.text || '').trim())
  return Number.isFinite(n) ? n : null
}

async function readClipboardPaths(cache) {
  const changeCount = await readChangeCount()
  if (changeCount !== null && cache.lastChangeCount === changeCount) return cache.lastResult

  const ran = await runScript('osascript', [], CLIPBOARD_APPLESCRIPT)
  if (!ran.ok) {
    const result = {
      ready: false,
      count: 0,
      paths: [],
      error: ran.error.includes('osascript')
        ? '读取系统剪贴板失败。请确认本机允许自动化 / osascript。'
        : ran.error || '当前环境无法读取系统剪贴板。',
    }
    cache.lastChangeCount = changeCount
    cache.lastResult = result
    return result
  }
  const found = parsePaths(ran.text)
  const paths = []
  for (const raw of found) paths.push({ path: raw, ok: true })
  const result = {
    ready: paths.length > 0,
    count: paths.length,
    paths,
  }
  cache.lastChangeCount = changeCount
  cache.lastResult = result
  return result
}

async function getFinderSelectionPaths() {
  const ran = await runScript('osascript', ['-l', 'JavaScript'], FINDER_SELECTION_JXA)
  if (!ran.ok || !ran.text.trim()) return []
  return parsePaths(ran.text)
}

async function fallbackFindPath(name, size) {
  try {
    const { stdout } = await execFileAsync('mdfind', ['-name', name], { timeout: 2000 })
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return null

    // Exact filename match filter
    const exact = lines.filter(p => path.basename(p) === name)
    if (exact.length === 1) return exact[0]

    const candidates = exact.length > 0 ? exact : lines
    if (size !== undefined && size > 0) {
      for (const cand of candidates) {
        try {
          const stat = await fsPromises.stat(cand)
          if (stat.size === size) return cand
        } catch {
          // ignore
        }
      }
    }
    return candidates[0]
  } catch {
    return null
  }
}

async function resolveDroppedFiles(files, cache) {
  if (!Array.isArray(files) || files.length === 0) return []

  // 1. Try Finder selection first (best and exact for files dragged from Finder)
  const finderPaths = await getFinderSelectionPaths()
  if (finderPaths.length > 0) {
    if (files.length === 1) {
      // Single file or folder dropped
      const hit = finderPaths.find(p => path.basename(p) === files[0].name)
      return [hit || finderPaths[0]]
    }
    if (finderPaths.length === files.length) {
      return finderPaths
    }
    const matched = []
    for (const f of files) {
      const hit = finderPaths.find(p => path.basename(p) === f.name)
      if (hit) matched.push(hit)
    }
    if (matched.length > 0) return matched
    return finderPaths
  }

  // 2. Try clipboard paths as second heuristic (user may have selected/copied file)
  try {
    const clip = await readClipboardPaths(cache || { lastChangeCount: null, lastResult: null })
    if (clip && clip.ready && clip.paths.length > 0) {
      const cPaths = clip.paths.map(p => p.path)
      if (files.length === 1) {
        const hit = cPaths.find(p => path.basename(p) === files[0].name)
        if (hit) return [hit]
        if (!files[0].name) return [cPaths[0]]
      }
    }
  } catch {}

  // 3. Fallback to mdfind search per file
  const resolved = []
  for (const f of files) {
    if (!f || !f.name) continue
    const found = await fallbackFindPath(f.name, f.size)
    if (found) resolved.push(found)
  }
  return resolved
}

function rejectUnlessLocal(req, res) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    sendJson(res, 403, {
      error: 'dsh-paste-path reads the filesystem/clipboard of the machine running `dsh web`; remote browsers are not supported.',
      code: 'remote-not-supported',
    })
    return true
  }
  return false
}

function registerRoutes(ctx) {
  const cache = {
    lastChangeCount: null,
    lastResult: { ready: false, count: 0, paths: [] },
  }

  ctx.inject(['webServer'], (web) => {
    const webServer = web.get('webServer')

    web.effect(() => webServer.register({
      kind: 'exact',
      path: PEEK_ROUTE,
      async handler(req, res) {
        if (rejectUnlessLocal(req, res)) return
        if (req.method !== 'GET') {
          res.setHeader('allow', 'GET')
          sendJson(res, 405, { error: 'Method not allowed.' })
          return
        }
        try {
          let result = await readClipboardPaths(cache)
          if (!result.ready) {
            const fPaths = await getFinderSelectionPaths()
            if (fPaths.length > 0) {
              result = { ready: true, count: fPaths.length }
            }
          }
          sendJson(res, 200, { ready: result.ready, count: result.count })
        } catch (error) {
          sendJson(res, 500, { error: errorMessage(error) })
        }
      },
    }), 'dsh-paste-path: peek')

    web.effect(() => webServer.register({
      kind: 'exact',
      path: PASTE_ROUTE,
      async handler(req, res) {
        if (rejectUnlessLocal(req, res)) return
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { error: 'Method not allowed.' })
          return
        }
        if (!isSameOriginMutation(req)) {
          sendJson(res, 403, { error: 'Paste requests require a same-origin browser request.' })
          return
        }
        try {
          let result = await readClipboardPaths(cache)
          if (!result.ready || result.paths.length === 0) {
            const fPaths = await getFinderSelectionPaths()
            if (fPaths.length > 0) {
              result = { ready: true, count: fPaths.length, paths: fPaths.map(p => ({ path: p, ok: true })) }
            }
          }
          if (!result.ready || result.paths.length === 0) {
            sendJson(res, 200, {
              paths: [],
              error: '剪贴板与访达中均未发现选中的文件路径。请在访达中选中文件后重试。',
            })
            return
          }
          const allPaths = result.paths.map(p => p.path); writeToSystemClipboard(allPaths.join(String.fromCharCode(10))); sendJson(res, 200, { paths: allPaths });
        } catch (error) {
          sendJson(res, 500, { error: errorMessage(error) })
        }
      },
    }), 'dsh-paste-path: paste')

    web.effect(() => webServer.register({
      kind: 'exact',
      path: DROP_ROUTE,
      async handler(req, res) {
        if (rejectUnlessLocal(req, res)) return
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { error: 'Method not allowed.' })
          return
        }
        if (!isSameOriginMutation(req)) {
          sendJson(res, 403, { error: 'Drop requests require a same-origin browser request.' })
          return
        }
        try {
          const body = await readBodyJson(req)
          const files = Array.isArray(body.files) ? body.files : []
          const paths = await resolveDroppedFiles(files, cache)
          sendJson(res, 200, { ok: true, paths })
        } catch (error) {
          sendJson(res, 500, { error: errorMessage(error) })
        }
      },
    }), 'dsh-paste-path: resolve-drop')
  })
}

export function apply(ctx) {
  if (process.platform !== 'darwin') {
    console.log('dsh-paste-path: skipped on ' + process.platform + ' (macOS only)')
    return
  }
  registerRoutes(ctx)
}
