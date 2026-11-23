/*
 * USD P&L for a portfolio on one underlying. Entries and marks
 * are per share/index point. Stock quantity is in shares. A scenario before
 * expiration keeps each leg's IV constant except for the requested shift.
 */
const day = 86400000;
const year = 365 * day;
const expiryCache = new Map();
const easternClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
});
const num = Number.isFinite;
const nonnegative = v => num(v) && v >= 0;
const onFutures = leg => leg.secType === 'FOP' || (!leg.secType && String(leg.symbol ?? '').includes('@'));
const indexFutures = new Set(['ES','MES','NQ','MNQ','YM','MYM','RTY','M2K','VX','VXM']);
const signedSettlement = leg => onFutures(leg) && leg.priceFloor !== 0
  && !indexFutures.has(String(leg.symbol ?? '').split(/[@#]/)[0]);

export function expiryMs(leg) {
  if (leg.kind === 'stock') return null;
  if (num(leg.expiresAt) && leg.expiresAt > 0) return leg.expiresAt;
  const date = String(leg.expiry ?? '').replaceAll('-', '');
  if (!/^\d{8}$/.test(date)) return null;
  const am = leg.settlement === 'AM';
  const key = date + (am ? 'AM' : 'PM');
  if (expiryCache.has(key)) return expiryCache.get(key);
  const iso = date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6);
  const noon = Date.parse(iso + 'T12:00:00Z');
  if (!num(noon) || new Date(noon).toISOString().slice(0, 10) !== iso) return null;
  const parts = easternClock.formatToParts(noon);
  const localMinutes = 60 * Number(parts.find(p => p.type === 'hour').value)
    + Number(parts.find(p => p.type === 'minute').value);
  const ms = noon + ((am ? 570 : 960) - localMinutes) * 60000;
  expiryCache.set(key, ms);
  return ms;
}

function normalCdf(z) {
  if (z < -9) return 0;
  if (z > 9) return 1;
  const a = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * a);
  const polynomial = t * (0.319381530 + t * (-0.356563782
    + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = Math.exp(-a * a / 2) * polynomial / Math.sqrt(2 * Math.PI);
  return z >= 0 ? 1 - tail : tail;
}

function isContract(leg) {
  if (!num(leg.qty) || !leg.qty) return false;
  if (leg.kind === 'stock' || leg.kind === 'realized') return true;
  return Number.isInteger(leg.qty) && leg.kind === 'option' && (leg.right === 'C' || leg.right === 'P')
    && num(leg.strike) && (onFutures(leg) || leg.strike > 0) && num(leg.multiplier) && leg.multiplier > 0
    && expiryMs(leg) !== null;
}

const units = leg => leg.qty * (leg.kind === 'stock' ? 1 : leg.multiplier);
const intrinsic = (leg, spot) => Math.max(0, leg.right === 'C' ? spot - leg.strike : leg.strike - spot);

function sumAvailable(legs, perUnit) {
  if (!legs.length || !legs.every(isContract)) return null;
  let total = 0;
  for (const leg of legs) {
    const v = perUnit(leg);
    if (!num(v)) return null;
    total += units(leg) * v;
  }
  return num(total) ? total : null;
}

function originalEntry(legs){
  return sumAvailable(legs,l=>l.kind==='realized'?l.originalBasis/units(l):nonnegative(l.entry)?l.entry:null);
}
function expirationSet(legs) {
  return [...new Set(legs.filter(l => l.kind === 'option').map(expiryMs))].sort((a, b) => a - b);
}

function terminal(legs, spot) {
  return sumAvailable(legs, leg => nonnegative(leg.entry)
    ? (leg.kind === 'realized' ? 0 : leg.kind === 'stock' ? spot : intrinsic(leg, spot)) - leg.entry : null);
}

function modelFor(leg, t, ivShift, rate, treeGreek = null) {
  const iv = leg.iv;
  if (!nonnegative(iv) || !num(ivShift) || !num(rate) || leg.strike <= 0) return null;
  const vol = Math.max(0, iv + ivShift);
  // A futures price has zero carry under the forward-price model. In this
  // parameterization q = r reduces the European formula to Black (1976).
  const q = onFutures(leg) ? rate : nonnegative(leg.dividendYield) ? leg.dividendYield : 0;
  const discount = Math.exp(-rate * t), expectedSpotDiscount = Math.exp(-q * t);
  const sign = leg.right === 'C' ? 1 : -1, k = leg.strike;
  const american = leg.style === 'US';
  if (vol < 1e-8) {
    return spot => {
      let price = Math.max(0, sign * (spot * expectedSpotDiscount - k * discount));
      if (american) {
        price = Math.max(price, intrinsic(leg, spot));
        // With deterministic carry there can be an interior exercise optimum.
        const ratio = k * rate / (spot * q);
        if (ratio > 0 && rate !== q) {
          const optimum = Math.log(ratio) / (rate - q);
          if (optimum > 0 && optimum < t)
            price = Math.max(price, sign * (spot * Math.exp(-q * optimum) - k * Math.exp(-rate * optimum)));
        }
      }
      return price;
    };
  }
  if (!american || (sign === 1 && q === 0 && rate >= 0)) {
    const rootT = vol * Math.sqrt(t);
    return spot => {
      if (spot === 0) return sign === 1 ? 0 : k * discount;
      const d1 = (Math.log(spot / k) + (rate - q + vol * vol / 2) * t) / rootT;
      const d2 = d1 - rootT;
      return Math.max(0, sign * (spot * expectedSpotDiscount * normalCdf(sign * d1)
        - k * discount * normalCdf(sign * d2)));
    };
  }
  // Recombining binomial tree with early exercise. Switch to equal probability
  // and center the up/down factors on the forward if CRR probabilities exceed bounds.
  const steps = 64, dt = t / steps, sigmaStep = vol * Math.sqrt(dt);
  const growth = Math.exp((rate - q) * dt), discStep = Math.exp(-rate * dt);
  let up = Math.exp(sigmaStep), down = 1 / up;
  let p = (growth - down) / (up - down);
  if (p < 0 || p > 1 || !num(p)) {
    const center = growth / ((up + down) / 2);
    up *= center; down *= center; p = 0.5;
  }
  const stride = up / down;
  const values = new Float64Array(steps + 1);
  return spot => {
    let first = spot * down ** steps, levelSpot = first;
    let sensitivity = 0;
    for (let j = 0; j <= steps; j++, levelSpot *= stride)
      values[j] = Math.max(0, sign * (levelSpot - k));
    for (let i = steps - 1; i >= 0; i--) {
      first /= down;
      levelSpot = first;
      for (let j = 0; j <= i; j++, levelSpot *= stride) {
        const hold = discStep * ((1 - p) * values[j] + p * values[j + 1]);
        const exercise = sign * (levelSpot - k);
        values[j] = Math.max(hold, exercise, 0);
        if (treeGreek && i === 0 && exercise > hold) return treeGreek === 'delta' ? sign : 0;
      }
      // Lattice derivatives use adjacent option nodes. Bumping the root price
      // alone gives a piecewise-linear estimate with artificial gamma spikes.
      if (treeGreek === 'delta' && i === 1)
        sensitivity = (values[1] - values[0]) / (spot * (up - down));
      if (treeGreek === 'gamma' && i === 2) {
        const low = first, middle = first * stride, high = middle * stride;
        const upperDelta = (values[2] - values[1]) / (high - middle);
        const lowerDelta = (values[1] - values[0]) / (middle - low);
        sensitivity = (upperDelta - lowerDelta) / ((high - low) / 2);
      }
    }
    return treeGreek ? sensitivity : values[0];
  };
}

// Invert the same premium model used by the graph at the timestamp of
// the observed premium/underlying pair. Entry cost is never an input.
export function estimateImpliedVolatility(input) {
  const {leg, spot, premium, asOf, rate} = input ?? {};
  if (leg?.kind !== 'option' || !['C','P'].includes(leg.right) ||
      !num(leg.strike) || leg.strike <= 0 || !num(spot) || spot <= 0 ||
      !num(premium) || premium <= 0 || !num(asOf) || asOf <= 0 || !num(rate)) return null;
  const expiry = expiryMs(leg);
  if (!num(expiry) || expiry <= asOf) return null;
  const t = (expiry - asOf) / year;
  const q = onFutures(leg) ? rate : nonnegative(leg.dividendYield) ? leg.dividendYield : 0;
  const american = leg.style === 'US';
  const upper = leg.right === 'C'
    ? spot * Math.max(american ? 1 : 0, Math.exp(-q*t))
    : leg.strike * Math.max(american ? 1 : 0, Math.exp(-rate*t));
  const tolerance = Math.max(1e-9, 1e-10 * Math.max(spot, leg.strike, premium));
  const boundary = Math.max(tolerance, nonnegative(leg.minTick) ? leg.minTick / 2 : 0);
  const price = iv => modelFor({...leg, iv}, t, 0, rate)(spot);
  const floor = price(0);
  if (!num(floor) || !num(upper) || premium <= floor + boundary || premium >= upper - boundary ||
      Math.abs(premium - intrinsic(leg, spot)) <= boundary) return null;

  // A finite bracket prevents near-asymptotic premiums from producing
  // arbitrarily large volatility estimates. Reject non-monotone numerical
  // regions rather than assuming an identifiable solution exists.
  let low = 0, lowPrice = floor, high = 0.25, highPrice = price(high);
  while (num(highPrice) && highPrice < premium && high < 16) {
    if (highPrice < lowPrice - tolerance) return null;
    low = high; lowPrice = highPrice;
    high *= 2; highPrice = price(high);
  }
  if (!num(highPrice) || highPrice < premium || highPrice < lowPrice) return null;
  for (let i=0; i<48; i++) {
    const mid = (low + high)/2, value = price(mid);
    if (!num(value) || value < lowPrice - tolerance || value > highPrice + tolerance) return null;
    if (value < premium) { low = mid; lowPrice = value; }
    else { high = mid; highPrice = value; }
    const width = (high-low)/Math.max(1,mid);
    if (width <= 1e-12 || (width <= 1e-7 && highPrice-lowPrice <= tolerance)) break;
  }
  const iv = (low+high)/2, fitted = price(iv);
  if (!num(fitted) || Math.abs(fitted-premium) > 4*tolerance) return null;
  const step = Math.max(1e-5, iv*1e-3);
  const below = price(Math.max(0,iv-step)), above = price(iv+step);
  // On an exercise plateau the premium cannot identify volatility. Require
  // a measurable change on both sides, even if a rounded premium was matched.
  return num(below) && num(above) && fitted-below > tolerance && above-fitted > tolerance ? iv : null;
}

export const greekModes = Object.freeze({
  delta: {label: 'Delta', unit: 'per price point'},
  gamma: {label: 'Gamma', unit: 'per price point²'},
  theta: {label: 'Theta', unit: 'per calendar day'},
  vega: {label: 'Vega', unit: 'per IV percentage point'},
  rho: {label: 'Rho', unit: 'per rate percentage point'}
});
const greekNumber = new Intl.NumberFormat('en-US', {maximumSignificantDigits: 4});
export function formatGreek(value) {
  if (!num(value)) return '—';
  if (value !== 0 && Math.abs(value) < 0.0001) return value.toExponential(2);
  return greekNumber.format(value === 0 ? 0 : value);
}

function optionGreek(leg, t, ivShift, rate, metric) {
  if (!nonnegative(leg.iv) || leg.strike <= 0) return null;
  const vol = leg.iv + ivShift;
  if (vol < 1e-8) return null;
  const future = onFutures(leg), sign = leg.right === 'C' ? 1 : -1;
  const q = future ? rate : nonnegative(leg.dividendYield) ? leg.dividendYield : 0;
  const americanTree = leg.style === 'US' && !(sign === 1 && q === 0 && rate >= 0);
  if (americanTree) {
    if (metric === 'delta' || metric === 'gamma')
      return modelFor(leg, t, ivShift, rate, metric);
    // Keep both bumped options inside their positive-time/volatility domains.
    const dt = metric === 'theta' ? Math.min(t * 0.05, 0.25 / 365) : 0;
    const dv = metric === 'vega' ? Math.min(vol * 0.05, 0.001) : 0;
    const dr = metric === 'rho' ? 0.0001 : 0;
    const higher = modelFor(leg, t + dt, ivShift + dv, rate + dr);
    const lower = modelFor(leg, t - dt, ivShift - dv, rate - dr);
    const scale = dt ? -1 / (2 * dt * 365) : 0.01 / (2 * (dv || dr));
    return s => (higher(s) - lower(s)) * scale;
  }
  const k = leg.strike, sqrtT = Math.sqrt(t), volT = vol * sqrtT;
  const cash = k * Math.exp(-rate * t), carry = Math.exp(-q * t);
  const drift = (rate - q + vol * vol / 2) * t;
  return s => {
    const d1 = (Math.log(s / k) + drift) / volT;
    if (metric === 'delta') return sign * carry * normalCdf(sign * d1);
    const density = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
    if (metric === 'gamma') return carry * density / (s * volT);
    if (metric === 'vega') return s * carry * density * sqrtT / 100;
    const cashN = cash * normalCdf(sign * (d1 - volT));
    if (metric === 'rho' && !future) return sign * cashN * t / 100;
    const assetN = s * carry * normalCdf(sign * d1);
    // In Black-76, rho holds the quoted futures price constant as rates move.
    if (metric === 'rho') return -t * Math.max(0, sign * (assetN - cashN)) / 100;
    return (sign * (q * assetN - rate * cashN) - s * carry * density * vol / (2 * sqrtT)) / 365;
  };
}

// Signed sensitivities are derivatives of the scenario position value. Entry
// cash flows and closed positions are constant and have no effect on Greeks.
export function scenarioGreekEvaluator(legs, horizonMs, ivShift, rate, metric) {
  if (!greekModes[metric] || !legs.length || !num(horizonMs) || !num(rate) || !num(ivShift)) return null;
  const options = [];
  let stockDelta = 0;
  for (const leg of legs) {
    if (!isContract(leg)) return null;
    if (leg.kind === 'realized') continue;
    if (leg.kind === 'stock') {
      if (metric === 'delta') stockDelta += leg.qty;
      continue;
    }
    const t = (expiryMs(leg) - horizonMs) / year;
    if (t <= 0) return null;
    const evaluate = optionGreek(leg, t, ivShift, rate, metric);
    if (!evaluate) return null;
    options.push({evaluate, size: units(leg), strike: leg.strike});
  }
  return spot => {
    if (!num(spot) || spot < 0) return null;
    let value = stockDelta;
    for (const option of options) {
      if (spot === 0 && (metric === 'gamma' || metric === 'vega')) continue;
      // The right-hand limit at zero is the boundary of the lognormal model.
      const at = spot || option.strike * 1e-10;
      value += option.size * option.evaluate(at);
    }
    return num(value) ? value : null;
  };
}

// Option premium sensitivity per one percentage point of annual interest.
export function modelRho(leg, spot, rate, now=Date.now()) {
  const expiry=expiryMs(leg);
  if (leg.kind!=='option' || !num(expiry) || !num(spot) || spot<=0 || expiry<=now) return null;
  const t=(expiry-now)/year, bump=.0001;
  const base=leg.scenarioBaseIv??leg.quotedIv;
  const quoted=base==null?leg:{...leg,iv:base};
  const up=modelFor(quoted,t,0,rate+bump), down=modelFor(quoted,t,0,rate-bump);
  if (!up || !down) return null;
  const value=(up(spot)-down(spot))*.01/(2*bump);
  return num(value)?value:null;
}

export function scenarioEvaluator(legs, horizonMs, ivShift = 0, rate = 0) {
  if (!legs.length || !legs.every(leg => isContract(leg) && nonnegative(leg.entry))) return null;
  const dates = expirationSet(legs);
  if (dates.length && horizonMs == null) horizonMs = dates[0];
  if (dates.length && !num(horizonMs)) return null;
  if (dates.length > 1 && horizonMs > dates[0]) return null;
  const prices = [];
  const allowNegative = legs.every(l=>l.kind==='realized'||signedSettlement(l)) && (!dates.length || horizonMs >= dates.at(-1));
  for (const leg of legs) {
    if (leg.kind === 'realized') prices.push(() => 0);
    else if (leg.kind === 'stock') prices.push(spot => spot);
    else {
      const t = (expiryMs(leg) - horizonMs) / year;
      const fn = t <= 0 ? spot => intrinsic(leg, spot) : modelFor(leg, t, ivShift, rate);
      if (!fn) return null;
      prices.push(fn);
    }
  }
  return spot => {
    if (!num(spot) || (spot < 0 && !allowNegative)) return null;
    let pnl = 0;
    for (let i = 0; i < legs.length; i++) pnl += units(legs[i]) * (prices[i](spot) - legs[i].entry);
    return num(pnl) ? pnl : null;
  };
}

export function payoff(legs, underlying, horizonMs, ivShift = 0, rate = 0) {
  const fn = scenarioEvaluator(legs, horizonMs, ivShift, rate);
  return fn ? fn(underlying) : null;
}

function expiryRisk(legs) {
  const unrestricted = legs.some(signedSettlement) && legs.every(l=>l.kind==='realized'||signedSettlement(l));
  const knots = [...new Set([0, ...legs.filter(l => l.kind === 'option').map(l => l.strike)])].sort((a,b) => a-b);
  const values = knots.map(s => terminal(legs, s));
  const eps = Math.max(1e-8, ...values.map(v => Math.abs(v) * Number.EPSILON * 16));
  const nearZero = value => Math.abs(value) <= eps;
  const tailSlope = legs.reduce((v, l) => v + ((l.kind === 'stock' || l.right === 'C') ? units(l) : 0), 0);
  const leftSlope = legs.reduce((v,l) => v + (l.kind === 'stock' ? units(l) : l.right === 'P' ? -units(l) : 0), 0);
  let high = Math.max(...values), low = Math.min(...values);
  if (tailSlope > 0 || unrestricted && leftSlope < 0) high = Infinity;
  if (tailSlope < 0 || unrestricted && leftSlope > 0) low = -Infinity;
  const roots = [], intervals = [];
  function addInterval(from, to) {
    const previous = intervals.at(-1);
    if (previous && previous[1] === from) previous[1] = to;
    else intervals.push([from, to]);
  }
  if (unrestricted) {
    const x = knots[0], v = values[0];
    if (nearZero(v) && leftSlope === 0) addInterval(-Infinity, x);
    else if (!nearZero(v) && leftSlope !== 0 && -v / leftSlope < 0) roots.push(x-v/leftSlope);
  }
  for (let i = 0; i < knots.length; i++) {
    const x = knots[i], v = values[i];
    if (nearZero(v)) roots.push(x);
    if (i + 1 < knots.length) {
      const u = values[i+1], next = knots[i+1];
      if (nearZero(v) && nearZero(u)) addInterval(x, next);
      else if (!nearZero(v) && !nearZero(u) && Math.sign(u) !== Math.sign(v))
        roots.push(x - v * (next - x) / (u - v));
    } else if (tailSlope === 0 && nearZero(v)) addInterval(x, Infinity);
    else if (!nearZero(v) && tailSlope !== 0 && -v / tailSlope > 0) roots.push(x - v / tailSlope);
  }
  return {
    maxProfit: Math.max(0, high), maxLoss: Math.max(0, -low),
    breakEvens: roots.filter(s => !intervals.some(([a,b]) => s>=a && s<=b)),
    breakEvenRanges: intervals
  };
}

function expiryProbability(legs, spot, expiry, now, ivShift, rate, risk) {
  const unavailable = {profitProbability:null, probabilityIv:null, probabilityNote:''};
  if (!risk || !num(spot) || spot <= 0 || !num(expiry) || !num(now) || expiry <= now || !num(ivShift) || !num(rate))
    return unavailable;
  const quoted = legs.filter(l => l.kind === 'option' && nonnegative(l.iv));
  if (!quoted.length) return unavailable;
  const distance = Math.min(...quoted.map(l => Math.abs(l.strike - spot)));
  const near = quoted.filter(l => Math.abs(l.strike - spot) <= distance + 1e-9);
  // Duplication of a position must not change the volatility reference.
  const vols = new Map(near.map(l => [[l.root,l.strike,l.right].join('|'), l.iv]));
  const vol = Math.max(0, [...vols.values()].reduce((sum, v) => sum + v, 0) / vols.size + ivShift);
  const t = (expiry-now) / year;
  const q = onFutures(near[0]) ? rate : nonnegative(near[0].dividendYield) ? near[0].dividendYield : 0;
  const forward = spot * Math.exp((rate-q)*t);
  let probability = 0;
  if (vol < 1e-8) probability = terminal(legs, forward) > 1e-8 ? 1 : 0;
  else {
    const dispersion = vol*Math.sqrt(t), drift = (rate-q-0.5*vol*vol)*t;
    const cdf = x => x===Infinity ? 1 : x<=0 ? 0 : normalCdf((Math.log(x/spot)-drift)/dispersion);
    const boundaries = [...new Set([0,Infinity,...quoted.map(l=>l.strike),...risk.breakEvens,
      ...risk.breakEvenRanges.flat()])].filter(x=>x>=0).sort((a,b)=>a-b);
    for (let i=1;i<boundaries.length;i++) {
      const a=boundaries[i-1], b=boundaries[i];
      const probe = b===Infinity ? a+Math.max(1,spot,a) : a+(b-a)/2;
      if (terminal(legs,probe)>1e-8) probability += cdf(b)-cdf(a);
    }
  }
  return {profitProbability: Math.max(0, Math.min(1, probability)), probabilityIv:vol,
    probabilityNote:'Risk-neutral probability of positive scenario P&L at expiration, using a lognormal price distribution and IV from the nearest strike with available volatility in this strategy.'};
}

export function positionMark(legs){
  const entryDebit = sumAvailable(legs, l => nonnegative(l.entry) ? l.entry : null);
  const marketValue = sumAvailable(legs, l => nonnegative(l.mid) ? l.mid : null);
  return {entryDebit,marketValue,markPnl:marketValue!==null&&entryDebit!==null?marketValue-entryDebit:null};
}

export function analyze(legs, spot, horizonMs, ivShift = 0, rate = 0, nowMs = Date.now()) {
  const dates = expirationSet(legs), firstExpiryMs = dates[0] ?? null, lastExpiryMs = dates.at(-1) ?? null;
  const mark=positionMark(legs),entryDebit=mark.entryDebit;
  const exactExpiry = dates.length <= 1 && entryDebit !== null;
  const risk = exactExpiry ? expiryRisk(legs) : {maxProfit:null, maxLoss:null, breakEvens:[], breakEvenRanges:[]};
  const probability = expiryProbability(legs, spot, firstExpiryMs, nowMs, ivShift, rate, exactExpiry ? risk : null);
  const greeks = {};
  for (const greek of ['delta','theta','gamma','vega','rho']) {
    greeks[greek] = sumAvailable(legs, l => {
      if (l.kind === 'realized') return 0;
      if (l.kind === 'stock') return greek === 'delta' ? 1 : 0;
      const value = greek === 'rho' ? modelRho(l, l.modelUnderlying ?? spot, rate, nowMs) : l[greek];
      if (!num(value)) return null;
      if (greek === 'delta' && (Math.abs(value) > 1.00001 || (l.right === 'C' ? value < -1e-5 : value > 1e-5))) return null;
      if ((greek === 'gamma' || greek === 'vega') && value < 0) return null;
      return value;
    });
  }
  const horizon = horizonMs ?? firstExpiryMs ?? nowMs;
  const scenarioPnl = payoff(legs, spot, horizon, ivShift, rate);
  const notes = [];
  if (!legs.length) notes.push('Add a leg to calculate strategy risk.');
  else if (entryDebit === null) notes.push('Every leg needs a valid contract and an entry price.');
  if (dates.length > 1) {
    notes.push('Different settlements make whole-strategy expiration limits path-dependent.');
    if (horizon > firstExpiryMs) notes.push('Choose a scenario on or before the first settlement.');
  }
  if (dates.length && horizon < lastExpiryMs) {
    if (legs.some(l => l.kind === 'option' && expiryMs(l) > horizon && !nonnegative(l.iv)))
      notes.push('Missing IV for '+legs.filter(l=>l.kind==='option' && expiryMs(l)>horizon && !nonnegative(l.iv)).map(l=>l.strike+l.right).join(', ')+'. The selected date needs TWS IV or matching option and underlying prices.');
    if (legs.some(onFutures)) notes.push('Futures scenarios use a positive futures price, zero forward carry, and flat IV by leg. European values use Black-76. American values use a binomial early-exercise model.');
    else notes.push('Scenario uses constant IV by leg and a flat annual rate. Dividend yield defaults to zero. American values allow early exercise in a binomial model.');
    if (legs.some(l => l.kind === 'option' && l.style !== 'EU' && l.style !== 'US' && expiryMs(l) > horizon)) notes.push('Unverified exercise styles use the European scenario approximation.');
  }
  if (legs.some(onFutures)) notes.push(legs.every(signedSettlement)
    ? 'Futures expiration bounds assume settlement may fall below zero.'
    : 'Index futures expiration bounds use a zero price floor.');
  if (legs.some(l => l.settlement === 'AM')) notes.push('AM expiry uses the opening settlement value.');
  if (legs.some(l => l.kind === 'option' && !num(l.expiresAt)))
    notes.push('Scenario clock uses regular Eastern settlement hours unless the contract supplies an expiration timestamp.');
  return { ...risk, ...probability, ...mark, percentBasis:originalEntry(legs),
    scenarioPnl, greeks, exactExpiry, firstExpiryMs, lastExpiryMs, note:notes.join(' ') };
}

function axisStep(span, target) {
  const raw = span / target, base = 10 ** Math.floor(Math.log10(raw));
  return ([1,2,2.5,5,10].find(k => k*base >= raw) ?? 10)*base;
}

const compactDollars = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:1, notation:'compact'});
const pretty = new Intl.NumberFormat('en-US',{maximumFractionDigits:2});
const money = new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2});

