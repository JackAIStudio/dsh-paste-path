import fsPromises from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'

export function normalizePathCandidate(raw) {
  let value = String(raw || '').trim()
  if (value === '' || value.startsWith('#')) return ''
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  if (value.startsWith('file://localhost')) value = value.slice(16)
  else if (value.startsWith('file://')) value = value.slice(7)
  try {
    value = decodeURIComponent(value)
  } catch {
    // Keep raw value if not URI-encoded
  }
  if (typeof value.normalize === 'function') value = value.normalize('NFC')
  return value.startsWith('/') ? value : ''
}

export function parsePaths(text) {
  const lines = String(text || '').split(/\r?\n/)
  const paths = []
  const seen = {}
  let sawContent = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    sawContent = true
    const value = normalizePathCandidate(line)
    if (!value) return []
    if (seen[value]) continue
    seen[value] = true
    paths.push(value)
  }
  return sawContent ? paths : []
}

export async function inspectSinglePath(filePath) {
  const norm = normalizePathCandidate(filePath)
  if (!norm) return null
  const isApp = norm.endsWith('.app') || norm.endsWith('.app/')
  const cleanPath = norm.replace(/\/+$/, '')
  const name = path.basename(cleanPath)
  let isDirectory = isApp
  let exists = false
  let size = 0
  try {
    const stat = await fsPromises.stat(cleanPath)
    exists = true
    isDirectory = isApp || stat.isDirectory()
    size = stat.size
  } catch {}

  return {
    path: cleanPath,
    name,
    type: isApp ? 'app' : (isDirectory ? 'folder' : 'file'),
    isApp,
    isDirectory,
    size,
    exists,
  }
}

/**
 * macOS 文件名变体：Finder 显示的 `/` 与磁盘上的 `:` 是同一个字符。
 *
 * Finder 沿用 HFS 时代的老规矩，把文件名里的 `:` 显示成 `/`。所以同一个屏幕录制
 * 工程，从访达拖进来时 DataTransfer 里的名字可能是磁盘形态
 * `Area 2026-09-22 20:40:01.screenstudio`，也可能是显示形态
 * `Area 2026-09-22 20/40/01.screenstudio`。两个方向都得能对上。
 *
 * 注意：含 `/` 的写法不能直接拿去拼路径（会被当成子目录），所以这里只保留能当
 * 文件名用的形态 —— 磁盘形态。
 *
 * @param raw - 拖入项的名字（可能是 Finder 显示形态）。
 * @returns 可当作文件名的候选名（不会含 `/`）。
 */
export function macNameVariants(raw) {
  const value = String(raw || '').trim()
  if (value === '') return []
  const variants = []
  const push = (candidate) => {
    if (candidate && !candidate.includes('/') && !variants.includes(candidate)) variants.push(candidate)
  }
  push(value)
  if (value.includes('/')) push(value.replace(/\//g, ':'))
  return variants
}

/**
 * 「文件名 → 绝对路径」的快速一层查找。
 *
 * 为什么需要它（这是真机上必须的兜底）：
 * JackDSH 是 Electron 应用，renderer 关掉了 nodeIntegration、开了 contextIsolation，
 * 而 Electron 又移除了 `File.path`，所以插件在**前端永远拿不到拖入项的绝对路径**。
 * 唯一能补上的地方就是服务端：它在同一台机器上，可以直接去文件系统里找。
 *
 * 实测教训：
 *   - 只搜 /Applications 那几个目录，「下载」里的东西一个都找不到；
 *   - 只靠 `mdfind -name`，「下载」里没被 Spotlight 索引的目录**零命中**；
 *   - 目录不是普通文件，无法用体积比对，所以候选要按「优先常见位置 + 浅层」排序。
 *
 * @param name - 拖入项的名字（basename）。
 * @param depth - 在常见目录里向下搜的层数。
 * @returns 绝对路径或 null。
 */
export function fastFindByName(name, depth = 2) {
  if (!name || typeof name !== 'string') return null
  // 先折算形态、再取最后一段。顺序不能反：`Area 2026-09-22 20/40/01.screenstudio`
  // 这种 Finder 显示名如果先走 path.basename，会被当成路径而只剩 `01.screenstudio`。
  const bases = macNameVariants(name.trim())
    .map((value) => path.basename(value))
    .filter((value) => value !== '' && value !== '.' && value !== '..')
  if (bases.length === 0) return null

  const home = process.env.HOME || ''
  // 每项是 [目录, 向下搜索的层数]
  const seeds = [
    [path.join(home, 'Downloads'), depth],
    [path.join(home, 'Desktop'), depth],
    [path.join(home, 'Documents'), depth],
    [path.join(home, 'Movies'), depth],
    [path.join(home, 'Pictures'), depth],
    [path.join(home, 'Music'), depth],
    [path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'), depth],
    ['/Applications', depth],
    ['/System/Applications', depth],
    ['/System/Applications/Utilities', depth],
    ['/System/Library/CoreServices', depth],
    [path.join(home, 'Applications'), depth],
    ['/tmp', depth],
    // 家目录只扫一层：工作目录常直接挂在 ~ 下（例如 ~/Screen Studio Projects），
    // 它不在上面任何种子目录里 —— 拖拽识别失败最常见的现场就在这里。
    [home, Math.min(depth, 1)],
  ]

  const hits = []
  const seen = new Set()
  const push = (candidate) => {
    if (!candidate || seen.has(candidate)) return
    seen.add(candidate)
    hits.push(candidate)
  }

  const walk = (dir, level, baseName) => {
    const target = path.join(dir, baseName)
    try {
      if (fs.existsSync(target)) push(target)
    } catch {}
    if (level <= 0) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      walk(path.join(dir, entry.name), level - 1, baseName)
    }
  }

  for (const [seed, seedDepth] of seeds) {
    try {
      if (!fs.existsSync(seed)) continue
    } catch {
      continue
    }
    // 种子目录本身就是目标（例如用户拖的就是 ~/Downloads）：先认下它，
    // 免得被种子内部更深的同名项抢走 —— 那种结果看着像路径，其实指错了地方。
    if (bases.includes(path.basename(seed))) push(seed)
    for (const baseName of bases) walk(seed, seedDepth, baseName)
  }

  if (hits.length === 0) return null
  // 顺序已经是「常见位置优先 + 浅层优先」（walk 是先看自己再看子目录），直接取第一个
  return hits[0]
}

/** 兼容旧调用：.app 的专门查找（现在直接用通用查找即可）。 */
export function fastFindAppPath(name) {
  if (!name || typeof name !== 'string') return null
  const appName = name.endsWith('.app') ? name : `${name}.app`
  const searchDirs = [
    '/Applications',
    '/System/Applications',
    '/System/Applications/Utilities',
    path.join(process.env.HOME || '/Users/jkw', 'Applications'),
  ]
  for (const dir of searchDirs) {
    const target = path.join(dir, appName)
    try {
      if (fs.existsSync(target)) return target
    } catch {}
  }
  return fastFindByName(appName)
}

export function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export function isSameOriginMutation(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string') return false
  try {
    const hostname = new URL(`http://${host}`).hostname
    if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
  } catch {
    return false
  }
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
    } catch {
      return false
    }
  }
  return req.headers['sec-fetch-site'] === 'same-origin'
}
