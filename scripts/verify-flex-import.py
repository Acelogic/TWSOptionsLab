#!/usr/bin/env python3
"""Replay original-shaped Activity Flex XML into a private Rust server and inspect its saved results.

Failure cases recorded up front: duplicate/foreign account identities, a signed short,
fees/rebates, options vs stock, execution corrections, a missing section, verified
flat vs a filtered report, assignment, duplicate saved contracts and both after-hours cutoffs.
The native importer must reject DTDs, guessed DST times, conflicting same-ID fills, and
client-supplied account identity or session endpoints; an invalid batch must roll back entirely.
Official BookTrade expirations, assignments and exercises need distinct transaction IDs and counts,
keep broker zero vs missing prices, and must never reconcile as exchange fills.
Frozen historical observations exercise the app's actual scope selection and P&L engine.
"""
import datetime as dt
import json
import hashlib
import os
import runpy
import shutil
import threading
import urllib.error
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

project=Path(__file__).resolve().parents[1]
artifact=Path(sys.argv[1])
account="FIXTURE-FLEX-MAIN"
dates=["20261119","20261120"]
when=["2026-11-19","2026-11-20"]
cutoffs=[int(dt.datetime.fromisoformat(d+"T21:00:00+00:00").timestamp()*1000) for d in when]
def xml(d,activity,holdings,action=None,omit=None):
    root=ET.Element("FlexQueryResponse",type="AF")
    header=ET.SubElement(root,"FlexStatements",count="1")
    report=ET.SubElement(header,"FlexStatement",accountId=account,fromDate=d,toDate=d,whenGenerated="20261122;183745",period="LastBusinessDay")
    trades=ET.SubElement(report,"Trades")
    for tr in activity:
        ET.SubElement(trades,"Trade",**tr)
    positions=ET.SubElement(report,"OpenPositions")
    for conid,qty,side in holdings:
        ET.SubElement(positions,"OpenPosition",accountId=account,assetCategory="OPT",side=side,position=qty,
            reportDate=d,multiplier="100",currency="USD",conid=str(conid),levelOfDetail="SUMMARY")
    for name in ["OptionEAE","Transfers","TradeTransfers","CorporateActions","TransactionTaxes"]:
        if name==omit:continue
        section=ET.SubElement(report,name)
        if name=="OptionEAE" and action is not None:ET.SubElement(section,"OptionEAE",conid=str(action),transactionType="Assignment")
    return ET.tostring(root,encoding="unicode")
def trade(conid,id,side,quantity,price,fee,**extra):
    obj=dict(accountId=account,assetCategory="OPT",levelOfDetail="EXECUTION",transactionType="ExchTrade",
      conid=str(conid),symbol="SYN   261218C00001000",underlyingSymbol="SYN",currency="USD",expiry="20261218",
      putCall="C",strike="1",dateTime="20261120;103015",tradePrice=price,ibExecID=id,ibCommission=fee,
      ibCommissionCurrency="USD",multiplier="100",buySell=side,quantity=quantity,taxes="0")
    return {**obj,**extra}
def api(port,route,payload=None):
    req=urllib.request.Request(f"http://127.0.0.1:{port}/api/{route}",data=None if payload is None else json.dumps(payload).encode(),headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req,timeout=30) as r:return json.load(r)
def importer(port,files,extras,expect=True):
    cli=[sys.executable,str(project/"scripts/import-ibkr-flex.py"),"--base-url",f"http://127.0.0.1:{port}","--timezone","America/New_York","--stdin-json",*extras]
    r=subprocess.run(cli,input=json.dumps(files),capture_output=True,text=True,timeout=90)
    assert account not in r.stdout+r.stderr,(r.stdout,r.stderr)
    out=json.loads(r.stdout)
    assert bool(r.returncode==0)==expect,out
    return out

