interface MarketViewItem {
  id: string; name: string; description: string; sourceName: string; repository: string;
  path: string; sourceId: string; official: boolean; updateAvailable: boolean;
  repositoryInfo?: { stars?: number; pushedAt?: string };
}
export type SkillMarketSort = 'updates' | 'name' | 'stars' | 'recent';
export function filterMarketItems<T extends MarketViewItem>(items: T[], query: string, source: string, sort: SkillMarketSort): T[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = items.filter(item => (!source || item.sourceId === source) && (!needle || [
    item.name, item.description, item.sourceName, item.repository, item.path,
  ].join(' ').toLocaleLowerCase().includes(needle)));
  const timestamp = (item: MarketViewItem) => Date.parse(item.repositoryInfo?.pushedAt || '') || 0;
  return filtered.sort((a, b) => {
    const order = sort === 'stars' ? (b.repositoryInfo?.stars ?? -1) - (a.repositoryInfo?.stars ?? -1)
      : sort === 'recent' ? timestamp(b) - timestamp(a)
        : sort === 'updates' ? Number(b.updateAvailable) - Number(a.updateAvailable) || Number(b.official) - Number(a.official) : 0;
    return order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}
export function marketVersion(item: { version?: string; digest: string }): string {
  return item.version ? `声明版本 ${item.version}` : `未声明版本 · ${item.digest.slice(0, 12)}`;
}
