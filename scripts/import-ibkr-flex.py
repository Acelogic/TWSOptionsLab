#!/usr/bin/env python3
"""Import official IBKR Activity Flex XML from local files to a loopback Options Lab."""
import argparse
import collections
import datetime as dt
import decimal
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

D = decimal.Decimal
DAY = dt.timedelta(days=1)
ACTIVITY = ("OptionEAE", "CorporateActions", "Transfers", "TradeTransfers", "TransactionTaxes")
NON_EXEC = {"ORDER", "SUMMARY", "SYMBOL_SUMMARY", "ASSET_CLASS", "CLOSED_LOT", "LOT", "WASH_SALE"}
class Problem(ValueError):
    pass

def require(ok, message):
    if not ok:
        raise Problem(message)

def mandatory(a, field):
    val = a.get(field, "").strip()
    require(val, f"Required Flex field {field} is missing. Re-export with the field enabled.")
    return val

def day(val):
    compact = val.replace("-", "")
    require(re.fullmatch(r"\d{8}", compact), "Use yyyyMMdd or yyyy-MM-dd for Flex dates.")
    try:
        return dt.datetime.strptime(compact, "%Y%m%d").date()
    except ValueError:
        raise Problem("Invalid calendar date in the statement.") from None

def stamp(local, zone):
    if local.tzinfo is None:
        a = local.replace(tzinfo=zone, fold=0)
        b = local.replace(tzinfo=zone, fold=1)
        require(a.utcoffset() == b.utcoffset(), "Ambiguous or missing local time at a daylight-saving transition.")
        local = a
    return int(local.timestamp() * 1000)

def timestamp(val, zone):
    require(val, "Execution-level Date/Time is required; a trade date alone is insufficient.")
    for fmt in ("%Y%m%d;%H%M%S", "%Y%m%d;%H:%M:%S", "%Y%m%d %H:%M:%S",
                "%Y-%m-%d;%H:%M:%S", "%Y%m%d;%H%M%S.%f"):
        try:
            parsed = dt.datetime.strptime(val, fmt)
        except ValueError:
            continue
        return stamp(parsed, zone)
    require("T" in val or " " in val, "Use yyyyMMdd;HHmmss or ISO 8601 for the Flex execution timestamp.")
    try:
        return stamp(dt.datetime.fromisoformat(val.replace("Z", "+00:00")), zone)
    except ValueError:
        raise Problem("Unsupported execution timestamp or ambiguous timezone.") from None

def dec(value, label):
    try:
        result = D(value)
    except (decimal.InvalidOperation, ValueError):
        raise Problem(f"Invalid numeric Flex field {label}.") from None
    require(result.is_finite() and math.isfinite(float(result)), f"Invalid numeric Flex field {label}.")
    return result

def positive_id(a):
    value = mandatory(a, "conid")
    require(value.isdecimal() and 0 < int(value) <= 2147483647, "Invalid conid in Flex data.")
    return int(value)

def tag(node):
    return node.tag.rsplit("}", 1)[-1]

def inside(node, name):
    return next((child for child in node if tag(child) == name), None)

def sign_qty(a):
    raw = dec(mandatory(a, "quantity"), "quantity")
    side = mandatory(a, "buySell").upper()
    require(side in ("BUY", "SELL") and raw != 0, "Trade is missing a buy/sell direction or quantity.")
    require(side != "BUY" or raw > 0, "Conflicting buy side and negative execution quantity.")
    return abs(raw) if side == "BUY" else -abs(raw)

def cancel_or_bust(a):
    notes = set(re.split("[,; ]+", (a.get("notes") or a.get("code") or "").upper()))
    typ = a.get("transactionType", "").upper()
    return "CANCEL" in typ or "BUST" in typ or "CA" in notes

def versioned_id(token):
    match = re.fullmatch(r"(.+\.\d+)\.(\d\d)", token)
    return (match[1], int(match[2])) if match else (token, 0)

