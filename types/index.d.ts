// What the prompt-analyzer pane shows, kept per session (hooks/register.mjs).

export type Severity = 'high' | 'medium' | 'low'

export type Analysis = {
  score: number
  task: string
  verdict: string
  issues: { severity: Severity; problem: string; fix: string }[]
  wording: { quote: string; better: string; why: string }[]
  skills: { name: string; why: string }[]
  missing: string[]
  improved: string
}

export type View =
  | { status: 'idle' }
  | { status: 'running'; prompt: string; model: string }
  | { status: 'done'; prompt: string; model: string; analysis: Analysis; tokensIn: number; tokensOut: number; ms: number; plain: boolean }
  | { status: 'error'; prompt: string; model: string; error: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-analyzer': {
      view: View
      /** The tab of a finished review: review, wording, skills, improved or tokens. */
      tab: string
    }
  }
}
