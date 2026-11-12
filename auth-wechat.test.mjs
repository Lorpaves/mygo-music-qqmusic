import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, createPublicKey, publicEncrypt, constants } from 'node:crypto';
import { wechatSignIn } from './auth-wechat.js';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const modulus='c4231830a2eb5fc2827170641e79d80fec51bda9a22e4b4ab37d1f205a4ae44d928cda25879f66a3429051663312a127faf8a246bdaaf63918417e90d7c95b5908aa6a2d0f852e4a6770294a548ac1c2fe8f1f252fb826f4ac86ab9a00e7ce47d002a56e7c4b51eb889acc60ca6adbc9f72e81f4d31b1dd7464805264530ab1d';
const md5=s=>createHash('md5').update(s).digest('hex');
function fixture(statuses=['408','404','408','405'], login={code:0,req:{code:0,data:{str_musicid:'1152921504606846976',musickey:'wechat-key',openid:'open',refresh_key:'refresh'}}}) {
  const calls=[],prompts=[];
  const deps={randomBytes:n=>new Uint8Array(n).fill(1),sleep:async()=>{},prompt:async v=>prompts.push(v),decodeQR:async b=>{assert.deepEqual([...b],[1,2,3]);return 'decoded-from-image';},fetch:async (url,opts={})=>{
    calls.push({url,opts});
    if(url.includes('api.tencentmusic.com')) {
      const p=JSON.parse(opts.body).qimeiParams,key='0101010101010101';
      assert.equal(p.sign,md5(p.key+p.params+p.time+'000'+p.nonce+'ZdJqM15EeO2zWc08'+p.extra));
      assert.equal(opts.headers.Sign,md5('qimei_qq_androidpzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH'+p.time));
      const pub=createPublicKey({key:{kty:'RSA',n:Buffer.from(modulus,'hex').toString('base64url'),e:'AQAB'},format:'jwk'});
      const padded=Buffer.concat([Buffer.from([0,2]),Buffer.alloc(109,1),Buffer.from([0]),Buffer.from(key)]);
      assert.equal(p.key,publicEncrypt({key:pub,padding:constants.RSA_NO_PADDING},padded).toString('base64'));
      const decipher=createDecipheriv('aes-128-cbc',Buffer.from(key),Buffer.from(key));
      const payload=JSON.parse(Buffer.concat([decipher.update(Buffer.from(p.params,'base64')),decipher.final()]).toString());
      assert.equal(payload.androidId,'0101010101010101');assert.equal(payload.appKey,'0AND0HD6FE4HY80F');
      return Response.json({data:JSON.stringify({data:{q16:'q16',q36:'q36'}})});
    }
    if(url.startsWith('https://u.y.qq.com/')) {const body=JSON.parse(opts.body);assert.equal(body.comm.QIMEI,'q16');if(body.req_0)return Response.json({code:0,req_0:{code:0,data:{session:{uid:123,sid:'sid'}}}});assert.equal(body.comm.uid,'123');assert.equal(body.req.param.code,'private-code');return Response.json(login);}
    if(url.includes('/connect/qrconnect?')) return new Response('<img src="/connect/qrcode/uuid-fixture">');
    if(url.includes('/connect/qrcode/'))return new Response(new Uint8Array([1,2,3]));
    if(url.includes('/connect/l/qrconnect')) {const status=statuses.shift();return new Response("window.wx_errcode="+status+";window.wx_code='private-code';");}
    throw Error('Unexpected URL '+url);
  }};return {deps,calls,prompts};
}
test('device envelope and complete QR exchange',async()=>{const f=fixture();const s=await wechatSignIn(f.deps);assert.equal(s.musicid,'1152921504606846976');assert.equal(s.loginType,1);assert.equal(s.musickey,'wechat-key');assert.equal(s.openid,'open');assert.equal(s.refresh_key,'refresh');assert.equal(s.device.sid,'sid');assert.deepEqual(f.prompts.map(p=>p.qr),['decoded-from-image','decoded-from-image']);const polls=f.calls.filter(c=>c.url.includes('/connect/l/qrconnect'));assert.equal(polls.length,4);assert.match(polls[2].url,/last=404/);});
test('expired QR stops without exchanging a session',async()=>{const f=fixture(['402']);await assert.rejects(wechatSignIn(f.deps),/expired/);assert.equal(f.calls.filter(c=>c.url.startsWith('https://u.y.qq.com/')).length,1);});
test('malformed QR status fails',async()=>{const f=fixture(['oops']);await assert.rejects(wechatSignIn(f.deps),/Malformed/);});
test('login rejection preserves business codes and server tip',async()=>{const f=fixture(['408','404','408','405'],{code:0,req:{code:20279,data:{musicid:12345,str_musicid:'12345',loginType:1,errtip:'device limit reached'}}});await assert.rejects(wechatSignIn(f.deps),error=>error.qqGlobalCode===0&&error.qqCode===20279&&error.qqLoginStage==='wechat-token-exchange'&&error.qqTip==='device limit reached');});
test('missing login data is reported as a protocol error',async()=>{const f=fixture(['408','404','408','405'],{code:0,req:{code:0}});await assert.rejects(wechatSignIn(f.deps),/no login credential/);});
test('missing secure random provider fails before network',async()=>{const f=fixture();delete f.deps.randomBytes;const old=globalThis.crypto;try{Object.defineProperty(globalThis,'crypto',{value:undefined,configurable:true});await assert.rejects(wechatSignIn(f.deps),/secure randomBytes/);assert.equal(f.calls.length,0);}finally{Object.defineProperty(globalThis,'crypto',{value:old,configurable:true});}});
test('MoeJS compiles and runs device cryptography', {skip:!process.env.MOEJS_HOST_DIR},()=>{
  const dir=mkdtempSync(join(tmpdir(),'wechat-moejs-'));
  try {
    const go=`package main
import ("fmt"; "os"; "github.com/MoeForge/moejs")
func main(){b,e:=os.ReadFile(os.Args[1]);if e!=nil{panic(e)};m,e:=moejs.Compile("wechat.js",string(b));if e!=nil{panic(e)};rt:=moejs.NewRuntime(moejs.Options{MemoryLimit:256<<20});if e=rt.Load(m);e!=nil{panic(e)};f,ok:=rt.Export("cryptoTest");if !ok{panic("missing export")};v,e:=rt.CallFunction(f,moejs.Undefined());if e!=nil{panic(e)};fmt.Print(v.String())}
`;
    const source=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'auth-wechat.js'),'utf8')+"\nexport function cryptoTest(){return md5('abc')+':'+rsa(n=>Array(n).fill(1),'0101010101010101')+':'+hex(aesCBC(bytes('0101010101010101'),bytes('hello')))}";
    const goPath=join(dir,'main.go'),jsPath=join(dir,'test.js');writeFileSync(goPath,go);writeFileSync(jsPath,source);
    const run=spawnSync('go',['run',goPath,jsPath],{cwd:process.env.MOEJS_HOST_DIR,encoding:'utf8',timeout:120000,env:{...process.env,GOFLAGS:'-mod=readonly',GOPROXY:'off'}});
    assert.equal(run.status,0,run.stderr);
    const key='0101010101010101',pub=createPublicKey({key:{kty:'RSA',n:Buffer.from(modulus,'hex').toString('base64url'),e:'AQAB'},format:'jwk'});
    const padded=Buffer.concat([Buffer.from([0,2]),Buffer.alloc(109,1),Buffer.from([0]),Buffer.from(key)]);
    const rsa=publicEncrypt({key:pub,padding:constants.RSA_NO_PADDING},padded).toString('base64');
    const cipher=createCipheriv('aes-128-cbc',Buffer.from(key),Buffer.from(key));
    const aes=Buffer.concat([cipher.update('hello'),cipher.final()]).toString('hex');
    assert.equal(run.stdout,md5('abc')+':'+rsa+':'+aes);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
