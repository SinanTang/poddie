interface SearchBarProps {
  query: string
  onQueryChange: (q: string) => void
  matchCount: number
  activeMatch: number
  onNavigate: (direction: 1 | -1) => void
}

export function SearchBar({ query, onQueryChange, matchCount, activeMatch, onNavigate }: SearchBarProps): React.JSX.Element {
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault()
      onNavigate(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      onQueryChange('')
    }
  }

  return (
    <span className="search">
      <input
        id="transcript-search"
        type="search"
        placeholder="Search transcript…  (⌘F)"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {query && (
        <>
          <span className="search-count">{matchCount === 0 ? '0' : `${activeMatch + 1} / ${matchCount}`}</span>
          <button className="ghost" onClick={() => onNavigate(-1)} disabled={matchCount === 0} title="Previous (Shift+Enter)">
            ‹
          </button>
          <button className="ghost" onClick={() => onNavigate(1)} disabled={matchCount === 0} title="Next (Enter)">
            ›
          </button>
        </>
      )}
    </span>
  )
}
