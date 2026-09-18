/**
 * 从插件源码实时生成 probe-lib.js：DSH 客户端的模块加载器垫片 + 打包好的插件本体。
 * 不依赖网络、不依赖服务端，双击 probe.html 就能在真实 Chromium 里跑。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')

const css = readFileSync(join(root, 'client/ui.css'), 'utf8')
const app = readFileSync(join(root, 'client/app.js'), 'utf8')

const out = `/* 自动生成，请勿手改；改完源码执行 npm run probe */
;(function () {
  var registrations = []
  window.__ModuleLoader__ = {
    load: function (registration) { registrations.push(registration) },
  }

  var css = ${JSON.stringify(css)}
  if (typeof document !== 'undefined') {
    var tag = document.createElement('style')
    tag.textContent = css
    document.head.appendChild(tag)
  }

  var module = { exports: {} }
  ;(function (module, exports, require) {
${app}
  })(module, module.exports, function (name) {
    throw new Error('probe: unexpected external require "' + name + '"')
  })

  var plugin = module.exports
  if (typeof plugin.apply === 'function') {
    plugin.apply({ effect: function () {} })
  }
})()
`

const target = join(here, 'probe-lib.js')
writeFileSync(target, out)
console.log('generated ' + target)

/* ---------------------------------------------------------------------------
   Lexical 端到端实测页需要真实 Lexical。
   不把 Lexical 拷进仓库（那是第三方源码，且体积大），
   改为在构建时把它软链到 test/manual/dsl/，从本机 DSH 运行时读取。
   --------------------------------------------------------------------------- */
const LEXICAL_ROOT = '/Applications/JackDSH.app/Contents/Resources/node_modules'
const LEXICAL_PACKAGES = [
  'lexical',
  '@lexical/plain-text',
  '@lexical/clipboard',
  '@lexical/dragon',
  '@lexical/extension',
  '@lexical/selection',
  '@lexical/utils',
  '@lexical/html',
]

function linkLexical() {
  const target = join(here, 'dsl')
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {}
  mkdirSync(target, { recursive: true })
  let linked = 0
  for (const name of LEXICAL_PACKAGES) {
    const src = join(LEXICAL_ROOT, name, 'dist')
    if (!existsSync(src)) continue
    const dst = join(target, name)
    mkdirSync(dirname(dst), { recursive: true })
    try {
      symlinkSync(src, dst, 'dir')
      linked += 1
    } catch {}
  }
  console.log('linked ' + linked + ' lexical packages for e2e probe')
}

linkLexical()
