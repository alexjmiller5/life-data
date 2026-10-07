import {expect,test} from 'bun:test';
import * as core from '../src/index.ts';
test('board retains option order, unknown values, empty group and exact Unicode IDs',()=>{
 const rows=[{id:'a',state:'Doing'},{id:'b',state:'Legacy'},{id:'é',state:null},{id:'e\u0301',state:''}];
 expect(core.boardRows({rows,column:'state',options:['Todo','Doing','Todo']})).toEqual({columns:[
  {value:'Todo',rowIds:[]},{value:'Doing',rowIds:['a']},{value:'Legacy',rowIds:['b']},{value:null,rowIds:['é','e\u0301']}
 ]});
});
test('board refuses multi-value cells and ambiguous row IDs',()=>{
 expect(()=>core.boardRows({rows:[{id:'a',state:['X']}],column:'state',options:[]})).toThrow();
 expect(()=>core.boardRows({rows:[{id:'a'},{id:'a'}],column:'state',options:[]})).toThrow();
});
