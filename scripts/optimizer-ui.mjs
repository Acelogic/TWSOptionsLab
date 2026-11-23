// Invoked by scripts/verify.mjs with its own TWS-connected server and data directory.
import {testBrowser} from './browser-fixture.mjs';

function captureBrokerQuotes(){
 const original=window.fetch.bind(window),qa=window.optimizerQA={latest:null,snapshot:null,ids:null,maskIV:false,deliveries:0};
 window.fetch=async(...args)=>{
  const response=await original(...args);
  if(!response.ok||!String(args[0]).endsWith('/api/quotes'))return response;
  const result=await response.json();qa.latest=result;
  const view=structuredClone(qa.snapshot??result);
  if(qa.ids)for(const id of Object.keys(view.quotes))if(!qa.ids.includes(Number(id)))delete view.quotes[id];
  if(qa.maskIV)for(const q of Object.values(view.quotes))q.iv=null;
  qa.deliveries++;
  return new Response(JSON.stringify(view),{status:200,headers:{'Content-Type':'application/json'}});
 };
}

async function optimizerWorkflow(book,info,name){
 const $=id=>document.getElementById(id),qa=window.optimizerQA;
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 async function wait(probe,label){
  for(let i=0;i<180;i++){const result=probe();if(result)return result;await delay(100)}
  throw Error('Waiting for '+label+' · '+$('optNote')?.textContent);
 }
 const change=(id,value)=>{const input=$(id);input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}))};
 const browse=async()=>{$('scan').click();await delay(50);return [...document.querySelectorAll('#optGrid tbody tr')].map(row=>[...row.cells].map(c=>c.textContent))};
 const check=(ok,description)=>{if(!ok)throw Error(description+' · '+$('optNote').textContent)};
 const cash=text=>Number(text.replace(/[^\d.\-]/g,''));
 await wait(()=>JSON.parse(localStorage.getItem('optionslab.draft.v1'))?.name===name,'SPX draft');
 document.querySelector('[data-page="optimize"]').click();
 change('optPricing','mid');
 const choice=await wait(()=>{
  const options=book.strikes.map(row=>({...qa.latest?.quotes[row.C],strike:row.strike,conId:row.C}))
   .filter(q=>q.feed==='Live'&&q.iv>0&&q.bid>0&&q.ask>=q.bid&&q.sizeBid!==0&&q.sizeAsk!==0);
  const pairs=[];
  for(const lo of options)for(const hi of options){
   const width=hi.strike-lo.strike,debit=(lo.bid+lo.ask-hi.bid-hi.ask)/2;
   if(width>0&&debit>0&&debit<width)pairs.push({lo,hi,debit,width});
  }
  return options.length>=4&&pairs.sort((a,b)=>a.width-b.width)[0];
 },'live priced calls and TWS IV');
 qa.snapshot=structuredClone(qa.latest);
 const {lo,hi,debit,width}=choice,target=lo.strike+width*.4,baseTime=book.expiresAt;
 const targetMs=Math.ceil(Math.max(baseTime-7200000,Date.now()+(baseTime-Date.now())*.25)/60000)*60000;
 check(targetMs<baseTime,'Choose an unexpired SPX series');
 const localTime=ms=>new Date(ms-new Date(ms).getTimezoneOffset()*60000).toISOString().slice(0,16);
 change('optTarget',target);change('optHorizon','date');change('optDate',localTime(targetMs));
 check(!$('optDateLabel').hidden,'Target date control should be available');
 const fullVertical=await browse();check(fullVertical.length>0,'Full vertical ranking');
 change('family','templates');const templates=await browse();check(templates.some(row=>row[1].split(' / ').length>=3),'Modeled multi-leg template ranking');
 for(const results of [fullVertical,templates])
  check(results.every((row,i)=>!i||cash(row[6])<=cash(results[i-1][6])),'Descending modeled P&L ranking');
 change('rank','returnOnRisk');
 const byReturn=await browse();
 check(byReturn.every((row,i)=>!i||cash(row[7])<=cash(byReturn[i-1][7])),'Descending modeled return-on-risk ranking');
 change('rank','targetPnL');
 const iterate=async update=>{const delivery=qa.deliveries;update();await wait(()=>qa.deliveries>delivery,'next market data delivery');await delay(50)};
 await iterate(()=>{qa.ids=[lo.conId,hi.conId]});
 change('family','vertical');change('direction','bullish');change('funding','debit');change('optHorizon','expiration');
 const [exact]=await browse();check(exact?.[0]==='Bull call spread','Selected expiry spread');
 const multiplier=info.roots[book.root].multiplier;
 const expiryPnl=(target-lo.strike-debit)*multiplier;
 check(Math.abs(cash(exact[6])-expiryPnl)<.011,'Exact payoff using qualified multiplier');
 change('optHorizon','date');change('optDate',localTime(targetMs));const [model]=await browse();
 check(model&&$('optNote').textContent.includes('Modeled with fixed TWS IV'),'Model source and date');
 // Independent zero-rate European call result for this SPX check.
 const cdf=x=>{
  const t=1/(1+.3275911*Math.abs(x)/Math.sqrt(2));
  const erf=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x/2);
  return (1+Math.sign(x)*erf)/2;
 };
 const call=q=>{
  const t=(baseTime-targetMs)/(365*86400000),sd=q.iv*Math.sqrt(t),d1=(Math.log(target/q.strike)+q.iv*q.iv*t/2)/sd;
  return target*cdf(d1)-q.strike*cdf(d1-sd);
 };
 const modeledPnl=(call(lo)-call(hi)-debit)*multiplier;
 check(Math.abs(cash(model[6])-modeledPnl)<.35,'Independent SPX time-value check');
 check(exact[6]!==model[6]&&exact[3]===model[3]&&exact[4]===model[4]&&exact[5]===model[5],'Target horizon changes P&L, preserves expiry bounds');
 await iterate(()=>{qa.maskIV=true});const missing=await browse(),warning=$('optNote').textContent;
 check(!missing.length&&warning.includes('2 without TWS IV'),'Missing IV eligibility');
 change('optHorizon','expiration');const [fallback]=await browse();
 check(fallback?.[6]===exact[6],'Exact expiry works with missing IV');
 return {root:book.root,expiry:book.expiry,multiplier,target,targetTime:new Date(targetMs).toISOString(),settlement:new Date(baseTime).toISOString(),
  contracts:[lo,hi].map(q=>({conId:q.conId,strike:q.strike,bid:q.bid,ask:q.ask,iv:q.iv,feed:q.feed})),
  fullVerticalResults:fullVertical.length,multiLegResults:templates.length,intraday:model[6],independentIntraday:modeledPnl,expiryPnL:exact[6],independentExpiry:expiryPnl,
  expiryMaxLoss:model[3],expiryMaxProfit:model[4],missingIV:warning,expiryWithMissingIV:fallback[6]};
}

export async function verifyOptimizer({base,tmp,book,info,sample}){
 async function waitFor(probe,label){
  for(let i=0;i<180;i++){try{const r=await probe();if(r)return r}catch{}await new Promise(r=>setTimeout(r,100))}
  throw Error('Waiting for '+label);
 }
 const browser=await testBrowser(tmp,waitFor);
 try{
  const name='Optimizer UI verification',leg={kind:'option',qty:1,right:'C',strike:sample.strike,expiry:book.expiry,root:book.root,entry:null};
  const draft={schema:1,symbol:info.symbol,root:book.root,expiry:book.expiry,legs:[leg],name};
  await browser.call('Page.navigate',{url:base+'/#strategy='+Buffer.from(JSON.stringify(draft)).toString('base64url')});
  await waitFor(()=>browser.evalPage("!!document.getElementById('optimize')&&document.readyState==='complete'"),'strategy UI');
  await browser.evalPage('('+captureBrokerQuotes.toString()+')()');
  return await browser.evalPage('('+optimizerWorkflow.toString()+')('+[book,info,name].map(JSON.stringify).join(',')+')');
 }finally{await browser.close()}
}
