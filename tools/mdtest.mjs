/**
 * 离线验证 /mobile app.js 的 Markdown 渲染(直接抽取文件中的真实函数运行)。
 * Run: node tools/mdtest.mjs
 */
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../public/mobile/app.js', import.meta.url), 'utf8')
const start = src.indexOf('function esc(')
const end = src.indexOf('function knownToolCallIds(')
if (start < 0 || end < 0) throw new Error('cannot locate renderer functions in app.js')
const chunk = src.slice(start, end)
const factory = new Function(chunk + `; return { esc, inlineMd, mdHtml, codeBlockHtml, partsHtml };`)
const { mdHtml } = factory()

const samples = {
  '症状2:标题紧贴正文(无空行),不应原样显示 ##': [
    '先介绍背景内容,继续往下讲,没有空行。',
    '## 5. 具体实现步骤',
    '紧接着的正文也不空行,下一句直接跟',
    '### 5.1 子标题同样要紧贴',
    '再来一句收尾。'
  ].join('\n'),
  '症状1a:四反引号外层围栏内嵌三反引号,不能把整篇吞成代码': [
    '下面是带嵌套代码块的文档说明:',
    '````markdown',
    '# 文档标题',
    '',
    '```js',
    'console.log(1)',
    '```',
    '',
    '> 引用行',
    '````',
    '说明结束,这段必须仍然是正常文本而不是代码。'
  ].join('\n'),
  '症状1b:文档中间恰好出现一次孤立 ``` 教学行(旧逻辑会把它后面全部变代码)': [
    '在 Markdown 中,用三个反引号 ``` 包裹代码块,像这样:',
    '',
    '```js',
    'const a = 1',
    '```',
    '',
    '以上是正确的成对写法。',
    '结尾正常段落,不应进入代码块。'
  ].join('\n'),
  '常规文档(标题/无序/有序/表格/引用/行内)': [
    '# 大标题',
    '',
    '## 1. 小节',
    '',
    '正文带 **加粗**、*斜体*、`行内代码` 和 [链接](https://example.com)。',
    '',
    '- 甲',
    '- 乙',
    '',
    '1. 第一',
    '2. 第二',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '> 引用一段话',
    '',
    '```python',
    'print("hi")',
    '```'
  ].join('\n'),
  '分隔线与列表后无空行接正文': [
    '列表:',
    '- 条目一',
    '- 条目二',
    '接续正文没有空行。',
    '---',
    '分隔线后的正文。'
  ].join('\n')
}

for (const [name, srcText] of Object.entries(samples)) {
  console.log('\n========== ' + name + ' ==========')
  console.log(mdHtml(srcText))
}
