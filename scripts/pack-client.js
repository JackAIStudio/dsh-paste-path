import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'client/ui.css'), 'utf8')
const app = readFileSync(join(root, 'client/app.js'), 'utf8')

const out = `window.__ModuleLoader__.load({
  id: 'dsh-paste-path',
  factory: (require) => {
    const module = { exports: {} }
    const css = ${JSON.stringify(css)}
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
${app}
    return module.exports
  },
})
`

writeFileSync(join(root, 'client.js'), out)
console.log(`packed client.js (${out.split('\n').length} lines)`)
