/** Pure authorization policy; server must verify caller identity and supply trusted grants. */
export const SERVICES = Object.freeze(['toss','grab','duo']);
export const ACTIONS = Object.freeze(['members','approve','revenue','setPrices','delegate','dualApprove']);
const FLAGS = {members:'can_members',approve:'can_approve',revenue:'can_revenue',setPrices:'can_set_prices',delegate:'can_delegate',dualApprove:'can_dual_approve'};
export function descendants(branches, root) {
  if (!Number.isInteger(root)) return [];
  const ids = new Set([root]), queue = [root];
  while (queue.length) {
    const current = queue.shift();
    for (const b of branches) {
      if (b.parent_id === current && !ids.has(b.id)) { ids.add(b.id); queue.push(b.id); }
    }
  }
  return [...ids];
}
export function authorized(grant, action, service, targetBranch, actorBranch, branches, owner = false) {
  if (!grant || !SERVICES.includes(service) || grant.service !== service || !ACTIONS.includes(action)) return false;
  if (grant[FLAGS[action]] !== true) return false;
  if (!Number.isInteger(targetBranch) || !Number.isInteger(actorBranch)) return false;
  if (grant.scope === 'global') return owner === true;
  if (grant.scope === 'own') return targetBranch === actorBranch;
  if (grant.scope === 'subtree') return descendants(branches, actorBranch).includes(targetBranch);
  return false;
}
export function visibleServices(grants) {
  return SERVICES.filter(s => grants.some(g => g.service === s && ACTIONS.some(a => g[FLAGS[a]] === true)));
}