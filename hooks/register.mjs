// /pa reviews a prompt before you send it: a quality score, unclear wording,
// missing context, skills that would help, and an improved version that one
// key puts in the prompt box. Each review is one separate model call (Haiku by
// default), so it never enters your conversation's context. While the pane is
// closed the plugin does nothing: its prompt hooks pass straight through.
import { atom, read, update } from 'claude-code'
import { buildRequest, parseAnalysis, plainRules, systemPrompt } from '../lib/analysis.mjs'
import { createTokenizer } from '../lib/bpe.mjs'
import { chipRows, tabBar, tokenFacts, visible } from '../lib/ui.mjs'

const PANE = 'prompt-analyzer'

// What the pane shows: idle, a review running, its result, or why it failed.
const view = atom({ plugin: 'prompt-analyzer', key: 'view' }, { status: 'idle' })
// Which tab of a finished review shows; each new review opens on 'review'.
const tab = atom({ plugin: 'prompt-analyzer', key: 'tab' }, 'review')

let draft = '' // the prompt box as of its last edit
let shown = false // whether the pane is open, so typing only redraws it then
let tokenizer // undefined until read, null when the vocabulary is missing
const splits = new Map() // text → token pieces, for the prompts being redrawn

const SEVERITY_COLOR = { high: 'error', medium: 'warning', low: 'subtle' }
const scoreColor = score => (score >= 8 ? 'success' : score >= 5 ? 'warning' : 'error')

function fmt(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

function oneLine(text, width) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > width ? flat.slice(0, Math.max(width - 1, 0)) + '…' : flat
}

// ── work ─────────────────────────────────────────────────────────────────────

// The /plain skill's writing rules, read fresh for each review so edits to the
// skill apply at once: the project's .claude/skills first, then the person's.
// Null when the skill isn't installed.
async function readPlainRules($, cwd) {
  const configDir =
    (await $.env.get('CLAUDE_CONFIG_DIR')) || `${(await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '~'}/.claude`
  for (const path of [cwd && `${cwd}/.claude/skills/plain/SKILL.md`, `${configDir}/skills/plain/SKILL.md`].filter(Boolean)) {
    try {
      const rules = plainRules(await $.fs.read(path))
      if (rules) return rules
    } catch {
      // Not installed there.
    }
  }
  return null
}

// Reviews one prompt and leaves the result (or the failure) in `view`.
async function analyze($, prompt, options) {
  const model = String(options?.MODEL || 'haiku')
  await update($, view, () => ({ status: 'running', prompt, model }))
  await update($, tab, () => 'review')
  try {
    const [commands, messages, cwd] = await Promise.all([
      $.command.list().catch(() => []),
      options?.INCLUDE_CONVERSATION === false ? [] : $.session.messages().catch(() => []),
      $.session.cwd().catch(() => ''),
    ])
    let files = []
    try {
      files = (await $.fs.list(cwd)).map(f => (f.kind === 'dir' ? `${f.name}/` : f.name))
    } catch {
      // An unreadable directory only means less context.
    }

    const plain = options?.PLAIN === false ? null : await readPlainRules($, cwd)

    const started = await $.clock.now()
    const reply = await $.model.complete({
      model,
      system: systemPrompt(plain),
      prompt: buildRequest({ prompt, messages, cwd, files, commands }),
      maxTokens: 2000,
      timeoutMs: 90_000,
    })
    const ms = (await $.clock.now()) - started
    if (!reply.isAnswered) {
      const why = reply.reason === 'api-error' ? `API error${reply.status ? ` ${reply.status}` : ''}` : reply.reason
      await update($, view, () => ({ status: 'error', prompt, model, error: `the review model gave no answer (${why})` }))
      return
    }

    const analysis = parseAnalysis(reply.text)
    if (!analysis) {
      await update($, view, () => ({ status: 'error', prompt, model, error: 'the review came back in a shape it could not read; press a to try again' }))
      return
    }
    // Keep only skills and commands that exist in this session.
    const names = new Set(commands.map(c => c.name))
    analysis.skills = analysis.skills.filter(s => names.has(s.name))

    const u = reply.usage
    const tokensIn = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    await update($, view, () => ({ status: 'done', prompt, model, analysis, tokensIn, tokensOut: u.output_tokens, ms, plain: Boolean(plain) }))
  } catch (error) {
    await update($, view, () => ({ status: 'error', prompt, model, error: String(error?.message ?? error) }))
  }
}

// The tokenizer and vocabulary are prompt-meter's (lib/bpe.mjs, vendor/), so
// /pa splits a prompt exactly as /pm does.
async function loadTokenizer($) {
  if (tokenizer !== undefined) return
  try {
    tokenizer = createTokenizer(JSON.parse(await $.fs.read(`${$.plugin.root}/vendor/claude-tokenizer.json`)))
  } catch {
    tokenizer = null // vocabulary missing: counts fall back to an estimate
  }
}

