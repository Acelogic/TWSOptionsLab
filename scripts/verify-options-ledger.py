#!/usr/bin/env python3
"""Run the native HTTP server against an isolated execution/position wire fixture."""
import argparse
import datetime as dt
import hashlib
import http.client
import json
import pathlib
import socket
import socketserver
import struct
import subprocess
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
DAY = dt.date.today() - dt.timedelta(days=3)
STAMP = DAY.strftime("%Y%m%d") + " 15:21:17 UTC"
AT = int(dt.datetime.combine(DAY, dt.time(15, 21, 17), tzinfo=dt.timezone.utc).timestamp()*1000)
A, B = "FixtureA", "FixtureB"
OPEN = (DAY+dt.timedelta(days=70)).strftime("%Y%m%d")
EXPIRED = (DAY-dt.timedelta(days=1)).strftime("%Y%m%d")

def varint(n):
    result = bytearray()
    while n > 127:
        result.append((n & 127) | 128)
        n >>= 7
    result.append(n)
    return bytes(result)

def fields(*values):
    result = bytearray()
    for index, val in values:
        if isinstance(val, int):
            result += varint(index*8) + varint(val)
        elif isinstance(val, float):
            result += varint(index*8+1) + struct.pack("<d", val)
        else:
            data = val.encode() if isinstance(val, str) else val
            result += varint(index*8+2) + varint(len(data)) + data
    return bytes(result)

def first_varint(data):
    value = shift = 0
    for idx,byte in enumerate(data):
        value |= (byte & 127) << shift
        if byte < 128:
            return value, idx+1
        shift += 7
    raise ValueError("Incomplete request identifier")

def wire_contract(conid, expiry):
    return fields((1,conid),(2,"TST"),(3,"OPT"),(4,expiry),(5,100.),(6,"C"),(7,100.),(8,"SMART"),(10,"USD"),(11,"TST CALL"),(21,expiry))

class Wire(socketserver.StreamRequestHandler):
    def packet(self, payload):
        self.wfile.write(struct.pack(">I",len(payload)) + payload)
    def send(self, message, *values):
        self.packet(struct.pack(">I", message+200) + fields(*values))
    def read(self):
        size = self.rfile.read(4)
        if not size:
            return None
        return self.rfile.read(struct.unpack(">I",size)[0])
    def accounts(self):
        self.send(15,(1,",".join(self.server.accounts)))
    def handle(self):
        self.request.settimeout(95)
        if self.rfile.read(4) != b"API\x00":
            return
        version = self.read().decode().split("..")[-1].split()[0].strip("\x00")
        self.packet(version.encode()+b"\x00"+STAMP.encode()+b"\x00")
        while (frame := self.read()):
            code = int.from_bytes(frame[:4],"big")-200
            if code == 71:
                self.accounts()
                self.send(9,(1,100))
            elif code == 17:
                self.accounts()
            elif code == 7:
                req, _ = first_varint(frame[5:])
                assert fields((8,7)) in frame, "Application omitted seven-day request"
                self.server.requests += 1
                # Parent combination names its actual legs. A fill sharing its
                # permanent ID but absent from that list must stay ungrouped.
                bag=fields((1,900),(2,"TST"),(3,"BAG"),(8,"SMART"),(10,"USD"),
                           (20,fields((1,10),(2,1),(3,"BUY"),(4,"SMART"))),
                           (20,fields((1,11),(2,1),(3,"SELL"),(4,"SMART"))))
                parent=fields((1,901),(2,"tst.bag.01"),(3,STAMP),(4,A),(6,"BOT"),(7,"1"),(8,1.),(9,9011))
                self.send(11,(1,req),(2,bag),(3,parent))
                for owner,cid,id_,expiry,price in [(A,10,"tst.a.01",OPEN,3.), (A,10,"tst.part.01",OPEN,2.5), (A,11,"tst.flat.01",OPEN,2.), (A,12,"tst.old.01",EXPIRED,1.), (B,55,"tst.a.01",OPEN,77.)]:
                    exe = fields((1,901),(2,id_),(3,STAMP),(4,owner),(5,"SMART"),(6,"BOT"),(7,"1"),(8,price),(9,9011))
                    self.send(11,(1,req),(2,wire_contract(cid,expiry)),(3,exe))
                    if id_=="tst.a.01" and owner==B:
                        self.send(59,(1,id_),(2,11.5),(3,"USD"))
                    if id_=="tst.part.01":
                        self.send(59,(1,id_),(2,1.26),(3,"USD"),(4,8.45))
                self.server.execution_end.wait(10)
                self.send(55,(1,req))
            elif code == 61:
                self.send(61,(1,A),(2,wire_contract(10,OPEN)),(3,"2"),(4,250.))
                if self.server.complete_positions:
                    self.send(62)

