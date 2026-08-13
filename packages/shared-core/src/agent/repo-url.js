'use strict';

/**
 * SDK-free repo-reference parsing, extracted from agent/workspace.js so
 * lightweight callers (the router gateway) can parse repo URLs without pulling
 * the agent/workspace + repository-broker tree. Pure function — no I/O, no deps.
 */

/**
 * Parse a GitHub/GitLab repo reference into a display name + tokenless HTTPS URL.
 * Bare namespace/repo values use the selected provider. Explicit URLs are
 * restricted to the selected official host; GitHub has exactly owner/repo while
 * GitLab may contain nested groups.
 */
function repoParts(repoUrl, selectedProvider = 'github') {
  const s = String(repoUrl || '').trim();
  const provider = String(selectedProvider || '').toLowerCase();
  if (provider !== 'github' && provider !== 'gitlab') return null;
  const expectedHost = provider === 'gitlab' ? 'gitlab.com' : 'github.com';
  const cleanPath = (value) => String(value || '').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  const fromPath = (host, value) => {
    const repoPath = cleanPath(value);
    const segments = repoPath.split('/').filter(Boolean);
    if (host !== expectedHost) return null;
    if (
      segments.length < 2 ||
      (provider === 'github' && segments.length !== 2) ||
      segments.some((segment) => segment === '.' || segment === '..' || !/^[A-Za-z0-9_.-]+$/.test(segment))
    ) {
      return null;
    }
    const name = segments[segments.length - 1];
    const owner = segments.slice(0, -1).join('/');
    return {
      provider,
      owner,
      name,
      fullName: `${owner}/${name}`,
      https: `https://${expectedHost}/${owner}/${name}.git`,
    };
  };

  // Bare namespace/repo (GitLab may include nested groups).
  if (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+(?:\.git)?$/.test(s)) return fromPath(expectedHost, s);

  let match = s.match(/^https:\/\/(github\.com|gitlab\.com)\/(.+)$/i);
  if (match) return fromPath(match[1].toLowerCase(), match[2]);
  match = s.match(/^git@(github\.com|gitlab\.com):(.+)$/i);
  if (match) return fromPath(match[1].toLowerCase(), match[2]);
  return null;
}

module.exports = { repoParts };
