import { yieldToUi } from './cooperativeWork';

export interface LocalTreeNode {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  local: boolean;
  remote: boolean;
}

export async function buildLocalManifestTree(manifest: Record<string, { size: number }> | null, signal: AbortSignal): Promise<Record<string, LocalTreeNode[]>> {
  const levels = new Map<string, Map<string, LocalTreeNode>>();
  if (!manifest) return {};
  let processed = 0;
  for (const path in manifest) {
    if (++processed % 128 === 0) await yieldToUi(signal);
    const meta = manifest[path];
    const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const childRel = parts.slice(0, i + 1).join('/');
      const isDir = i < parts.length - 1;
      let level = levels.get(parent);
      if (!level) { level = new Map(); levels.set(parent, level); }
      level.set(childRel, {
        name: parts[i], rel: childRel, isDir,
        size: isDir ? 0 : meta.size,
        local: true, remote: false,
      });
    }
  }
  const tree: Record<string, LocalTreeNode[]> = {};
  for (const [parent, nodes] of levels) {
    if (++processed % 128 === 0) await yieldToUi(signal);
    tree[parent] = [...nodes.values()].sort((a, b) => (
      a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)
    ));
  }
  return tree;
}
