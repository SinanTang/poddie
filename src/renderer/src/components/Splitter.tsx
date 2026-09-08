import { useRef } from 'react'

type Orientation = 'vertical' | 'horizontal'

interface SplitterProps {
  /** 'vertical' is a vertical bar resizing width; 'horizontal' resizes height. */
  orientation: Orientation
  /** Fired once as a drag begins — the parent records the size it is about to change. */
  onDragStart: () => void
  /**
   * Total pixel offset from where this drag began, NOT an increment. The parent
   * clamps `sizeAtDragStart + delta`, so a drag that runs past a minimum and
   * comes back tracks the pointer again instead of drifting away from it.
   */
  onDrag: (delta: number) => void
  onReset: () => void
  label: string
}

const KEY_STEP_PX = 16

/**
 * The draggable edge between two panes. Holds no size of its own: it reports
 * pointer movement and the parent owns every size and limit, so one component
 * serves both axes and there is a single place where a pane can be clamped.
 */
export function Splitter({
  orientation,
  onDragStart,
  onDrag,
  onReset,
  label
}: SplitterProps): React.JSX.Element {
  const origin = useRef(0)
  const vertical = orientation === 'vertical'
  const along = (e: { clientX: number; clientY: number }): number => (vertical ? e.clientX : e.clientY)

  return (
    <div
      className={`splitter ${orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={(e) => {
        // pointer capture keeps the drag alive over the video element and past
        // the window edge, where plain mousemove listeners lose it
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        origin.current = along(e)
        onDragStart()
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        onDrag(along(e) - origin.current)
      }}
      onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const back = vertical ? 'ArrowLeft' : 'ArrowUp'
        const forward = vertical ? 'ArrowRight' : 'ArrowDown'
        if (e.key === 'Enter') {
          e.preventDefault()
          onReset()
          return
        }
        if (e.key !== back && e.key !== forward) return
        e.preventDefault()
        onDragStart()
        onDrag(e.key === back ? -KEY_STEP_PX : KEY_STEP_PX)
      }}
    />
  )
}