function split(text) {
  if (!tokenizer || !text) return []
  if (!splits.has(text)) {
    if (splits.size > 64) splits.clear()
    splits.set(text, tokenizer.split(text))
  }
  return splits.get(text)
}

function countTokens(text) {
  if (tokenizer) return split(text).reduce((sum, piece) => sum + piece.tokens, 0)
  const nonAscii = text.match(/[^\x20-\x7e\n\t]/g)?.length ?? 0
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii)
}

async function fill($, text) {
  const filled = await $.prompt.fill({ text, mode: 'replace' })
  if (filled.isFilled) $.ui.toast('In the prompt box: esc to edit or send it')
  else $.ui.toast(`Couldn't fill the prompt box (${filled.refusal ?? 'refused'})`)
}

// ── drawing ──────────────────────────────────────────────────────────────────

function section(Text, title, note) {
  return h(Text, { wrap: 'truncate-end' }, h(Text, { bold: true, color: 'claude' }, title), h(Text, { color: 'subtle' }, note ? `  ${note}` : ''))
}

function scoreLine(Text, analysis) {
  const s = analysis.score
  return h(
    Text,
    { wrap: 'truncate-end' },
    h(Text, { bold: true, color: scoreColor(s) }, `${s || '?'}/10 `),
    h(Text, { color: scoreColor(s) }, '█'.repeat(s)),
    h(Text, { color: 'subtle' }, '░'.repeat(10 - s)),
    h(Text, { bold: true }, `  ${analysis.verdict}`),
  )
}

const nothing = (Text, text) => h(Text, { color: 'subtle' }, `  ${text}`)

// ── tabs of a finished review ────────────────────────────────────────────────

// 1 review: what the prompt asks, and what holds it back.
function reviewTab(Text, v, width) {
  const a = v.analysis
  const rows = []
  if (a.task) rows.push(h(Text, { color: 'subtle', wrap: 'wrap' }, `task: ${a.task}`))
  rows.push(h(Text, { color: 'subtle', italic: true, wrap: 'truncate-end' }, `│ ${oneLine(v.prompt, width - 2)}`))
  rows.push(h(Text, null, ' '), section(Text, 'issues'))
  if (!a.issues.length) rows.push(nothing(Text, 'No issues found.'))
  for (const issue of a.issues) {
    rows.push(
      h(Text, { wrap: 'wrap' }, h(Text, { color: SEVERITY_COLOR[issue.severity] }, ` ● ${issue.severity.padEnd(6)} `), h(Text, null, issue.problem)),
      ...(issue.fix ? [h(Text, { color: 'subtle', wrap: 'wrap' }, `           → ${issue.fix}`)] : []),
    )
  }
  return rows
}

// 2 wording: the prompt's own words, and better ones.
function wordingTab(Text, a) {
  const rows = [section(Text, 'wording')]
  if (!a.wording.length) rows.push(nothing(Text, 'Nothing to reword.'))
  for (const w of a.wording) {
    rows.push(
      h(
        Text,
        { wrap: 'wrap' },
        h(Text, { color: 'error' }, ` "${w.quote}"`),
        h(Text, { color: 'subtle' }, ' → '),
        h(Text, { color: 'success' }, w.better ? `"${w.better}"` : '(drop it)'),
        h(Text, { color: 'subtle' }, w.why ? `  ${w.why}` : ''),
      ),
    )
  }
  return rows
}

// 3 skills: what would help with the task, and what the prompt should add.
function skillsTab(Text, a) {
  const rows = [section(Text, 'skills to use')]
  if (!a.skills.length) rows.push(nothing(Text, 'No skill in this session fits the task.'))
  for (const skill of a.skills) {
    rows.push(h(Text, { wrap: 'wrap' }, h(Text, { bold: true, color: 'suggestion' }, ` /${skill.name}`), h(Text, { color: 'subtle' }, `  ${skill.why}`)))
  }
  rows.push(h(Text, null, ' '), section(Text, 'worth adding'))
  if (!a.missing.length) rows.push(nothing(Text, 'Nothing missing.'))
  for (const item of a.missing) rows.push(h(Text, { wrap: 'wrap' }, ` · ${item}`))
  return rows
}

