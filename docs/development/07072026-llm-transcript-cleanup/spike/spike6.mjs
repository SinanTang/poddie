// Spike v6: classification, not generation. v1-v5 all failed on the same root cause: the model
// can't reliably ADDRESS tokens (counting) and can't PLACE punctuation (generation), even when
// anchored. v6 inverts control: the app enumerates the units, the model only classifies.
//   A) punct: Whisper segment boundaries ARE clause breaks (measured: avg 7 words, prosody-driven).
//      Model picks the mark that ends each numbered segment: 。？！， or none (continuation).
//   B) filler: the list detector finds candidate token sequences; the model judges each numbered
//      candidate in context: disfluency (cut) or meaningful (keep). Addresses the zh precision risk.
// No positions in model output — only numbers we handed it. Alignment is deterministic.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const PROJECT = '/Users/sinan/Documents/developers/poddie/footage/IMG_0470.MOV.poddie.json'
const OUT_DIR = new URL('./results6/', import.meta.url).pathname
const OLLAMA = 'http://127.0.0.1:11434'
const MODEL = process.argv[2] ?? 'qwen3:8b'
const SEG_BATCH = Number(process.argv[3] ?? 40)
const CAND_BATCH = 30

// --- generic chat ---
async function chat(system, user, schema) {
  const t0 = Date.now()
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think: false,
      format: schema,
      options: { temperature: 0, num_ctx: 8192 },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  })
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)
  const data = await res.json()
  return { content: data.message?.content ?? '', wallSec: (Date.now() - t0) / 1000, outTokens: data.eval_count }
}

// =========================== A) punctuation by segment boundary ===========================
const PUNCT_SYSTEM = `You punctuate a verbatim speech transcript for captions. Input lines are consecutive transcript segments, "number|text", in speaking order. The segment boundaries follow the speaker's pauses.

For EVERY segment number, decide what punctuation mark belongs at the END of that segment:
- "。" the sentence ends here (use "？" for questions, "！" for exclamations)
- "，" the sentence continues into the next segment, with a natural pause
- ""  (empty) the text flows into the next segment mid-phrase — no mark

Return JSON: {"marks":[{"n":<segment number>,"add":"。"|"？"|"！"|"，"|""}, ...]} with ONE entry per input segment, in order. Use the transcript's own language conventions (for Latin-script text use . ? ! ,). Do not translate, do not rewrite.`

const PUNCT_SCHEMA = {
  type: 'object',
  properties: {
    marks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          add: { type: 'string', enum: ['。', '？', '！', '，', '.', '?', '!', ',', ''] }
        },
        required: ['n', 'add']
      }
    }
  },
  required: ['marks']
}

async function punctBatch(segs, offset) {
  const user = segs.map((s, k) => `${offset + k}|${s.text.trim()}`).join('\n')
  const { content, wallSec, outTokens } = await chat(PUNCT_SYSTEM, user, PUNCT_SCHEMA)
  let marks = []
  try { marks = JSON.parse(content).marks ?? [] } catch { /* count as zero answers */ }
  const byN = new Map()
  for (const m of marks) if (Number.isInteger(m.n) && m.n >= offset && m.n < offset + segs.length && !byN.has(m.n)) byN.set(m.n, m.add)
  return { byN, wallSec, outTokens, answered: byN.size, asked: segs.length }
}

// =========================== B) filler candidate judgment ===========================
// Flat data list — zh + en defaults, always all active (language never gates logic).
const FILLER_LIST = [
  '嗯', '呃', '啊', '那个', '就是说', '就是', '然后', '这个', '所以说', '反正',
  'um', 'uh', 'erm', 'like', 'you know', 'i mean', 'sort of', 'kind of', 'basically', 'actually', 'so'
]

const norm = (s) => s.replace(/\s+/g, '').toLowerCase()

/** Find list-candidate occurrences as word-index ranges (longest match first at each position). */
function findCandidates(words) {
  const sorted = [...FILLER_LIST].sort((a, b) => norm(b).length - norm(a).length)
  const out = []
  for (let i = 0; i < words.length; i++) {
    for (const f of sorted) {
      const target = norm(f)
      let text = ''
      let j = i
      while (j < words.length && text.length < target.length) {
        text += norm(words[j].text)
        j++
      }
      if (text === target) {
        out.push({ i, j: j - 1, text: words.slice(i, j).map((w) => w.text).join('') })
        i = j - 1
        break
      }
    }
  }
  return out
}

const FILLER_SYSTEM = `You review flagged words in a verbatim podcast transcript. Each input line is "number|context text" where the flagged words are wrapped in 【brackets】. The flagged words MIGHT be spoken fillers (hesitation sounds, verbal tics, discourse fillers) — or they might carry real meaning in this sentence.

For EVERY number, judge the bracketed words IN THEIR CONTEXT:
- cut=true  → pure disfluency; removing it from the audio loses nothing
- cut=false → it has grammatical or semantic function here (pronoun, conjunction, "this/that" pointing at something, part of a phrase)

Return JSON: {"judgments":[{"n":N,"cut":true|false}, ...]} with one entry per input line. When unsure, prefer cut=false.`

