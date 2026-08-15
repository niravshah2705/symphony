/** Build the EventSource query from the context cryptographically bound to the
 * minted token. Never re-read the mutable workspace selection after minting. */
export function mintedStreamContextQuerySuffix(minted) {
  const valid = (value) => {
    const id = typeof value === 'string' ? value.trim() : '';
    return id && id.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(id) ? id : '';
  };
  const query = new URLSearchParams();
  const organizationId = valid(minted && minted.organizationId);
  const projectId = valid(minted && minted.projectId);
  if (organizationId) query.set('organizationId', organizationId);
  if (projectId) query.set('projectId', projectId);
  const value = query.toString();
  return value ? `&${value}` : '';
}
