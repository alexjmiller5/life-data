import type { SourceLinkArgs, SourceLinkResult } from './contract.generated.ts';
import type { SqlDriver } from './driver.ts';
import { readCatalog } from './catalog.ts';
import { qident } from './validate.ts';

/** A narrow source parser also works in hosts without the URL global. */
function notionPage(url: string): string | undefined {
  if (url.length > 4096 || /[\s\\\u0000-\u001f\u007f]/.test(url)) return;
  const path = /^https:\/\/(?:notion\.so|www\.notion\.so|app\.notion\.com)\/([^?#]*)(?:[?#].*)?$/i.exec(url)?.[1];
  const last = path?.split('/').at(-1);
  return last?.match(/(?:^|-)([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i)?.[1].replaceAll('-', '').toLowerCase();
}

export async function resolveSourceLink(db: SqlDriver, args: SourceLinkArgs): Promise<SourceLinkResult> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.url !== 'string' || Object.keys(args).some(key => key !== 'url')) throw Error('Invalid source link');
  const page = notionPage(args.url);
  if (!page) return {};
  return db.transaction(async () => {
    const exists = await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='provenance'");
    if (!exists.length) return {};
    const columns = new Set((await db.all("SELECT name FROM pragma_table_info('provenance')")).map(row=>row.name));
    if (!['from_kind','from_ref','to_kind','to_ref','rel','field','deleted_at'].every(col=>columns.has(col))) throw Error('Source identity metadata is unavailable.');
    const edges = await db.all(`SELECT DISTINCT to_kind,to_ref FROM provenance
      WHERE from_kind IN ('notion','notion_media') AND lower(replace(from_ref,'-',''))=?
      AND rel='imported_from' AND field IS NULL AND deleted_at IS NULL LIMIT 2`, [page]);
    if (edges.length > 1) throw Error('This source has multiple imported destinations. Open the original link or review its source mappings.');
    const edge=edges[0];
    if (!edge || typeof edge.to_kind !== 'string' || typeof edge.to_ref !== 'string') return {};
    const catalog=await readCatalog(db);
    if (!catalog.tables.some(table=>table.id===edge.to_kind)) return {};
    const records=await db.all(`SELECT id FROM ${qident(edge.to_kind)} WHERE id COLLATE BINARY = ? LIMIT 1`,[edge.to_ref]);
    return records[0]?.id === edge.to_ref ? {destination:{table:edge.to_kind,row:edge.to_ref}} : {};
  });
}
