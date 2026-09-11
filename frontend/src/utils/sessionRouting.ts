export function mergeSessionRouting(current: any, incoming: any): any {
  const merged = { ...current, ...incoming };
  if (incoming?.loopControlMode !== 'manual' && incoming?.loopControlMode !== 'loop') {
    merged.loopControlMode = current?.loopControlMode;
  }
  return merged;
}

export class SessionRoutingCache {
  private entries = new Map<string, any>();
  private revisions = new Map<string, number>();
  get(id: string): any { return this.entries.get(id) || null; }
  revision(id: string): number { return this.revisions.get(id) || 0; }
  update(id: string, incoming: any): any {
    const merged = mergeSessionRouting(this.get(id), { ...incoming, id });
    this.entries.set(id, merged);
    this.revisions.set(id, this.revision(id) + 1);
    return merged;
  }
  loaded(id: string, incoming: any, revision: number): any {
    if (this.revision(id) !== revision) return mergeSessionRouting(incoming, this.get(id));
    return this.update(id, incoming);
  }
  delete(id: string): void { this.entries.delete(id); this.revisions.delete(id); }
  clear(): void { this.entries.clear(); this.revisions.clear(); }
}
