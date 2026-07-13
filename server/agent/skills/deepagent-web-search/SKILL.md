export const meta = {
  name: 'deepagent-skills',
  description: 'Define skills for deepagent to search web and summarize tasks',
  Phases: [
    { title: 'Skill Creation', detail: 'Write documentation for new skills' },
    { title: 'Verification', detail: 'Verify skill definitions' },
  ],
}

const SKILLS = `
# deepagent-web-search
- **deepagent-web-search** (`~/.claude/skills/deepagent-web-search/SKILL.md`) - search the web for technical information, debug logs, or documentation, then summarize findings and relevant tasks. Trigger: `/deepagent-web-search`
When the user types `/deepagent-web-search`, invoke the Skill tool with `skill: "deepagent-web-search"` before doing anything else.

# deepagent-task-summarizer
- **deepagent-task-summarizer** (`~/.claude/skills/deepagent-task-summarizer/SKILL.md`) - analyze a set of requirements or research findings, extract specific actionable tasks, and format as a structured todo list. Trigger: `/deepagent-task-summarizer`
When the user types `/deepagent-task-summarizer`, invoke the Skill tool with `skill: "deepagent-task-summarizer"` before doing anything else.
`;

Write(`${SKILLS}`)
