import {payoff} from './risk.js';
// Strike offsets describe the shape of a template. Only strikes supplied by TWS
// are returned. Entries stay unset until the caller has an actual price.
const call = (offset, qty = 1, far = false) => ({ right: 'C', offset, qty, far });
const put = (offset, qty = 1, far = false) => ({ right: 'P', offset, qty, far });
const shares = qty => ({ stock: true, qty });
const invert = legs => legs.map(leg => ({ ...leg, qty: -leg.qty }));
const templates = new Map();
export const presets = [];

function add(id, name, group, recipe, geometry = '') {
  templates.set(id, { recipe, geometry });
  presets.push({
    id, name, group,
    usesStock: recipe.some(leg => leg.stock),
    usesNextExpiry: recipe.some(leg => leg.far),
  });
}

function pair(longId, longName, shortId, shortName, group, recipe, geometry = '') {
  add(longId, longName, group, recipe, geometry);
  add(shortId, shortName, group, invert(recipe), geometry);
}

pair('long-call', 'Long call', 'short-call', 'Short call', 'Single legs', [call(0)]);
pair('long-put', 'Long put', 'short-put', 'Short put', 'Single legs', [put(0)]);
pair('long-stock', 'Long shares', 'short-stock', 'Short shares', 'Single legs', [shares(1)]);
add('cash-secured-put', 'Cash-secured put', 'Income and protection', [put(-1,-1)]);
add('covered-call', 'Covered call', 'Income and protection', [shares(1),call(1,-1)]);
add('covered-put', 'Covered put', 'Income and protection', [shares(-1),put(-1,-1)]);
add('protective-put', 'Protective put', 'Income and protection', [shares(1),put(-1)]);
add('protective-call', 'Protective call on short shares', 'Income and protection', [shares(-1),call(1)]);
pair('collar', 'Collar', 'reverse-collar', 'Reverse collar', 'Income and protection',
  [shares(1),put(-1),call(1,-1)]);
add('covered-straddle','Covered straddle','Income and protection',[shares(1),put(0,-1),call(0,-1)]);
add('covered-strangle','Covered strangle','Income and protection',[shares(1),put(-1,-1),call(1,-1)],'strangle');

add('bull-call-spread','Bull call spread','Vertical spreads',[call(0),call(1,-1)]);
add('bear-call-spread','Bear call spread','Vertical spreads',[call(0,-1),call(1)]);
add('bear-put-spread','Bear put spread','Vertical spreads',[put(0),put(-1,-1)]);
add('bull-put-spread','Bull put spread','Vertical spreads',[put(0,-1),put(-1)]);

pair('long-straddle','Long straddle','short-straddle','Short straddle','Volatility',
  [put(0),call(0)]);
pair('long-strangle','Long strangle','short-strangle','Short strangle','Volatility',
  [put(-1),call(1)],'strangle');
pair('long-guts','Long guts','short-guts','Short guts','Volatility',[call(-1),put(1)],'strangle');
add('strip','Strip','Volatility',[call(0),put(0,2)]);
add('strap','Strap','Volatility',[call(0,2),put(0)]);

for (const [word, fn] of [['call',call],['put',put]]) {
  pair('long-'+word+'-butterfly','Long '+word+' butterfly',
    'short-'+word+'-butterfly','Short '+word+' butterfly','Butterflies and condors',
    [fn(-1),fn(0,-2),fn(1)],'grid');
  pair('long-'+word+'-condor','Long '+word+' condor',
    'short-'+word+'-condor','Short '+word+' condor','Butterflies and condors',
    [fn(-3),fn(-1,-1),fn(1,-1),fn(3)],'grid');
  const widths = word === 'call' ? [-1,0,2] : [-2,0,1];
  pair(word+'-broken-wing',word==='call'?'Call broken-wing butterfly':'Put broken-wing butterfly',
    'short-'+word+'-broken-wing','Short '+word+' broken-wing butterfly','Butterflies and condors',
    [fn(widths[0]),fn(widths[1],-2),fn(widths[2])],'grid');
}
pair('iron-butterfly','Iron butterfly (credit)','reverse-iron-butterfly','Reverse iron butterfly (debit)',
  'Butterflies and condors',[put(-1),put(0,-1),call(0,-1),call(1)],'grid');
pair('iron-condor','Iron condor (credit)','reverse-iron-condor','Reverse iron condor (debit)',
  'Butterflies and condors',[put(-3),put(-1,-1),call(1,-1),call(3)],'grid-inside');