// The guide follows the pointer's x coordinate. The value follows the
// curve, independent of how far above or below the curve the pointer sits.
export function drawInspection(ctx,{x,y,left,right,top,bottom,heading,value}){
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  ctx.save();
  ctx.setLineDash([]);
  ctx.font='12px Inter, system-ui, sans-serif';
  ctx.textBaseline='middle';
  ctx.textAlign='center';
  const half=ctx.measureText(heading).width/2;
  const titleX=clamp(x,left+half+1,right-half-1);
  ctx.beginPath();ctx.strokeStyle='rgba(237,238,246,.85)';ctx.lineWidth=1;
  ctx.moveTo(x,top+17);ctx.lineTo(x,bottom);ctx.stroke();
  // A thin halo keeps the transparent labels legible on fills and gridlines.
  ctx.strokeStyle='#08081c';ctx.lineWidth=3;ctx.lineJoin='round';ctx.fillStyle='#fff';
  ctx.strokeText(heading,titleX,top+8);ctx.fillText(heading,titleX,top+8);
  ctx.font='600 14px Inter, system-ui, sans-serif';
  const textWidth=ctx.measureText(value).width,placeLeft=x+8+textWidth>right;
  ctx.textAlign=placeLeft?'right':'left';
  const textX=clamp(placeLeft?x-8:x+8,placeLeft?left+textWidth:left,placeLeft?right:right-textWidth);
  const textY=clamp(y,top+24,bottom-7);
  ctx.strokeText(value,textX,textY);ctx.fillText(value,textX,textY);
  ctx.beginPath();ctx.arc(x,y,3.4,0,Math.PI*2);ctx.fill();ctx.restore();
}

