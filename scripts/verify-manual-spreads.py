#!/usr/bin/env python3
"""Exercise manual spread choices through real Chrome, native HTTP/SQLite and a local TWS fixture.

Failure cases include double-counted fees, partial-lot overlap, invisible selection state,
cross-account reuse, stale broker revisions, missing commissions, or loss of source records
across a save/ungroup, reimport, account switch, or server restart.
"""
import argparse
import concurrent.futures
import decimal
import hashlib
import http.client
import json
import pathlib
import runpy
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET

ROOT=pathlib.Path(__file__).resolve().parents[1]
WIRE=runpy.run_path(str(ROOT/"scripts/verify-options-ledger.py"))
D=decimal.Decimal
SPECS={"MANS":31000,"NOFEE":31100,"CHANGE":31200,"ROLLQA":31300,"REPLAYQA":31400,"UNPROVEN":31500}
SYNTHETIC=set(SPECS)
def report_xml(account,symbols,correction=False,alternate=False):
    root=ET.Element("FlexQueryResponse",type="AF")
    reports=ET.SubElement(root,"FlexStatements",count="1")
    stmt=ET.SubElement(reports,"FlexStatement",accountId=account,fromDate="20250905",toDate="20250912",whenGenerated="20250910;110000")
    trades=ET.SubElement(stmt,"Trades")
    for symbol in symbols:
        for offset,leg,side,opened,strike,price,fee,close_prices,close_fees in (
            (1,"LO","BUY","20250905;101000",100,"4",".50",("6","5"),(".25",".50")),
            (2,"HI","SELL","20250905;103500",110,"3",".60",("2","2.50"),(".35",".70")),
        ):
            if alternate and leg=="LO":price="3.50"
            closings=("20250908;121500","20250909;132500")
            if symbol=="ROLLQA" and leg=="HI":
                opened="20250910;103500";closings=("20250911;121500","20250912;132500")
            prefix=f"{symbol}-{leg}"
            trade=dict(accountId=account,assetCategory="OPT",levelOfDetail="EXECUTION",transactionType="ExchTrade",symbol=symbol+" contract",underlyingSymbol=symbol,underlyingConid=str(SPECS[symbol]),conid=str(SPECS[symbol]+offset),currency="USD",multiplier="100",expiry="20250919",strike=str(strike),putCall="C",exchange="SMART")
            def emit(id_,effect,action,qty,stamp,px,charge,realized,corrected=False):
                ident=f"{prefix}-{id_}"
                attr=dict(trade,ibExecID=ident+(".02" if corrected else ".01"),transactionID="TR-"+ident,tradeID="T-"+ident,ibOrderID="IB-"+ident,brokerageOrderID="ORD-"+ident,openCloseIndicator=effect,buySell=action,quantity=str(qty),dateTime=stamp,orderTime=stamp,tradeDate=stamp[:8],tradePrice=str(px),fifoPnlRealized=str(realized))
                if charge is not None:attr.update(ibCommission=str(-D(charge)),ibCommissionCurrency="USD")
                ET.SubElement(trades,"Trade",attr)
            if symbol=="UNPROVEN" and leg=="LO":
                emit("LEG-A","O","BUY",1,"20250905;101000","4",".50",0)
                emit("LEG-B","O","BUY",2,"20250905;104000","5","1.00",0)
                # This closing execution has an official total but no opening-lot references.
                emit("COMBINED","C","SELL",-3,"20250909;100000","6",".75","398.50")
                continue
            entry_fee=D(fee)*3 if symbol!="NOFEE" or leg!="HI" else None
            emit("OPEN","O",side,3 if side=="BUY" else -3,opened,price,entry_fee,0)
            for i,(q,stamp,px,charge) in enumerate(zip((1,2),closings,close_prices,close_fees),1):
                action="SELL" if side=="BUY" else "BUY"
                adjusted=correction and symbol=="CHANGE" and leg=="LO" and i==1
                if adjusted:px="6.10"
                gross=(D(px)-D(price))*100*q*(1 if side=="BUY" else -1)
                fifo=gross-D(fee)*q-D(charge)+D("1.00")
                emit("CLOSE"+str(i),"C",action,-q if side=="BUY" else q,stamp,px,charge,fifo,adjusted)
                ET.SubElement(trades,"Lot",dict(accountId=account,assetCategory="OPT",levelOfDetail="CLOSED_LOT",conid=trade["conid"],currency="USD",dateTime=stamp,buySell=action,transactionID="TR-"+prefix+"-OPEN",openDateTime=opened,quantity=str(q if side=="BUY" else -q),fifoPnlRealized=str(fifo),cost=str(D(price)*100*q)))
            if symbol=="REPLAYQA" and leg=="LO":
                reopened="20250910;110000";closed="20250911;121000"
                emit("REOPEN","O","BUY",1,reopened,"3",".50",0)
                emit("RECLOSE","C","SELL",-1,closed,"4",".30","100.20")
                ET.SubElement(trades,"Lot",dict(accountId=account,assetCategory="OPT",levelOfDetail="CLOSED_LOT",conid=trade["conid"],currency="USD",dateTime=closed,buySell="SELL",transactionID="TR-"+prefix+"-REOPEN",openDateTime=reopened,quantity="1",fifoPnlRealized="100.20",cost="300"))
    return ET.tostring(root,encoding="unicode")

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1",0));return sock.getsockname()[1]