for (const [word,fn] of [['call',call],['put',put]]) {
  const sign = word === 'call' ? 1 : -1;
  pair(word+'-ratio-spread',word==='call'?'Call ratio spread':'Put ratio spread',
    word+'-backspread',word==='call'?'Call ratio backspread':'Put ratio backspread','Ratios and ladders',
    [fn(0),fn(sign,-2)]);
  pair((word==='call'?'bull-call':'bear-put')+'-ladder',word==='call'?'Bull call ladder':'Bear put ladder',
    (word==='call'?'bear-call':'bull-put')+'-ladder',word==='call'?'Bear call ladder':'Bull put ladder','Ratios and ladders',
    [fn(0),fn(sign,-1),fn(2*sign,-1)]);
  pair('calendar-'+word,word==='call'?'Call calendar':'Put calendar',
    'reverse-calendar-'+word,'Reverse '+word+' calendar','Calendars and diagonals',
    [fn(0,-1),fn(0,1,true)]);
  pair('diagonal-'+word,word==='call'?'Call diagonal':'Put diagonal',
    'reverse-diagonal-'+word,'Reverse '+word+' diagonal','Calendars and diagonals',
    [fn(sign,-1),fn(0,1,true)]);
}
add('double-calendar','Double calendar','Calendars and diagonals',
  [put(-1,-1),put(-1,1,true),call(1,-1),call(1,1,true)],'strangle');
add('double-diagonal','Double diagonal','Calendars and diagonals',
  [put(-1,-1),put(-2,1,true),call(1,-1),call(2,1,true)],'strangle');
pair('long-synthetic','Synthetic long shares','short-synthetic','Synthetic short shares','Synthetics',
  [call(0),put(0,-1)]);
pair('long-combo','Long risk reversal','short-combo','Short risk reversal','Synthetics',
  [put(-1,-1),call(1)],'strangle');
pair('conversion','Conversion','reversal','Reversal','Synthetics',[shares(1),put(0),call(0,-1)]);
add('jade-lizard','Jade lizard','Ratios and ladders',[put(-1,-1),call(1,-1),call(2)]);
add('reverse-jade-lizard','Reverse jade lizard','Ratios and ladders',[put(-2),put(-1,-1),call(1,-1)]);

const cashIndex = new Set(['SPX','SPXW','XSP','VIX','VIXW','RUT','RUTW','NDX','NDXP','XND','DJX','OEX','XEO','NANOS']);
const european = new Set([...cashIndex].filter(symbol => symbol !== 'OEX'));

function normalizedExpiry(value) {
  const text = String(value || '').replaceAll('-', '');
  if (!/^\d{8}$/.test(text)) return null;
  const date = new Date(text.slice(0,4)+'-'+text.slice(4,6)+'-'+text.slice(6)+'T00:00:00Z');
  return Number.isFinite(+date) && date.toISOString().slice(0,10).replaceAll('-','') === text ? text : null;
}

function cleanedStrikes(values) {
  return [...new Set((values || []).map(row => typeof row === 'object' && row!==null ? row.strike : row)
    .filter(k => k != null && k !== '').map(Number)
    .filter(k => Number.isFinite(k) && k > 0))].sort((a,b) => a-b);
}

function key(n) {
  return Math.round(n * 1000000);
}

function pickStrikes(recipe, geometry, near, far, spot) {
  const options = recipe.filter(leg => !leg.stock);
  if (!options.length) return new Map();
  const offsets = [...new Set(options.map(leg=>leg.offset))].sort((a,b)=>a-b);
  const sources = [near,far].map(source=>Object.fromEntries(['C','P'].map(right=>{
    const rows=source.filter(row=>typeof row!=='object' || row===null || row.right===right || !!row[right]);
    return [right,new Map(cleanedStrikes(rows).map(k=>[key(k),k]))];
  })));
  const allowed = new Map(offsets.map(offset => {
    const parts = options.filter(leg=>leg.offset===offset).map(leg=>sources[leg.far?1:0][leg.right]);
    return [offset,new Map([...parts[0]].filter(([k])=>parts.every(source=>source.has(k))))];
  }));
  if ([...allowed.values()].some(source=>!source.size)) throw Error('No listed strikes for these expirations.');
  if (offsets.length===1) {
    const offset=offsets[0];
    const candidates=[...allowed.get(offset).values()].filter(k=>offset===0 || (k-spot)*offset>0);
    if (!candidates.length) throw Error('No listed strike on the required side of the underlying.');
    return new Map([[offset,candidates.reduce((a,b)=>Math.abs(a-spot)<=Math.abs(b-spot)?a:b)]]);
  }
  if (geometry.startsWith('grid')) return regularGrid(offsets,allowed,spot,geometry==='grid-inside');
  // Offset ranks may be uneven in points. Every required leg must be listed in
  // its own expiration. A missing far-month strike can shift the whole pattern.
  const pool=cleanedStrikes([...near,...far]);
  const min=offsets[0],max=offsets.at(-1);
  let best=null, distance=Infinity;
  for(let anchor=Math.max(0,-min);anchor<pool.length-Math.max(0,max);anchor++) {
    const choices=new Map(offsets.map(offset=>[offset,pool[anchor+offset]]));
    if(offsets.some(offset=>!allowed.get(offset).has(key(choices.get(offset))))) continue;
    if(geometry==='strangle' && offsets.some(offset=>offset!==0 && (choices.get(offset)-spot)*offset<=0)) continue;
    const score=Math.abs(pool[anchor]-spot);
    if(score<distance){best=choices;distance=score}
  }
  // A two-leg strangle can use two adjacent strikes with spot strictly between.
  if(!best && min===-1 && max===1 && offsets.length===2 && geometry==='strangle') {
    const lows=[...allowed.get(-1).values()].filter(k=>k<spot);
    const highs=[...allowed.get(1).values()].filter(k=>k>spot);
    if(lows.length && highs.length) return new Map([[-1,Math.max(...lows)],[1,Math.min(...highs)]]);
  }
  if(!best) throw Error('The listed chain cannot form this strike pattern around the underlying.');
  return best;
}

