import { describe, expect, test } from 'bun:test';
import { D1Shim as D1 } from './d1shim.js';
import { ensureReceiptStorage, receiptIdentity, readReceipt, receiptStatement, redactReceipts } from '../src/governance-store.js';

const target={table:'items',rowId:'row-1'};
const request={proposalId:'proposal-1',expectedVersion:'version-1',previewToken:'opaque-token',idempotencyKey:'request-1'};
const scope={deploymentId:'deployment-1',principalId:'principal-1',operation:'approveProposal',idempotencyKey:request.idempotencyKey};
const negative={kind:'error',code:'revision_changed',resolution:'not_committed',conflicts:[]};
const success={kind:'success',value:{operationId:'operation-1'}};

async function fixture() {
  const db=new D1();
  await db.prepare('CREATE TABLE items (id TEXT PRIMARY KEY, value INTEGER)').run();
  await db.prepare("INSERT INTO items VALUES ('row-1',0)").run();
  await ensureReceiptStorage(db);
  const identity=await receiptIdentity(scope,request);
  const terminal=(body,status=200)=>receiptStatement(db,identity,target,['value'],status,'SELECT ? AS result',[JSON.stringify(body)]);
  return {db,identity,terminal,update:()=>db.prepare("UPDATE items SET value=value+1 WHERE id='row-1'")};
}

describe('governance terminal receipt storage',()=>{
  test('canonical request hashing is independent of object key order but binds every value and scope',async()=>{
    const a=await receiptIdentity(scope,request);
    expect(await receiptIdentity(scope,{idempotencyKey:'request-1',previewToken:'opaque-token',expectedVersion:'version-1',proposalId:'proposal-1'})).toEqual(a);
    for(const field of ['deploymentId','principalId','operation','idempotencyKey'])
      expect((await receiptIdentity({...scope,[field]:'other'},request)).key).not.toBe(a.key);
    expect((await receiptIdentity(scope,{...request,previewToken:'other'})).requestHash).not.toBe(a.requestHash);
  });

  test('success and its row write commit together, replay does not execute again after a newer edit',async()=>{
    const {db,identity,terminal,update}=await fixture();
    await db.batch([update(),terminal(success)]);
    await update().run();
    expect(await readReceipt(db,identity)).toEqual({target,columns:['value'],status:200,result:success});
    expect((await db.prepare('SELECT value FROM items').first()).value).toBe(2);
    await expect(db.batch([update(),terminal(success)])).rejects.toThrow();
    expect((await db.prepare('SELECT value FROM items').first()).value).toBe(2);
    db.db.close();
  });

  test('mismatched request content cannot retrieve an existing receipt payload',async()=>{
    const {db,terminal}=await fixture();
    await db.batch([terminal(success)]);
    const other=await receiptIdentity(scope,{...request,expectedVersion:'version-2'});
    expect(await readReceipt(db,other)).toEqual({mismatch:true});
    db.db.close();
  });

  test('failed row validation rolls back both receipt and earlier row changes',async()=>{
    const {db,identity,terminal,update}=await fixture();
    await expect(db.batch([update(),terminal(success),db.prepare('SELECT abs(-9223372036854775808)')])).rejects.toThrow();
    expect(await readReceipt(db,identity)).toBeNull();
    expect((await db.prepare('SELECT value FROM items').first()).value).toBe(0);
    db.db.close();
  });

  test('negative settlement winning first prevents a previously prepared late original from applying',async()=>{
    const {db,identity,terminal,update}=await fixture();
    const original=[update(),terminal(success)];
    await db.batch([terminal(negative,409)]);
    await expect(db.batch(original)).rejects.toThrow();
    expect((await db.prepare('SELECT value FROM items').first()).value).toBe(0);
    expect((await readReceipt(db,identity)).result).toEqual(negative);
    db.db.close();
  });

  test('original winning first excludes a prepared negative receipt and preserves committed result',async()=>{
    const {db,identity,terminal,update}=await fixture();
    const denial=terminal(negative,409);
    await db.batch([update(),terminal(success)]);
    await expect(db.batch([denial])).rejects.toThrow();
    expect((await readReceipt(db,identity)).result).toEqual(success);
    expect((await db.prepare('SELECT value FROM items').first()).value).toBe(1);
    db.db.close();
  });

  test('purge redacts matching positive and negative payloads while preserving key exclusion',async()=>{
    const {db,identity,terminal,update}=await fixture();
    await db.batch([terminal(negative,409)]);
    await db.batch(redactReceipts(db,target,'unrelated'));
    expect((await readReceipt(db,identity)).result).toEqual(negative);
    await db.batch(redactReceipts(db,target,'value'));
    expect(await readReceipt(db,identity)).toEqual({target,columns:[],status:200,result:{kind:'purged'}});
    await expect(db.batch([update(),terminal(success)])).rejects.toThrow();
    expect((await db.prepare('SELECT value FROM items').first()).value).toBe(0);
    db.db.close();
  });

  test('receipt result can be computed from the committing row inside the same transaction',async()=>{
    const {db,identity,update}=await fixture();
    await db.batch([update(),receiptStatement(db,identity,target,['value'],200,
      "SELECT json_object('kind','success','value',value) AS result FROM items WHERE id=?",['row-1'])]);
    expect((await readReceipt(db,identity)).result).toEqual({kind:'success',value:1});
    db.db.close();
  });
});
