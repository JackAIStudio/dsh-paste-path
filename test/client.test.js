/**
 * 纯逻辑单测：路径判定、去重、插入规划。
 *
 * 这里**只**测不依赖 DOM 的纯函数。
 *
 * 为什么不做 DOM 桩测试：上一版用桩测过，结果是绿的，但在真实 Chromium 里
 * 路径根本插不进去（beforeinput 在原生 DOM 上是空操作）——桩把关键行为假造了，
 * 反而给出了错误的安全感。真实 DOM 行为请跑 test/manual/probe.html，
 * 那是真实浏览器里的端到端实测。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 让 client/app.js 能在 Node 里被求值，取出内部纯函数。
 *
 * windowStub 用来模拟桌面壳（JackDSH 的 preload 桥）：不传就是浏览器环境。
 */
function loadInternalsWithWindow(windowStub) {
  const src = readFileSync(join(root, 'client/app.js'), 'utf8')
  const module = { exports: {} }
  const fn = new Function('module', 'exports', 'window', 'document', src + '\n;return module.exports')
  const exports = fn(module, module.exports, windowStub, undefined)
  return exports.__internals
}

function loadInternals() {
  return loadInternalsWithWindow(undefined)
}

const I = loadInternals()

/* ---------------------------------------------------------------- 路径判定 */

test('只有目录和 .app 归插件管，其余一律放行官方', () => {
  assert.equal(I.isDirectoryLike({ name: 'JackVoice.app', type: '' }), true)
  assert.equal(I.isDirectoryLike({ name: 'mac工作台.app', type: 'application/octet-stream' }), true)
  assert.equal(I.isDirectoryLike({ name: '2026-09-17', type: '' }), true)
  assert.equal(I.isDirectoryLike({ name: 'Desktop', type: '' }), true)
})

test('有扩展名的普通文件绝不拦截（官方 0.1.5 原生支持）', () => {
  for (const name of ['发布文案.md', '成片.mov', 'a.mp4', 'b.pdf', 'c.zip', 'd.txt', 'e.json', 'f.docx']) {
    assert.equal(I.isDirectoryLike({ name, type: '' }), false, `${name} 不该被拦截`)
  }
})

test('图片放行给原生多模态', () => {
  assert.equal(I.isDirectoryLike({ name: 'shot.png', type: 'image/png' }), false)
  assert.equal(I.isDirectoryLike({ name: 'photo.heic', type: '' }), false)
  assert.equal(I.isDirectoryLike({ name: 'a.webp', type: '' }), false)
  assert.equal(I.isImageFile('封面.PNG', ''), true)
  assert.equal(I.isImageFile('x', 'image/jpeg'), true)
})

test('macOS 包（bundle）必须归我们：它们看着像文件，底层是目录', () => {
  // 实测踩过的坑：Area ….screenstudio 被当成普通文件丢给官方，
  // 官方对目录取字节流 EISDIR 失败 → 该文件**静默消失**（不弹卡片、不报错）。
  const bundles = [
    'Area 2026-08-29 19_27_28.screenstudio',
    '剪辑.fcpbundle',
    '笔记.rtfd',
    '项目.xcodeproj',
    '库.photoslibrary',
    '插件.plugin',
    'X.app',
  ]
  for (const name of bundles) {
    assert.equal(I.isMacosBundle(name), true, `${name} 应被认成 macOS 包`)
    assert.equal(I.isDirectoryLike({ name, type: '' }), true, `${name} 应归插件`)
    assert.equal(I.isNativelySupported({ name, type: '' }), false, `${name} 不该交给官方`)
  }
})

test('普通文件绝不能被误判成 macOS 包（误判会让它变成一行路径）', () => {
  // .lnk 是 Windows 快捷方式，是**文件**不是包 —— 误判成包会让它不再上传而是变成路径
  for (const name of ['百度网盘.lnk', '说明.md', '视频.mp4', '图.jpg', '包.zip', '表.csv', '稿.docx']) {
    assert.equal(I.isMacosBundle(name), false, `${name} 不是 macOS 包`)
  }
})