function regularGrid(offsets, allowed, spot, inside) {
  const first=offsets[0],last=offsets.at(-1);
  const lows=[...allowed.get(first).values()].sort((a,b)=>Math.abs(a-spot)-Math.abs(b-spot));
  const highs=[...allowed.get(last).values()];
  let best=null, bestScore=Infinity;
  for(const low of lows) {
    for(const high of highs) {
      if(high<=low) continue;
      const step=(high-low)/(last-first);
      if(step/2>bestScore) break;
      const origin=low-first*step;
      const score=Math.abs(origin-spot)+step/2;
      if(score>=bestScore || (inside && !(origin-step<spot && spot<origin+step))) continue;
      const choices=new Map(offsets.map(offset=>[offset,allowed.get(offset).get(key(origin+offset*step))]));
      if([...choices.values()].every(k=>k!=null)){best=choices;bestScore=score}
    }
  }
  if(!best) throw Error('This chain does not contain the strike spacing required for this template.');
  return best;
}

export function makePreset(id, context) {
  const template = templates.get(id);
  if (!template) throw Error('Unknown strategy template.');
  const {recipe,geometry} = template;
  const symbol = String(context.symbol || '').toUpperCase();
  const root = String(context.root || symbol).toUpperCase();
  if (!symbol || !root) throw Error('Select an underlying and trading class.');
  const stock = recipe.some(leg=>leg.stock);
  if (stock && (cashIndex.has(symbol) || ['IND','FUT','CONTFUT'].includes(context.secType))) {
    throw Error('This template requires shares of a tradable stock or ETF.');
  }
  const options=recipe.some(leg=>!leg.stock);
  const spot=Number(context.spot);
  if(options && (!(spot>0) || !Number.isFinite(spot))) throw Error('An underlying price is required to select strikes.');
  const multiplier=Number(context.multiplier ?? 100);
  if(!Number.isFinite(multiplier) || multiplier<=0) throw Error('Invalid contract multiplier.');
  if(stock && !Number.isInteger(multiplier)) throw Error('This template requires a whole-share hedge for one option contract.');
  const expiry=normalizedExpiry(context.expiry), nextExpiry=normalizedExpiry(context.nextExpiry);
  if(options && !expiry) throw Error('Select an expiration.');
  if(recipe.some(leg=>leg.far) && (!nextExpiry || nextExpiry<=expiry)) throw Error('Select a later expiration for the second leg.');
  const near=context.strikes || [];
  const far=context.nextStrikes == null || !recipe.some(leg=>leg.far) ? near : context.nextStrikes;
  const strikes=pickStrikes(recipe,geometry,near,far,spot);
  const style=context.style || (european.has(symbol) || european.has(root) ? 'EU' : 'US');
  return recipe.map(leg => leg.stock
    ? {kind:'stock',symbol,root:symbol,right:null,strike:null,expiry:null,qty:leg.qty*multiplier,entry:null,multiplier:1,style}
    : {kind:'option',symbol,root,right:leg.right,strike:strikes.get(leg.offset),
       expiry:leg.far?nextExpiry:expiry,qty:leg.qty,entry:null,multiplier,style});
}


// Payoff silhouettes in the catalog use a common illustrative market so the
// user can recognize a strategy before loading its actual TWS contracts.
export function strategyShape(id){
  const day=86400000, now=Date.UTC(2025,0,2), front=now+14*day;
  const legs=templates.get(id).recipe.map(r=>{
    if(r.stock)return {kind:'stock',qty:r.qty,entry:100,multiplier:1};
    const leg={kind:'option',right:r.right,strike:100+r.offset*3,entry:0,
      multiplier:1,qty:1,style:'EU',iv:.3,expiresAt:r.far?now+40*day:front};
    return {...leg,qty:r.qty,entry:payoff([leg],100,now)};
  });
  return Array.from({length:49},(_,i)=>payoff(legs,88+i/2,front));
}
