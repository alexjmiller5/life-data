import { expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { generateContract } from '../../scripts/generate-core-contract.ts';

const root = resolve(import.meta.dir, '../..');
const contract = JSON.parse(await readFile(resolve(root, 'core/contract/core.json'), 'utf8'));

test('one contract deterministically generates TS and prefixed Swift, including operation pairs', () => {
  const first = generateContract(contract);
  expect(generateContract(JSON.parse(JSON.stringify(contract)))).toEqual(first);
  expect(first.typescript).toContain('export type View =');
  expect(first.typescript).toContain('export interface CoreOperations');
  expect(first.typescript).toContain('rows: { args: View; result: WorkspaceRow[] }');
  expect(first.typescript).toContain('search: { args: SearchArgs; result: SearchHit[] }');
  expect(first.typescript).toContain('remoteRows: { args: RemoteRowsArgs; result: RemoteRowsPage }');
  expect(first.typescript).toContain('remoteRow: { args: RemoteRowArgs; result: RemoteRowResult }');
  expect(first.swift).toContain('public init(record: CoreRow, label: String, deleted: Bool)');
  expect(first.swift).toContain('public init(endpoint: String, table: String, limit: CoreCount? = nil, cursor: String? = nil)');
  expect(first.swift).toContain('public init(rows: [CoreRemoteRecord], nextCursor: String?)');
  expect(first.swift).toContain('public typealias Response = CoreRemoteRowResult');
  expect(first.swift).toContain('public init(text: String, table: String? = nil, limit: CoreCount? = nil, offset: CoreCount? = nil)');
  expect(first.swift).toContain('public typealias Response = [CoreSearchHit]');
  expect(first.typescript).toContain('listViews: { args: ListViewsArgs; result: SavedViewList }');
  expect(first.typescript).toContain('saveView: { args: SaveViewArgs; result: SavedViewRecord }');
  expect(first.typescript).toContain('deleteView: { args: DeleteViewArgs; result: SavedViewRecord }');
  expect(first.typescript).toContain('writeability: { args: WriteabilityArgs; result: Writeability }');
  expect(first.swift).toContain('public typealias Response = CoreWriteability');
  expect(first.swift).toContain('public struct CoreSavedViewDefinition:');
  expect(first.swift).toContain('public typealias Response = CoreSavedViewList');
  expect(first.swift).toContain('public struct CoreView:');
  expect(first.swift).toContain('public struct CoreFilter:');
  expect(first.swift).toContain('public typealias Response = [CoreWorkspaceRow]');
  expect(first.swift).toContain('public enum CoreFilterOp: String');
  expect(first.swift).toContain('case notEmpty = "not_empty"');
  expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(first.typescript).toContain(first.hash);
  expect(first.swift).toContain(first.hash);
  expect(first.swift).not.toContain('/Users/');
});

test('Swift codecs preserve required nulls, optional presence, and safe integers', () => {
  const { swift } = generateContract(contract);
  expect(swift).toContain('public enum CorePresence<Value:');
  expect(swift).toContain('try container.encode(readAt, forKey: .readAt)');
  expect(swift).toContain('try container.encode(nextCursor, forKey: .nextCursor)');
  expect(swift).toContain('container.contains(.readAt)');
  expect(swift).toContain('9_007_199_254_740_991');
  expect(swift).toContain('public init(column: String, op: CoreFilterOp, value: CoreFilterValue? = nil)');
});

test('generated DTOs and requests carry projection and edit revision requirements', () => {
  const { swift, typescript } = generateContract(contract);
  for (const source of [swift, typescript]) {
    expect(source).toContain('columns is SQL projection');
    expect(source).toContain('fetch a full row before editing');
    expect(source).toContain('expectedUpdatedAt is required when id is supplied');
  }
});

test('unknown schema constructs and dangling operation types fail generation', () => {
  const bad = structuredClone(contract);
  bad.$defs.View.properties.table.pattern = 'secret';
  expect(() => generateContract(bad)).toThrow(/unsupported schema/);
  const missing = structuredClone(contract);
  missing.operations.rows.result = { $ref: '#/$defs/DoesNotExist' };
  expect(() => generateContract(missing)).toThrow(/unknown contract type/);
});

test('checked-in artifacts match the authoritative contract', async () => {
  const result = generateContract(contract);
  expect(await readFile(resolve(root, 'core/src/contract.generated.ts'), 'utf8')).toBe(result.typescript);
  expect(await readFile(resolve(root, 'core/generated/CoreContract.generated.swift'), 'utf8')).toBe(result.swift);
});

test('check mode detects stale output without rewriting either artifact', async () => {
  const temp = await mkdtemp(resolve(tmpdir(), 'core-contract-check-'));
  const ts = resolve(temp, 'core.ts'), swift = resolve(temp, 'core.swift');
  const generated = generateContract(contract);
  await writeFile(ts, generated.typescript);
  await writeFile(swift, generated.swift);
  const check = () => Bun.spawn(['bun', resolve(root, 'scripts/generate-core-contract.ts'), '--check', '--ts', ts, '--swift', swift], { stdout: 'pipe', stderr: 'pipe' });
  expect(await check().exited).toBe(0);
  await writeFile(swift, '// stale');
  expect(await check().exited).not.toBe(0);
  expect(await readFile(swift, 'utf8')).toBe('// stale');
  expect(await readFile(ts, 'utf8')).toBe(generated.typescript);
});
