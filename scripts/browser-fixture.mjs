import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {access,readFile} from 'node:fs/promises';
import {delimiter,isAbsolute,join} from 'node:path';

// Honor the caller's browser, then look for Chrome or Chromium on PATH and
// in the usual application installation directories for the current OS.
export async function browserExecutable(){
 const configured=process.env.CHROME_BIN;
 const pathDirs=(process.env.PATH??'').split(delimiter).filter(Boolean);
 const binaries=process.platform==='win32'?['chrome.exe','chromium.exe']:['google-chrome','google-chrome-stable','chromium','chromium-browser'];
 const candidates=configured
  ?(isAbsolute(configured)||configured.includes('/')||configured.includes('\\')?[configured]:pathDirs.map(dir=>join(dir,configured)))
  :pathDirs.flatMap(dir=>binaries.map(bin=>join(dir,bin)));
 if(!configured&&process.platform==='darwin'){
  for(const dir of ['/Applications',process.env.HOME&&join(process.env.HOME,'Applications')].filter(Boolean))
   for(const name of ['Google Chrome','Chromium'])candidates.push(join(dir,name+'.app','Contents','MacOS',name));
 }
 if(!configured&&process.platform==='win32'){
  for(const dir of [process.env.LOCALAPPDATA,process.env.ProgramFiles,process.env['ProgramFiles(x86)']].filter(Boolean))
   candidates.push(join(dir,'Google','Chrome','Application','chrome.exe'),join(dir,'Chromium','Application','chrome.exe'));
 }
 for(const path of candidates){try{await access(path,constants.X_OK);return path}catch{}}
 throw Error('Chrome or Chromium was not found. Set CHROME_BIN to the browser executable.');
}

// Every E2E run supplies its own temporary directory and closes the browser
// before deleting the private profile.
export async function testBrowser(tmp,waitFor){
 const chrome=await browserExecutable();
 const profile=join(tmp,'chrome');
 const browser=spawn(chrome,['--headless=new','--disable-extensions','--disable-background-networking',
  '--disable-sync','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,
  '--window-size=1400,950','about:blank'],{stdio:'ignore'});
 let ws;
 async function close(){
  ws?.close();
  if(browser.exitCode!==null||browser.signalCode!==null)return;
  const exited=new Promise(resolve=>browser.once('exit',resolve));
  browser.kill('SIGTERM');
  const timeout=setTimeout(()=>browser.kill('SIGKILL'),3000);
  try{await exited}finally{clearTimeout(timeout)}
 }
 try{
  const port=await waitFor(async()=>(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0],'isolated Chrome');
  const tabs=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  ws=new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});
  let sequence=0;
  const pending=new Map();
  ws.addEventListener('message',event=>{
   const message=JSON.parse(event.data),callback=pending.get(message.id);
   if(!callback)return;
   pending.delete(message.id);
   if(message.error)callback.reject(Error(message.error.message));else callback.resolve(message.result);
  });
  const call=(method,params={})=>new Promise((resolve,reject)=>{
   const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));
  });
  async function evalPage(expression){
   const result=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
   if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description??result.exceptionDetails.text);
   return result.result.value;
  }
  return {call,evalPage,close};
 }catch(error){await close();throw error}
}