class Fixture(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    def handle_error(self,request,address):
        # Restarting the fixture client closes its transport at arbitrary boundaries.
        pass

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--artifact",type=pathlib.Path,required=True)
    args=parser.parse_args()
    subprocess.run(["cargo","build","--locked"],cwd=ROOT,check=True)
    with (ROOT/"target/debug/tws-options-lab").open("rb") as binary:
        tested_binary=hashlib.file_digest(binary,"sha256").hexdigest()
    server=Fixture(("127.0.0.1",0),Wire)
    server.accounts,server.requests,server.complete_positions=[A],0,True
    server.execution_end=threading.Event();server.execution_end.set()
    threading.Thread(target=server.serve_forever,daemon=True).start()
    tests=[]
    with tempfile.TemporaryDirectory() as folder:
        transient = socket.socket()
        transient.bind(("127.0.0.1",0))
        webport = transient.getsockname()[1]
        transient.close()
        def launch():
            proc=subprocess.Popen([ROOT/"target/debug/tws-options-lab","--no-open","--port",str(webport),"--tws-port",str(server.server_address[1]),"--data-dir",folder],stdout=subprocess.DEVNULL)
            for _ in range(80):
                try:
                    conn=socket.create_connection(("127.0.0.1",webport),timeout=.1);conn.close();break
                except OSError:
                    time.sleep(.05)
            return proc
        def call(name,data=None,expected=200):
            conn=http.client.HTTPConnection("127.0.0.1",webport,timeout=35)
            conn.request("GET" if data is None else "POST","/api/"+name,body=None if data is None else json.dumps(data),headers={"Content-Type":"application/json"})
            response=conn.getresponse()
            value=json.loads(response.read());conn.close()
            assert response.status==expected,(response.status,value)
            return value
        def load():
            return call("options-history")
        def add(owner,rows):
            return {"source":"IBKR Flex","accounts":[{"accountId":owner,"from":AT-1000,"to":AT+1000,"executions":rows}]}
        def note(label):
            tests.append(label)
        proc=launch()
        try:
            a=call("account-scope",{"accountId":A});b=call("account-scope",{"accountId":B})
            assert len(a["accountScope"])==64 and a!=b
            note("Local aliases distinguish fixture accounts")
            batch=load()
            assert batch["status"]=="ok" and batch["accountVerified"] and len(batch["rows"])==4,(batch,server.requests)
            rows={r["id"]:r for r in batch["rows"]}
            assert rows["tst.a.01"]["at"]==AT and rows["tst.a.01"]["price"]==3 and rows["tst.a.01"]["positionStatus"]=="open"
            assert rows["tst.a.01"]["comboId"]==rows["tst.flat.01"]["comboId"]=="TWS-PERM/9011" and not rows["tst.old.01"].get("comboId")
            assert rows["tst.part.01"]["realizedPnl"]==8.45 and rows["tst.part.01"]["realizedSource"]=="TWS commission report"
            assert rows["tst.part.01"]["realizedCurrency"]=="USD" and not rows["tst.part.01"].get("openClose")
            assert rows["tst.a.01"]["commission"] is None
            assert rows["tst.part.01"]["commission"]==1.26 and rows["tst.flat.01"]["commission"] is None
            assert rows["tst.flat.01"]["positionStatus"]=="closed" and rows["tst.old.01"]["positionStatus"]=="expired"
            assert all(row["matchStatus"]=="unmatched" for row in batch["rows"]) and batch["coverage"]["complete"] is False
            note("Seven-day native execution subscription, partial fills, exact fee join, time conversion, complete inventory and expiry")
            assert load()["rows"]==batch["rows"] and server.requests==1
            note("Adjacent readers share a broker snapshot")
            # The native history response also contains UI and account-scope metadata.
            # The statement fixture supplies only fields that a broker report owns.
            statement_fields={"id","at","conId","symbol","localSymbol","secType","currency",
                              "expiry","lastTradingDate","strike","right","side","qty","price",
                              "multiplier","commission","commissionCurrency"}
            base={k:v for k,v in rows["tst.a.01"].items() if k in statement_fields}
            source_override={k:v for k,v in rows["tst.part.01"].items() if k in base}
            source_override.update(realizedPnl=7.25,realizedSource="IBKR Flex FIFO",realizedCurrency="USD",openClose="CLOSE",brokerageOrderId="fixture-order-link",ibOrderId="leg-order",transactionId="fixture-transaction")
            assert call("options-history/import",add(A,[source_override]))["changed"]==1
            enriched=next(r for r in load()["rows"] if r["id"]=="tst.part.01")
            assert enriched["comboId"]=="TWS-PERM/9011" and enriched["realizedPnl"]==7.25 and enriched["brokerageOrderId"]=="fixture-order-link"
            call("options-history/import",add(A,[dict(base,comboId="fabricated")]),expected=400)
            note("Actual TWS BAG membership and permanent IDs are account-scoped; official FIFO enriches the matching fill")
            corrected=dict(base,id="tst.a.02",price=3.25,commission=1.1,commissionCurrency="USD")
            assert call("options-history/import",add(A,[corrected]))["changed"]==1
            assert call("options-history/import",add(A,[base,corrected]))["changed"]==0
            assert call("options-history/import",add(B,[]))["received"]==0
            conflict=dict(corrected,qty=4)
            call("options-history/import",add(A,[dict(base,id="atomic.01"),conflict]),expected=400)
            ledger=load()
            assert len(ledger["rows"])==4
            assert any(row["id"]=="tst.a.02" and row["commission"]==1.1 for row in ledger["rows"])
            note("Corrections, repeat imports, empty statements, atomic rollback and revision precedence")
            for name in ("Draft A","Draft B"):
                call("save",{"name":name,"document":{"symbol":"TST","legs":[{"kind":"option","conId":10,"qty":1,"entry":3.,"multiplier":100.,"root":"TST","right":"C","strike":100.,"expiry":OPEN}]}})
            matched=next(row for row in load()["rows"] if row["id"]=="tst.a.02")
            assert matched["matchStatus"]=="ambiguous" and {m["name"] for m in matched["matches"]}=={"Draft A","Draft B"}
            note("Qualified contract shared by saved strategies remains ambiguous")
            server.accounts=[B]
            server.execution_end.clear()
            started=time.monotonic()
            changed=load()
            assert time.monotonic()-started<2 and changed["refreshing"]
            req_count=server.requests
            assert load()["refreshing"] and server.requests==req_count
            server.execution_end.set()
            for _ in range(15):
                changed=load()
                if not changed.get("refreshing"): break
                time.sleep(.1)
            assert not changed.get("refreshing") and server.requests==req_count
            note("Incremental fill archive and nonblocking readers while waiting for broker execution End")
            assert len(changed["rows"])==1 and changed["rows"][0]["price"]==77.
            assert A not in json.dumps(changed) and B not in json.dumps(changed)
            note("Another live account with overlapping execution ID never sees prior scoped executions")
            server.accounts=[A,B]
            server.complete_positions=False
            started=time.monotonic()
            unknown=load()
            assert time.monotonic()-started<2 and unknown["refreshing"],"Blocked on incomplete inventory"
            for _ in range(20):
                if not unknown.get("refreshing"): break
                time.sleep(.2)
                unknown=load()
            assert not unknown.get("refreshing")
            assert unknown["status"]=="ok" and len(unknown["rows"])==5 and all(r["positionStatus"]=="unknown" for r in unknown["rows"] if r["conId"]!=12)
            note("Incomplete positions cannot classify open or closed contracts")
            events=[dict(base,id="IBKR-FLEX-LIFECYCLE/"+token,eventType=action,price=price,commission=None,commissionCurrency=None)
                    for token,action,price in (("book001","expiration",0.),("book002","assignment",None),("book003","exercise",None))]
            summary=call("options-history/import",add(A,events))
            assert summary["executionCount"]==0 and summary["lifecycleCount"]==3 and summary["changed"]==3
            assert call("options-history/import",add(A,events))["changed"]==0
            call("options-history/import",add(A,[dict(events[1],eventType="expiration")]),expected=400)
            call("options-history/import",add(A,[dict(events[0],eventType=None)]),expected=400)
            ledger=load()
            assert ledger["lifecycleCount"]==3 and ledger["executionCount"]==5
            lifecycle=[r for r in ledger["rows"] if r.get("eventType")]
            assert {r["eventType"]:r["price"] for r in lifecycle}=={"expiration":0.,"assignment":None,"exercise":None}
            assert all(r["source"]=="IBKR Activity Flex" for r in lifecycle)
            import sqlite3
            with sqlite3.connect(pathlib.Path(folder)/"options-history.sqlite") as db:
                assert db.execute("SELECT count(*) FROM lifecycle_events").fetchone()==(3,)
                assert db.execute("SELECT count(*) FROM executions WHERE base LIKE 'IBKR-FLEX-LIFECYCLE/%'").fetchone()==(0,)
            note("Flex exercise, assignment and expiration keep their broker IDs, reported or unknown prices and separate accounting")

            proc.terminate();proc.wait(timeout=5)
            server.shutdown();server.server_close()
            proc=launch()
            offline=load()
            assert offline["status"]=="unavailable" and offline["accountVerified"] and not offline["liveAccountVerified"] and len(offline["rows"])==8
            assert call("account-scope",{"accountId":A})==a
            assert (pathlib.Path(folder)/"options-history.sqlite").stat().st_mode & 0o777==0o600
            note("Isolated archive and account key survive process restart, offline labels remain explicit")
        finally:
            proc.terminate();proc.wait(timeout=5)
            server.shutdown();server.server_close()
    related=["src/options_history.rs","src/options_history/archive.rs","src/main.rs","scripts/verify-options-ledger.py"]
    args.artifact.parent.mkdir(parents=True,exist_ok=True)
    args.artifact.write_text(json.dumps({"testedBinarySha256":tested_binary,"passed":tests,"fixture":"Local protobuf TWS execution/position server + temporary SQLite","sources":{f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in related}},indent=2)+"\n")
    print(f"{len(tests)} native ledger scenarios passed. {args.artifact}")

if __name__=="__main__":
    main()
