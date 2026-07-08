// Render spike6 outputs for manual quality annotation.
import { readFileSync } from 'node:fs'

const MODEL = (process.argv[2] ?? 'qwen3:8b').replace(/:/g, '_')
const dir = new URL('./results6/', import.meta.url).pathname
const project = JSON.parse(readFileSync('/Users/sinan/Documents/developers/poddie/footage/IMG_0470.MOV.poddie.json', 'utf8'))
const t = project.transcript

const punct = JSON.parse(readFileSync(`${dir}punct-${MODEL}.json`, 'utf8'))
console.log('===== PUNCT: segments with model marks inserted =====')
for (const r of punct.punctResults) {
  if (r.error) continue
  const byN = new Map(r.byN)
  console.log(`--- batch @${r.offset} ---`)
  let line = ''
  for (let n = r.offset; n < r.offset + r.asked; n++) {
    const seg = t.segments[n]
    const mark = byN.get(n) ?? '(?)'
    line += seg.text.trim() + (mark === '' ? '⌇' : mark)
    if (line.length > 90) { console.log(line); line = '' }
  }
  if (line) console.log(line)
}

const filler = JSON.parse(readFileSync(`${dir}filler-${MODEL}.json`, 'utf8'))
console.log('\n===== FILLER: judged candidates in context =====')
for (const r of filler.fillerResults) {
  if (r.error) continue
  const byN = new Map(r.byN)
  console.log(`--- batch @${r.start} ---`)
  r.batch.forEach((c, k) => {
    const n = r.start + k
    const verdict = byN.get(n) === true ? 'CUT ' : byN.get(n) === false ? 'keep' : '(?) '
    const L = t.words.slice(Math.max(0, c.i - 10), c.i).map((w) => w.text).join('')
    const R = t.words.slice(c.j + 1, c.j + 11).map((w) => w.text).join('')
    console.log(`${verdict} ${L}【${c.text}】${R}`)
  })
}