// 4 improved: the rewrite, and what it does to the token count.
function improvedTab(Box, Text, v) {
  const a = v.analysis
  if (!a.improved) return [nothing(Text, 'No rewrite: the prompt is fine as it is.')]
  const before = countTokens(v.prompt)
  const after = countTokens(a.improved)
  return [
    section(Text, 'improved prompt', 'i puts it in the prompt box · o puts yours back'),
    h(Box, { key: 'improved', borderStyle: 'round', borderColor: 'suggestion', paddingX: 1, flexDirection: 'column' }, h(Text, { wrap: 'wrap' }, a.improved)),
    h(
      Text,
      { wrap: 'truncate-end' },
      h(Text, { color: 'subtle' }, `  ${'tokens:'.padEnd(12)}`),
      h(Text, { bold: true }, `${fmt(before)} → ${fmt(after)}`),
      h(Text, { color: after > before ? 'warning' : 'success' }, `  ${after >= before ? '+' : '-'}${fmt(Math.abs(after - before))}`),
      h(Text, { color: 'subtle' }, `  ${[...v.prompt].length} → ${[...a.improved].length} chars`),
    ),
  ]
}

// 5 tokens: the whole split of the reviewed prompt, and what stands out in it.
function tokensTab(Text, prompt, width) {
  const pieces = split(prompt)
  if (!pieces.length) return [nothing(Text, 'No token split: vendor/claude-tokenizer.json is missing.')]
  const facts = tokenFacts(pieces)
  const fact = (label, value) => h(Text, { wrap: 'truncate-end' }, h(Text, { color: 'subtle' }, `  ${`${label}:`.padEnd(20)}`), ...value)
  return [
    ...chipRows(Text, pieces, width, 12),
    h(Text, null, ' '),
    ...(facts.multi.length ? [fact('several per char', facts.multi.map(p => h(Text, { bold: true }, `${visible(p.text)}×${p.tokens}  `)))] : []),
    fact('longest tokens', facts.longest.map(p => h(Text, null, h(Text, { bold: true }, visible(p.text)), h(Text, { color: 'subtle' }, ` ${[...p.text].length}  `)))),
    fact('whitespace', [h(Text, null, `${facts.whitespace} token${facts.whitespace === 1 ? '' : 's'}`), h(Text, { color: 'subtle' }, ' of spaces and line breaks')]),
    h(Text, { color: 'subtle', wrap: 'truncate-end' }, '  split with the public Claude tokenizer (older models): current models count a little differently'),
  ]
}

const TABS = v => {
  const a = v.analysis
  const count = n => (n ? String(n) : '')
  return [
    { id: 'review', label: 'review', badge: count(a.issues.length) },
    { id: 'wording', label: 'wording', badge: count(a.wording.length) },
    { id: 'skills', label: 'skills', badge: count(a.skills.length + a.missing.length) },
    { id: 'improved', label: 'improved' },
    { id: 'tokens', label: 'tokens', badge: fmt(countTokens(v.prompt)) },
  ]
}

// The reviewed prompt split into tokens, drawn as /pm draws a prompt's: up to
// three rows of chips, then its "prompt:" row (tokens, chars, chars/token).
function tokenBreakdown(Box, Text, prompt, width) {
  const tokens = countTokens(prompt)
  const chars = [...prompt].length
  return h(
    Box,
    { key: 'tokens', flexDirection: 'column' },
    ...chipRows(Text, split(prompt), width, 3),
    h(
      Text,
      { wrap: 'truncate-end' },
      h(Text, { color: 'subtle' }, `  ${'prompt:'.padEnd(12)}`),
      h(Text, { bold: true }, fmt(tokens).padStart(8)),
      h(Text, { color: 'subtle' }, `  ${chars} chars · ${(chars / Math.max(tokens, 1)).toFixed(1)} chars/token`),
      ...(tokenizer ? [] : [h(Text, { color: 'warning' }, '   estimate: vendor/claude-tokenizer.json is missing')]),
    ),
  )
}

function body(Box, Text, Button, v, width, current, select) {
  if (v.status === 'idle') {
    return [
      h(Text, { bold: true }, 'Review a prompt before you send it'),
      h(Text, null, ' '),
      h(Text, null, h(Text, { bold: true, color: 'suggestion' }, '  /pa <your prompt>'), h(Text, { color: 'subtle' }, '   review that text')),
      h(Text, null, h(Text, { bold: true, color: 'suggestion' }, '  ctrl+x tab, a'), h(Text, { color: 'subtle' }, '       review what you are typing in the prompt box')),
      h(Text, null, ' '),
      h(Text, { color: 'subtle', wrap: 'wrap' }, 'You get a score, unclear wording, missing context, skills that would help, and an improved version that i puts in the prompt box.'),
    ]
  }
  // The token breakdown sits above whatever the review has come to.
  const above = [tokenBreakdown(Box, Text, v.prompt, width), h(Text, null, ' ')]
  const preview = h(Text, { color: 'subtle', italic: true, wrap: 'truncate-end' }, `│ ${oneLine(v.prompt, width - 2)}`)
  if (v.status === 'running') return [...above, h(Text, { color: 'suggestion' }, `⋯ reviewing with ${v.model}…`), preview]
  if (v.status === 'error') return [...above, h(Box, { key: 'error' }, h(Text, { color: 'error', wrap: 'wrap' }, `✗ ${v.error}`)), preview]
  // A finished review: the score stays in view, the rest is in tabs.
  const tabs = TABS(v)
  const active = tabs.some(t => t.id === current) ? current : 'review'
  const content =
    active === 'wording'
      ? wordingTab(Text, v.analysis)
      : active === 'skills'
        ? skillsTab(Text, v.analysis)
        : active === 'improved'
          ? improvedTab(Box, Text, v)
          : active === 'tokens'
            ? tokensTab(Text, v.prompt, width)
            : reviewTab(Text, v, width)
  return [...above, scoreLine(Text, v.analysis), h(Text, null, ' '), ...tabBar(Box, Text, Button, tabs, active, select, width), ...content]
}

