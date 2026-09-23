import { spawn, execFile } from 'node:child_process'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  isLoopbackAddress,
  isSameOriginMutation,
  parsePaths,
  normalizePathCandidate,
  inspectSinglePath,
  fastFindAppPath,
  fastFindByName,
  macNameVariants,
} from './paths.js'

const execFileAsync = promisify(execFile)

export const name = 'dsh-paste-path'
export const inject = []

const DIAG_ROUTE = '/dsh-paste-path/diag'
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

/**
 * 诊断落盘：把前端拖拽时的真实数据写进 ~/.dsh/dsh-paste-path-diag.log。
 * 用途：拖拽问题只能在真实客户端复现，浏览器自动化无法模拟 macOS 原生拖拽
 * （BrowserSkill 的拦截层会直接返回 501），所以让运行时自己把证据留下来。
 */
function diagLogPath() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-paste-path-diag.log')
}

function appendDiag(entry) {
  const line = `${new Date().toISOString()} ${JSON.stringify(entry)}\n`
  try {
    fs.appendFileSync(diagLogPath(), line)
  } catch {
    // 诊断不能影响主流程
  }
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

/**
 * 「文件名 → 绝对路径」的兜底解析。
 *
 * 关键背景：JackDSH 是 Electron，renderer 关了 nodeIntegration、开了 contextIsolation，
 * 而 Electron 又移除了 `File.path`。所以拖进来的目录/.app **在前端拿不到绝对路径**，
 * 只能由同机的服务端去文件系统里找回来。
 *
 * 三级策略（按可靠性排序）：
 *   1. 直接去常见目录按名字找（含子目录）—— 实测最快最准：
 *      `.screenstudio` 86ms、`暂存` 11ms 就命中，且不依赖 Spotlight 索引。
 *   2. `.app` 再去标准应用目录快速确认一次。
 *   3. 最后用 `mdfind`，并对候选排序（精确同名的、路径浅的优先）。
 */
async function fallbackFindPath(name, size) {
  if (!name || typeof name !== 'string') return null

  // 1. 直接按名字在常见目录里找
  try {
    const hit = fastFindByName(name)
    if (hit) return hit
  } catch {}

  // 2. .app 的标准位置
  try {
    if (name.endsWith('.app') || !path.extname(name)) {
      const appHit = fastFindAppPath(name)
      if (appHit) return appHit
    }
  } catch {}

  // 3. mdfind 兜底。
  //
  // 查询词要用 Finder 显示形态（磁盘上的冒号换成斜杠）：实测
  // `mdfind -name 'Area 2026-09-22 20:40:01.screenstudio'` 对没被 Spotlight
  // 索引好的目录零命中，而 `Area 2026-09-22 20/40/01.screenstudio` 能命中。
  // 拿回结果后 basename 再按同一套规则归一化比对，否则精确筛选会把真命中筛掉。
  try {
    const queryForms = [...new Set(macNameVariants(name).map(f => f.replace(/:/g, '/')))]
    const lines = []
    for (const form of queryForms) {
      try {
        const { stdout } = await execFileAsync('mdfind', ['-name', form], { timeout: 2000 })
        for (const line of stdout.split('\n')) {
          const value = line.trim()
          if (value && !lines.includes(value)) lines.push(value)
        }
      } catch {}
      if (lines.length > 0) break
    }
    if (lines.length === 0) return null

    const canonical = (value) => String(value).replace(/:/g, '/')
    const wanted = canonical(name)
    const exact = lines.filter(p => canonical(path.basename(p)) === wanted)

    // 体积只能用于普通文件；目录的 stat.size 是元数据大小，拿来比会误判。
    if (size !== undefined && size > 0) {
      for (const cand of exact.length > 0 ? exact : lines) {
        try {
          const stat = await fsPromises.stat(cand)
          if (stat.isFile() && stat.size === size) return cand
        } catch {}
      }
    }

    if (exact.length > 0) {
      // 多个同名时取路径最浅的（通常是用户真正拖的那个）
      exact.sort((a, b) => a.split('/').length - b.split('/').length)
      return exact[0]
    }
    return null
  } catch {
    return null
  }
}

async function resolveDroppedFiles(files, cache) {
  if (!Array.isArray(files) || files.length === 0) return []

  // 1. Try clipboard paths as first heuristic (user may have selected/copied file)
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

  // 2. Fallback to fast app search / mdfind search per file
  const resolved = []
  for (const f of files) {
    if (!f || !f.name) continue
    const hit = await fallbackFindPath(f.name, f.size)
    if (hit) resolved.push(hit)
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
      path: DIAG_ROUTE,
      async handler(req, res) {
        if (rejectUnlessLocal(req, res)) return
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST')
          sendJson(res, 405, { error: 'Method not allowed.' })
          return
        }
        if (!isSameOriginMutation(req)) {
          sendJson(res, 403, { error: 'Diagnostic requests require a same-origin browser request.' })
          return
        }
        try {
          const body = await readBodyJson(req)
          appendDiag(body && typeof body === 'object' ? body : { raw: String(body) })
          sendJson(res, 200, { ok: true, file: diagLogPath() })
        } catch (error) {
          sendJson(res, 500, { error: errorMessage(error) })
        }
      },
    }), 'dsh-paste-path: diag')

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
          const result = await readClipboardPaths(cache)
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
          const result = await readClipboardPaths(cache)
          if (!result.ready || result.paths.length === 0) {
            sendJson(res, 200, {
              paths: [],
              error: '剪贴板中未检测到复制的文件或有效路径。请先在访达中复制文件（Cmd+C）。',
            })
            return
          }
          const allPaths = result.paths.map(p => p.path)
          writeToSystemClipboard(allPaths.join(String.fromCharCode(10)))
          const items = (await Promise.all(allPaths.map(p => inspectSinglePath(p)))).filter(Boolean)
          sendJson(res, 200, { paths: allPaths, items })
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
