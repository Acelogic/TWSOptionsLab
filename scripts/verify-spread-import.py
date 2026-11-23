#!/usr/bin/env python3
"""Compare the native ledger with generated Activity Flex reports or local user-supplied statements.

Check that order grouping, a closing lot's cross-report opening reference, an expiration
booking, tax adjustments, and richer imported fields survive repeat and sparse imports.
The default fixture never needs a brokerage account or a saved activity report.
"""
import argparse
import collections
import datetime
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
import time
import xml.etree.ElementTree as ET
from zoneinfo import ZoneInfo

ROOT=pathlib.Path(__file__).resolve().parents[1]
D=decimal.Decimal
def timestamp(value,zone):
    return int(datetime.datetime.strptime(value,"%Y%m%d;%H%M%S").replace(tzinfo=zone).timestamp()*1000)
def post(port,route,value):
    conn=http.client.HTTPConnection("127.0.0.1",port,timeout=120)
    conn.request("POST","/api/"+route,body=json.dumps(value),headers={"Content-Type":"application/json"})
    res=conn.getresponse();data=json.loads(res.read());conn.close()
    assert res.status==200,("Native HTTP import failed",res.status,data.get("error"))
    return data
def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1",0));return s.getsockname()[1]
def observed(folder):
    with sqlite3.connect(folder/"options-history.sqlite") as db:
        sql="SELECT scope,fill FROM executions UNION ALL SELECT scope,payload FROM lifecycle_events"
        return {(scope,row["id"]):row for scope,raw in db.execute(sql) if (row:=json.loads(raw))}
def sparse_lots(xml):
    doc=ET.fromstring(xml)
    for lot in doc.findall(".//Trades/Lot"):
        for field in ("fifoPnlRealized","cost"):
            lot.attrib.pop(field,None)
    return ET.tostring(doc,encoding="unicode")