test('分类取向：宁可误判成目录，也不误判成文件', () => {
  // 误判成目录 → 多一行路径，模型照样能读，无害
  // 误判成文件 → 官方读目录失败，用户看到东西凭空消失，有害
  // 所以这里断言「已知的包一个都不能漏」
  const mustBeOurs = ['X.app', 'a.screenstudio', 'b.fcpbundle', 'c.rtfd', 'd.xcodeproj', '无扩展名目录']
  for (const name of mustBeOurs) {
    assert.equal(I.isDirectoryLike({ name, type: '' }), true, `${name} 绝不能漏出去`)
  }
})

test('混合拖拽（图片 + 文件夹）必须被精确分流，不能二选一', () => {
  // 用 items 构造，模拟访达里的真实拖拽：图片、txt、文件夹混在一起
  const mk = (name, type) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => ({ name, type }) })
  const mkDir = (name) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => ({ name, type: '' }) })

  const dt = {
    files: [],
    items: [
      mk('截屏 2026-09-16 11.15.47.png', 'image/png'),
      mkDir('同步空间'),
      mk('Timeline 3_字幕轨1_1_TXT.txt', 'text/plain'),
      mkDir('封面'),
      mk('成片.mov', 'video/quicktime'),
    ],
  }

  const { targets, natives } = I.classifyTransfer(dt)
  assert.deepEqual(targets.map((f) => f.name).sort(), ['同步空间', '封面'])
  assert.deepEqual(
    natives.map((f) => f.name).sort(),
    ['Timeline 3_字幕轨1_1_TXT.txt', '成片.mov', '截屏 2026-09-16 11.15.47.png'].sort()
  )
})

