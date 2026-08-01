"""One-off (port of scripts/models-label-group.js).

Create the "Models" issue-label GROUP in Linear and pull the model-routing labels
(local/hosted) into it, so Linear shows them as a single-select dropdown on
issues. Idempotent. Uses the Linear API key from the store, or LINEAR_API_KEY
from the environment.

    python -m ai_fleet.scripts.models_label_group
    LINEAR_API_KEY=lin_api_xxx python -m ai_fleet.scripts.models_label_group
"""

from __future__ import annotations

import asyncio
import os
import sys

from ai_fleet import linear, store
from ai_fleet.config import CONFIG


async def main() -> int:
    api_key = os.environ.get("LINEAR_API_KEY") or store.get_api_key()
    if not api_key:
        print("No Linear API key. Set it in Settings or pass LINEAR_API_KEY=…", file=sys.stderr)
        return 1

    group_name = CONFIG.CODER.modelLabelGroup
    children = [CONFIG.CODER.localModelLabel, CONFIG.CODER.hostedModelLabel]

    print(f'Grouping model labels [{", ".join(children)}] under "{group_name}"…')
    for name in children:
        label = await linear.get_or_create_grouped_issue_label(api_key, group_name, name)
        print(f'  ✓ "{name}" → group "{group_name}" (label {label["id"]})')
    print(f'Done. "{group_name}" now renders as a single-select dropdown on issues in Linear.')
    return 0


def cli() -> None:
    try:
        sys.exit(asyncio.run(main()))
    except Exception as err:
        print(f"Failed: {getattr(err, 'message', None) or err}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    cli()
