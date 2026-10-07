import fixture from '../../tests/fixtures/hub-query-contract.json';
import {expect,test} from 'bun:test';
import {normalizeRowsQuery,supportsRowsQuery} from '../src/query.ts';

test('clients require query capability and never silently fall back to unbounded pulls',()=>{
 expect(supportsRowsQuery({row_query:'bounded-v1'})).toBe(true);
 for(const caps of [undefined,{}, {row_query:'v2'},{row_api:'v1'}])expect(supportsRowsQuery(caps)).toBe(false);
});

test('query normalization supplies bounded defaults and keeps cursor separately',()=>{
 expect(normalizeRowsQuery({table:'items',columns:['title','id']})).toEqual({table:'items',columns:['id','title'],order:[],limit:50});
 expect(()=>normalizeRowsQuery({table:'items',columns:['id'],filter:{or:[]}})).toThrow();
});


test('portable query fixture normalizes through the canonical policy',()=>{
 const request=normalizeRowsQuery(fixture.request);
 expect(request.order).toEqual([{column:'released',direction:'desc'}]);
 expect(request.limit).toBe(50);
 expect(supportsRowsQuery(fixture.capability)).toBe(true);
});

test('a client-normalized request with three sort fields remains valid at the server boundary',()=>{
 const input={table:'items',columns:['id','title','released','saved'],order:[{column:'released',direction:'asc'},{column:'saved',direction:'desc'},{column:'title',direction:'asc'}]};
 const normalized=normalizeRowsQuery(input);
 expect(()=>normalizeRowsQuery(normalized)).not.toThrow();
});
