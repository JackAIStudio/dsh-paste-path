import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePathCandidate,
  parsePaths,
  isLoopbackAddress,
  inspectSinglePath,
  fastFindAppPath,
  fastFindByName,
} from '../paths.js'

test('normalizePathCandidate trims and handles quotes', () => {
  assert.equal(normalizePathCandidate('  "/Users/jkw/test.mp4"  '), '/Users/jkw/test.mp4')
  assert.equal(normalizePathCandidate("'/Users/jkw/folder'"), '/Users/jkw/folder')
})

test('normalizePathCandidate handles file:// URLs', () => {
  assert.equal(normalizePathCandidate('file:///Users/jkw/test%20file.txt'), '/Users/jkw/test file.txt')
  assert.equal(normalizePathCandidate('file://localhost/Users/jkw/test.txt'), '/Users/jkw/test.txt')
})

test('parsePaths parses multi-line paths and ignores empty/comment lines', () => {
  const input = `
/Users/jkw/file1.mov
# comment
/Users/jkw/file2.mp4

/Users/jkw/file1.mov
`
  const result = parsePaths(input)
  assert.deepEqual(result, ['/Users/jkw/file1.mov', '/Users/jkw/file2.mp4'])
})

test('isLoopbackAddress identifies 127.0.0.1 and ::1', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.100'), false)
})

test('fastFindAppPath finds macOS applications', () => {
  const jackVoice = fastFindAppPath('JackVoice.app')
  assert.equal(jackVoice, '/Applications/JackVoice.app')

  const macWorkbench = fastFindAppPath('mac工作台.app')
  assert.equal(macWorkbench, '/Applications/mac工作台.app')

  const clock = fastFindAppPath('Clock.app')
  assert.equal(clock, '/System/Applications/Clock.app')

  const safari = fastFindAppPath('Safari.app')
  assert.equal(Boolean(safari && safari.includes('Safari.app')), true)
})

test('inspectSinglePath accurately inspects apps, folders, and files', async () => {
  const appInfo = await inspectSinglePath('/Applications/JackVoice.app')
  assert.equal(appInfo.name, 'JackVoice.app')
  assert.equal(appInfo.type, 'app')
  assert.equal(appInfo.isApp, true)
  assert.equal(appInfo.isDirectory, true)
  assert.equal(appInfo.exists, true)

  const folderInfo = await inspectSinglePath('/Applications')
  assert.equal(folderInfo.name, 'Applications')
  assert.equal(folderInfo.type, 'folder')
  assert.equal(folderInfo.isApp, false)
  assert.equal(folderInfo.isDirectory, true)
  assert.equal(folderInfo.exists, true)

  const pkgJsonInfo = await inspectSinglePath(new URL('../package.json', import.meta.url).pathname)
  assert.equal(pkgJsonInfo.name, 'package.json')
  assert.equal(pkgJsonInfo.type, 'file')
  assert.equal(pkgJsonInfo.isApp, false)
  assert.equal(pkgJsonInfo.isDirectory, false)
  assert.equal(pkgJsonInfo.exists, true)
})

test('fastFindByName 能在「下载」里找到目录/.app（含名字里带冒号的）', () => {
  // 真机背景：JackDSH 是 Electron，renderer 关了 nodeIntegration、开了 contextIsolation，
  // Electron 又移除了 File.path —— 所以拖入项的绝对路径只能由服务端找回来。
  // 而 `mdfind -name` 对没被 Spotlight 索引的目录是零命中，必须有本地目录搜索兜底。
  const clock = fastFindByName('Clock.app')
  assert.ok(clock && clock.endsWith('Clock.app'), 'Clock.app 应该能找到')

  const folder = fastFindByName('Downloads')
  assert.ok(folder && folder.endsWith('/Downloads'), 'Downloads 应该能找到')
})

test('fastFindByName 对不存在的名字返回 null（不抛错、不瞎猜）', () => {
  assert.equal(fastFindByName('绝对不存在的玩意-9f3a2b.xyz'), null)
  assert.equal(fastFindByName(''), null)
  assert.equal(fastFindByName(null), null)
  assert.equal(fastFindByName('..'), null)
  assert.equal(fastFindByName('.'), null)
})

test('fastFindByName 优先返回常见位置（浅层优先）', () => {
  // 先看种子目录本身、再看子目录，所以「下载/名字」会排在更深的位置前面
  const hit = fastFindByName('Downloads')
  assert.ok(hit !== null)
  assert.ok(!hit.includes('/Downloads/'), '应该优先命中 ~/Downloads 本身而不是它里面的同名项')
})

test('fastFindAppPath 仍然只认标准应用目录，且能兜到通用查找', () => {
  assert.equal(fastFindAppPath('Clock.app'), '/System/Applications/Clock.app')
  assert.equal(fastFindAppPath('mac工作台.app'), '/Applications/mac工作台.app')
  assert.equal(fastFindAppPath('绝不存在-3a9.app'), null)
})
