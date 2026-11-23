#!/usr/bin/env python3
"""Private HTTP and TWS-wire replay of estimated dates on closing-price ticks.

Failure modes: receipt time becomes the calibration time, weekends/holidays pick
a non-session, 16:15 options receive the equity's 16:00 cutoff, an old cached
price is relabeled after a new session, unknown venues borrow US holidays, or
calendar labels open extra market data or historical requests.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
from zoneinfo import ZoneInfo

ROOT=Path(__file__).resolve().parents[1]
wire=runpy.run_path(str(ROOT/"scripts/verify-options-ledger.py"))
Fixture,BaseWire,fields,varint=wire["Fixture"],wire["Wire"],wire["fields"],wire["first_varint"]
ids=[80101,80102,80103,80104]
ET=ZoneInfo("America/New_York")
def instant(s):
    return int(dt.datetime.fromisoformat(s).replace(tzinfo=ET).timestamp()*1000)
def parse_fields(encoded):
    f={}
    while encoded:
        tag,n=varint(encoded);encoded=encoded[n:];wire_type=tag%8
        if wire_type==0:v,n=varint(encoded);encoded=encoded[n:]
        elif wire_type==2:
            size,n=varint(encoded);v=encoded[n:n+size];encoded=encoded[n+size:]
        elif wire_type==1:v=struct.unpack('<d',encoded[:8])[0];encoded=encoded[8:]
        else:raise AssertionError('Unexpected field encoding')
        f[tag//8]=v
    return f

class CalendarWire(BaseWire):
    def handle(self):
        if self.rfile.read(4)!=b'API\0':return
        version=self.read().decode().split('..')[-1].split()[0].strip('\0')
        self.packet(version.encode()+b'\0' + b'20261122 22:00:00 US/Eastern\0')
        while (raw:=self.read()):
            msg=int.from_bytes(raw[:4],"big")-200
            self.server.count[msg]+=1
            if msg==71:
                self.accounts();self.send(9,(1,1))
            elif msg==17:self.accounts()
            elif msg in (9,1):
                data=parse_fields(raw[4:]);req=data[1];cid=parse_fields(data[2])[1]
                if msg==9:
                    suffix='1615' if cid==ids[2] else '1600'
                    tag='OPT' if cid in ids[1:3] else 'STK'
                    exchange='LSE' if cid==ids[3] else 'CBOE'
                    currency,zone=('GBP','Europe/London') if cid==ids[3] else ('USD','America/New_York')
                    contract=fields((1,cid),(2,'CAL'),(3,tag),(4,'20261218'),(6,'C' if tag=='OPT' else ''),
                        (7,100.0 if tag=='OPT' else 1.0),(8,exchange),(9,exchange),(10,currency))
                    # The venue's advertised window begins Monday. Friday requires
                    # verified-US fallback, including each option's observed close.
                    hours='20261123:0930-20261123:'+suffix+';20261124:0930-20261124:'+suffix
                    detail=fields((4,exchange),(12,zone),(13,hours),(14,hours))
                    self.send(10,(1,req),(2,contract),(3,detail));self.send(52,(1,req))
                else:
                    self.send(58,(1,req),(2,1));self.send(1,(1,req),(2,9),(3,100.125),(4,'0'))
                    self.server.receivers[cid]=(self,req)

def build(folder):
    crate=folder/'private';shutil.copytree(ROOT/'src',crate/'src')
    shutil.copy(ROOT/'Cargo.lock',crate/'Cargo.lock')
    binary='quote-close-calendar-verification'
    (crate/'Cargo.toml').write_text((ROOT/'Cargo.toml').read_text()+f'\n[[bin]]\nname="{binary}"\npath="src/main.rs"\n')
    m=crate/'src/main.rs';src=m.read_text();needle='    let app = Router::new()'
    assert needle in src
    m.write_text(src.replace(needle,'''    let client=state.market.client(1).await?;
    for id in [80101,80102,80103,80104]{state.catalog.saved_contract(&state.market,&client,id).await?;}
'''+needle,1))
    m=crate/'src/market.rs';src=m.read_text();needle='fn now_ms() -> i64 {\n    chrono::Utc::now().timestamp_millis()\n}'
    assert needle in src
    m.write_text(src.replace(needle,'''fn now_ms() -> i64 {
        std::fs::read_to_string(std::env::var_os("QUOTE_FIXTURE_CLOCK").unwrap()).unwrap().trim().parse().unwrap()
    }''',1))
    subprocess.run(['cargo','build','--locked','--quiet','--manifest-path',str(crate/'Cargo.toml'),'--target-dir',str(ROOT/'target'),'--bin',binary],check=True)
    return ROOT/'target/debug'/binary

def main():
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);out=parser.parse_args().output
    stages=[]
    with tempfile.TemporaryDirectory(prefix='quoted-close-calendar-') as tmp:
        folder=Path(tmp);clock=folder/'clock';clock.write_text(str(instant('2026-11-22T23:00')))
        binary=build(folder)
        tws=Fixture(('127.0.0.1',0),CalendarWire);tws.accounts=['CalendarFixture'];tws.count=collections.Counter();tws.receivers={}
        threading.Thread(target=tws.serve_forever,daemon=True).start()
        with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        proc=subprocess.Popen([binary,'--no-open','--port',str(port),'--tws-port',str(tws.server_address[1]),'--data-dir',folder/'db'],
            env={**os.environ,'QUOTE_FIXTURE_CLOCK':str(clock)},stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        def fetch():
            req=urllib.request.Request(f'http://127.0.0.1:{port}/api/quotes',data=json.dumps({'ids':ids,'mode':1}).encode(),headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=5) as r:return json.load(r)
        def check(label,date,regular='16:00',long='16:15'):
            data=fetch();quotes=data['quotes']
            for cid in ids:
                r=quotes[str(cid)];expected=date if cid!=ids[3] or date=='2026-11-23' else None
                end=instant(date+'T'+(long if cid==ids[2] else regular)) if expected else None
                if expected and cid==ids[3]:end=int(dt.datetime.fromisoformat(date+'T16:00').replace(tzinfo=ZoneInfo('Europe/London')).timestamp()*1000)
                assert (r['closeSessionDate'],r['closeSessionEnd'])==(expected,end),(label,cid,r,expected,end)
                assert r['close']==100.125 and r['closeAt'] is not None
            stages.append({'check':label,'date':date,'stockEnd':quotes[str(ids[0])]['closeSessionEnd'],
                'longOptionEnd':quotes[str(ids[2])]['closeSessionEnd'],'foreignVenueEnd':quotes[str(ids[3])]['closeSessionEnd']})
        def move(s,new_tick):
            stamp=instant(s);next_clock=clock.with_suffix('.next');next_clock.write_text(str(stamp));next_clock.replace(clock)
            if new_tick:
                for cid,(handler,req) in tws.receivers.copy().items():
                    handler.send(1,(1,req),(2,9),(3,100.125),(4,'0'))
                for _ in range(60):
                    if all(q.get('closeAt')==stamp for q in fetch()['quotes'].values()):break
                    time.sleep(.05)
                else:raise AssertionError('Fresh close tick failed to reach the application')
        try:
            for _ in range(150):
                try:
                    if all(q.get('close') is not None for q in fetch()['quotes'].values()):break
                except OSError:pass
                if proc.poll() is not None:raise RuntimeError(proc.stderr.read().decode())
                time.sleep(.06)
            else:raise RuntimeError('Timed out waiting for quote callbacks')
            check('Sunday night prior close','2026-11-20')
            move('2026-11-23T12:00',False);check('Monday intraday uses Friday callback','2026-11-20')
            move('2026-11-23T17:00',True);check('After Monday close still treats tick as previous-day field','2026-11-20')
            move('2026-11-24T08:30',False);check('Stale price never relabeled',None)
            move('2026-11-24T08:30',True);check('New tick uses native Monday window','2026-11-23')
            move('2026-11-26T11:30',True);check('Thanksgiving prior close','2026-11-25')
            move('2026-11-29T11:30',True);check('Early-close Friday cutoff','2026-11-27','13:00','13:15')
            assert tws.count[1]==4 and tws.count[9]==4 and not tws.count[20] and not tws.count[96],tws.count
        finally:
            proc.terminate();proc.wait(timeout=10);tws.shutdown();tws.server_close()
    files=['src/session_calendar.rs','src/catalog.rs','src/market.rs','src/snapshots/completed.rs','scripts/verify-quote-close-calendar.py']
    out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps({'passed':True,'checks':stages,'contractRequests':4,'subscriptions':4,
        'historicalRequests':0,'sourceHashes':{f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in files},
        'repeatCommand':'python3 scripts/verify-quote-close-calendar.py /path/to/verification.json'},indent=2)+'\n')
    print(f'Verified {len(stages)} calendar transitions over four native quote subscriptions. {out}')
if __name__=='__main__':main()