// ── hooks ────────────────────────────────────────────────────────────────────

export function register(on, options) {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pa',
      description: 'Review a prompt before sending it: score, wording, missing context, skills, improved version',
      argumentHint: '[prompt]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'pa' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: 'prompt-analyzer', focus: true, rows: 30 })
    if (!opened.isPlaced) return { text: `pane waits: ${opened.reason}` }
    const prompt = e.args.trim()
    if (!prompt) return { text: 'pane open: type a prompt, then ctrl+x tab and a to review it' }
    await analyze($, prompt, options)
    const v = await read($, view)
    return { text: v.status === 'done' ? `reviewed: ${v.analysis.score}/10, details in the pane` : 'review failed, see the pane' }
  })

  // What you type, so a can review it; only while the pane is open.
  on('prompt.edit', async ($, e, next) => {
    if (!shown) return next(e)
    const box = await next(e)
    if (box.text !== draft) {
      draft = box.text
      if (shown) $.ui.invalidate('ui.render')
    }
    return box
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (!shown) return next(e)
    draft = ''
    if (shown) $.ui.invalidate('ui.render')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    shown = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    shown = true
    await loadTokenizer($)
    const v = await read($, view)
    const current = await read($, tab)
    const width = e.props.bodyColumns
    const busy = v.status === 'running'

    const typed = draft.trim()
    const draftLine = h(
      Text,
      { wrap: 'truncate-end' },
      h(Text, { bold: true, color: 'suggestion' }, '✎ draft   '),
      typed
        ? h(Text, { color: 'subtle' }, `${[...typed].length} chars · ${e.props.isFocused ? 'a reviews it' : 'ctrl+x tab, then a reviews it'}`)
        : h(Text, { color: 'subtle' }, e.props.isFocused ? 'esc, then type a prompt; come back with ctrl+x tab' : 'type a prompt, then ctrl+x tab and a'),
    )

    const buttons = [
      h(Button, {
        key: 'analyze',
        label: busy ? 'reviewing…' : 'review draft',
        hotkey: 'a',
        plain: true,
        autoFocus: true,
        dimColor: busy || !typed ? true : undefined,
        onPress: () => (busy ? undefined : typed ? analyze($, typed, options) : $.ui.toast('Type a prompt in the prompt box first')),
      }),
      ...(v.status === 'done' && v.analysis.improved
        ? [h(Button, { key: 'insert', label: 'use improved', hotkey: 'i', plain: true, onPress: () => fill($, v.analysis.improved) })]
        : []),
      ...(v.status !== 'idle' && !busy ? [h(Button, { key: 'original', label: 'restore original', hotkey: 'o', plain: true, onPress: () => fill($, v.prompt) })] : []),
      h(Button, { key: 'close', label: 'close', hotkey: 'q', plain: true, onPress: () => $.ui.close({ id: PANE }) }),
    ]
    const cost =
      v.status === 'done'
        ? `${v.model}${v.plain ? ' + /plain' : ''} · ${fmt(v.tokensIn)} in · ${fmt(v.tokensOut)} out · ${(v.ms / 1000).toFixed(1)}s`
        : ''

    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { wrap: 'truncate-end' }, h(Text, { bold: true, color: 'claude' }, '◆ prompt-analyzer'), h(Text, { color: 'subtle' }, cost ? `   ${cost}` : '')),
      draftLine,
      h(Text, { color: 'subtle' }, '─'.repeat(width)),
      h(Box, { key: 'body', flexDirection: 'column' }, ...body(Box, Text, Button, v, width, current, id => update($, tab, () => id))),
      h(Text, null, ' '),
      h(Box, { flexDirection: 'row', gap: 2 }, ...buttons),
    )
  })
}