class Run:
    def __init__(self,folder,broker):
        self.folder=folder;self.broker=broker;self.port=free_port();self.proc=None
    def start(self):
        self.proc=subprocess.Popen([ROOT/"target/debug/tws-options-lab","--port",str(self.port),"--tws-port",str(self.broker),"--data-dir",self.folder,"--no-open"],stdout=subprocess.DEVNULL)
        for _ in range(100):
            try:socket.create_connection(("127.0.0.1",self.port),.15).close();return
            except OSError: time.sleep(.06)
        raise RuntimeError("The isolated native server did not start")
    def close(self):
        if self.proc:self.proc.terminate();self.proc.wait(timeout=8);self.proc=None
    def api(self,route,data=None,rejected=False):
        conn=http.client.HTTPConnection("127.0.0.1",self.port,timeout=30)
        conn.request("GET" if data is None else "POST","/api/"+route,body=None if data is None else json.dumps(data),headers={"Content-Type":"application/json"})
        resp=conn.getresponse();value=json.loads(resp.read());conn.close()
        if rejected:assert 400<=resp.status<500 and value.get("error"),("Expected refusal",route,resp.status,value)
        else:assert resp.status==200,(route,resp.status,value)
        return value
    def upload(self,xml):return self.api("ibkr-flex",{"xml":[xml],"timezone":"America/New_York"})
    def ledger(self):return self.api("options-history")
    def edit(self,data,rejected=False):return self.api("manual-spread",data,rejected)
    def raw_records(self):
        with sqlite3.connect(self.folder/"options-history.sqlite") as db:
            return {(scope,r["id"]):r for scope,raw in db.execute("select scope,fill from executions") if (r:=json.loads(raw))["symbol"] in SYNTHETIC}
    def browser(self,phase,folder,state):
        folder.mkdir()
        inp=folder/"state.json";out=folder/"visible.json";inp.write_text(json.dumps(state))
        subprocess.run(["node",ROOT/"scripts/manual-spreads-browser.mjs",str(self.port),folder,phase,inp,out],cwd=ROOT,check=True,timeout=100)
        return json.loads(out.read_text())

def trades(d,sym):return [t for t in d["trades"] if t["symbol"]==sym]
def normal(d,sym):return sorted((t for t in trades(d,sym) if not t.get("manualGroupId")),key=lambda t:t["legs"][0]["strike"])
def selections(items):return [{"tradeId":t["id"]} for t in items]
def request(scope,items,name,action="preview",token=None):
    d={"action":action,"scope":scope,"selections":items,"name":name}
    if token:d["previewToken"]=token
    return d
