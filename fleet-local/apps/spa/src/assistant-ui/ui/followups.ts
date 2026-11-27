// Follow-up suggestions, derived client-side from the agent's last answer. There
// is no wire mechanism for suggestions (a harness could emit them, but none does
// today — see docs/HARNESS_CAPABILITY_MATRIX.md), so this reads the answer's own
// structure: an enumerated set of options becomes one chip per option, a yes/no
// question becomes accept/refine chips, and anything else falls back to three
// generic next-steps. It never invents facts about the task.

export const MAX_SUGGESTIONS = 3;
const OPTION_LIMIT = 6;

const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/;
const MD_LINK = /\[([^\]]+)\]\([^)]+\)/g;
const QUESTION = /[?.!]\s*$/;
const YESNO = /^(would|do|should|can|shall|want|need|shall i|may i)\b/i;

function stripInline(text: string): string {
  return text
    .replace(MD_LINK, '$1')
    .replace(/[*_`]/g, '')
    .trim();
}

// A leading label before a colon is the useful half of an option line: "Retry:
// runs the same call again" -> "Retry". Only when the label is short enough to
// be a title, so a sentence that merely contains a colon stays whole.
function leadLabel(value: string): string {
  const idx = value.indexOf(':');
  if (idx === -1) return value;
  const head = value.slice(0, idx).trim();
  return head.length > 0 && head.length <= 40 ? head : value;
}

function clamp(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

export function deriveSuggestions(answer: string): string[] {
  if (!answer || !answer.trim()) return [];
  const lines = answer.split('\n');

  const options: string[] = [];
  for (const line of lines) {
    const match = BULLET.exec(line);
    if (!match) continue;
    const value = clamp(leadLabel(stripInline(match[1] ?? '')));
    if (value) options.push(value);
    if (options.length >= OPTION_LIMIT) break;
  }
  if (options.length >= 2) return options.slice(0, MAX_SUGGESTIONS);

  const questions = lines
    .map((l) => stripInline(l))
    .filter((l) => l !== '' && QUESTION.test(l));
  if (questions.length > 0) {
    const last = questions[questions.length - 1] ?? '';
    return YESNO.test(last) ? ['Yes, go ahead', 'Not yet — explain first'] : ['Answer', 'Show an alternative'];
  }

  return ['Explain your reasoning', 'Give a concrete example', 'What should happen next?'];
}