def lifecycle_identity(a):
    if a.get("transactionType","").upper()!="BOOKTRADE":return None
    notes=set(re.split("[;, ]+",(a.get("notes") or a.get("code") or "").upper()))
    kinds=[kind for code,kind in [("EP","expiration"),("A","assignment"),("EX","exercise")] if code in notes]
    token=a.get("transactionID","").strip()
    prefix="IBKR-FLEX-LIFECYCLE/"
    if len(kinds)!=1 or not re.fullmatch("[A-Za-z0-9._-]+",token) or len(token)+len(prefix)>128 or token.upper() in ("0","-","NONE","N/A"):
        return None
    return prefix+token,kinds[0]

def execution(a, zone, lifecycle=None):
    con_id, signed = positive_id(a), sign_qty(a)
    sec_type = mandatory(a, "assetCategory").upper()
    at = timestamp(a.get("dateTime") or ((a.get("tradeDate", "")+";"+a["tradeTime"]) if a.get("tradeTime") else ""), zone)
    ident = lifecycle[0] if lifecycle else (a.get("ibExecID") or a.get("ibExecId") or "").strip()
    require(lifecycle or not ident.startswith("IBKR-FLEX-LIFECYCLE/"),"Reserved broker lifecycle identity.")
    require(ident and ident.upper() not in ("N/A","NONE","0","-") and re.fullmatch(r"[!-~]{1,128}",ident),
            "Execution-level IB Execution ID is missing or invalid. Include it in the Flex Trades section.")
    price = None if lifecycle and not a.get("tradePrice") else dec(mandatory(a, "tradePrice"), "tradePrice")
    multiplier = dec(mandatory(a, "multiplier") if sec_type != "STK" else a.get("multiplier") or "1", "multiplier")
    require((price is None or price >= 0) and multiplier > 0, "Invalid contract premium or multiplier.")
    fee = -dec(a["ibCommission"], "ibCommission") if a.get("ibCommission") else None
    ccy = mandatory(a, "currency")
    fee_ccy = a.get("ibCommissionCurrency") or None
    symbol = mandatory(a,"underlyingSymbol") if sec_type in ("OPT","FOP") else mandatory(a,"symbol")
    fields = dict(id=ident, at=at, conId=con_id, secType=sec_type, symbol=symbol,
                  localSymbol=a.get("localSymbol") or mandatory(a, "symbol"), currency=ccy, multiplier=float(multiplier),
                  qty=float(abs(signed)), side="BUY" if signed > 0 else "SELL", price=None if price is None else float(price),
                  commission=None if fee is None else float(fee), commissionCurrency=fee_ccy)
    if lifecycle:fields["eventType"]=lifecycle[1]
    if sec_type in ("OPT", "FOP"):
        require(abs(signed) == abs(signed).to_integral_value(), "An option execution must have a whole contract quantity.")
        strike = dec(mandatory(a, "strike"), "strike")
        right = mandatory(a, "putCall").upper()
        require(right in ("P","C","PUT","CALL") and strike.is_finite(), "Invalid option strike or right.")
        fields.update(expiry=day(mandatory(a, "expiry")).strftime("%Y%m%d"), right=right[0], strike=float(strike))
    return fields

@dataclass
class Statement:
    acct: str
    start: dt.date
    end: dt.date
    node: ET.Element
    option_trades: list
    blocked: set
    warning_rows: int

