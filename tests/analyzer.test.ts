import { expect, test } from 'claude-code/testing'
import { buildRequest, parseAnalysis } from '../lib/analysis.mjs'

const PANE = 'prompt-analyzer'
const PROPS = { title: 'prompt-analyzer', isFocused: true, bodyColumns: 120, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} } as const

const REVIEW = {
  score: 4,
  task: 'Fix a login bug',
  verdict: 'No file, error or way to check the fix',
  issues: [{ severity: 'high', problem: 'Which login bug is unclear', fix: 'Paste the error and name the file' }],
  wording: [{ quote: 'fix it', better: 'find the cause and fix it', why: 'asks for the root cause' }],
  skills: [
    { name: 'code-review', why: 'review the fix before committing' },
    { name: 'made-up-skill', why: 'does not exist here' },
  ],
  missing: ['the error message'],
  improved: 'Login fails with 401 for valid users in src/auth/login.ts. Find the cause, fix it, and add a regression test.',
}

// A tiny claude.json for prompt-meter's tokenizer: every byte is a token, and
// "fix" and " it" merge into one each.
const VOCAB = JSON.stringify({
  pat_str: "'s|'t|'re|'ve|'m|'ll|'d| ?\\p{L}+| ?\\p{N}+| ?[^\\s\\p{L}\\p{N}]+|\\s+(?!\\S)|\\s+",
  special_tokens: {},
  bpe_ranks: `! 0 ${Array.from({ length: 256 }, (_, i) => btoa(String.fromCharCode(i))).join(' ')}\n! 256 ${btoa('fi')} ${btoa('fix')} ${btoa(' i')} ${btoa(' it')}`,
})

const PLAIN_SKILL = `---
name: plain
description: Rewrite text in Simplified Technical English.
---

# Plain

## Input

1. If \`$ARGUMENTS\` is a file path, read that file.

## Rules

1. Write a maximum of 20 words per instruction sentence.

## The 80% rule

Aim for about 80% adherence, not 100%.

## Output

1. Give only the rewritten text.
`

const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

// Stands in for the engine: commands, session, files, the model and the
// prompt box. Records what the plugin asked of the model and the prompt box.
function engine(on: any, { reply = '```json\n' + JSON.stringify(REVIEW) + '\n```', plainSkill = true } = {}) {
  const calls = { model: [] as any[], fills: [] as any[], messages: 0 }
  on('command.list', () => ({
    value: [
      { name: 'code-review', description: 'Review the current diff for bugs', source: 'builtin' },
      { name: 'run', description: 'Launch the app to see a change working', source: 'builtin' },
    ],
  }))
  on('session.messages', () => {
    calls.messages++
    return { value: [{ role: 'user', text: 'the login page is broken', toolUses: [] }] }
  })
  on('session.cwd', () => ({ value: '/proj' }))
  let now = 1_000
  on('clock.now', () => ({ value: (now += 1500) }))
  on('fs.list', () => ({ value: [{ name: 'src', kind: 'dir', size: 0 }, { name: 'package.json', kind: 'file', size: 10 }] }))
  on('model.complete', ($: unknown, e: any) => {
    calls.model.push(e)
    return { value: { isAnswered: true, text: reply, usage } }
  })
  // The vocabulary, and the /plain skill in the person's config when installed.
  on('fs.read', ($: unknown, e: { path: string }) => {
    if (e.path.endsWith('vendor/claude-tokenizer.json')) return { value: VOCAB }
    if (plainSkill && e.path === '/home/u/.claude-config/skills/plain/SKILL.md') return { value: PLAIN_SKILL }
    return { deny: 'no such file' }
  })
  on('env.get', ($: unknown, e: { name: string }) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? '/home/u/.claude-config' : undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', ($: unknown, e: any) => {
    calls.fills.push(e)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  return calls
}

const run = ($: any, args: string) =>
  $.command.run({ command: 'pa', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const mount = ($: any, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'prompt-analyzer', surface, component: 'Pane', requestId: PANE, props: PROPS })

test('/pa <prompt> reviews that text and shows the review', async ($, on) => {
  const calls = engine(on)
  const ran = await run($, 'fix it')
  expect(ran.text).toContain('4/10')

  const sent = calls.model[0]
  expect(sent.model).toBe('haiku')
  expect(sent.prompt).toContain('<prompt>\nfix it\n</prompt>')
  expect(sent.prompt).toContain('/code-review: Review the current diff')
  expect(sent.prompt).toContain('the login page is broken')
  expect(sent.prompt).toContain('src/, package.json')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    const body = async () => (await ui.find({ key: 'body' }))?.text ?? ''
    // The score stays above the tabs; the review tab opens first.
    expect(await body()).toContain('4/10')
    expect(await body()).toContain('Which login bug is unclear')
    await ui.press({ key: 'tab:wording' })
    expect(await body()).toContain('find the cause and fix it')
    expect(await body()).toContain('4/10')
    await ui.press({ key: 'tab:skills' })
    expect(await body()).toContain('/code-review')
    expect(await body()).not.toContain('made-up-skill') // only skills that exist here
    expect(await body()).toContain('the error message')
    await ui.press({ key: 'tab:improved' })
    expect((await ui.find({ key: 'improved' }))?.text).toContain('regression test')
    expect(await body()).toMatch(/tokens:\s+\d+ → \d+/)
    await ui.press({ key: 'tab:tokens' })
    expect(await body()).toContain('longest tokens')
    await ui.press({ key: 'tab:review' })
    await ui.unmount()
  }
})

test('i puts the improved prompt in the prompt box, o the original', async ($, on) => {
  const calls = engine(on)
  await run($, 'fix it')
  const ui = await mount($)
  await ui.press({ key: 'insert' })
  expect(calls.fills.at(-1)).toMatchObject({ text: REVIEW.improved, mode: 'replace' })
  await ui.press({ key: 'original' })
  expect(calls.fills.at(-1)).toMatchObject({ text: 'fix it', mode: 'replace' })
  await ui.unmount()
})

test('a reviews what is typed in the prompt box', async ($, on) => {
  const calls = engine(on)
  on('prompt.edit', ($: unknown, e: any) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length }
  })
  const ui = await mount($)
  await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'make the tests pass' } as any)
  await ui.press({ key: 'analyze' })
  expect(calls.model.at(-1).prompt).toContain('<prompt>\nmake the tests pass\n</prompt>')
  expect((await ui.find({ key: 'body' }))?.text).toContain('4/10')
  await ui.unmount()
})

