import type { Database } from './database.ts';
type Action = 'read' | 'write' | 'export';
type Rule = { read: boolean; write: boolean };
type Resource = {
  id: string; parent_id: string | null; owner_id: string; group_id: string;
  policy: string; group_policies: string; user_policies: string;
  inherit_permissions: number; export_disabled: number; trashed: number;
};
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parse(value: string): Record<string, unknown> {
  try { return record(JSON.parse(value)); } catch { return {}; }
}
function rule(value: unknown): Rule {
  const item = record(value), visible = !Object.hasOwn(item, 'visible') || item.visible === true;
  const write = visible && item.write === true;
  return { read: visible && (item.read === true || write), write };
}

export class AccessService {
  private cache = new Map<string, boolean>();
  private epoch = -1;
  private db: Database;
  constructor(db: Database) { this.db = db; }

  allows(userId: string, resourceId: string, action: Action): boolean {
    if (!['read', 'write', 'export'].includes(action)) return false;
    // Never retain a decision based on uncommitted state: epoch values can be
    // reused after rollback (ABA) by an unrelated subsequent transaction.
    if (this.db.inTransaction) return this.evaluate(userId, resourceId, action);
    const state = this.db.prepare('SELECT acl_epoch FROM app_state WHERE id=1').get() as { acl_epoch: number };
    if (state.acl_epoch !== this.epoch) { this.cache.clear(); this.epoch = state.acl_epoch; }
    const key = JSON.stringify([userId, resourceId, action]);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const allowed = this.evaluate(userId, resourceId, action);
    if (this.cache.size >= 2048) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, allowed);
    return allowed;
  }

  private evaluate(userId: string, resourceId: string, action: Action): boolean {
    const user = this.db.prepare('SELECT active,admin_role FROM users WHERE id=?').get(userId) as { active: number; admin_role: string } | undefined;
    if (!user || user.active !== 1) return false;
    const chain: Resource[] = [], seen = new Set<string>();
    let id: string | null = resourceId;
    while (id !== null) {
      if (seen.has(id) || chain.length > 32) return false;
      seen.add(id);
      const item = this.db.prepare('SELECT * FROM resources WHERE id=?').get(id) as Resource | undefined;
      if (!item || item.trashed) return false;
      chain.push(item); id = item.parent_id;
    }
    const settings = this.db.prepare('SELECT default_policy,export_disabled FROM app_state WHERE id=1').get() as { default_policy: string; export_disabled: number };
    const basicAction = action === 'export' ? 'read' : action;
    let permitted = user.admin_role === 'simple' || user.admin_role === 'giga';
    if (!permitted) {
      const groups = new Set((this.db.prepare('SELECT group_id FROM memberships WHERE user_id=?').all(userId) as { group_id: string }[]).map(row => row.group_id));
      const source = chain.find(item => !item.inherit_permissions || item.parent_id === null)!;
      let personal: Rule | undefined;
      for (const item of chain) {
        const policies = parse(item.user_policies);
        if (Object.hasOwn(policies, userId)) { personal = rule(policies[userId]); break; }
        if (!item.inherit_permissions) break;
      }
      if (personal) permitted = personal[basicAction];
      else {
        const additional = source.inherit_permissions && source.parent_id === null ? {} : parse(source.group_policies);
        const matching = Object.entries(additional).filter(([group]) => groups.has(group));
        if (matching.length) permitted = matching.some(([, value]) => rule(value)[basicAction]);
        else {
          const policy = parse(source.inherit_permissions && source.parent_id === null ? settings.default_policy : source.policy);
          const scope = userId === source.owner_id ? 'owner' : groups.has(source.group_id) ? 'group' : 'everyone';
          permitted = rule(policy[scope])[basicAction];
        }
      }
    }
    if (!permitted) return false;
    return action !== 'export' || user.admin_role === 'giga' || (!settings.export_disabled && !chain.some(item => item.export_disabled));
  }
}