export function scenarioPriceBounds(legs,center,percent,horizon,target=null){
 const span=(Math.abs(center)||1)*percent/100;
 const dates=expirationSet(legs);
 const signed=legs.some(signedSettlement)&&legs.every(l=>l.kind==='realized'||signedSettlement(l))&&horizon>=(dates.at(-1)??0);
 let min=center-span,max=center+span;
 if(num(target)&&target<min)min=target-Math.abs(target)*.1;
 if(num(target)&&target>max)max=target+Math.abs(target)*.1;
 if(!signed)min=Math.max(0,min);
 return {min,max:Math.max(min+.000001,max)};
}

export function drawRisk(canvas, legs, options = {}) {
  const {spot, horizonMs, ivShift = 0, rate = 0, hoverX = null, hoverY = null, onHover, unit='usd', zoom=1} = options;
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth || 640, h = canvas.clientHeight || 300;
  const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w*dpr)) canvas.width = Math.round(w*dpr);
  if (canvas.height !== Math.round(h*dpr)) canvas.height = Math.round(h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
  const greek = greekModes[unit];
  const selected = greek ? scenarioGreekEvaluator(legs, horizonMs, ivShift, rate, unit) : scenarioEvaluator(legs, horizonMs, ivShift, rate);
  const dates = expirationSet(legs);
  const expiry = dates[0] ?? null;
  const terminalReference = !greek && dates.length <= 1 && expiry !== null && num(horizonMs) && horizonMs < expiry;
  const terminal = terminalReference ? scenarioEvaluator(legs, expiry, ivShift, rate) : null;
  const missingIv = legs.some(l => l.kind === 'option' && expiryMs(l) > horizonMs && !nonnegative(l.iv));
  const expirationOnly = !selected && !!terminal && missingIv && num(ivShift) && num(rate);
  const fn = expirationOnly ? terminal : selected;
  const ref = expirationOnly ? null : terminal;
  const intermediate = ref ? scenarioEvaluator(legs,(horizonMs+expiry)/2,ivShift,rate) : null;
  const percent = unit==='percent' || unit==='riskPercent', entry = sumAvailable(legs,l=>nonnegative(l.entry)?l.entry:null);
  const riskBase = unit==='riskPercent' && dates.length<=1 && entry!==null ? expiryRisk(legs).maxLoss : null;
  const basis = unit==='riskPercent' ? riskBase : originalEntry(legs);
  const valueMode = unit==='value';
  const percentUnavailable = percent && (!num(basis) || Math.abs(basis) < 1e-8);
  const factor = percent && !percentUnavailable ? 100/Math.abs(basis) : 1;
  const previousLegs=options.previousLegs??[],previousDates=expirationSet(previousLegs),previousExpiry=previousDates[0];
  // A scenario past a prior position's settlement needs its actual closing price.
  const previousModel=!expirationOnly&&!greek&&previousLegs.length&&(!previousExpiry||horizonMs<=previousExpiry)?
    scenarioEvaluator(previousLegs,horizonMs,ivShift,rate):null;
  let previous=null;
  if(previousModel){
    const offset=valueMode?sumAvailable(previousLegs,l=>l.entry):0;
    const denominator=unit==='riskPercent'?(previousDates.length<=1?expiryRisk(previousLegs).maxLoss:null):percent?originalEntry(previousLegs):1;
    if(num(offset)&&num(denominator)&&Math.abs(denominator)>1e-8){
      const scale=percent?100/Math.abs(denominator):1;
      previous=s=>{const v=previousModel(s);return num(v)?(v+offset)*scale:null};
    }
  }
  const currency = options.currency || 'USD';
  const compactMoney = currency==='USD' ? compactDollars : new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:1,notation:'compact'});
  const exactMoney = currency==='USD' ? money : new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:2});
  const tickMoney = new Intl.NumberFormat('en-US',{style:'currency',currency,minimumFractionDigits:0,maximumFractionDigits:2});
  const tickLabel = v => greek ? formatGreek(v) : percent ? pretty.format(v)+'%' : Math.abs(v)>=1e7 ? compactMoney.format(v) : tickMoney.format(v);
  const detailLabel = v => greek ? greek.label+' '+formatGreek(v) : percent ? pretty.format(v)+'%' : exactMoney.format(v);
  const strikes = legs.filter(l => l.kind === 'option' && num(l.strike)).map(l => l.strike);
  const futures = legs.some(onFutures) && legs.every(l=>l.kind==='realized'||onFutures(l));
  const center = num(spot) && (futures || spot >= 0) ? spot : strikes.length ? strikes.reduce((a,b)=>a+b)/strikes.length : options.referenceCenter ?? null;
  const parsedStyle = typeof getComputedStyle === 'function' ? getComputedStyle(canvas) : null;
  const theme = (token,fallback) => parsedStyle?.getPropertyValue(token).trim() || fallback;
  const ink=theme('--chart-text','#afc1c7'), grid=theme('--chart-grid','#34464d'),
    muted=theme('--chart-comparison','#b9a4d9');
  ctx.font='12px Inter, sans-serif';ctx.lineJoin='round';
  function unavailable(message) {
    ctx.fillStyle=ink;ctx.textAlign='center';ctx.fillText(message,w/2,h/2,Math.max(1,w-16));
    canvas.setAttribute('aria-label',message);onHover?.(null);return null;
  }
  if (!fn || !num(center) || percentUnavailable) {
    let message;
    if (!legs.length) message=options.emptyMessage||'Add a position to draw the strategy';
    else if (!num(center)) message='A reference price or option strike is needed to center the graph';
    else if (!legs.every(isContract)) message='Check each included contract’s quantity, strike, multiplier and expiration';
    else if (!greek && legs.some(l=>!nonnegative(l.entry))) message='Enter an opening price for every included position';
    else if (percentUnavailable) message=unit==='riskPercent'?'Risk scale needs a finite nonzero maximum loss':'Percent scale needs a nonzero net entry';
    else if (greek && expiry!==null && horizonMs>=expiry) message='Choose a date before expiration to model '+greek.label.toLowerCase();
    else if (greek) message='Greek scenarios need a positive strike and implied volatility for each open option';
    else if (missingIv) message='Each option still open on the selected date needs implied volatility';
    else if (dates.length>1 && horizonMs>expiry) message='Choose a date on or before the first settlement';
    else message='Check the scenario date, interest rate and model inputs';
    return unavailable(message);
  }
  // Include payoff turns, finite break-evens and spot. Modest padding makes a
  // vertical's two strikes visible even when the reference is close to them.
  const be = !greek && dates.length <= 1 ? expiryRisk(legs).breakEvens : [];
  const anchors = [center,...strikes,...be];
  const minAnchor = Math.min(...anchors), maxAnchor = Math.max(...anchors);
  const spreadWidth=maxAnchor-minAnchor;
  const pad=new Set(strikes).size>1
    ? Math.max(0.01,spreadWidth*.42,Math.abs(center)*.0005)
    : Math.max(0.01,Math.abs(center)*(anchors.length<=2?.04:.018),spreadWidth*.22);
  const graphHorizon = expirationOnly ? expiry : horizonMs ?? expiry;
  const negativeAxis = futures && legs.every(l=>l.kind==='realized'||signedSettlement(l)) && graphHorizon >= (dates.at(-1) ?? 0);
  const autoLow = negativeAxis ? minAnchor-pad : Math.max(0,minAnchor-pad), autoHigh=maxAnchor+pad;
  const magnification = num(zoom) && zoom > 0 ? Math.min(10,Math.max(0.1,zoom)) : 1;
  const leftEdge=center-(center-autoLow)/magnification;
  const x0=options.priceBounds?.min??(negativeAxis?leftEdge:Math.max(0,leftEdge));
  const x1=options.priceBounds?.max??(center+(autoHigh-center)/magnification);
  const xValues = new Set([x0,x1,...strikes,...be,center]);
  if(previous)for(const leg of previousLegs)if(leg.kind==='option')xValues.add(leg.strike);
  const samples = Math.max(64, Math.min(180, Math.round(w/4)));
  for (let i=1;i<samples;i++) xValues.add(x0+(x1-x0)*i/samples);
  const scaled = (evaluate,s) => {const val=evaluate?.(s);return num(val)?(val+(valueMode?entry:0))*factor:null;};
  const points=[...xValues].filter(x=>x>=x0 && x<=x1).sort((a,b)=>a-b).map(s=>({s,v:scaled(fn,s),r:scaled(ref,s),m:scaled(intermediate,s),prior:previous?.(s)}));
  if (points.length < 2 || points.some(p=>!num(p.v))) return unavailable('Scenario model unavailable in this underlying price range');
  const previousOverlay=!!previous&&points.every(p=>num(p.prior));
  const values=points.flatMap(p=>[p.v,p.r,p.m,previousOverlay?p.prior:null].filter(num));
  let y0=Math.min(0,...values),y1=Math.max(0,...values);
  const margin=greek?Math.max(1e-9,(y1-y0)*.1||0.01):Math.max(percent?0.1:1,(y1-y0)*.1);y0-=margin;y1+=margin;
  const yStride=axisStep(y1-y0,Math.max(4,Math.min(18,Math.floor((h-36)/20))));
  const yTicks=[];
  for(let y=Math.ceil(y0/yStride)*yStride;y<=y1+yStride*1e-7;y+=yStride)yTicks.push(y);
  const left=Math.ceil(Math.max(45,...yTicks.map(y=>ctx.measureText(tickLabel(y)).width+14)));
  const right=w-5,top=expirationOnly?33:12,bottom=h-22;
  if (expirationOnly) {
    ctx.fillStyle=ink;ctx.textAlign='left';ctx.textBaseline='middle';
    ctx.fillText('Expiration only · selected date needs IV',left,13,Math.max(1,right-left));
  }
  const px=s=>left+(right-left)*(s-x0)/(x1-x0);
  const py=v=>bottom-(bottom-top)*(v-y0)/(y1-y0);
  function line(ax,ay,bx,by,color,dash=[],width=1){
    ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);
    ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.stroke();ctx.setLineDash([]);
  }
  ctx.fillStyle=ink;ctx.textBaseline='middle';ctx.textAlign='right';
  for(const v of yTicks){
    line(left,py(v),right,py(v),grid);
    line(left-4,py(v),left,py(v),ink);
    ctx.fillText(tickLabel(v),left-9,py(v));
  }
  const stride=axisStep(x1-x0,Math.max(2,Math.min(7,Math.floor((right-left)/75))));
  for(let v=Math.ceil(x0/stride)*stride;v<=x1+stride*1e-7;v+=stride){
    const label=pretty.format(v), tw=ctx.measureText(label).width;
    ctx.textAlign='center';ctx.fillStyle=ink;ctx.fillText(label,Math.max(left+tw/2,Math.min(right-tw/2,px(v))),bottom+13);
    line(px(v),top,px(v),bottom,grid);
    line(px(v),bottom,px(v),bottom+4,ink);
  }
  line(left,top,left,bottom,'#bebdcb');
  line(left,bottom,right,bottom,'#bebdcb');
  function stroke(key,color,dash,width) {
    ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.setLineDash(dash);
    points.forEach((p,i)=>{if(i===0)ctx.moveTo(px(p.s),py(p[key]));else ctx.lineTo(px(p.s),py(p[key]))});
    ctx.stroke();ctx.setLineDash([]);
  }
  // Fill from the payoff curve to zero. Each half uses its own vertical clip,
  // including curves with more than one break-even.
  const zero=py(0);
  for(const positive of [true,false]){
    ctx.save();ctx.beginPath();ctx.rect(left,positive?top:zero,right-left,positive?zero-top:bottom-zero);ctx.clip();
    const tint=ctx.createLinearGradient(0,positive?top:bottom,0,zero);
    const rgb=positive?'110,175,76':'164,54,44';
    tint.addColorStop(0,'rgba('+rgb+',.8)');
    tint.addColorStop(1,'rgba('+rgb+',0)');
    ctx.beginPath();ctx.moveTo(px(points[0].s),zero);
    points.forEach(p=>ctx.lineTo(px(p.s),py(p.v)));
    ctx.lineTo(px(points.at(-1).s),zero);ctx.closePath();ctx.fillStyle=tint;ctx.fill();
    ctx.restore();
  }
  line(left,zero,right,zero,'#c1c2cd',[],1);
  const strokeGradient=ctx.createLinearGradient(0,top,0,bottom);
  const crossing=(zero-top)/(bottom-top);
  strokeGradient.addColorStop(Math.max(0,crossing-.1),'#74b951');
  strokeGradient.addColorStop(crossing,'#b59a48');
  strokeGradient.addColorStop(Math.min(1,crossing+.1),'#a63a32');
  const previousInk='#a4a8b3';
  if(previousOverlay)stroke('prior',previousInk,[],2);
  stroke('v',strokeGradient,[],3);
  if(intermediate&&points.every(p=>num(p.m)))stroke('m',muted,[5,4],1.2);
  if(ref&&points.every(p=>num(p.r)))stroke('r',muted,[1,4],1.3);
  if(!greek&&!valueMode){
    let visible=be.filter(v=>v>=x0&&v<=x1);
    if(ref||dates.length>1){
      visible=[];
      for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i];
        if((a.v<0)!==(b.v<0)){
          let lo=a.s,hi=b.s;
          for(let n=0;n<22;n++){
            const mid=(lo+hi)/2;
            if((scaled(fn,mid)<0)===(a.v<0))lo=mid;else hi=mid;
          }
          visible.push((lo+hi)/2);
        }
      }
    }
    for(const b of visible){
      line(px(b),top+14,px(b),bottom,'#739cce');
      if(!num(hoverX)||Math.abs(px(b)-hoverX)>80){
        ctx.fillStyle='#9bbce8';ctx.textAlign='center';
        ctx.fillText(pretty.format(b),Math.max(left+30,Math.min(right-30,px(b))),top+7);
      }
    }
  }
  if(num(options.target)&&options.target>=x0&&options.target<=x1){
    const x=px(options.target);
    line(x,top+16,x,bottom,'#1b9fdf',[4,3]);
    ctx.fillStyle='#80c6f0';ctx.textAlign='center';
    ctx.fillText('Target '+pretty.format(options.target),Math.max(left+40,Math.min(right-40,x)),top+8);
  }
  if(ref||previousOverlay){
    const dateLabel=t=>new Date(t).toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/New_York'});
    const legend=ref?[[dateLabel(horizonMs),[]],[dateLabel((horizonMs+expiry)/2),[5,4]],['Expiration',[1,4]]]:[];
    if(previousOverlay)legend.push(['Previous (saved)',[],previousInk]);
    ctx.save();ctx.globalAlpha=num(hoverX)?.5:.87;ctx.font='12px Inter, system-ui, sans-serif';
    ctx.textAlign='left';ctx.fillStyle=ink;
    legend.forEach(([name,dash,color],i)=>{const y=top+8+i*17;line(left+5,y,left+30,y,color??ink,dash,1.8);ctx.fillText(name,left+36,y)});
    ctx.restore();
  }
  if (num(spot) && spot>=x0 && spot<=x1) {
    line(px(spot),top,px(spot),bottom,ink,[1,3]);
  }
  let hover=null;
  if(num(hoverX)&&hoverX>=left&&hoverX<=right&&(!num(hoverY)||(hoverY>=top&&hoverY<=bottom))){
    const underlying=x0+(hoverX-left)/(right-left)*(x1-x0);
    const pnl=fn(underlying),displayPnl=(pnl+(valueMode?entry:0))*factor;
    const move=spot>0?(underlying/spot-1)*100:null;
    const heading=(expirationOnly?'Expiration only · ':'')+pretty.format(underlying)+(num(move)?' ('+(move>0?'+':'')+Number(move.toFixed(1))+'%)':'');
    const value=detailLabel(displayPnl);
    drawInspection(ctx,{x:hoverX,y:py(displayPnl),left,right,top,bottom,heading,value});
    hover={underlying,pnl,displayPnl,heading,value,expirationOnly};
  }
  onHover?.(hover);
  const subject=greek?'Modeled strategy '+greek.label+' ('+currency+' '+greek.unit+')':valueMode?'Strategy position value':'Strategy profit and loss';
  canvas.setAttribute('aria-label',(expirationOnly?'Expiration only. Selected date needs implied volatility. ':'')+subject+' from underlying '+pretty.format(x0)+' to '+pretty.format(x1)+(ref?'; dashed line shows the intermediate date and dotted line shows expiration payoff':'')+(previousOverlay?'; gray line shows the previous saved strategy':'')+(num(spot)?'; at reference '+detailLabel(scaled(fn,spot)):''));
  return {xMin:x0,xMax:x1,yMin:y0,yMax:y1,hover,comparison:!!ref,previousOverlay,expirationOnly};
}