def parse_inputs(paths, zone, documents=None):
    statements = []
    def read_inputs():
        if documents is not None:
            for xml in documents:
                yield xml.encode("utf-8")
        else:
            for path in paths:
                try:
                    yield Path(path).read_bytes()
                except OSError:
                    raise Problem("Unable to read a supplied XML file.") from None
    for data in read_inputs():
        require(b"\0" not in data and b"<!doctype" not in data.lower() and b"<!entity" not in data.lower(),
                "Use UTF-8 Activity XML without DTD or entity declarations.")
        try:
            root = ET.fromstring(data)
        except ET.ParseError:
            raise Problem("A file is not well-formed Activity Flex XML.") from None
        require(tag(root) == "FlexQueryResponse" and root.get("type", "AF").upper() in ("AF","ACTIVITYFLEX","ACTIVITY"), "Expected an IBKR Activity Flex XML response.")
        group = inside(root, "FlexStatements")
        require(group is not None and len(group) and all(tag(n) == "FlexStatement" for n in group), "No Activity Flex statements found.")
        if group.get("count"):
            require(group.get("count") == str(len(group)), "Flex statement count does not match the XML contents.")
        for st in group:
            account = mandatory(st.attrib, "accountId")
            require(account.lower() not in ("all","consolidated","multiple"), "Use separate, account-specific Flex statements.")
            first, last = day(mandatory(st.attrib,"fromDate")), day(mandatory(st.attrib,"toDate"))
            require(first <= last, "Statement dates are reversed.")
            trades = inside(st, "Trades")
            require(trades is not None, "Include the Trades section at Executions level in the Flex XML.")
            options, blocked, omitted, summaries, executions = [], set(), 0, 0, 0
            for t in trades:
                a = t.attrib
                if tag(t) != "Trade":
                    require(tag(t) in ("Lot","WashSale","Order","SymbolSummary","AssetSummary"), "Unrecognized row in the Flex Trades section.")
                    summaries += 1
                    continue
                level = a.get("levelOfDetail", "").upper()
                if level in NON_EXEC:
                    summaries += 1
                    continue
                require(level == "EXECUTION", "Include Level of Detail = EXECUTION for Flex trades.")
                require(not a.get("accountId") or a["accountId"] == account, "Mixed account identifiers in statement executions.")
                executions += 1
                sec = mandatory(a,"assetCategory").upper()
                if sec not in ("OPT","FOP"):
                    continue
                conid = positive_id(a)
                if cancel_or_bust(a):
                    raise Problem("This option export contains canceled or busted executions. Supply a corrected final execution export.")
                lifecycle=None
                if a.get("transactionType","").upper() not in ("", "EXCHTRADE", "TRADE", "EXECUTION"):
                    blocked.add(conid)
                    lifecycle=lifecycle_identity(a)
                    if not lifecycle:
                        omitted += 1
                        continue
                options.append(execution(a, zone,lifecycle))
            require(executions or not summaries, "The Trades section contains totals or lots without execution-level rows.")
            statements.append(Statement(account,first,last,st,options,blocked,omitted))
    return statements

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):
        return None

class Lab:
    def __init__(self,url):
        u = urllib.parse.urlsplit(url)
        require(u.scheme=="http" and u.hostname in ("127.0.0.1","::1") and u.port and u.path in ("","/") and
                not (u.query or u.fragment or u.username or u.password), "Use an explicit loopback HTTP URL for Options Lab.")
        self.base=url.rstrip("/")+"/api/"
        self.client=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    def call(self,path,body=None):
        req=urllib.request.Request(self.base+path,data=None if body is None else json.dumps(body,allow_nan=False).encode(),
                                   headers={"Content-Type":"application/json"})
        try:
            with self.client.open(req,timeout=240 if path=="ibkr-flex" else 45) as response:
                return json.load(response)
        except urllib.error.HTTPError as e:
            # Server responses could contain identifiers from an invalid fill.
            raise Problem(f"Options Lab rejected {path.split('?')[0]} (HTTP {e.code}). Check the statement fields and saved version.") from None
        except (OSError, ValueError):
            raise Problem("The loopback Options Lab server is unavailable or returned invalid JSON.") from None