test('混合拖拽里含包时，包不能被交给官方', () => {
  const dt = {
    files: [],
    items: [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => ({ name: '剪辑.mp4', type: 'video/mp4' }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => ({ name: 'Area 2026-08-29 19_27_28.screenstudio', type: '' }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => ({ name: '构图对比.jpg', type: 'image/jpeg' }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => ({ name: '暂存', type: '' }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => ({ name: '百度网盘.lnk', type: '' }) },
    ],
  }
  const { targets, natives } = I.classifyTransfer(dt)
  const t = targets.map((f) => f.name)
  const n = natives.map((f) => f.name)

  assert.deepEqual(t.sort(), ['Area 2026-08-29 19_27_28.screenstudio', '暂存'].sort())
  assert.ok(n.includes('剪辑.mp4'), 'mp4 归官方')
  assert.ok(n.includes('构图对比.jpg'), 'jpg 归官方')
  assert.ok(n.includes('百度网盘.lnk'), '.lnk 是文件，归官方')
  assert.ok(!n.includes('Area 2026-08-29 19_27_28.screenstudio'), '包绝不能交给官方')
})

test('分类严格互补：任取一个文件，要么归我们、要么归官方，绝不两边都算或都不算', () => {
  const samples = [
    { name: 'a.png', type: 'image/png' },
    { name: 'b.mov', type: 'video/quicktime' },
    { name: 'c.md', type: '' },
    { name: 'd', type: '' },
    { name: 'E.app', type: '' },
    { name: 'f.zip', type: 'application/zip' },
    { name: 'g', type: 'application/octet-stream' },
  ]
  for (const f of samples) {
    const mine = I.isDirectoryLike(f)
    const theirs = I.isNativelySupported(f)
    assert.notEqual(mine, theirs, `${f.name} 必须恰好归一方`)
  }
})

test('访达 Cmd+V 粘贴（clipboard 常常没有 webkitGetAsEntry）仍能认出目录', () => {
  // Chromium 从访达粘贴文件夹时，items 有 kind=file，但 webkitGetAsEntry 可能缺席。
  // 必须靠 isDirectoryLike（无扩展名 + 空 MIME）判成目录，否则官方会去上传并红框失败。
  const mkPaste = (name, type) => ({ kind: 'file', getAsFile: () => ({ name, type }) })
  const dt = {
    files: [{ name: '暂存', type: '' }],
    items: [
      mkPaste('image.png', 'image/png'),
      mkPaste('暂存', ''),
      mkPaste('说明.md', ''),
    ],
  }
  const { targets, natives } = I.classifyTransfer(dt)
  assert.deepEqual(targets.map((f) => f.name), ['暂存'])
  assert.deepEqual(natives.map((f) => f.name).sort(), ['image.png', '说明.md'].sort())
})

test('粘贴截图不得拦截：纯图片必须放行给官方多模态', () => {
  const dt = {
    files: [{ name: 'image.png', type: 'image/png' }],
    items: [{ kind: 'file', getAsFile: () => ({ name: 'image.png', type: 'image/png' }) }],
  }
  const { targets, natives } = I.classifyTransfer(dt)
  assert.equal(targets.length, 0)
  assert.deepEqual(natives.map((f) => f.name), ['image.png'])
})

test('getAsFile 对目录返回 null 时，用 entry.name 占位，不能把事件吞掉却插不了路径', () => {
  const dt = {
    files: [],
    items: [
      {
        kind: 'file',
        webkitGetAsEntry: () => ({ isDirectory: true, name: '暂存' }),
        getAsFile: () => null,
      },
    ],
  }
  const { targets, natives } = I.classifyTransfer(dt)
  assert.equal(natives.length, 0)
  assert.deepEqual(targets.map((f) => f.name), ['暂存'])
})

test('collectTargets 去重并同时看 files 与 items', () => {
  const dt = {
    files: [{ name: 'A.app', type: '' }, { name: 'note.md', type: '' }],
    items: [
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => ({ name: 'Folder', type: '' }) },
      { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => ({ name: 'A.app', type: '' }) },
      { kind: 'string' },
    ],
  }
  const names = I.collectTargets(dt).map((f) => f.name).sort()
  assert.deepEqual(names, ['A.app', 'Folder'])
})

/* ------------------------------------------------------------ 文本归一比较 */

test('squash 去掉所有空白，让视觉折行与真实换行等价', () => {
  assert.equal(I.squash('a\nb'), 'ab')
  assert.equal(I.squash('  a   b  '), 'ab')
  assert.equal(I.squash('a\n\nb'), 'ab')
  assert.equal(I.squash(''), '')
})

test('readbackMatches 容忍编辑器吞掉末尾换行与视觉折行', () => {
  const target = '/Applications/青椒云电脑.app\n/System/Applications/Clock.app'
  assert.equal(I.readbackMatches(target, target), true)
  assert.equal(I.readbackMatches(target + '\n', target), true)
  // 编辑器把长路径按视觉折行
  assert.equal(I.readbackMatches('/Applications/青椒云\n电脑.app', '/Applications/青椒云电脑.app'), true)
})

test('textHasPath 能认出被视觉折行的长路径', () => {
  const p = '/Users/jkw/Library/Mobile Documents/com~apple~CloudDocs/x'
  const rendered = '/Users/jkw/Library/Mobile\nDocuments/com~apple~CloudDocs/x'
  assert.equal(I.textHasPath(rendered, p), true)
  assert.equal(I.textHasPath('别的文字', p), false)
})

/* ------------------------------------------------------------------ 插入规划 */

test('空输入框：每条路径独占一行', () => {
  const plan = I.planInsert('', ['/A.app', '/B.app'], [])
  assert.equal(plan.paths.length, 2)
  assert.deepEqual(plan.fresh, ['/A.app', '/B.app'])
  assert.equal(plan.target, '/A.app\n/B.app')
})

test('已有路径不再重复登记', () => {
  const plan = I.planInsert('/A.app', ['/A.app'], ['/A.app'])
  assert.deepEqual(plan.fresh, [])
  assert.deepEqual(plan.paths, ['/A.app'])
  assert.equal(plan.target, '/A.app')
})

test('用户文字在上，路径收拢到末尾，中间恰好一个空行', () => {
  const plan = I.planInsert('帮我看一下这个', ['/A.app'], [])
  assert.equal(plan.target, '帮我看一下这个\n\n/A.app')
})

test('路径写在文字前面时也会被收拢到末尾', () => {
  const plan = I.planInsert('/A.app\n\n帮我看一下', ['/B.app'], ['/A.app'])
  assert.deepEqual(plan.paths, ['/A.app', '/B.app'])
  assert.equal(plan.target, '帮我看一下\n\n/A.app\n/B.app')
})

test('多行用户文字被保留（不会被当路径）', () => {
  const plan = I.planInsert('第一行\n第二行', ['/A.app'], [])
  assert.equal(plan.target, '第一行\n第二行\n\n/A.app')
})

test('普通句子即使长得很像路径也不会被误当成路径行', () => {
  // 没在记账里的行一律视为用户文字
  const plan = I.planInsert('/not-tracked/path', [], [])
  assert.equal(plan.target, '/not-tracked/path')
})

test('路径块内部的空行被清理掉', () => {
  const plan = I.planInsert('/A.app\n\n\n/B.app', [], ['/A.app', '/B.app'])
  assert.equal(plan.target, '/A.app\n/B.app')
})

test('同一批里的重复项只登记一次', () => {
  const plan = I.planInsert('', ['/A.app', '/A.app'], [])
  assert.deepEqual(plan.fresh, ['/A.app'])
  assert.deepEqual(plan.paths, ['/A.app'])
})

/* ------------------------------------------------------------ 规范化与源码约定 */

test('normalizePath 处理 file:// 与尾斜杠', () => {
  assert.equal(I.normalizePath('file:///Applications/A.app/'), '/Applications/A.app')
  assert.equal(I.normalizePath('  /Applications/A.app/  '), '/Applications/A.app')
})

test('源码必须保留实测得出的关键约定（改错就全盘失效）', () => {
  const src = readFileSync(join(root, 'client/app.js'), 'utf8')

  // 1) 读内容必须用 innerText：textContent 不把 <br> 当字符，会把所有行黏成一行
  assert.match(src, /\.innerText/, '必须用 innerText 读编辑器内容')

  // 2) DSH 的输入框是 Lexical，真换行只能靠编辑器 API。
  //    必须优先走 insertViaLexical，并保留 DOM 通道作为非 Lexical 环境的回落。
  assert.match(src, /function insertViaLexical/, '必须保留 Lexical 插入通道')
  assert.match(src, /insertViaLexical\(el, missing/, '插入流程必须优先尝试 Lexical 通道')
  assert.match(src, /function writeAtEnd/, '必须保留通用 DOM 回落通道')

  // 3) 必须用 _pendingEditorState（当前待提交状态）。
  //    用 editor.getEditorState() 拿到的是上次提交的旧状态，位置会错——实测踩过。
  assert.match(src, /_pendingEditorState/, '必须读待提交状态')
  assert.doesNotMatch(src, /getEditorState\(\)\.read/, '不得用已提交状态取节点（位置会错）')

  // 4) 绝不接管发送按钮
  assert.doesNotMatch(src, /stopImmediatePropagation\(\)[\s\S]{0,200}send/i, '不得接管发送')

  // 5) 必须拦截输入框里的 Cmd+V：官方 PASTE_COMMAND 会把目录当附件上传并红框失败。
  //    v0.3 回归过一次（只拦了 drop，粘贴只留 ⌘⇧V），测试守住别再拿掉。
  assert.match(src, /addEventListener\("paste", onPaste, true\)/, '必须在捕获阶段监听 paste')
  assert.match(src, /async function onPaste/, '必须有 onPaste 分流')

  // 6) 路径必须优先取自桌面壳的 Electron 官方桥（webUtils.getPathForFile）。
  //    这是唯一精确的路径来源；拿掉它就退回「按文件名去文件系统里猜」，
  //    工作目录（~/Screen Studio Projects 这类）会直接猜不中。
  assert.match(src, /jackdshNative/, '必须读桌面壳暴露的能力')
  assert.match(src, /getPathForFile/, '必须用 Electron 官方的 getPathForFile 取真实路径')
  assert.match(src, /nativePathOf\(file\) \|\|/, 'directPaths 必须优先用壳给的精确路径')
})

test('代码里不得引用 Lexical 模块级 helper（插件作用域拿不到，会直接抛错）', () => {
  const raw = readFileSync(join(root, 'client/app.js'), 'utf8')
  // 注释里可以出现这些名字（用来解释为什么不能用），但真实代码里一行都不许有。
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

  for (const name of ['$getRoot', '$getSelection', '$isRangeSelection', '$createParagraphNode']) {
    assert.ok(!code.includes(name), `代码里不得引用 ${name}：它在 Lexical 模块作用域里，插件拿不到`)
  }
})

/* ------------------------------------------- 桌面壳路径桥（Electron 官方 getPathForFile） */

/** 造一个桌面壳 window 桩：只有 jackdshNative 有意义，其余是空实现。 */
function shellWindow(bridge) {
  return {
    jackdshNative: bridge,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
    setTimeout,
    clearTimeout,
  }
}

test('没有桌面壳时（浏览器里打开）路径桥安静返回空', () => {
  // 3080 是纯浏览器入口，没有 jackdshNative —— 必须安静地退回服务端解析，不能抛错。
  assert.equal(I.nativePathOf({ name: 'a.app' }), '')
  assert.equal(I.nativePathOf(null), '')
  assert.equal(I.nativePathOf(undefined), '')

  const browser = loadInternalsWithWindow(shellWindow(undefined))
  assert.equal(browser.nativePathOf({ name: 'a.app' }), '')
})

test('路径桥把原始 File 原样交给壳，拿回精确绝对路径', () => {
  // 真机背景：这是路径的唯一精确来源。壳内部调的是 webUtils.getPathForFile(file)，
  // 它只认真实的 File 对象——自己 new 一个 File 是拿不到路径的，所以必须原样传。
  const seen = []
  const J = loadInternalsWithWindow(shellWindow({
    getPathForFile: (file) => {
      seen.push(file)
      return '/Users/jkw/Screen Studio Projects/Area 2026-09-22 20:40:01.screenstudio'
    },
  }))
  const file = { name: 'Area 2026-09-22 20/40/01.screenstudio', type: '', size: 224 }
  assert.equal(J.nativePathOf(file), '/Users/jkw/Screen Studio Projects/Area 2026-09-22 20:40:01.screenstudio')
  assert.equal(seen.length, 1)
  assert.equal(seen[0], file, '必须把原始 File 对象原样交给壳')
})

test('壳给的精确路径优先于已废弃的 file.path，壳抛错时安静降级', () => {
  const J = loadInternalsWithWindow(shellWindow({ getPathForFile: () => '/Users/jkw/精确.app' }))
  assert.deepEqual(J.directPaths([{ name: 'x.app', path: '/Users/jkw/旧字段.app' }]), ['/Users/jkw/精确.app'])

  const K = loadInternalsWithWindow(shellWindow({
    getPathForFile: () => { throw new Error('boom') },
  }))
  assert.deepEqual(K.directPaths([{ name: 'x.app', path: '/Users/jkw/旧字段.app' }]), ['/Users/jkw/旧字段.app'])
})