def money(value):return D(str(value)).quantize(D(".01"))
def economics():
    expected=[]
    for qty,long_px,long_close_fee,short_px,short_close_fee in (
        (1,D("6"),D(".25"),D("2"),D(".35")),(2,D("5"),D(".50"),D("2.5"),D(".70"))):
        long=(long_px-D("4"))*100*qty-D(".50")*qty-long_close_fee
        short=(D("3")-short_px)*100*qty-D(".60")*qty-short_close_fee
        expected.append(long+short)
    return expected
def main():
    parser=argparse.ArgumentParser();parser.add_argument("artifact",type=pathlib.Path)
    args=parser.parse_args()
    subprocess.run(["cargo","build","--locked"],cwd=ROOT,check=True)
    binary=ROOT/"target/debug/tws-options-lab"
    with binary.open("rb") as f:binary_hash=hashlib.file_digest(f,"sha256").hexdigest()
    wire=WIRE["Fixture"](("127.0.0.1",0),WIRE["Wire"])
    a,b=WIRE["A"],WIRE["B"]
    wire.accounts=[a];wire.requests=0;wire.complete_positions=True;wire.execution_end=threading.Event();wire.execution_end.set()
    threading.Thread(target=wire.serve_forever,daemon=True).start()
    checks=[];evidence={}
    with tempfile.TemporaryDirectory(prefix="manual-spreads-e2e-") as tmp:
        tmp=pathlib.Path(tmp);run=Run(tmp/"library",wire.server_address[1])
        try:
            run.start()
            source=report_xml(a,SPECS);run.upload(source);run.upload(report_xml(b,["MANS"],alternate=True))
            initial=run.ledger()
            baseline=normal(initial,"MANS")
            assert len(baseline)==2 and all(t.get("manualEligible") and len(t["legs"])==1 for t in baseline)
            scope=baseline[0]["selectionScope"];initial_ids={t["id"] for t in baseline}
            raw=run.raw_records();amounts=economics();whole=sum(amounts)
            assert sum(money(t["netRealizedPnl"]) for t in baseline)==whole
            checks.append("Separate broker orders appeared as two distinct closed source trades.")
            state={"sourceIds":[t["id"] for t in baseline],"whole":float(whole),"name":"Desk vertical","symbol":"MANS"}
            evidence["browserCreate"]=run.browser("create",tmp/"first-browser",state)
            saved=run.ledger();groups=[t for t in trades(saved,"MANS") if t.get("manualGroupId")]
            assert len(groups)==1 and len(trades(saved,"MANS"))==1
            group=groups[0];ident=group["manualGroupId"]
            assert money(group["netRealizedPnl"])==whole and money(group["brokerRealizedPnl"])==whole+D("4")

            assert {f["id"] for f in group["fills"]}=={f["id"] for t in baseline for f in t["fills"]}
            assert run.raw_records()==raw
            assert saved["tradeSummary"]["byCurrency"]==initial["tradeSummary"]["byCurrency"]
            checks.append("Browser selection, preview and save combined all six actual fills. Both entry and exit fees were counted once.")
            run.upload(source);run.close();run.start()
            restarted=run.ledger()
            assert any(t.get("manualGroupId")==ident and money(t["netRealizedPnl"])==whole for t in trades(restarted,"MANS"))
            assert run.raw_records()==raw
            checks.append("Group and raw economics survived native reimport and process restart.")
            wire.accounts=[b]
            switched=run.ledger();foreign=normal(switched,"MANS")
            assert len(foreign)==2 and all(t["selectionScope"]!=scope for t in foreign)
            assert not any(t.get("manualGroupId")==ident for t in switched["trades"])
            run.edit({"action":"ungroup","scope":scope,"id":ident},rejected=True)
            checks.append("Another authenticated account with reused execution IDs could neither see nor remove the saved spread.")
            wire.accounts=[a]
            evidence["browserUndo"]=run.browser("undo",tmp/"next-browser",{**state,"manualId":ident})
            restored=run.ledger()
            assert {t["id"] for t in normal(restored,"MANS")}==initial_ids and run.raw_records()==raw
            checks.append("Browser ungroup restored the original episode IDs and preserved every broker row.")
            baseline=normal(restored,"MANS");scope=baseline[0]["selectionScope"]
            first=[{"tradeId":t["id"],"fillId":next(f["id"] for f in t["fills"] if "CLOSE1" in f["id"]),"role":"close"} for t in baseline]
            body=request(scope,first,"One-lot vertical")
            p=run.edit(body);assert money(p["trade"]["netRealizedPnl"])==amounts[0]
            assert all(money(x["openedQty"])==1 and money(x["closedQty"])==1 and not x["wholeTrade"] for x in p["selectionSummary"])
            save=request(scope,first,"One-lot vertical","save",p["previewToken"])
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
                one,duplicate=list(workers.map(run.edit,(save,save)))
            assert one["id"]==duplicate["id"]
            remain=run.ledger()
            slices=trades(remain,"MANS")
            assert len(slices)==3 and sum(money(t["netRealizedPnl"]) for t in slices)==whole
            assert remain["tradeSummary"]["byCurrency"]==initial["tradeSummary"]["byCurrency"] and run.raw_records()==raw
            run.edit(request(scope,first,"Second overlapping group"),rejected=True)
            checks.append("A balanced one-lot selection apportioned commissions, left two residual source positions, and refused an overlapping second group.")
            run.edit({"action":"ungroup","scope":scope,"id":one["id"]})
            active=run.ledger();no_fee=normal(active,"NOFEE")
            missing=run.edit(request(scope,selections(no_fee),"Unpriced vertical"))
            assert missing["trade"]["netRealizedPnl"] is None and missing["trade"]["pnlReason"]
            assert money(missing["trade"]["brokerRealizedPnl"])!=0
            run.edit(request(scope,selections([baseline[0],no_fee[1]]),"Mixed underlying"),rejected=True)
            run.edit(request(scope,selections([baseline[0]]),"One contract"),rejected=True)
            checks.append("Missing commission remained unpriced. Invalid single-contract and cross-underlying spreads were refused.")
            rolled=normal(active,"ROLLQA")
            chronology=run.edit(request(scope,selections(rolled),"Sequential roll"))
            assert chronology["trade"]["chronologyNote"] and money(chronology["trade"]["netRealizedPnl"])==whole
            checks.append("User-selected sequential trade periods previewed at their actual return with a chronology note.")
            replay=normal(active,"REPLAYQA")
            assert len(replay)==3
            same_contract=[t for t in replay if t["legs"][0]["conId"]==SPECS["REPLAYQA"]+1]
            assert len(same_contract)==2
            run.edit(request(scope,selections(same_contract),"One contract twice"),rejected=True)
            replay_body=request(scope,selections(replay),"Reopened spread")
            replay_preview=run.edit(replay_body)
            assert replay_preview["sourceTradeCount"]==3 and len(replay_preview["trade"]["legs"])==2
            assert money(replay_preview["trade"]["netRealizedPnl"])==whole+D("99.20")
            repeated_leg=next(l for l in replay_preview["trade"]["legs"] if l["conId"]==SPECS["REPLAYQA"]+1)
            assert repeated_leg["openedQty"]==4 and repeated_leg["closedQty"]==4
            repeated=run.edit({**replay_body,"action":"save","previewToken":replay_preview["previewToken"]})
            assert len(trades(run.ledger(),"REPLAYQA"))==1 and run.raw_records()==raw
            run.edit({"action":"ungroup","scope":scope,"id":repeated["id"]})
            assert len(normal(run.ledger(),"REPLAYQA"))==3
            checks.append("Two separately closed episodes of one strike grouped with another strike at their exact combined net. Ungroup restored all three source episodes.")
            unproven=normal(active,"UNPROVEN")
            unproven_ids={t["id"] for t in unproven}
            open_episode=next(t for t in unproven if any(f["id"]=="UNPROVEN-LO-LEG-A.01" for f in t["fills"]))
            orphan_close=next(t for t in unproven if any(f["id"]=="UNPROVEN-LO-COMBINED.01" for f in t["fills"]))
            eligible_short=next(t for t in unproven if t["manualEligible"])
            assert len(unproven_ids)==3 and not open_episode["manualEligible"] and not orphan_close["manualEligible"]
            uncertain=run.edit(request(scope,[
                {"tradeId":open_episode["id"],"fillId":"UNPROVEN-LO-LEG-A.01","role":"open"},
                {"tradeId":eligible_short["id"]}],"Unconfirmed lot split"),rejected=True)
            assert any(term in uncertain["error"].lower() for term in ("lot","allocat","available","eligible","complete single-contract"))
            assert {t["id"] for t in normal(run.ledger(),"UNPROVEN")}==unproven_ids and run.raw_records()==raw
            checks.append("A partial closing quantity lacking broker lot attribution was refused; both original positions and all executions remained intact.")
            stale=normal(active,"CHANGE");proposal=request(scope,selections(stale),"Revision check")
            preview=run.edit(proposal)
            previous=run.edit(request(scope,selections(stale),"Revision check","save",preview["previewToken"]))
            run.upload(report_xml(a,["CHANGE"],correction=True))
            revised=run.ledger()
            assert any(m["id"]==previous["id"] and m["status"]=="needsReview" for m in revised["manualGroups"])
            assert not any(t.get("manualGroupId") for t in trades(revised,"CHANGE"))
            run.edit({"action":"ungroup","scope":scope,"id":previous["id"]})
            run.edit(request(scope,selections(stale),"Revision check","save",preview["previewToken"]),rejected=True)
            assert not any(t.get("manualGroupId") for t in trades(run.ledger(),"CHANGE"))
            fresh=normal(run.ledger(),"CHANGE")
            assert sum(money(t["netRealizedPnl"]) for t in fresh)==whole+D("10")
            checks.append("A broker revision invalidated the old preview. The corrected execution remained available at its actual price.")
            screenshot=tmp/"first-browser/preview.png"
            shot=args.artifact.with_name(args.artifact.stem+"-preview.png")
            shot.parent.mkdir(parents=True,exist_ok=True);shot.write_bytes(screenshot.read_bytes())
            evidence["previewScreenshot"]={"file":shot.name,"sha256":hashlib.sha256(shot.read_bytes()).hexdigest()}
            evidence.update(wholeNet=float(whole),oneLotNet=float(amounts[0]),residualNet=float(amounts[1]),distinctBrokerFills=len(group["fills"]),missingCommissionNet=None,distinctAccounts=2)
        finally:run.close();wire.shutdown();wire.server_close()
    files=("src/main.rs","src/options_history.rs","src/options_history/manual.rs","src/options_history/trades.rs","web/index.html","web/options-history.css","web/options-history.js","web/history-grouping.js","scripts/browser-fixture.mjs","scripts/verify-options-ledger.py","scripts/verify-manual-spreads.py","scripts/manual-spreads-browser.mjs")
    args.artifact.parent.mkdir(parents=True,exist_ok=True)
    args.artifact.write_text(json.dumps({"testedBinarySha256":binary_hash,"fixture":"Native Rust HTTP with isolated SQLite, loopback TWS protocol responder and headless Chrome","checks":checks,"results":evidence,"sources":{f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files}},indent=2)+"\n")
    print(f"{len(checks)} end-to-end manual spread scenarios passed. {args.artifact}")
if __name__=="__main__":main()
