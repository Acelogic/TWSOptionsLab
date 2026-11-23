// This screener compares one-lot, same-expiration vertical spreads. With
// natural pricing each buy uses its ask and each sell uses its bid. Quotes
// are independent observations, so neither pricing mode promises a fill.
import {makePreset, presets} from './strategies.js';
import {analyze, expiryMs, payoff} from './risk.js';

const round = value => Math.round((value + Number.EPSILON) * 1e8) / 1e8;

function numeric(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalFilter(value, label, nonnegative = true) {
  if (value == null || value === '') return null;
  const parsed = numeric(value);
  if (parsed === null || (nonnegative && parsed < 0)) throw Error('Invalid '+label+'.');
  return parsed;
}

function groupChain(chain, options, horizon) {
  const groups = new Map();
  const coverage={listed:0,quoted:0,eligible:0,missingIV:0,unsupported:0,afterExpiry:0};
  for (const raw of chain) {
    const expiry = String(raw.expiry || options.expiry || '').replaceAll('-','');
    const root = raw.root || options.root || raw.symbol;
    const symbol = raw.symbol || options.symbol || root;
    const multiplier = numeric(raw.multiplier ?? options.multiplier ?? 100);
    const right = String(raw.right || '').toUpperCase();
    const strike = numeric(raw.strike), bid = numeric(raw.bid), ask = numeric(raw.ask);
    if ((options.expiry && expiry!==String(options.expiry).replaceAll('-',''))
        || (options.root && root!==options.root) || (options.symbol && symbol!==options.symbol)) continue;
    coverage.listed++;
    if (!/^\d{8}$/.test(expiry) || !root || !['C','P'].includes(right)
        || !(multiplier > 0) || !(strike > 0) || !(bid > 0) || !(ask >= bid)) continue;
    const bidSize=raw.bidSize ?? raw.sizeBid, askSize=raw.askSize ?? raw.sizeAsk;
    if ((bidSize != null && !(numeric(bidSize)>0))
        || (askSize != null && !(numeric(askSize)>0))) continue;
    if (options.liveOnly && raw.marketDataType!=null && Number(raw.marketDataType)!==1) continue;
    if (options.liveOnly && raw.feed!=null && raw.feed!=='Live') continue;
    if (raw.stale===true || raw.valid===false) continue;
    const settlement = raw.settlement || '';
    const style = raw.style || options.style;
    const quote={...raw,kind:'option',symbol,root,expiry,right,strike,bid,ask,multiplier,style};
    coverage.quoted++;
    const end=expiryMs(quote);
    if(horizon.ms!=null && (end==null || !Number.isFinite(quote.expiresAt)&&!['AM','PM'].includes(settlement))){
      coverage.unsupported++;continue;
    }
    if(horizon.ms!=null && horizon.ms>end){coverage.afterExpiry++;continue}
    quote.targetBasis=horizon.ms!=null&&horizon.ms<end?'modeled':'expiration';
    if(quote.targetBasis==='modeled'){
      if(!['EU','US'].includes(style)){coverage.unsupported++;continue}
      if(!Number.isFinite(quote.iv)||quote.iv<0){coverage.missingIV++;continue}
      // One scenario valuation per quoted contract. Every candidate reuses it,
      // including American contracts that require an early-exercise tree.
      const pnl=payoff([{...quote,qty:1,entry:0}],horizon.target,horizon.ms,0,horizon.rate);
      if(!Number.isFinite(pnl)){coverage.unsupported++;continue}
      quote.targetValue=pnl/multiplier;
    }
    coverage.eligible++;
    const groupId = JSON.stringify([symbol,root,expiry,right,multiplier,settlement,style,raw.expiresAt??null,
      raw.currency || 'USD',raw.feed ?? raw.marketDataType ?? null]);
    if (!groups.has(groupId)) groups.set(groupId,new Map());
    const group=groups.get(groupId);
    const previous=group.get(strike);
    if (previous && previous.received!=null && raw.received!=null && previous.received>raw.received) continue;
    group.set(strike,quote);
  }
  if(options.coverage)Object.assign(options.coverage,coverage);
  return groups;
}

function insertRanked(best, candidate, limit, compare) {
  if (best.length===limit && compare(candidate,best.at(-1))>=0) return;
  let lo=0,hi=best.length;
  while(lo<hi) {
    const i=Math.floor((lo+hi)/2);
    if(compare(candidate,best[i])<0)hi=i;else lo=i+1;
  }
  best.splice(lo,0,candidate);
  if(best.length>limit)best.pop();
}

/**
 * chain: a flat grid of actual TWS option quotes. Each quote has one strike
 * and right. Missing, crossed, explicitly stale and zero-size markets are
 * excluded. Different roots, multipliers, expirations or settlements never
 * combine. Set targetMs to a pre-expiration epoch timestamp to rank by modeled
 * value at the target underlying price. rate is annual, expressed as a decimal.
 * An optional coverage object receives quote, model and eligibility counts.
 *
 * netDebit, strikes, width and breakeven are underlying points.
 * maxLoss (positive magnitude), maxProfit and targetPnL are contract currency for one
 * spread. returnOnRisk = targetPnL / maxLoss. Fees are excluded.
 */
function filters(chain, options) {
  if (!Array.isArray(chain)) throw Error('Supply a quoted option chain.');
  const target=numeric(options.target);
  if (target===null || target<0) throw Error('Enter a nonnegative underlying target price.');
  const ms=optionalFilter(options.targetMs,'target date and time');
  const rate=optionalFilter(options.rate,'annual rate',false)??0;
  const direction=options.direction || 'both';
  const funding=options.funding || 'both';
  const pricing=options.pricing || 'natural';
  const order=options.sortBy || 'targetPnL';
  if(!['both','bullish','bearish'].includes(direction) || !['both','debit','credit'].includes(funding)) throw Error('Unknown spread filter.');
  if(!['mid','natural'].includes(pricing)) throw Error('Choose midpoint or natural pricing.');
  if(!['targetPnL','returnOnRisk','maxProfit','maxLoss'].includes(order)) throw Error('Unknown ranking.');
  const maxLoss=optionalFilter(options.maxLoss,'loss limit');
  const maxWidth=optionalFilter(options.maxWidth,'spread width');
  const minTargetPnL=optionalFilter(options.minTargetPnL,'minimum target P&L',false);
  const limit=Math.floor(optionalFilter(options.maxResults,'result count') ?? 100);
  const compare=(a,b)=>(order==='maxLoss'?a[order]-b[order]:b[order]-a[order])
    || b.returnOnRisk-a.returnOnRisk || a.maxLoss-b.maxLoss
    || a.root.localeCompare(b.root) || a.expiry.localeCompare(b.expiry)
    || (a.right||'').localeCompare(b.right||'') || (a.longStrike??0)-(b.longStrike??0)
    || (a.shortStrike??0)-(b.shortStrike??0) || a.name.localeCompare(b.name);
  return {target,horizon:{ms,rate,target},direction,funding,pricing,maxLoss,maxWidth,minTargetPnL,limit,compare};
}

export function screenSpreads(chain, options = {}) {
  const {target,horizon,direction,funding,pricing,maxLoss,maxWidth,minTargetPnL,limit,compare}=filters(chain,options);
  if(!limit)return [];
  const best=[];
  for(const quotes of groupChain(chain,options,horizon).values()) {
    const series=[...quotes.values()].sort((a,b)=>a.strike-b.strike);
    for(let i=0;i<series.length-1;i++) for(let j=i+1;j<series.length;j++){
      const lo=series[i],hi=series[j];
      const width=round(hi.strike-lo.strike);
      if(maxWidth!=null && width>maxWidth) break;
      const isCall=lo.right==='C';
      for(const bullish of [true,false]){
        const side=bullish?'bullish':'bearish';
        const type=bullish===isCall?'debit':'credit';
        if(direction!=='both' && direction!==side || funding!=='both' && funding!==type) continue;
        // Lower-strike long + higher-strike short is bullish for both rights.
        const long=bullish?lo:hi,short=bullish?hi:lo;
        const buy=pricing==='natural'?long.ask:(long.ask+long.bid)/2;
        const sell=pricing==='natural'?short.bid:(short.ask+short.bid)/2;
        const netDebit=round(buy-sell);
        const premium=Math.abs(netDebit);
        if(premium>=width || (type==='debit'?netDebit<=0:netDebit>=0)) continue;
        const multiplier=lo.multiplier;
        const risk=round((type==='debit'?premium:width-premium)*multiplier);
        if(maxLoss!=null && risk>maxLoss) continue;
        const reward=round((type==='debit'?width-premium:premium)*multiplier);
        const intrinsic=strike=>Math.max(0,isCall?target-strike:strike-target);
        const spreadValue=lo.targetBasis==='modeled'?long.targetValue-short.targetValue:intrinsic(long.strike)-intrinsic(short.strike);
        const profit=round((spreadValue-netDebit)*multiplier);
        if(minTargetPnL!=null && profit<minTargetPnL) continue;
        const anchor=type==='debit'?long.strike:short.strike;
        const breakeven=round(anchor+(isCall?premium:-premium));
        const row={name:(bullish?'Bull ':'Bear ')+(isCall?'call':'put')+' spread',
          symbol:lo.symbol,root:lo.root,expiry:lo.expiry,right:lo.right,pricing,
          direction:side,funding:type,longStrike:long.strike,shortStrike:short.strike,
          width,netDebit,breakeven,maxLoss:risk,maxProfit:reward,targetPnL:profit,
          returnOnRisk:profit/risk,target,multiplier,targetBasis:lo.targetBasis,targetMs:horizon.ms??expiryMs(lo),
          legs:[{...long,kind:'option',qty:1,entry:round(buy)},
                {...short,kind:'option',qty:-1,entry:round(sell)}]};
        insertRanked(best,row,limit,compare);
      }
    }
  }
  return best;
}

const multiLegFamilies = new Set(['Butterflies and condors','Volatility','Ratios and ladders','Synthetics']);
const multiLegPresets = presets.filter(p=>multiLegFamilies.has(p.group) && !p.usesNextExpiry && !p.usesStock);

function mergedBooks(chain, options, horizon) {
  const books=new Map();
  // groupChain validates each quote and separates call and put grids. A
  // template may join those grids only when all other contract terms match.
  for(const quotes of groupChain(chain,options,horizon).values()) for(const q of quotes.values()){
    const id=JSON.stringify([q.symbol,q.root,q.expiry,q.multiplier,q.settlement||'',q.style,
      q.currency||'USD',q.feed??q.marketDataType??null,q.expiresAt??null]);
    if(!books.has(id))books.set(id,new Map());
    const book=books.get(id);
    if(!book.has(q.strike))book.set(q.strike,{strike:q.strike});
    book.get(q.strike)[q.right]=q;
  }
  return books;
}

function makeCandidates(book, reference) {
  const ordered=[...book.values()].sort((a,b)=>a.strike-b.strike);
  const nearest=ordered.reduce((near,row,i)=>Math.abs(row.strike-reference)<Math.abs(ordered[near].strike-reference)?i:near,0);
  const start=Math.max(0,Math.min(nearest-12,ordered.length-25));
  const neighborhood=ordered.slice(start,start+25);
  const candidates=[];
  const seen=new Set();
  for(const stride of [1,2,3]) for(let phase=0;phase<stride;phase++){
    const strikes=neighborhood.filter((_,i)=>i%stride===phase);
    if(!strikes.length)continue;
    const first=strikes[0].C || strikes[0].P;
    for(let index=0;index<strikes.length;index++){
      const anchor=strikes[index].strike;
      const middle=index+1<strikes.length?(anchor+strikes[index+1].strike)/2:anchor;
      // A credit iron condor needs spot between its inner strikes. Include
      // mid-strike anchors for these structures on four-strike ladders.
      for(const preset of multiLegPresets) {
        const spot=preset.id.endsWith('iron-condor')?middle:anchor;
        let pattern;
        try{pattern=makePreset(preset.id,{...first,spot,strikes})}
        catch{continue} // A listed pattern may need an unavailable side or spacing.
        if(pattern.length<2)continue;
        const signature=pattern.map(l=>l.right+'@'+l.strike+'x'+l.qty).sort().join(',');
        if(seen.has(signature))continue;
        seen.add(signature);
        candidates.push({preset,pattern});
      }
    }
  }
  return candidates;
}

function templateDirection(legs, result, spot, width) {
  // Delta threshold is one equivalent share per standard 100 multiplier.
  // When Greeks are absent, use the local expiration slope at the supplied
  // spot. A nonmonotonic payoff can change direction as the underlying moves.
  let slope=result.greeks.delta==null ? null : result.greeks.delta/legs[0].multiplier;
  let basis='position delta';
  if(slope==null && spot>0) {
    const h=Math.min(spot/2,Math.max(0.001,width*0.001));
    const upper=payoff(legs,spot+h,result.firstExpiryMs),lower=payoff(legs,spot-h,result.firstExpiryMs);
    slope=(upper-lower)/(2*h*legs[0].multiplier);basis='local expiration slope';
  }
  return {direction:slope==null?'unclassified':Math.abs(slope)<=0.01?'neutral':slope>0?'bullish':'bearish',basis};
}

/**
 * Rank quoted, single-expiration templates using the same filters and units as
 * screenSpreads. options.spot supplies the underlying reference for directional
 * classification when TWS deltas are unavailable. Select up to 25 nearby
 * strikes at three spacings. No unbounded-loss candidate is admitted.
 */
export function screenTemplates(chain, options = {}) {
  const {target,horizon,direction,funding,pricing,maxLoss,maxWidth,minTargetPnL,limit,compare}=filters(chain,options);
  if(!limit)return [];
  const spot=numeric(options.spot);
  const best=[];
  for(const book of mergedBooks(chain,options,horizon).values()){
    if(!book.size)continue;
    for(const {preset,pattern} of makeCandidates(book,spot>0?spot:target)){
      const strikes=[...new Set(pattern.map(l=>l.strike))].sort((a,b)=>a-b);
      const width=round(strikes.at(-1)-strikes[0]);
      if(maxWidth!=null && width>maxWidth)continue;
      const legs=pattern.map(l=>{
        const q=book.get(l.strike)[l.right];
        const entry=pricing==='natural'?(l.qty>0?q.ask:q.bid):(q.ask+q.bid)/2;
        return {...q,...l,entry:round(entry)};
      });
      const head=legs[0],multiplier=head.multiplier;
      const netDebit=round(legs.reduce((sum,l)=>sum+l.qty*l.entry,0));
      const type=netDebit>0?'debit':netDebit<0?'credit':'even';
      if(funding!=='both' && funding!==type)continue;
      // Set the spot to the target for this terminal evaluation. No IV, rate
      // or probability estimate is needed to rank expiration cash flows.
      const settlement=expiryMs(head);
      if(settlement==null)continue;
      const risk=analyze(legs,target,settlement,0,0,settlement);
      if(!risk.exactExpiry || !Number.isFinite(risk.maxLoss) || risk.maxLoss<=0 || !(risk.maxProfit>0))continue;
      const loss=round(risk.maxLoss), gain=Number.isFinite(risk.maxProfit)?round(risk.maxProfit):Infinity;
      if(maxLoss!=null && loss>maxLoss)continue;
      const directional=templateDirection(legs,risk,spot,width);
      if(direction!=='both' && direction!==directional.direction)continue;
      const pnl=head.targetBasis==='modeled'?
        legs.reduce((sum,l)=>sum+l.qty*l.multiplier*(l.targetValue-l.entry),0):
        payoff(legs,target,risk.firstExpiryMs);
      if(pnl==null || !Number.isFinite(pnl))continue;
      const targetPnL=round(pnl);
      if(minTargetPnL!=null && targetPnL<minTargetPnL)continue;
      const breakevens=risk.breakEvens.map(round);
      const row={presetId:preset.id,name:preset.name,legs,strikes,width,symbol:head.symbol,
        root:head.root,expiry:head.expiry,multiplier,pricing,netDebit,funding:type,
        direction:directional.direction,directionBasis:directional.basis,
        maxLoss:loss,maxProfit:gain,target,targetPnL,returnOnRisk:targetPnL/loss,targetBasis:head.targetBasis,targetMs:horizon.ms??settlement,
        breakeven:breakevens.length===1?breakevens[0]:null,breakevens,
        breakEvenRanges:risk.breakEvenRanges};
      insertRanked(best,row,limit,compare);
    }
  }
  return best;
}
