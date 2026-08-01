"""One-off maintenance (port of scripts/reset-aifail.js).

Find every Linear issue labelled `aifail`, move it to its team's Backlog state,
and strip the `aifail` label so the coder monitor can pick it up again.

    python -m ai_fleet.scripts.reset_aifail           # dry run — list only
    python -m ai_fleet.scripts.reset_aifail --apply    # perform the changes
"""

from __future__ import annotations

import asyncio
import sys

from ai_fleet import linear, store

FAIL_LABEL = "aifail"

AIFAIL_ISSUES_QUERY = """
  query AifailIssues($label: String!, $first: Int!) {
    issues(first: $first, filter: { labels: { name: { eq: $label } } }) {
      nodes {
        id identifier title url
        state { id name type }
        team { id name }
        labels(first: 50) { nodes { id name } }
      }
    }
  }"""


async def main(apply: bool) -> None:
    data = store.read_store()
    api_key = data and data.get("settings", {}).get("linearApiKey")
    if not api_key:
        raise RuntimeError("No linearApiKey configured in the store.")

    res = await linear.linear_request(api_key, AIFAIL_ISSUES_QUERY, {"label": FAIL_LABEL, "first": 250})
    issues = ((res or {}).get("issues") or {}).get("nodes") or []

    if not issues:
        print(f'No issues carry the "{FAIL_LABEL}" label. Nothing to do.')
        return

    print(f'Found {len(issues)} issue(s) labelled "{FAIL_LABEL}":\n')

    backlog_by_team: dict[str, dict] = {}

    async def backlog_state_for(team):
        if not team or not team.get("id"):
            raise RuntimeError("issue has no team")
        if team["id"] in backlog_by_team:
            return backlog_by_team[team["id"]]
        states = await linear.get_team_states(api_key, team["id"])
        backlog = linear.pick_state_by_type(states, "backlog", "Backlog")
        if not backlog:
            raise RuntimeError(f'team "{team.get("name")}" has no Backlog-type state')
        backlog_by_team[team["id"]] = backlog
        return backlog

    changed = 0
    for issue in issues:
        labels = (issue.get("labels") or {}).get("nodes") or []
        kept_label_ids = [l["id"] for l in labels if l["name"] != FAIL_LABEL]
        backlog = await backlog_state_for(issue["team"])
        from_ = f"{issue['state']['name']} ({issue['state']['type']})"
        kept_names = ", ".join(l["name"] for l in labels if l["name"] != FAIL_LABEL)
        all_names = ", ".join(l["name"] for l in labels)
        print(
            f"  {issue['identifier']}  {from_} → Backlog | "
            f"labels: [{all_names}] → [{kept_names}]  "
            f"— {issue['title'][:60]}"
        )
        if apply:
            await linear.update_issue(api_key, issue["id"], {"stateId": backlog["id"], "labelIds": kept_label_ids})
            changed += 1

    print("")
    if apply:
        print(f'✅ Updated {changed} issue(s): moved to Backlog and removed "{FAIL_LABEL}".')
    else:
        print(f"Dry run only. Re-run with --apply to perform these {len(issues)} change(s).")


def cli() -> None:
    apply = "--apply" in sys.argv
    try:
        asyncio.run(main(apply))
    except Exception as err:
        print(f"reset-aifail failed: {getattr(err, 'message', None) or err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    cli()