def verified_server(folder):
    # The private build injects only the exchange calendar, clock and observed prices.
    # Flex parsing, identity handshakes, cutoff selection, daily returns and both SQLite stores are production Rust.
    private=folder/"crate"
    shutil.copytree(project/"src",private/"src")
    shutil.copy(project/"Cargo.lock",private/"Cargo.lock")
    binary="flex-import-verification"
    (private/"Cargo.toml").write_text((project/"Cargo.toml").read_text()+f'\n[[bin]]\nname = "{binary}"\npath = "src/main.rs"\n')
    p=private/"src/snapshots.rs"
    head="pub(crate) async fn response(app: &Shared, mode: u8) -> Result<Value> {"
    raw=p.read_text(); assert raw.count(head)==1
    inject='''
    if let Some(file) = std::env::var_os("FLEX_MARKET_FIXTURE") {
        let (saved, scope_state, _) = scoped_saved(app, mode).await?;
        let mut cases:Value=serde_json::from_reader(std::fs::File::open(file)?)?;
        cases["friday"]["trades"]=json!(saved);
        let mut friday=session_values(serde_json::to_vec(&cases)?.as_slice())?["friday"].take();
        friday["brokerAccount"]=json!({"status":scope_state});
        return Ok(friday);
    }
'''
    p.write_text(raw.replace(head,head+inject)+'\n'+(project/"scripts/saved-session-adapter.rs").read_text())
    target=project/"target"
    subprocess.run(["cargo","build","--locked","--quiet","--manifest-path",str(private/"Cargo.toml"),"--target-dir",str(target),"--bin",binary],check=True)
    return target/"debug"/binary

def market_inputs(conids):
    now=int(dt.datetime.fromisoformat("2026-11-22T17:00:00+00:00").timestamp()*1000)
    items=[];observed=[]
    for cid in sorted(set(conids)):
        items.append({"conId":cid,"listing":{"secType":"OPT","zone":"America/New_York","currency":"USD",
            "usEquitySession":True,"sessions":[[end-23400000,end] for end in cutoffs],
            "closedSessionDates":["2026-11-21","2026-11-22"]},"quote":{"feed":"Frozen","bid":9,"ask":10,"mid":9.5,"at":now}})
        for side,prices in [("BID",(4,6)),("ASK",(5,8)),("MIDPOINT",(4.5,7))]:
            for end,price in zip(cutoffs,prices):
                observed.append({"conId":cid,"side":side,"end":end,"at":end,"price":price})
    return {"friday":{"now":now,"items":items,"history":observed}}

