// Branch tree, localStorage-only by design. kagent owns each conversation's
// history behind one contextId and cannot fork it, so a "branch" is not a
// replayed prefix — it is a NEW conversation (its own thread handle, its own
// server session) that remembers where the human left the previous one. The
// prefix lives in the parent branch, not in the child.

export interface Branch {
  /** The AG-UI thread handle this branch runs on — the app's conversation id. */
  threadId: string;
  /** The branch this one forked from, or null for the trunk. */
  parentThreadId: string | null;
  /** First line of the message the fork was taken from, as the label. */
  label: string;
  createdAt: number;
}

const KEY_PREFIX = 'fleet-local:branches:';
const LIMIT = 50;

export function loadBranches(orgId: string, projectId: string): Branch[] {
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${orgId}:${projectId}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (b): b is Branch =>
        typeof b === 'object' && b !== null && typeof (b as Branch).threadId === 'string',
    );
  } catch {
    return [];
  }
}

function save(orgId: string, projectId: string, branches: Branch[]): void {
  try {
    localStorage.setItem(`${KEY_PREFIX}${orgId}:${projectId}`, JSON.stringify(branches.slice(-LIMIT)));
  } catch {
    // A full or blocked localStorage loses the tree display only; every branch
    // is still a real session row the sidebar's session list can resume.
  }
}

export function addBranch(orgId: string, projectId: string, branch: Branch): Branch[] {
  const branches = loadBranches(orgId, projectId).filter((b) => b.threadId !== branch.threadId);
  branches.push(branch);
  save(orgId, projectId, branches);
  return branches;
}

export function labelFromMessage(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? text;
  const trimmed = line.trim();
  return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
}

export interface BranchNode {
  branch: Branch;
  children: BranchNode[];
}

/** Forest of branches; a branch whose parent predates the tree (or was never
 *  forked from one) is its own root, so nothing goes invisible. */
export function buildTree(branches: Branch[]): BranchNode[] {
  const byParent = new Map<string | null, Branch[]>();
  for (const b of branches) {
    const list = byParent.get(b.parentThreadId) ?? [];
    list.push(b);
    byParent.set(b.parentThreadId, list);
  }
  const known = new Set(branches.map((b) => b.threadId));
  const seen = new Set<string>();
  const walk = (parent: string | null): BranchNode[] =>
    (byParent.get(parent) ?? [])
      .sort((a, b) => a.createdAt - b.createdAt)
      .filter((b) => !seen.has(b.threadId) && (seen.add(b.threadId) || true))
      .map((branch) => ({ branch, children: walk(branch.threadId) }));
  const roots = walk(null);
  for (const [parentId, kids] of byParent) {
    if (parentId !== null && !known.has(parentId)) roots.push(...walk(parentId));
  }
  return roots.sort((a, b) => a.branch.createdAt - b.branch.createdAt);
}