def normalize_history(statements, zone):
    account_refs = collections.defaultdict(dict)
    shipments = []
    for st in statements:
        refs = account_refs[st.acct]
        new = []
        for event in st.option_trades:
            key=event["id"]
            if key in refs:
                require(refs[key]==event,"Conflicting copies of an execution ID. Use consistent original reports.")
            else:
                refs[key]=event
                new.append(event)
        start=stamp(dt.datetime.combine(st.start,dt.time()),zone)
        end=stamp(dt.datetime.combine(st.end+DAY,dt.time()),zone)-1
        # Overnight and late-booked fills may precede the report date. Keep
        # their actual execution timestamp; statement range metadata is partial.
        event_times=[e["at"] for e in st.option_trades]
        header={"accountId":st.acct,"from":min([start]+event_times),"to":max([end]+event_times)}
        current=[]
        size=0
        for e in new:
            n=len(json.dumps(e).encode())+2
            require(n<90_000,"One Flex execution exceeds the native import request limit.")
            if current and size+n>90_000:
                shipments.append({**header,"executions":current})
                current=[]
                size=0
            current.append(e)
            size+=n
        shipments.append({**header,"executions":current})
    return shipments, sum(len(rows) for rows in account_refs.values())

def inventory(st, conid, model, zone):
    generated=timestamp(mandatory(st.node.attrib,"whenGenerated"),zone)
    require(generated>=stamp(dt.datetime.combine(st.end+DAY,dt.time()),zone), "Use a final daily report generated after the report date ended.")
    blocked = conid in st.blocked
    for section in ACTIVITY:
        node=inside(st.node,section)
        require(node is not None, f"Daily export is missing the {section} section.")
        for entry in node:
            cid=entry.get("conid")
            if not cid or cid=="0" or cid==str(conid) or entry.get("underlyingConid")==str(conid):
                blocked=True
    require(not blocked,"A lifecycle event, transfer, adjustment or separate charge needs reconciliation.")
    for opt in ("UnsettledTransfers","Adjustments","UnbookedTrades","PendingExcercises","PendingExercises"):
        section=inside(st.node,opt)
        if section is not None:
            require(all(node.get("conid") not in (None,"","0",str(conid)) for node in section),
                    "The daily statement includes an unresolved adjustment or transfer.")
    positions=inside(st.node,"OpenPositions")
    require(positions is not None,"Daily export is missing Open Positions at Summary level.")
    quantities=[]
    summaries=0
    target_lots=False
    for op in positions:
        a=op.attrib
        require(tag(op)=="OpenPosition","Unsupported Open Positions section structure.")
        require(not a.get("accountId") or a["accountId"]==st.acct, "Open Positions combines multiple accounts.")
        level=mandatory(a,"levelOfDetail").upper()
        require(level in ("SUMMARY","LOT"),"Invalid Open Positions level of detail.")
        if level=="LOT":
            target_lots |= a.get("conid")==str(conid)
            continue
        summaries+=1
        cid=positive_id(a)
        require(day(mandatory(a,"reportDate"))==st.end,"Open Positions includes a different inventory date.")
        if cid!=conid:
            continue
        require(not a.get("model") or a["model"].strip().lower() in ("independent","default"), "A modeled account allocation needs separate reconciliation.")
        require(a.get("currency")==model["currency"] and dec(mandatory(a,"multiplier") if model["kind"]!="stock" else a.get("multiplier") or "1","multiplier")==D(str(model["multiplier"])),
                "Statement holdings disagree with model contract currency or multiplier.")
        require(a.get("assetCategory") in (("STK",) if model["kind"]=="stock" else ("OPT","FOP")),"Position security type disagrees with the saved contract.")
        qty=dec(mandatory(a,"position"),"position")
        side=mandatory(a,"side").upper()
        require(side in ("LONG","SHORT") and (side=="SHORT" or qty>=0), "Position side or signed quantity is inconsistent.")
        quantities.append(-abs(qty) if side=="SHORT" else qty)
    require(summaries or not len(positions),"Open Positions contains only lot details. Include Summary.")
    require(not target_lots or quantities,"The saved contract has lot details but no account-wide position summary.")
    require(len(quantities)<=1,"More than one summary position maps to this saved contract.")
    return quantities[0] if quantities else D(0)

