import type { Chapter } from './types'

/**
 * Chapter and subchapter END times are derived, never trusted.
 *
 * The prompt asks the model to span the whole episode, but a local 8B model
 * ignores that often enough to matter: one real run left an 11m36s hole
 * between chapter 1 (ended 5:04) and chapter 2 (started 16:40) — a quarter of
 * the episode belonging to no chapter, which would silently vanish from
 * per-chapter clip exports.
 *
 * So an end time is not data we keep, it is the next start time. A section
 * runs until the next one begins, exactly like podcast chapter markers, and
 * the last one runs to the end of the media. That makes gaps and overlaps
 * unrepresentable rather than something every caller has to defend against.
 *
 * Returns chapters tiling [0, durationSec] with no gaps and no overlaps.
 */
export function normalizeChapters(chapters: Chapter[], durationSec: number): Chapter[] {
  if (durationSec <= 0) return []

  const usable = (t: unknown): number | null =>
    typeof t === 'number' && Number.isFinite(t) ? Math.min(Math.max(t, 0), durationSec) : null

  // Keep each chapter's subs in time order, and chapters in the order they
  // first speak. A model that emits them out of order is a bug we absorb here.
  const ordered = chapters
    .map((ch) => ({
      ch,
      subs: ch.subchapters
        .filter((s) => usable(s.startTime) !== null)
        .map((s) => ({ ...s, startTime: usable(s.startTime) as number }))
        .sort((a, b) => a.startTime - b.startTime)
    }))
    .filter((entry) => entry.subs.length > 0)
    .sort((a, b) => a.subs[0].startTime - b.subs[0].startTime)

  if (ordered.length === 0) return []

  // Flatten in chapter order and force starts strictly increasing. Anchoring
  // the first at 0 keeps a late-starting first chapter from orphaning the
  // opening seconds.
  const flat = ordered.flatMap((entry, chapterIdx) => entry.subs.map((sub) => ({ sub, chapterIdx })))
  let cursor = 0
  const kept: typeof flat = []
  for (const [i, node] of flat.entries()) {
    const start = i === 0 ? 0 : Math.max(node.sub.startTime, cursor)
    // A sub with nothing left after the one before it has no span to own.
    if (i > 0 && start >= durationSec) continue
    node.sub.startTime = start
    cursor = start + 1e-6
    kept.push(node)
  }

  for (const [i, node] of kept.entries()) {
    node.sub.endTime = i + 1 < kept.length ? kept[i + 1].sub.startTime : durationSec
  }

  return ordered
    .map((entry, chapterIdx) => ({
      ch: entry.ch,
      subs: kept.filter((n) => n.chapterIdx === chapterIdx).map((n) => n.sub)
    }))
    .filter((entry) => entry.subs.length > 0)
    .map(({ ch, subs }) => ({
      ...ch,
      startTime: subs[0].startTime,
      endTime: subs[subs.length - 1].endTime,
      subchapters: subs
    }))
}