export function closedQuantity(leg) {
  return (leg.closes ?? []).reduce((total, fill) => total + fill.qty, 0);
}

export function remainingQty(leg) {
  return Math.sign(leg.qty) * (Math.abs(leg.qty) - closedQuantity(leg));
}

export function optionFee(leg, quantity, rate) {
  return leg.kind === 'option' ? Math.abs(quantity) * rate : 0;
}

export function realizedPnl(leg, rate = 0) {
  return (leg.closes ?? []).reduce((pnl, fill) => pnl
    + Math.sign(leg.qty) * fill.qty * (fill.price - leg.entry) * leg.multiplier
    - 2 * optionFee(leg, fill.qty, rate), 0);
}

// Keep entry premiums and market prices intact. Fixed cash flows participate
// in P&L and original cost basis, with zero market value and zero exposure.
export function projectPositions(source, quotes, rate = 0) {
  const positions = [];
  let cashPnl = 0, originalBasis = 0, hasCashFlows = false;
  for (const leg of source) {
    if (leg.excluded) continue;
    const qty = remainingQty(leg), closed = closedQuantity(leg);
    if (qty) positions.push({...leg, ...quotes[leg.conId], qty});
    const openingFee = optionFee(leg, leg.qty, rate);
    if (!closed && !openingFee) continue;
    hasCashFlows = true;
    // Closed lots carry opening and closing fees. Open lots carry opening fees.
    cashPnl += realizedPnl(leg, rate) - optionFee(leg, qty, rate);
    originalBasis += openingFee + Math.sign(leg.qty) * closed * leg.entry * leg.multiplier;
  }
  if (hasCashFlows) positions.push({kind:'realized', qty:cashPnl > 0 ? -1 : 1,
    multiplier:1, entry:Math.abs(cashPnl), mid:0, originalBasis});
  return positions;
}