test('a reply it cannot read says so', async ($, on) => {
  engine(on, { reply: 'Sorry, I cannot help with that.' })
  const ran = await run($, 'fix it')
  expect(ran.text).toContain('failed')
  const ui = await mount($)
  expect((await ui.find({ key: 'error' }))?.text).toContain('could not read')
  await ui.unmount()
})

test('the conversation stays out when the option is off', { options: { INCLUDE_CONVERSATION: false } }, async ($, on) => {
  const calls = engine(on)
  await run($, 'fix it')
  expect(calls.messages).toBe(0)
  expect(calls.model[0].prompt).toContain('(none: this would be the first prompt)')
})

test('parseAnalysis reads fenced JSON and clamps what it gets', () => {
  const read = parseAnalysis('Here you go:\n```json\n{"score": 14, "issues": [{"severity": "huge", "problem": "p"}], "improved": "x"}\n```')
  expect(read?.score).toBe(10)
  expect(read?.issues[0].severity).toBe('medium')
  expect(parseAnalysis('no json here')).toBeNull()
  expect(buildRequest({ prompt: 'hi' })).toContain('(none listed)')
})

test('the reviewed prompt is split into tokens above the review, as /pm shows it', async ($, on) => {
  engine(on)
  await run($, 'fix it')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mount($, surface)
    const tokens = (await ui.find({ key: 'tokens' }))?.text ?? ''
    expect(tokens).toContain('fix␣it') // chips: "fix" and " it", whitespace as ␣
    expect(tokens).toContain('prompt:')
    expect(tokens).toMatch(/prompt:\s+2\s+6 chars · 3\.0 chars\/token/)
    // Above the score and the tabs, on every tab.
    for (const id of ['review', 'wording', 'skills', 'improved', 'tokens']) {
      await ui.press({ key: `tab:${id}` })
      const text = (await ui.find({ key: 'body' }))?.text ?? ''
      expect(text.indexOf('fix␣it')).toBeLessThan(text.indexOf('4/10'))
    }
    await ui.press({ key: 'tab:review' })
    await ui.unmount()
  }
})

test('the advice is written with the /plain skill when it is installed', async ($, on) => {
  const calls = engine(on)
  await run($, 'fix it')
  const system = calls.model[0].system
  expect(system).toContain('<plain_skill>')
  expect(system).toContain('Write a maximum of 20 words per instruction sentence.')
  expect(system).toContain('Aim for about 80% adherence')
  expect(system).not.toContain('$ARGUMENTS') // its Input and Output sections stay out
  expect(system).toContain('They do not apply to "quote", to "improved"')
  const ui = await mount($)
  expect((await ui.find({ key: 'body' }))?.text).toContain('4/10')
  await ui.unmount()
})

test('without the /plain skill, or with the option off, the advice is written as usual', async ($, on) => {
  const calls = engine(on, { plainSkill: false })
  const ran = await run($, 'fix it')
  expect(ran.text).toContain('4/10')
  expect(calls.model[0].system).not.toContain('<plain_skill>')
})

test('the /plain option off keeps the skill out', { options: { PLAIN: false } }, async ($, on) => {
  const calls = engine(on)
  await run($, 'fix it')
  expect(calls.model[0].system).not.toContain('<plain_skill>')
})

test('a new review opens on the review tab', async ($, on) => {
  engine(on)
  await run($, 'fix it')
  const ui = await mount($)
  await ui.press({ key: 'tab:skills' })
  expect((await ui.find({ key: 'body' }))?.text).toContain('skills to use')
  await run($, 'fix it again')
  expect((await ui.find({ key: 'body' }))?.text).toContain('Which login bug is unclear')
  await ui.unmount()
})