def synthetic_statements():
    make_report=runpy.run_path(str(ROOT/"scripts/verify-manual-spreads.py"))["report_xml"]
    example=make_report("FIXTURE-SPREAD-IMPORT",["MANS"])
    documents=[]
    for opening in (True,False):
        report=ET.fromstring(example)
        stmt=report.find(".//FlexStatement");trades=stmt.find("Trades")
        start,end=("20250905","20250905") if opening else ("20250908","20250919")
        stmt.attrib.update(fromDate=start,toDate=end,whenGenerated=end+";200000")
        for node in list(trades):
            if (node.get("openCloseIndicator")=="O")!=opening:
                trades.remove(node)
        if opening:
            for trade in trades:
                trade.attrib.update(brokerageOrderID="FIXTURE-SPREAD-OPEN",orderTime=start+";100000")
        else:
            first=trades.find("Trade")
            first.set("fifoPnlRealized",str(D(first.get("fifoPnlRealized"))+D("7.50")))
            booking=dict(first.attrib)
            booking.pop("ibExecID")
            booking.update(transactionType="BookTrade",notes="Ep",transactionID="FIXTURE-EXPIRY",
                           tradeID="FIXTURE-EXPIRY-TRADE",conid="31999",symbol="MANS expiry fixture",
                           dateTime=end+";162000",tradeDate=end,orderTime=end+";162000",
                           brokerageOrderID="FIXTURE-EXPIRY-ORDER",ibOrderID="FIXTURE-EXPIRY-IB",
                           quantity="-1",tradePrice="0",ibCommission="0",fifoPnlRealized="0")
            ET.SubElement(trades,"Trade",booking)
        documents.append(ET.tostring(report,encoding="unicode"))
    return documents
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--statement",type=pathlib.Path,action="append",help="Compare with an explicitly supplied local Activity Flex XML. Default: generated reports.")
    p.add_argument("--timezone",default="America/New_York")
    p.add_argument("--artifact",type=pathlib.Path,required=True)
    p.add_argument("--fixture-dir",type=pathlib.Path,help="Retain a private new fixture database for additional local replays")
    args=p.parse_args();zone=ZoneInfo(args.timezone)
    subprocess.run(["cargo","build","--locked"],cwd=ROOT,check=True)
    with (ROOT/"target/debug/tws-options-lab").open("rb") as binary:
        tested_binary=hashlib.file_digest(binary,"sha256").hexdigest()
    with tempfile.TemporaryDirectory() as tmp:
        folder=args.fixture_dir or pathlib.Path(tmp)/"db"
        folder.mkdir(mode=0o700)
        port=free_port();broker=free_port()
        proc=subprocess.Popen([ROOT/"target/debug/tws-options-lab","--data-dir",folder,"--port",str(port),"--tws-port",str(broker),"--no-open"],stdout=subprocess.DEVNULL)
        try:
            for _ in range(90):
                try: socket.create_connection(("127.0.0.1",port),.15).close();break
                except OSError: time.sleep(.06)
            scopes={};expected={};lots=collections.defaultdict(list);orders=collections.defaultdict(set);annual=[]
            documents=[file.read_text() for file in args.statement] if args.statement else synthetic_statements()
            post(port,"ibkr-flex",{"xml":[sparse_lots(documents[0])],"timezone":args.timezone})
            for xml in documents:
                post(port,"ibkr-flex",{"xml":[xml],"timezone":args.timezone})
                doc=ET.fromstring(xml)
                for st in doc.findall(".//FlexStatement"):
                    account=st.get("accountId")
                    if account not in scopes:scopes[account]=post(port,"account-scope",{"accountId":account})["accountScope"]
                    scope=scopes[account];prev=None
                    for node in st.find("Trades"):
                        a=node.attrib
                        if node.tag=="WashSale":continue
                        if node.tag=="Lot":
                            if prev and a.get("assetCategory") in ("OPT","FOP"):
                                lots[prev].append(a)
                            continue
                        prev=None
                        if node.tag!="Trade" or a.get("levelOfDetail")!="EXECUTION" or a.get("assetCategory") not in ("OPT","FOP"):continue
                        ident=a.get("ibExecID") or ("IBKR-FLEX-LIFECYCLE/"+a["transactionID"])
                        prev=(scope,ident)
                        expected[prev]=a
                        if a.get("brokerageOrderID"):orders[(scope,a["brokerageOrderID"])].add(a["conid"])
                    annual.append([st.get("fromDate"),st.get("toDate")])
            actual=observed(folder)
            assert set(expected)==set(actual), "Stored identities differ from original normalized broker transactions"
            linked=tax=0;closed=0;open_rows=0
            openings={(scope,a.get("transactionID")):a for (scope,_),a in expected.items() if a.get("openCloseIndicator")=="O"}
            for key,a in expected.items():
                scope,_=key;row=actual[key]
                side={"O":"OPEN","C":"CLOSE"}.get(a.get("openCloseIndicator"))
                assert row.get("openClose")==side
                for input,output in (("brokerageOrderID","brokerageOrderId"),("ibOrderID","ibOrderId"),("transactionID","transactionId"),("tradeID","tradeId")):
                    assert row.get(output)==(a.get(input) or None), "Broker order metadata mismatch"
                assert row.get("underlyingConId")==int(a["underlyingConid"])
                if a.get("orderTime"):assert row["orderAt"]==timestamp(a["orderTime"],zone)
                for fld,key_name in (("netCash","netCash"),("cost","costBasis"),("proceeds","proceeds")):
                    if a.get(fld): assert abs(D(str(row[key_name]))-D(a[fld])) < D(".0000001")
                if a.get("fifoPnlRealized"):
                    assert abs(D(str(row["realizedPnl"]))-D(a["fifoPnlRealized"])) < D(".0000001")
                    assert row["realizedCurrency"]==a["currency"] and row["realizedSource"]=="IBKR Flex FIFO"
                if side=="OPEN":open_rows+=1
                if side=="CLOSE":closed+=1
                raw=lots.get(key)
                if not raw:continue
                report=row.get("closedLots",[])
                assert len(report)==len(raw), "Missing broker closed-lot allocation"
                def lot_id(r):return (r["openingTransactionId"],r["openedAt"],D(str(r["qty"])),D(str(r["realizedPnl"])),D(str(r["costBasis"])))
                original=[(l["transactionID"],timestamp(l["openDateTime"],zone),abs(D(l["quantity"])),D(l["fifoPnlRealized"]),D(l["cost"])) for l in raw]
                assert sorted(map(lot_id,report))==sorted(original),"Closed-lot values or identities disagree"
                assert sum(abs(D(l["quantity"])) for l in raw)==abs(D(a["quantity"]))
                for l in raw:
                    op=openings.get((scope,l["transactionID"]))
                    if op:
                        assert op["dateTime"]==l["openDateTime"] and op["conid"]==l["conid"]
                        linked+=1
                if abs(sum(D(l["fifoPnlRealized"]) for l in raw)-D(a["fifoPnlRealized"])) > D(".005"):
                    tax+=1
            for xml in reversed(documents):
                post(port,"ibkr-flex",{"xml":[xml],"timezone":args.timezone})
            assert observed(folder)==actual,"Reimport changed official evidence"
            post(port,"ibkr-flex",{"xml":[sparse_lots(documents[-1])],"timezone":args.timezone})
            assert observed(folder)==actual,"A report without optional lot financial fields erased verified lot economics"
            # A valid sparse export can describe the same trade. Reapplying it
            # must not erase order identifiers, realized results, or closed lots.
            slim=ET.fromstring(documents[0])
            for trades in slim.findall(".//Trades"):
                for n in list(trades):
                    if n.tag=="Lot":trades.remove(n)
                    if n.tag=="Trade":
                        for k in ("fifoPnlRealized","netCash","cost","proceeds","orderTime","brokerageOrderID","ibOrderID","underlyingConid","openCloseIndicator"):n.attrib.pop(k,None)
            post(port,"ibkr-flex",{"xml":[ET.tostring(slim,encoding="unicode")],"timezone":args.timezone})
            assert observed(folder)==actual,"A thinner reimport erased richer broker evidence"
            result={"testedBinarySha256":tested_binary,"statementPeriods":sorted(annual),"executionRows":sum(not r.get("eventType") for r in actual.values()),"lifecycleRows":sum(bool(r.get("eventType")) for r in actual.values()),"openingRows":open_rows,"closingRows":closed,"closedLotRows":sum(map(len,lots.values())),"openingTransactionsVerifiedAcrossReports":linked,"multiContractBrokerageOrders":sum(len(v)>1 for v in orders.values()),"closingRowsWithTaxAdjustedLotDifferences":tax,"consistentRepeatedAndSparseImports":True,"sources":{k:hashlib.sha256((ROOT/k).read_bytes()).hexdigest() for k in ("src/flex_upload/statements.rs","src/options_history/archive.rs","src/options_history.rs","scripts/verify-spread-import.py")}}
            if not args.statement:
                assert (result["executionRows"],result["lifecycleRows"],linked,tax,result["multiContractBrokerageOrders"])==(6,1,4,1,1)
                result["sources"]["scripts/verify-manual-spreads.py"]=hashlib.sha256((ROOT/"scripts/verify-manual-spreads.py").read_bytes()).hexdigest()
            result["inputs"]="local supplied statements" if args.statement else "synthetic fixtures"
            args.artifact.parent.mkdir(parents=True,exist_ok=True);args.artifact.write_text(json.dumps(result,indent=2)+"\n")
            print(json.dumps({k:v for k,v in result.items() if k!="sources"}))
        finally:
            proc.terminate();proc.wait(timeout=8)
if __name__=="__main__":main()