with tempfile.TemporaryDirectory(prefix="tws-flex-e2e-") as temp:
    folder=Path(temp)
    subprocess.run(["cargo","build","--locked","--quiet"],cwd=project,check=True)
    with socket.socket() as s:s.bind(("127.0.0.1",0));port=s.getsockname()[1]
    binary=verified_server(folder)
    wire_fixture=runpy.run_path(str(project/"scripts/verify-options-ledger.py"))
    wire=wire_fixture["Fixture"](("127.0.0.1",0),wire_fixture["Wire"])
    wire.accounts,wire.requests,wire.complete_positions=[account],0,True
    threading.Thread(target=wire.serve_forever,daemon=True).start()
    market=folder/"market.json"
    server=subprocess.Popen([binary,"--port",str(port),"--data-dir",str(folder),"--no-open","--tws-port",str(wire.server_address[1])],env={**os.environ,"PATH":str(folder/"no-subprocess-runtime"),"FLEX_MARKET_FIXTURE":str(market)},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for n in range(60):
            try: api(port,"library");break
            except OSError:
                if n==59:raise
                time.sleep(.1)
        snapshots={"rows":{}}
        names=["sized","absent","assignment","after-hours","shared-a","shared-b","unbalanced","short"]
        conids=[8101,8102,8103,8104,8105,8105,8106,8107]
        market.write_text(json.dumps(market_inputs(conids)))
        for name,conid in zip(names,conids):
            leg=dict(kind="option",root="SYN",symbol="SYN",right="C",expiry="20261218",conId=conid,qty=100,strike=1,multiplier=100,entry=5,currency="USD")
            initial=api(port,"save",{"name":name,"document":{"schema":1,"symbol":"SYN","currency":"USD","legs":[leg],"pricing":"natural"}})
            snapshots["rows"][initial["id"]]={"version":initial["version"],"currency":"USD","dayPeriod":{"mode":"closed","date":when[1],"priorDate":when[0]},"legs":[
                {"conId":conid,"timeZone":"America/New_York","dayPrior":{"date":when[0],"sessionEnd":cutoffs[0]},"dayCurrent":{"date":when[1],"sessionEnd":cutoffs[1]}}]}
        snapshot=folder/"session.json";snapshot.write_text(json.dumps(snapshots))
        confirm=["--verify-saved",when[1],"--confirm-unfiltered","--snapshot-file",str(snapshot)]
        holdings=[(8101,"2","Long"),(8103,"1","Long"),(8104,"1","Long"),(8105,"1","Long"),(8106,"1","Long"),(8107,"2","Short")]
        old=xml(dates[0],[],holdings)
        latest=[(8101,"3","Long"),(8103,"1","Long"),(8104,"2","Long"),(8105,"1","Long"),(8106,"3","Long"),(8107,"1","Short")]
        records=[trade(8101,"flex-example.01.01","BUY","2","5","-0.75"),trade(8101,"flex-example.02.01","SELL","-1","6.5","0.1"),
             trade(8104,"flex-example.03.01","BUY","1","8","-1",dateTime="20261120;163000"),
             trade(8107,"flex-example.04.01","BUY","1","8","-1"),
             trade(8180,"flex-example.05.01","BUY","1","10","-1",assetCategory="FOP",underlyingSymbol="ES",multiplier="50"),
             trade(8200,"flex-example.06.01","BUY","1","1","-1",assetCategory="STK",multiplier="1")]
        new=xml(dates[1],records,latest,action=8103)
        for missing in ("OptionEAE","Transfers"):
            dry=importer(port,[old,xml(dates[1],records,latest,omit=missing)],confirm+["--dry-run"])
            assert dry["verifiedStrategies"]==0,dry
        bad=importer(port,[old,new],["--verify-saved",when[1],"--snapshot-file",str(snapshot)],False)
        assert "unfiltered" in bad["error"]
        bad=importer(port,[old,new.replace('levelOfDetail="EXECUTION"','levelOfDetail="SUMMARY"')],["--dry-run"],False)
        assert "execut" in bad["error"].lower()
        dry=importer(port,[old,new],confirm+["--dry-run"])
        assert dry["verifiedStrategies"]==3,dry
        before=api(port,"library")
        def upload(files,verify=False,**extra):
            value=api(port,"ibkr-flex",{"xml":files,"timezone":"America/New_York",
                         "verifySaved":when[1] if verify else None,"confirmUnfiltered":verify,**extra})
            assert account not in json.dumps(value)
            return value
        def rejected(files,**extra):
            try: upload(files,**extra)
            except urllib.error.HTTPError as e:
                assert 400<=e.code<500
                body=e.read()
                assert account.encode() not in body and b"<FlexQueryResponse" not in body
                return
            raise AssertionError("Invalid Flex upload succeeded")
        rejected([old,new],verifySaved=when[1])
        rejected([old],accountScope="f"*64)
        rejected([old],snapshots=snapshots)
        rejected(["<!DOCTYPE FlexQueryResponse>"+old])
        rejected([old,new.replace("20261120;103015","20261101;013000")])
        rejected([new,new.replace('tradePrice="5"','tradePrice="5.5"',1)])
        rejected([new.replace('transactionType="ExchTrade"','transactionType="Bust"',1)])
        rejected([old,new.replace('currency="USD"','currency="AAAAX"',1)])
        archive=sqlite3.connect(folder/"options-history.sqlite")
        assert archive.execute("SELECT count(*) FROM executions").fetchone()[0]==0
        archive.close()
        uploaded=upload([old,new])
        assert uploaded["ok"] and uploaded["executions"]==5 and uploaded["verifiedStrategies"]==0,uploaded
        # Ownership is evaluated on the native server using actual valuation cutoffs.
        for missing in ("OptionEAE","Transfers"):
            partial=upload([old,xml(dates[1],records,latest,omit=missing)],verify=True)
            assert partial["verifiedStrategies"]==0,partial
        outcome=upload([old,new],verify=True)
        repeat=importer(port,[old,new],["--verify-saved",when[1],"--confirm-unfiltered"])
        assert set((r["name"],r["reason"]) for r in outcome["skippedStrategies"])==set((r["name"],r["reason"]) for r in dry["skippedStrategies"])
        by_name={item["name"]:item["id"] for item in before}
        valuation=api(port,"saved-snapshots?mode=1")
        assert valuation["brokerAccount"]["status"]=="current",valuation["brokerAccount"]
        verified={k:valuation["rows"][by_name[k]] for k in ("sized","absent","short")}
        for name,qty in {"sized":649.35,"absent":0,"short":-601}.items():
            v=verified[name]
            assert v["dayPeriod"]["attribution"]=="broker" and v["dayPeriod"]["verified"]
            assert abs(v["dayPnl"]-qty)<1e-7,(name,v["dayPnl"])
        wire.accounts=["FIXTURE-FLEX-OTHER"]
        other=api(port,"saved-snapshots?mode=1")["rows"][by_name["sized"]]
        assert other["dayPeriod"].get("verified") is not True and other.get("brokerDayPnl") is None
        wire.accounts=[account]
        assert outcome["executions"]==5 and outcome["verifiedStrategies"]==3 and repeat["verifiedStrategies"]==3,outcome
        assert api(port,"library")==before
        ledger=sqlite3.connect(folder/"library.sqlite")
        saved={a:json.loads(b) for a,b in ledger.execute("SELECT name,payload FROM account_sessions JOIN strategies ON strategy_id=id")}
        assert set(saved)=={"sized","short","absent"},saved.keys()
        sized=saved["sized"]["legs"][0]; short=saved["short"]["legs"][0];flat=saved["absent"]["legs"][0]
        assert (sized["priorQty"],sized["endQty"])==(2,3)
        assert [(f["qty"],f["commission"]) for f in sized["fills"]]==[(2,.75),(-1,-.1)]
        assert (short["priorQty"],short["endQty"])==(-2,-1)
        assert (flat["priorQty"],flat["endQty"],flat["fills"])==(0,0,[])
        expected={x["name"] for x in outcome["skippedStrategies"]};assert expected=={"assignment","after-hours","shared-a","shared-b","unbalanced"}
        archive=sqlite3.connect(folder/"options-history.sqlite")
        stored=[json.loads(row[0]) for row in archive.execute("SELECT fill FROM executions")]
        assert len(stored)==5 and {x["secType"] for x in stored}=={"OPT","FOP"}
        assert {row[0] for row in archive.execute("SELECT scope FROM executions")}=={saved["short"]["accountScope"]}
        second=new.replace(account,"FIXTURE-FLEX-OTHER")
        multi=importer(port,[old,new,second],["--dry-run"])
        assert (multi["accounts"],multi["executions"])==(2,10)
        multi_native=upload([old,new,second],verify=True)
        assert multi_native["executions"]==10 and multi_native["verifiedStrategies"]==0 and any("multiple accounts" in w for w in multi_native["warnings"])
        assert not ledger.execute("SELECT count(*) FROM account_sessions WHERE account_scope <> ?",(saved["sized"]["accountScope"],)).fetchone()[0]
        correction=trade(8180,"flex-example.05.02","BUY","1","11","-1",assetCategory="FOP",underlyingSymbol="ES",multiplier="50")
        updated=importer(port,[xml(dates[1],[correction],[])],[])
        stored=[json.loads(row[0]) for row in archive.execute("SELECT fill FROM executions WHERE scope=?",(saved["short"]["accountScope"],))]
        es=next(fill for fill in stored if fill["secType"]=="FOP")
        assert len(stored)==5 and es["price"]==11 and es["id"].endswith(".02")
        prior_fill=trade(8101,"prior-late.01.01","BUY","1","4","-1",dateTime="20261119;161000")
        late_account="FIXTURE-FLEX-LATE"
        prior_late=upload([xml(dates[0],[prior_fill],holdings).replace(account,late_account),new.replace(account,late_account)],verify=True)
        assert any(r["name"]=="sized" and "After-close" in r["reason"] for r in prior_late["skippedStrategies"])
        lifecycle_account="FIXTURE-FLEX-EVENT"
        def booking(cid,code,tid,qty,reported_price,fee):
            return trade(cid,"","BUY",qty,reported_price,fee,transactionType="BookTrade",notes=code,
                transactionID=tid,tradeID="0000-irrelevant",dateTime="20261120;162000",openCloseIndicator="C")
        option_bookings=[booking(8101,"Ep","740100","1","0","0"),booking(8104,"A","740101","1","",""),
            booking(8103,"C;Ex","740102","2","1.25","-0.25"),booking(8106,"GEA","740103","1","","")]
        def for_lifecycle(raw):return raw.replace(account,lifecycle_account)
        activity_reports=[for_lifecycle(old),for_lifecycle(xml(dates[1],records+option_bookings,latest))]
        recorded=upload(activity_reports,verify=True)
        assert (recorded["executions"],recorded["lifecycleEvents"])==(5,3) and recorded["warnings"],recorded
        assert any(r["name"]=="sized" and "lifecycle" in r["reason"] for r in recorded["skippedStrategies"]),recorded
        dry_activity=importer(port,activity_reports,["--dry-run"])
        assert (dry_activity["executions"],dry_activity["lifecycleEvents"])==(5,3)
        upload(activity_reports)
        wire.accounts=[lifecycle_account]
        ledger_view=api(port,"options-history")
        assert ledger_view["executionCount"]==5 and ledger_view["lifecycleCount"]==3,ledger_view
        events={r["eventType"]:r for r in ledger_view["rows"] if r.get("eventType")}
        assert set(events)=={"expiration","assignment","exercise"}
        assert len({r["id"] for r in events.values()})==3 and events["expiration"]["id"]=="IBKR-FLEX-LIFECYCLE/740100"
        assert (events["expiration"]["qty"],events["expiration"]["side"],events["expiration"]["price"],events["expiration"]["commission"])==(1,"BUY",0,0)
        assert events["assignment"]["price"] is None and events["assignment"]["commission"] is None
        assert (events["exercise"]["qty"],events["exercise"]["price"],events["exercise"]["commission"])==(2,1.25,0.25)
        assert archive.execute("SELECT count(*) FROM executions WHERE fill LIKE '%IBKR-FLEX-LIFECYCLE/%'").fetchone()[0]==0
        different=booking(8101,"Ep","740100","2","0","0")
        rejected([for_lifecycle(xml(dates[1],[different],[]))])
        rejected([xml(dates[1],[trade(8180,"","BUY","1","1","-1",transactionID="740105")],[])])
        wire.accounts=[account]
        ledger.close();archive.close()
        for p in folder.glob("*.sqlite*"):
            raw=p.read_bytes()
            assert account.encode() not in raw and late_account.encode() not in raw and lifecycle_account.encode() not in raw and b"<FlexQueryResponse" not in raw
        report={"passed":True,"source":"Synthetic IBKR Activity Flex XML + isolated Rust import, real HTTP and SQLite",
                "historyExecutions":len(stored),"verifiedRows":sorted(saved),"skipped":outcome["skippedStrategies"],
                "signedAccountHoldings":[short["priorQty"],short["endQty"]],"sizedFillFees":[f["commission"] for f in sized["fills"]],
                "nativeLifecycleTypes":sorted(events),"scopedLifecycleCount":3,"scopedExecutionCount":ledger_view["executionCount"],"reportedZeroAndAbsentPriceDistinct":True,"unknownLifecycleWithheld":True,"lifecycleFeesCannotEnterReturns":True,"webUploadUsesNativeRust":True,"ordinaryCliUsesNativeRust":True,"completeInvalidBatchRolledBack":True,
                "brokerReturn":{k:round(v["dayPnl"],2) for k,v in verified.items()},"privateAccountSwitchWithheld":True,
                "priorAfterHoursWithheld":True,"comparisonWithPrivatePythonDryRun":True,"optionalCliStdinExercised":True,"nativeServerExecutablePathEmpty":True,"multiAccountOwnershipWithheld":True,"reimportIdempotent":True,"revisionReplaced":True,"privateAccountScopeConsistent":True,"rawAccountStored":False}
        report["sources"]={name:hashlib.sha256((project/name).read_bytes()).hexdigest() for name in (
            "src/flex_upload.rs","src/flex_upload/statements.rs","src/flex_upload/reconcile.rs","scripts/import-ibkr-flex.py",
            "scripts/verify-flex-import.py","scripts/saved-session-adapter.rs")}
        report["repeatCommand"]="python3 scripts/verify-flex-import.py /path/to/verification.json"
        artifact.parent.mkdir(parents=True,exist_ok=True);artifact.write_text(json.dumps(report,indent=2)+"\n");print(f"Verified and wrote {artifact}")
    finally:
        server.terminate(); server.wait(timeout=10);wire.shutdown();wire.server_close()
