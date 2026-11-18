---
name: spec-kit
description: Spec-driven development with the Spec Kit CLI. Use when a change needs an approved specification, plan, and task list before implementation, or when the user asks to specify, plan, or run /speckit.* commands against a repository.
---

# Spec Kit

Spec Kit turns an idea into a reviewed specification, then a plan, then a task
list, and only then an implementation. The plugin bundle carries the command
templates; the `specify` CLI that renders them into your agent's command set is
installed in the **harness runtime image**, not in this mount — the plugin image
is `FROM scratch` and has no shell to run an installer in.

## Check the tool is there before you plan around it

```bash
specify version
```

If it is missing, say so and stop: writing specs by hand while believing the
CLI is available produces artifacts `/speckit.implement` cannot regenerate.

## The order the workflow depends on

Run these in sequence, each as its own step, and never skip ahead.

1. `/speckit.constitution` — the project's non-negotiable principles. Everything
   later is judged against this file.
2. `/speckit.specify <what you want>` — the *what* and *why*. No stack, no files,
   no schema names.
3. `/speckit.clarify` — resolve the ambiguities the specification left. Ask one
   question at a time; do not batch them into a wall of text.
4. `/speckit.plan <stack>` — the *how*, constrained by the constitution.
5. `/speckit.tasks` — the plan decomposed into independently verifiable tasks.
6. `/speckit.checklist` — a quality gate over the specification, not the code.
7. `/speckit.implement` — execute the task list.

`templates/commands/*.md` in the upstream checkout is the source of those
command bodies; read them when you need the exact prompts rather than the shape.

## Rules that keep the sequence honest

- Do not start an implementation before `tasks.md` exists and has been reviewed.
- A change that contradicts `constitution.md` is a plan revision, not an
  implementation note.
- Keep the specification free of implementation detail; keep the plan free of
  requirements. When a document does both, split it.
- Regenerate rather than hand-edit derived artifacts, so a re-run reproduces
  them.
- Treat `.specify/` as working state the CLI owns.
