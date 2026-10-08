// Drawing shared by prompt-meter (/pm) and prompt-analyzer (/pa): token chips,
// facts about a token split, and a row of tabs. The two plugins carry the same
// copy of this file, so a prompt looks the same in both. Keep them identical.
// Uses the hooks module's global `h`; the elements come from the caller.

// Token chip backgrounds, cycled. Muted enough for light text on either theme.
const CHIPS = ['#3b5b8c', '#6d4a8c', '#2f7560', '#86672a', '#8c3f55']
const CHIP_TEXT = '#f4f4f4'

export const visible = s => s.replaceAll(' ', '␣').replaceAll('\n', '↵').replaceAll('\t', '⇥')

// Lays the token pieces out as colored chips, at most maxRows rows of width
// cells. What doesn't fit becomes "+N more" at the end of the last row.
export function chipRows(Text, pieces, width, maxRows) {
  const rows = [[]]
  let used = 0
  let hidden = 0
  pieces.forEach((piece, i) => {
    if (hidden) {
      hidden += piece.tokens
      return
    }
    let label = visible(piece.text) + (piece.tokens > 1 ? `×${piece.tokens}` : '')
    if (label.length > width) label = label.slice(0, width - 1) + '…'
    if (used + label.length > width) {
      if (rows.length === maxRows) {
        hidden += piece.tokens
        return
      }
      rows.push([])
      used = 0
    }
    rows.at(-1).push({ label, color: CHIPS[i % CHIPS.length], tokens: piece.tokens })
    used += label.length
  })
  if (hidden) {
    const last = rows.at(-1)
    while (last.length && used + ` +${hidden} more`.length > width) {
      const chip = last.pop()
      hidden += chip.tokens
      used -= chip.label.length
    }
  }
  return rows.map((row, r) =>
    h(
      Text,
      { wrap: 'truncate-end' },
      ...row.map(chip => h(Text, { backgroundColor: chip.color, color: CHIP_TEXT }, chip.label)),
      ...(hidden && r === rows.length - 1 ? [h(Text, { color: 'subtle' }, ` +${hidden} more`)] : []),
    ),
  )
}

// What stands out in a token split: characters that cost several tokens each,
// the longest tokens, and how many tokens are only whitespace.
export function tokenFacts(pieces) {
  const seen = new Set()
  const multi = []
  for (const p of pieces) {
    if (p.tokens > 1 && !seen.has(p.text)) {
      seen.add(p.text)
      multi.push(p)
    }
  }
  const longest = [...new Map(pieces.filter(p => p.tokens === 1).map(p => [p.text, p])).values()]
    .sort((a, b) => [...b.text].length - [...a.text].length)
    .slice(0, 4)
  const whitespace = pieces.filter(p => !p.text.trim()).reduce((sum, p) => sum + p.tokens, 0)
  return { multi, longest, whitespace }
}

// A row of tabs over a rule. Each tab is a plain Button that its digit (1, 2,
// …) presses while the pane has the keys; the current one is bright with a
// heavy rule under it, the rest dim. A plain Button draws as "1: label".
export function tabBar(Box, Text, Button, tabs, current, select, width) {
  const labels = tabs.map(t => (t.badge ? `${t.label} ${t.badge}` : t.label))
  const buttons = tabs.map((t, i) =>
    h(Button, {
      key: `tab:${t.id}`,
      label: labels[i],
      hotkey: String(i + 1),
      plain: true,
      dimColor: t.id === current ? undefined : true,
      onPress: () => select(t.id),
    }),
  )
  const rule = []
  let used = 0
  tabs.forEach((t, i) => {
    if (i) {
      rule.push(h(Text, { color: 'subtle' }, '──'))
      used += 2
    }
    const cells = 3 + labels[i].length
    rule.push(t.id === current ? h(Text, { color: 'claude', bold: true }, '━'.repeat(cells)) : h(Text, { color: 'subtle' }, '─'.repeat(cells)))
    used += cells
  })
  rule.push(h(Text, { color: 'subtle' }, '─'.repeat(Math.max(0, width - used))))
  return [h(Box, { key: 'tabs', flexDirection: 'row', gap: 2 }, ...buttons), h(Text, { wrap: 'truncate-end' }, ...rule)]
}
