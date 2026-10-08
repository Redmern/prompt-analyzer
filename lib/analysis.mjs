// What the analyzer asks the model, and how it reads the answer. No imports,
// so the hooks module and the tests both load it.

export const SYSTEM = `You review prompts a developer is about to send to Claude Code, an agentic coding assistant that works in their terminal: it reads and edits files, runs commands, and can use the skills and slash commands listed with the prompt. Judge how well the prompt will get its task done, and how to make it better. Be concrete and brief, and quote the prompt's own words.

Look at:
- Goal: is the outcome clear? Is it one task, or several tangled together?
- Context: does it name the files, functions, errors, commands or URLs Claude would otherwise have to guess or search for? A vague reference ("it", "that bug", "the thing") is fine only when the recent conversation makes it unambiguous.
- Constraints and done-criteria: scope, what not to touch, style, and how to check the result (tests to run, expected output).
- Wording: vague or loaded words, typos that change the meaning, contradictions, instructions that only say what not to do, a request phrased so it invites doing too much or too little.
- Skills: which of the listed skills or slash commands would help with this task. Only suggest names from the list. A skill is used by naming it in the prompt ("use the code-review skill") or typing /name.

Never invent files, errors or facts. If the prompt is already good, say so and keep the rewrite close to it. Write the improved prompt in the same language and voice as the original, as the developer would send it, with no preamble.

Reply with one JSON object and nothing else:
{"score": <1-10>, "task": "<what the prompt asks for, one line>", "verdict": "<the main strength or problem, one line>", "issues": [{"severity": "high" | "medium" | "low", "problem": "<...>", "fix": "<...>"}], "wording": [{"quote": "<exact words from the prompt>", "better": "<replacement>", "why": "<few words>"}], "skills": [{"name": "<name from the list, no slash>", "why": "<...>"}], "missing": ["<context worth adding>"], "improved": "<the rewritten prompt>"}
At most 4 issues, 4 wording notes, 3 skills and 4 missing items; an empty list where there is nothing to say.`

// The parts of the /plain skill (Simplified Technical English) that say how to
// write: its "Rules" and "The 80% rule" sections. Its Input and Output sections
// are about running it as a command, so they stay out. Null when neither is there.
export function plainRules(skill) {
  const body = skill.replace(/^---\n[\s\S]*?\n---\n/, "");
  const sections = [...body.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)]
    .filter(([, title]) => /^(rules|the 80% rule)$/i.test(title.trim()))
    .map(([, title, text]) => `## ${title.trim()}\n${text.trim()}`);
  return sections.length ? sections.join("\n\n") : null;
}

// The reviewer's system prompt, with /plain's rules for its explanations when
// they are given.
export function systemPrompt(plain) {
  if (!plain) return SYSTEM;
  return `${SYSTEM}

Write every explanation (task, verdict, problem, fix, why, missing) in plain style, following the rules of the /plain skill below. They do not apply to "quote", to "improved", to skill names, or to code, paths and identifiers.
<plain_skill>
${plain}
</plain_skill>`;
}

const clip = (text, n) => (text.length > n ? text.slice(0, n - 1) + "…" : text);

// The user message: the prompt, plus what Claude Code would know when it
// arrives, so references and skill suggestions can be judged.
export function buildRequest({ prompt, messages = [], cwd = "", files = [], commands = [] }) {
  const recent = messages
    .slice(-6)
    .map((m) => `${m.role}: ${clip(m.text.replace(/\s+/g, " ").trim(), 600)}`)
    .filter((line) => !line.endsWith(": "))
    .join("\n");
  const listed = commands
    .slice(0, 160)
    .map((c) => `/${c.name}: ${clip(c.description.replace(/\s+/g, " ").trim(), 140)}`)
    .join("\n");
  return [
    `<prompt>\n${prompt}\n</prompt>`,
    `<recent_conversation>\n${recent || "(none: this would be the first prompt)"}\n</recent_conversation>`,
    `<project>\nworking directory: ${cwd || "(unknown)"}\ntop-level entries: ${files.slice(0, 60).join(", ") || "(unknown)"}\n</project>`,
    `<available_skills_and_commands>\n${listed || "(none listed)"}\n</available_skills_and_commands>`,
  ].join("\n\n");
}

const SEVERITIES = new Set(["high", "medium", "low"]);
const text = (v) => (typeof v === "string" ? v.trim() : "");
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

// The model's reply as an analysis, or null when it holds none. Tolerates
// prose or a code fence around the JSON.
export function parseAnalysis(reply) {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw;
  try {
    raw = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const score = Math.round(Number(raw.score));
  const analysis = {
    score: Number.isFinite(score) ? Math.min(10, Math.max(1, score)) : 0,
    task: text(raw.task),
    verdict: text(raw.verdict),
    issues: list(raw.issues, 4)
      .map((i) => ({ severity: SEVERITIES.has(i?.severity) ? i.severity : "medium", problem: text(i?.problem), fix: text(i?.fix) }))
      .filter((i) => i.problem),
    wording: list(raw.wording, 4)
      .map((w) => ({ quote: text(w?.quote), better: text(w?.better), why: text(w?.why) }))
      .filter((w) => w.quote),
    skills: list(raw.skills, 3)
      .map((s) => ({ name: text(s?.name).replace(/^\//, ""), why: text(s?.why) }))
      .filter((s) => s.name),
    missing: list(raw.missing, 4).map(text).filter(Boolean),
    improved: text(raw.improved),
  };
  return analysis.score || analysis.improved || analysis.issues.length ? analysis : null;
}