def matched_fills(st, conid, model, zone, end):
    events={}
    for t in inside(st.node,"Trades"):
        a=t.attrib
        if tag(t)!="Trade" or a.get("levelOfDetail","").upper()!="EXECUTION":
            continue
        cid=a.get("conid")
        if not cid and a.get("assetCategory") in ("STK","OPT","FOP"):
            raise Problem("Missing contract identifier in the unfiltered daily execution section.")
        if cid!=str(conid):
            continue
        require(not cancel_or_bust(a) and a.get("transactionType","").upper() in ("EXCHTRADE","TRADE","EXECUTION"),
                "An execution type or cancellation requires independent reconciliation.")
        if a.get("origTradeID","") not in ("","0") or "CO" in re.split("[;, ]+",a.get("notes","").upper()):
            raise Problem("A corrected or prior-period execution needs separate reconciliation.")
        require(not a.get("model") or a["model"].strip().lower() in ("independent","default"),"A model allocation requires separate account reconciliation.")
        event=execution(a,zone)
        require(event["currency"]==model["currency"] and event["multiplier"]==model["multiplier"] and event["commission"] is not None
                and event["commissionCurrency"]==event["currency"],"Unconfirmed fill multiplier, commission or currency.")
        require(a.get("taxes","")!="" and dec(a["taxes"],"taxes")==0,
                "Include Taxes in the daily trade fields; additional transaction taxes require separate reconciliation.")
        require(dt.datetime.fromtimestamp(event["at"]/1000,zone).date()==st.end and event["at"]<=end,
                "After-close or other-date activity prevents using end-of-day holdings at this contract’s regular close.")
        stem,version=versioned_id(event["id"])
        require(version<=1 and stem not in events, "Corrected or duplicate executions require reconciliation.")
        events[stem]=dict(id=event["id"],at=event["at"],qty=float(sign_qty(a)),price=event["price"],commission=event["commission"],currency=event["currency"])
    return list(events.values())

