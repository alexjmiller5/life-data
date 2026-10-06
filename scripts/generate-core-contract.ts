import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

type Schema = true | {
  $ref?: string; type?: string | string[]; enum?: string[]; anyOf?: Schema[]; oneOf?: Schema[];
  properties?: Record<string, Schema>; required?: string[]; items?: Schema;
  additionalProperties?: Schema;
  description?: string;
};
type Contract = { $defs: Record<string, Schema>; operations: Record<string, { args: Schema; result: Schema; description?: string }> };
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const pascal = (name: string) => name[0].toUpperCase() + name.slice(1);
const quote = (value: string) => JSON.stringify(value);
const swiftKeywords = new Set(('associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any false is nil self Self super throws true try _').split(' '));
const swiftIdentifier = (name: string) => swiftKeywords.has(name) ? '`' + name + '`' : name;

/** Deliberately restricted build-time schema vocabulary. Unsupported shapes fail
 * generation instead of silently widening either language's public contract. */
export function generateContract(contract: Contract) {
  const defs = contract.$defs;
  if (!defs || !contract.operations) throw new Error('invalid core contract');
  const hash = createHash('sha256').update(JSON.stringify(contract)).digest('hex');
  const keys = new Set(['$ref', 'type', 'enum', 'anyOf', 'oneOf', 'properties', 'required', 'items', 'additionalProperties', 'description']);
  const comment = (description?: string, indent = '') => description ? description.split(/\r?\n/).map(line => `${indent}/// ${line}\n`).join('') : '';
  const refName = (s: Exclude<Schema, true>) => {
    const name = s.$ref?.replace(/^#\/\$defs\//, '');
    if (!name || s.$ref !== `#/$defs/${name}` || !Object.hasOwn(defs, name)) throw new Error('unknown contract type');
    return name;
  };
  function variants(s: Exclude<Schema, true>) {
    if (!s.oneOf || s.oneOf.length < 2) throw new Error('unsupported schema tagged union');
    const members=s.oneOf.map(ref=>{
      if (ref===true || !ref.$ref || Object.keys(ref).length!==1) throw new Error('unsupported schema union member');
      const name=refName(ref), schema=defs[name];
      if (schema===true || schema.type!=='object' || !schema.properties || !schema.required) throw new Error('unsupported schema union member');
      return {name,schema};
    });
    const tags=members[0].schema.required!.filter(key=>{
      const values=members.map(({schema})=>{
        const field=schema.properties![key];
        return schema.required!.includes(key) && field!==true && field?.type==='string' && field.enum?.length===1 ? field.enum[0] : null;
      });
      return values.every(value=>value!==null && /^[a-z][a-z0-9_]*$/.test(value)) && new Set(values).size===members.length;
    });
    if(tags.length!==1)throw new Error('unsupported schema union discriminator');
    const key=tags[0];
    return {key,members:members.map(({name,schema})=>({name,tag:(schema.properties![key] as Exclude<Schema,true>).enum![0]}))};
  }
  function validate(s: Schema): void {
    if (s === true) return;
    if (!s || Object.keys(s).some(k => !keys.has(k))) throw new Error('unsupported schema construct');
    if (s.$ref) { refName(s); if (Object.keys(s).length !== 1) throw new Error('unsupported schema reference'); return; }
    if (s.oneOf) {
      if (Object.keys(s).some(key=>!['oneOf','description'].includes(key))) throw new Error('unsupported schema union');
      variants(s);s.oneOf.forEach(validate);return;
    }
    if (s.anyOf) {
      if (s.anyOf.length !== 2 || s.anyOf[1] === true || s.anyOf[1].type !== 'null') throw new Error('unsupported schema union');
      s.anyOf.forEach(validate); return;
    }
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (types.some(t => !['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'].includes(t!))) throw new Error('unsupported schema type');
    if (s.enum && (s.type !== 'string' || !s.enum.length || s.enum.some(v => typeof v !== 'string'))) throw new Error('unsupported schema enum');
    if (s.type === 'array') { if (!s.items) throw new Error('unsupported schema array'); validate(s.items); }
    if (s.type === 'object') {
      if (s.properties) {
        if (s.additionalProperties || !s.required || s.required.some(k => !Object.hasOwn(s.properties!, k))) throw new Error('unsupported schema object');
        const names = Object.keys(s.properties).map(camel);
        if (new Set(names).size !== names.length) throw new Error('unsupported schema name collision');
        Object.values(s.properties).forEach(validate);
      } else if (s.additionalProperties) validate(s.additionalProperties);
      else throw new Error('unsupported schema dictionary');
    }
  }
  for (const [name, s] of Object.entries(defs)) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) throw new Error('unsupported schema type name');
    validate(s);
  }
  for (const [name, op] of Object.entries(contract.operations)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(name)) throw new Error('unsupported schema operation name');
    validate(op.args); validate(op.result);
  }
  function ts(s: Schema): string {
    if (s === true) return 'unknown';
    if (s.$ref) return refName(s);
    if (s.oneOf) return s.oneOf.map(ts).join(' | ');
    if (s.anyOf) return s.anyOf.map(ts).join(' | ');
    if (s.enum) return s.enum.map(quote).join(' | ');
    if (Array.isArray(s.type)) return s.type.map(t => ts({ type: t })).join(' | ');
    switch (s.type) {
      case 'integer': case 'number': return 'number';
      case 'string': case 'boolean': case 'null': return s.type;
      case 'array': { const item = ts(s.items!); return (item.includes(' | ') ? `(${item})` : item) + '[]'; }
      case 'object': return s.properties
        ? `{ ${Object.entries(s.properties).map(([key, value]) => `${key}${s.required!.includes(key) ? '' : '?'}: ${ts(value)}`).join('; ')} }`
        : `Record<string, ${ts(s.additionalProperties!)}>`;
      default: throw new Error('unsupported schema type');
    }
  }
  function sw(s: Schema): string {
    if (s === true) return 'CoreJSONValue';
    if (s.$ref) return 'Core' + refName(s);
    if (s.anyOf) return sw(s.anyOf[0]) + '?';
    switch (s.type) {
      case 'string': return 'String'; case 'number': return 'Double'; case 'integer': return 'Int';
      case 'boolean': return 'Bool'; case 'null': return 'CoreNull';
      case 'array': return `[${sw(s.items!)}]`;
      case 'object': if (s.additionalProperties) return `[String: ${sw(s.additionalProperties)}]`;
    }
    throw new Error('unsupported schema inline Swift type; use a named definition');
  }
  function integerChecks(s: Schema, value: string): string[] {
    if (s === true) return [];
    if (s.$ref) return integerChecks(defs[refName(s)], value);
    if (s.type === 'integer') return [`try CoreContract.checkInteger(${value})`];
    if (s.anyOf) {
      const checks = integerChecks(s.anyOf[0], 'value');
      return checks.length ? [`if let value = ${value} { ${checks.join('; ')} }`] : [];
    }
    return [];
  }
  function struct(name: string, s: Exclude<Schema, true>): string {
    const fields = Object.entries(s.properties!).map(([wire, schema]) => {
      const optional = !s.required!.includes(wire);
      const nullable = schema === true ? undefined : schema.anyOf;
      const presence = optional && nullable;
      const type = presence ? `CorePresence<${sw(nullable[0])}>` : sw(schema) + (optional ? '?' : '');
      return { wire, name: swiftIdentifier(camel(wire)), schema, optional, nullable, presence, type };
    });
    const params = fields.map(f => `${f.name}: ${f.type}${f.presence ? ' = .missing' : f.optional ? ' = nil' : ''}`).join(', ');
    const lines = [`public struct Core${name}: Codable, Hashable, Sendable {`,
      ...fields.map(f => `  public var ${f.name}: ${f.type}`),
      `  public init(${params}) {`, ...fields.map(f => `    self.${f.name} = ${f.name}`), '  }'];
    if (!fields.length) return lines.concat('}').join('\n');
    lines.push('  private enum CodingKeys: String, CodingKey {',
      ...fields.map(f => `    case ${f.name}${f.name === f.wire ? '' : ' = ' + quote(f.wire)}`), '  }',
      '  public init(from decoder: Decoder) throws {', '    let container = try decoder.container(keyedBy: CodingKeys.self)');
    for (const f of fields) {
      if (f.presence) lines.push(`    if !container.contains(.${f.name}) { ${f.name} = .missing }`,
        `    else if try container.decodeNil(forKey: .${f.name}) { ${f.name} = .null }`,
        `    else { ${f.name} = .value(try container.decode(${sw(f.nullable![0])}.self, forKey: .${f.name})) }`);
      else if (f.optional) lines.push(`    ${f.name} = container.contains(.${f.name}) ? try container.decode(${sw(f.schema)}.self, forKey: .${f.name}) : nil`);
      else if (f.nullable) lines.push(`    guard container.contains(.${f.name}) else { throw DecodingError.keyNotFound(CodingKeys.${f.name}, .init(codingPath: decoder.codingPath, debugDescription: "Missing required nullable field")) }`,
        `    ${f.name} = try container.decodeIfPresent(${sw(f.nullable[0])}.self, forKey: .${f.name})`);
      else lines.push(`    ${f.name} = try container.decode(${f.type}.self, forKey: .${f.name})`);
      if (!f.presence) {
        const checks = integerChecks(f.schema, f.optional ? 'value' : f.name);
        if (checks.length) lines.push('    ' + (f.optional ? `if let value = ${f.name} { ${checks.join('; ')} }` : checks.join('; ')));
      }
    }
    lines.push('  }', '  public func encode(to encoder: Encoder) throws {', '    var container = encoder.container(keyedBy: CodingKeys.self)');
    for (const f of fields) {
      if (f.presence) lines.push(`    switch ${f.name} {`, '    case .missing: break',
        `    case .null: try container.encodeNil(forKey: .${f.name})`,
        `    case .value(let value): try container.encode(value, forKey: .${f.name})`, '    }');
      else {
        const checks = integerChecks(f.schema, f.optional ? 'value' : f.name);
        if (checks.length) lines.push('    ' + (f.optional ? `if let value = ${f.name} { ${checks.join('; ')} }` : checks.join('; ')));
        lines.push(`    try container.${f.optional ? 'encodeIfPresent' : 'encode'}(${f.name}, forKey: .${f.name})`);
      }
    }
    return lines.concat('  }', '}').join('\n');
  }
  function union(name: string, types: string[]): string {
    const cases: Record<string, [string, string]> = { string: ['string', 'String'], number: ['number', 'Double'], boolean: ['bool', 'Bool'], array: ['array', '[CoreJSONValue]'], object: ['object', '[String: CoreJSONValue]'] };
    const lines = [`public enum Core${name}: Codable, Hashable, Sendable {`,
      ...types.map(t => t === 'null' ? '  case null' : `  case ${cases[t][0]}(${cases[t][1]})`),
      '  public init(from decoder: Decoder) throws {', '    let container = try decoder.singleValueContainer()'];
    if (types.includes('null')) lines.push('    if container.decodeNil() { self = .null; return }');
    for (const t of types.filter(t => t !== 'null')) {
      const [c, type] = cases[t]; lines.push(`    if let value = try? container.decode(${type}.self) { self = .${c}(value); return }`);
    }
    lines.push('    throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid contract value")', '  }',
      '  public func encode(to encoder: Encoder) throws {', '    var container = encoder.singleValueContainer()', '    switch self {');
    for (const t of types) lines.push(t === 'null' ? '    case .null: try container.encodeNil()' : `    case .${cases[t][0]}(let value): try container.encode(value)`);
    return lines.concat('    }', '  }', '}').join('\n');
  }
  function taggedUnion(name:string,s:Exclude<Schema,true>):string {
    const {key,members}=variants(s);
    return [
      `public enum Core${name}: Codable, Hashable, Sendable {`,
      ...members.map(m=>`  case \`${camel(m.tag)}\`(Core${m.name})`),
      `  private enum CodingKeys: String, CodingKey { case tag = ${quote(key)} }`,
      '  public init(from decoder: Decoder) throws {',
      '    let container = try decoder.container(keyedBy: CodingKeys.self)',
      '    switch try container.decode(String.self, forKey: .tag) {',
      ...members.map(m=>`    case ${quote(m.tag)}: self = .\`${camel(m.tag)}\`(try Core${m.name}(from: decoder))`),
      '    default: throw DecodingError.dataCorruptedError(forKey: .tag, in: container, debugDescription: "Unknown contract discriminator")',
      '    }','  }',
      '  public func encode(to encoder: Encoder) throws {','    switch self {',
      ...members.flatMap(m=>[
        `    case .\`${camel(m.tag)}\`(let value):`,
        `      guard value.${swiftIdentifier(camel(key))} == ${quote(m.tag)} else { throw EncodingError.invalidValue(value, .init(codingPath: encoder.codingPath, debugDescription: "Mismatched contract discriminator")) }`,
        '      try value.encode(to: encoder)',
      ]),
      '    }','  }','}',
    ].join('\n');
  }
  const banner = `// Generated by life-data/scripts/generate-core-contract.ts. Contract SHA-256: ${hash}\n// Do not edit; change core/contract/core.json and regenerate.\n`;
  const typescript = banner + `export const CORE_CONTRACT_HASH = ${quote(hash)};\n` +
    Object.entries(defs).map(([name, s]) => comment(s === true ? undefined : s.description) + `export type ${name} = ${ts(s)};`).join('\n') +
    '\n\nexport interface CoreOperations {\n' + Object.entries(contract.operations).map(([name, op]) => comment(op.description, '  ') + `  ${name}: { args: ${ts(op.args)}; result: ${ts(op.result)} };`).join('\n') +
    '\n}\nexport type CoreMethod = keyof CoreOperations;\nexport type CoreArgs<M extends CoreMethod> = CoreOperations[M]["args"];\nexport type CoreResult<M extends CoreMethod> = CoreOperations[M]["result"];\nexport type CoreHandlers = { [M in CoreMethod]: (args: CoreArgs<M>) => CoreResult<M> | Promise<CoreResult<M>> };\n';
  const swift = banner + `import Foundation\n\npublic enum CoreContract {\n  public static let hash = ${quote(hash)}\n  static func checkInteger(_ value: Int) throws {\n    guard (-9_007_199_254_740_991...9_007_199_254_740_991).contains(value) else {\n      throw EncodingError.invalidValue(value, .init(codingPath: [], debugDescription: "Integer exceeds JavaScript precision"))\n    }\n  }\n}\n\npublic struct CoreNull: Codable, Hashable, Sendable, ExpressibleByNilLiteral {\n  public init() {}\n  public init(nilLiteral: ()) {}\n  public init(from decoder: Decoder) throws {\n    let container = try decoder.singleValueContainer()\n    guard container.decodeNil() else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected null") }\n  }\n  public func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encodeNil() }\n}\n\npublic enum CorePresence<Value: Codable & Hashable & Sendable>: Hashable, Sendable {\n  case missing, null, value(Value)\n}\n\n` +
    Object.entries(defs).map(([name, s]) => {
      if (s === true) return name === 'JSONValue' ? union(name, ['string', 'number', 'boolean', 'null', 'array', 'object']) : `public typealias Core${name} = CoreJSONValue`;
      if (s.oneOf) return comment(s.description) + taggedUnion(name,s);
      if (s.enum) return `public enum Core${name}: String, Codable, Hashable, Sendable, CaseIterable {\n` + s.enum.map(v => `  case ${swiftIdentifier(camel(v))} = ${quote(v)}`).join('\n') + '\n}';
      if (Array.isArray(s.type)) return union(name, s.type);
      if (s.properties) return comment(s.description) + struct(name, s);
      return `public typealias Core${name} = ${sw(s)}`;
    }).join('\n\n') +
    '\n\npublic protocol CoreRequest: Sendable {\n  associatedtype Arguments: Encodable & Sendable\n  associatedtype Response: Decodable & Sendable\n  static var method: String { get }\n  var arguments: Arguments { get }\n}\n\npublic enum CoreRequests {\n' +
    Object.entries(contract.operations).map(([name, op]) => comment(op.description, '  ') + `  public struct ${pascal(name)}: CoreRequest {\n    public typealias Arguments = ${sw(op.args)}\n    public typealias Response = ${sw(op.result)}\n    public static let method = ${quote(name)}\n    public var arguments: Arguments\n    public init(_ arguments: Arguments) { self.arguments = arguments }\n  }`).join('\n') + '\n}\n';
  return { hash, typescript, swift };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (flag: string, fallback: string) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
  const root = resolve(import.meta.dir, '..');
  const schema = option('--schema', resolve(root, 'core/contract/core.json'));
  const result = generateContract(JSON.parse(await readFile(schema, 'utf8')));
  const outputs = [
    [option('--ts', resolve(root, 'core/src/contract.generated.ts')), result.typescript],
    [option('--swift', resolve(root, 'core/generated/CoreContract.generated.swift')), result.swift],
  ];
  for (const [path, content] of outputs) {
    if (args.includes('--check')) {
      if (await readFile(path, 'utf8').catch(() => '') !== content) throw new Error(`Stale generated contract: ${path}`);
    } else { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
  }
  console.log(`Core contract ${args.includes('--check') ? 'verified' : 'generated'}: ${result.hash}`);
}