const FILLER_SCHEMA = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, cut: { type: 'boolean' } },
        required: ['n', 'cut']
      }
    }
  },
  required: ['judgments']
}

async function fillerBatch(cands, words, offset) {
  const user = cands
    .map((c, k) => {
      const L = words.slice(Math.max(0, c.i - 12), c.i).map((w) => w.text).join('')
      const R = words.slice(c.j + 1, c.j + 13).map((w) => w.text).join('')
      return `${offset + k}|${L}【${c.text}】${R}`
    })
    .join('\n')
  const { content, wallSec, outTokens } = await chat(FILLER_SYSTEM, user, FILLER_SCHEMA)
  let js = []
  try { js = JSON.parse(content).judgments ?? [] } catch { /* zero answers */ }
  const byN = new Map()
  for (const j of js) if (Number.isInteger(j.n) && j.n >= offset && j.n < offset + cands.length && !byN.has(j.n)) byN.set(j.n, j.cut)
  return { byN, wallSec, outTokens, answered: byN.size, asked: cands.length }
}

// =========================== run ===========================
mkdirSync(OUT_DIR, { recursive: true })
const project = JSON.parse(readFileSync(PROJECT, 'utf8'))
const t = project.transcript

// A) punct: 3 stretches of 2×SEG_BATCH segments (early/middle/late)
const segAnchors = [30, 600, 1100]
const punctResults = []
for (const a of segAnchors) {
  for (let b = 0; b < 2; b++) {
    const offset = a + b * SEG_BATCH
    const segs = t.segments.slice(offset, offset + SEG_BATCH)
    process.stdout.write(`punct segs ${offset}-${offset + segs.length - 1} ... `)
    try {
      const r = await punctBatch(segs, offset)
      const dist = {}
      for (const add of r.byN.values()) dist[add || '(none)'] = (dist[add || '(none)'] || 0) + 1
      punctResults.push({ offset, ...r, byN: [...r.byN.entries()], dist })
      console.log(`${r.wallSec.toFixed(0)}s answered=${r.answered}/${r.asked} dist=${JSON.stringify(dist)}`)
    } catch (e) {
      console.log(`FAILED: ${e.message}`)
      punctResults.push({ offset, error: e.message })
    }
  }
}

// B) filler: candidates across the whole episode, judge 3 batches (early/middle/late)
const cands = findCandidates(t.words)
console.log(`filler candidates in full episode: ${cands.length}`)
const candDist = {}
for (const c of cands) candDist[c.text.toLowerCase()] = (candDist[c.text.toLowerCase()] || 0) + 1
console.log('top candidates:', JSON.stringify(Object.fromEntries(Object.entries(candDist).sort((a, b) => b[1] - a[1]).slice(0, 12))))

const fillerResults = []
for (const start of [0, Math.floor(cands.length / 2), Math.max(0, cands.length - CAND_BATCH)]) {
  const batch = cands.slice(start, start + CAND_BATCH)
  process.stdout.write(`filler cands ${start}-${start + batch.length - 1} ... `)
  try {
    const r = await fillerBatch(batch, t.words, start)
    const cut = [...r.byN.values()].filter(Boolean).length
    fillerResults.push({ start, ...r, byN: [...r.byN.entries()], batch })
    console.log(`${r.wallSec.toFixed(0)}s answered=${r.answered}/${r.asked} cut=${cut} keep=${r.answered - cut}`)
  } catch (e) {
    console.log(`FAILED: ${e.message}`)
    fillerResults.push({ start, error: e.message })
  }
}

writeFileSync(`${OUT_DIR}punct-${MODEL.replace(/:/g, '_')}.json`, JSON.stringify({ punctResults, segments: t.segments.length }, null, 2))
writeFileSync(`${OUT_DIR}filler-${MODEL.replace(/:/g, '_')}.json`, JSON.stringify({ fillerResults, candTotal: cands.length, candDist }, null, 2))

const punctOk = punctResults.filter((r) => !r.error)
const avgSegSec = punctOk.length ? punctOk.reduce((s, r) => s + r.wallSec, 0) / punctOk.reduce((s, r) => s + r.asked, 0) : NaN
const fillerOk = fillerResults.filter((r) => !r.error)
const avgCandSec = fillerOk.length ? fillerOk.reduce((s, r) => s + r.wallSec, 0) / fillerOk.reduce((s, r) => s + r.asked, 0) : NaN
console.log(`\nprojected full episode: punct ${(avgSegSec * t.segments.length / 60).toFixed(1)} min (${t.segments.length} segs), filler ${(avgCandSec * cands.length / 60).toFixed(1)} min (${cands.length} cands)`)