def saved_evidence(sts, requested, zone, lab, account_file=None, snapshot_file=None):
    require(all(s.start<=s.end for s in sts),"Invalid statement dates.")
    accounts={s.acct for s in sts}
    if account_file:
        try:
            selected=Path(account_file).read_text().strip()
        except OSError:
            raise Problem("Unable to read the private account selector file.") from None
        require(selected in accounts,"Selected account is absent from the supplied statements.")
    else:
        require(len(accounts)==1,"To verify with multiple accounts, supply an account selector file or separate the exports.")
        selected=next(iter(accounts))
    daily={}
    for st in sts:
        if st.acct!=selected or st.start!=st.end:
            continue
        require(st.end not in daily, "Provide just one full daily statement per account and date.")
        daily[st.end]=st
    require(requested in daily,"The requested verification date needs an account-specific single-day Flex report.")
    scope=lab.call("account-scope",{"accountId":selected}).get("accountScope","")
    require(re.fullmatch("[0-9a-f]{64}",scope),"Options Lab returned an invalid local account scope.")
    library=lab.call("library")
    if snapshot_file:
        try:
            snapshots=json.loads(Path(snapshot_file).read_bytes())
        except (OSError, ValueError):
            raise Problem("Unable to open the supplied saved-snapshots JSON.") from None
    else:
        snapshots=lab.call("saved-snapshots?mode=1")
        for _ in range(12):
            if all(x.get("dayPeriod",{}).get("mode") not in ("unknown","mixed") for x in snapshots["rows"].values()):
                break
            time.sleep(.5)
            snapshots=lab.call("saved-snapshots?mode=1")
    records, skipped=[],[]
    for row in library:
        try:
            snapshot=snapshots.get("rows",{}).get(row["id"],{})
            require(snapshot.get("version")==row["version"],"The saved snapshot or version is unavailable.")
            period=snapshot.get("dayPeriod",{})
            require(period.get("mode")=="closed" and period.get("date")==requested.isoformat(),"The requested completed session is unavailable on this saved row.")
            prior=dt.date.fromisoformat(period["priorDate"])
            require(prior in daily,"A matching prior-date, single-day Flex report is missing.")
            # Each intervening civil date must have explicit unfiltered activity.
            # This avoids silently overlooking weekend/overnight gap activity.
            gap=(requested-prior).days
            require(0<gap<=21 and all(prior+DAY*i in daily for i in range(1,gap)),
                    "One or more intervening daily activity reports are missing.")
            old, new=daily[prior],daily[requested]
            result=[]
            for model in row["document"]["legs"]:
                if model.get("excluded"):continue
                conid=model.get("conId")
                if model.get("kind")=="option" and day(model["expiry"])<prior and sum(c["qty"] for c in model.get("closes",[]))==abs(model["qty"]):
                    continue
                require(isinstance(conid,int) and conid>0,"An included contract has no broker contract identity.")
                leg=next((l for l in snapshot["legs"] if l["conId"]==conid),{})
                first=leg.get("dayPrior") or {}
                last=leg.get("dayCurrent") or {}
                require(first.get("date")==prior.isoformat() and last.get("date")==requested.isoformat(),"This leg’s two venue endpoints are unavailable.")
                p,end=first.get("sessionEnd"),last.get("sessionEnd")
                require(isinstance(p,int) and isinstance(end,int) and p<end and dt.datetime.fromtimestamp(p/1000,zone).date()==prior
                        and dt.datetime.fromtimestamp(end/1000,zone).date()==requested,"The statement timezone and venue cutoffs do not align.")
                model={**model,"currency":model.get("currency") or row["document"].get("currency") or snapshot.get("currency")}
                require(model["currency"],"Saved currency is unknown.")
                start_qty=inventory(old,conid,model,zone)
                end_qty=inventory(new,conid,model,zone)
                matched_fills(old,conid,model,zone,p)
                fills=[]
                held=start_qty
                for i in range(1,gap+1):
                    d=prior+DAY*i
                    cutoff=end if d==requested else stamp(dt.datetime.combine(d+DAY,dt.time()),zone)-1
                    chunk=matched_fills(daily[d],conid,model,zone,cutoff)
                    held+=sum((D(str(f["qty"])) for f in chunk),D(0))
                    balance=end_qty if d==requested else inventory(daily[d],conid,model,zone)
                    require(held==balance and all(p<f["at"]<=end for f in chunk),
                            "Dated holdings and signed executions do not balance.")
                    fills.extend(chunk)
                require(len({f["id"] for f in fills})==len(fills),"An execution appears on more than one reporting date.")
                require(not any(r["conId"]==conid for r in result),"Several saved legs share this contract; allocation is ambiguous.")
                result.append(dict(conId=conid,currency=model["currency"],multiplier=model["multiplier"],priorEnd=p,end=end,
                    priorQty=float(start_qty),endQty=float(end_qty),fills=fills,zone=leg.get("timeZone") or zone.key))
            require(result,"No eligible saved contracts.")
            records.append(dict(strategyId=row["id"],version=row["version"],priorDate=prior.isoformat(),date=requested.isoformat(),
                   accountScope=scope,source="IBKR Activity Flex XML",inventoryMethod="datedStatement",complete=True,legs=result))
        except (Problem, KeyError, ValueError, TypeError) as e:
            reason=str(e) if isinstance(e,Problem) else "Required dated saved-contract fields are missing."
            skipped.append({"name":row["name"],"reason":reason})
    # The full saved library matters, including models that failed other checks.
    by_contract=collections.defaultdict(set)
    for row in library:
        for l in row["document"]["legs"]:
            if not l.get("excluded") and l.get("conId"):
                by_contract[l["conId"]].add(row["id"])
    clean=[]
    names={r["id"]:r["name"] for r in library}
    for r in records:
        if any(len(by_contract[l["conId"]])>1 and (l["priorQty"] or l["endQty"] or l["fills"]) for l in r["legs"]):
            skipped.append({"name":names[r["strategyId"]],"reason":"More than one saved strategy refers to a nonzero account contract."})
        else: clean.append(r)
    return clean,skipped,names

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url",default="http://127.0.0.1:18762")
    parser.add_argument("--timezone",required=True,help="IANA timezone configured for the Flex report")
    parser.add_argument("--verify-saved",metavar="YYYY-MM-DD",help="Verify selected dated holdings using two unfiltered daily reports")
    parser.add_argument("--confirm-unfiltered",action="store_true",help="Both daily reports cover the entire account, all positions and all executions")
    parser.add_argument("--account-file",help="Local file containing the selected account ID when multiple accounts are present")
    parser.add_argument("--snapshot-file",help="Previously captured local /api/saved-snapshots JSON with the two venue cutoffs")
    parser.add_argument("--dry-run",action="store_true")
    parser.add_argument("--stdin-json",action="store_true",help="Read a JSON array of XML strings from stdin")
    parser.add_argument("files",nargs="*",metavar="ACTIVITY_XML")
    a=parser.parse_args()
    zone=ZoneInfo(a.timezone)
    require(bool(a.files) != a.stdin_json, "Supply either Activity XML file paths or --stdin-json.")
    documents=None
    if a.stdin_json:
        try:
            documents=json.load(sys.stdin)
        except (ValueError,UnicodeError):
            raise Problem("Invalid JSON upload.") from None
        require(isinstance(documents,list) and documents and all(isinstance(s,str) for s in documents),"Expected a nonempty array of XML documents.")
    if not a.dry_run and not a.snapshot_file and not a.account_file:
        if a.verify_saved:
            require(a.confirm_unfiltered,"Confirm the daily reports are complete and unfiltered before verifying historical ownership.")
        if documents is None:
            try:
                documents=[Path(path).read_text(encoding="utf-8-sig") for path in a.files]
            except (OSError, UnicodeError):
                raise Problem("Unable to read a supplied UTF-8 XML file.") from None
        result=Lab(a.base_url).call("ibkr-flex",{"xml":documents,"timezone":a.timezone,
            "verifySaved":str(day(a.verify_saved)) if a.verify_saved else None,"confirmUnfiltered":a.confirm_unfiltered})
        print(json.dumps(result))
        return
    sts=parse_inputs(a.files,zone,documents)
    shipments,total=normalize_history(sts,zone)
    lifecycle_events=sum("eventType" in row for batch in shipments for row in batch["executions"])
    n=total-lifecycle_events
    lab=Lab(a.base_url)
    records,skipped=[],[]
    names={}
    warnings=[]
    if a.verify_saved:
        require(a.confirm_unfiltered,"Confirm both daily reports are complete and unfiltered before verifying historical ownership.")
        requested=day(a.verify_saved)
        try:
            records,skipped,names=saved_evidence(sts,requested,zone,lab,a.account_file,a.snapshot_file)
        except Problem as e:
            warnings.append("Saved-trade ownership verification unavailable. "+str(e))
    verified=len(records) if a.dry_run else 0
    if not a.dry_run:
        processed=0
        for batch in shipments:
            try:
                lab.call("options-history/import",{"source":"IBKR Flex","accounts":[batch]})
            except Problem as e:
                raise Problem(f"{e} Previously accepted batches: {processed}. Reimporting the original files is safe.") from None
            processed+=1
        for r in records:
            try:
                lab.call("account-session-evidence",{"records":[r]})
                verified+=1
            except Problem as e:
                skipped.append({"name":names[r["strategyId"]],"reason":str(e)})
    for entry in skipped:
        for account in {st.acct for st in sts}:
            entry["name"]=entry["name"].replace(account,"[account]")
    if any(st.warning_rows for st in sts):
        warnings.append("Non-exchange option lifecycle entries were excluded from the execution history and from historical ownership verification.")
    if not n:warnings.append("The supplied Trades sections contain zero option executions.")
    print(json.dumps(dict(ok=True,dryRun=a.dry_run,statements=len(sts),accounts=len({s.acct for s in sts}),executions=n,lifecycleEvents=lifecycle_events,
                          verifiedStrategies=verified,skippedStrategies=skipped,warnings=warnings)))
if __name__=="__main__":
    try:
        main()
    except (Problem,ZoneInfoNotFoundError,OverflowError) as exc:
        message=str(exc) if isinstance(exc,Problem) else "Invalid timezone or numeric range in import."
        print(json.dumps({"ok":False,"error":message}))
        sys.exit(2)
