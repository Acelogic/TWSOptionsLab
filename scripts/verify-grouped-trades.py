#!/usr/bin/env python3
"""Exercise the public grouped history route in a temporary SQLite/TWS-offline profile.

Failure cases: spread scaling across orders vs flat reopening, roll attribution,
partial leg exits, ambiguous shared contracts, trade reversals, financial fees,
tax adjustments, lifecycle delivery, incomplete data, account isolation.
"""

import datetime as dt
import json
import math
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = Path(sys.argv[1])
T = int(dt.datetime.fromisoformat("2026-11-10T15:00:00+00:00").timestamp() * 1000)
events = []


def fill(
    symbol,
    contract,
    qty,
    price,
    fees,
    effect,
    minute,
    strike=100,
    order=None,
    references=None,
    fifo=None,
    fee_ccy="USD",
    event=None,
    **extra,
):
    ident = f"FIL-{len(events)+1}"
    f = dict(
        id=ident,
        at=T + minute * 60000,
        conId=contract,
        symbol=symbol,
        localSymbol=symbol + " fixture",
        secType="OPT",
        currency="USD",
        expiry="20261218",
        strike=strike,
        right="C",
        side="BUY" if qty > 0 else "SELL",
        qty=abs(qty),
        price=price,
        multiplier=100,
        commission=fees,
        commissionCurrency=fee_ccy,
        transactionId="TR-" + ident,
    )
    if effect:
        f["openClose"] = effect
    if order:
        f.update(
            brokerageOrderId=order[0],
            orderAt=T + order[1] * 60000,
            underlyingConId=sum(map(ord, symbol)),
        )
    if references:
        f["closedLots"] = [
            dict(
                openingTransactionId=o["transactionId"],
                openedAt=o["at"],
                qty=q,
                realizedPnl=n,
            )
            for o, q, n in references
        ]
    if fifo is not None:
        f.update(
            realizedPnl=fifo, realizedSource="IBKR Flex FIFO", realizedCurrency="USD"
        )
    if event:
        f.update(eventType=event, id="IBKR-FLEX-LIFECYCLE/" + ident)
    f.update(extra)
    events.append(f)
    return f


# Two full spread orders scale into one identical still-held position.
a = fill("SCALE", 111, 2, 5, 2, "OPEN", 0, 100, ("combo1", 0))
b = fill("SCALE", 112, -2, 2, 2, "OPEN", 0, 110, ("combo1", 0))
c = fill("SCALE", 111, 1, 6, 1, "OPEN", 1, 100, ("combo2", 1))
d = fill("SCALE", 112, -1, 3, 1, "OPEN", 1, 110, ("combo2", 1))
fill("SCALE", 112, 1, 1, 1, "CLOSE", 2, 110, references=[(b, 1, 98)], fifo=98)
fill(
    "SCALE",
    111,
    -3,
    7,
    3,
    "CLOSE",
    3,
    100,
    ("combo3", 3),
    [(a, 2, 396), (c, 1, 98)],
    494,
)
fill(
    "SCALE",
    112,
    2,
    1,
    2,
    "CLOSE",
    3,
    110,
    ("combo3", 3),
    [(b, 1, 98), (d, 1, 198)],
    296,
)
# Same contracts AFTER flat must be a new group even with same reused brokerage ID.
fill("SCALE", 111, 1, 7, 1, "OPEN", 4, 100, ("combo1", 4))
fill("SCALE", 112, -1, 4, 1, "OPEN", 4, 110, ("combo1", 4))
# Distinct single-contract episodes with a close and reopening in the same second.
early = fill("SAME", 121, 1, 4, 1, "OPEN", 0)
fill("SAME", 121, 1, 9, 1, "OPEN", 1)
fill("SAME", 121, -1, 6, 1, "CLOSE", 1, references=[(early, 1, 198)], fifo=198)
# A reversal allocates the buy fee over short closure and newly established long qty.
short = fill("FLIP", 131, -3, 4, 3, "OPEN", 0)
flip = fill("FLIP", 131, 5, 2, 5, "MIXED", 1, references=[(short, 3, 594)], fifo=594)
fill("FLIP", 131, -2, 4, 2, "CLOSE", 2, references=[(flip, 2, 396)], fifo=396)
# Rolling a unique long strikes closes one and opens the replacement in the same order.
roll = fill("ROLL", 141, 2, 5, 2, "OPEN", 0)
fill("ROLL", 141, -2, 6, 2, "CLOSE", 1, 100, ("roll", 1), [(roll, 2, 196)], 196)
new = fill("ROLL", 142, 2, 3, 2, "OPEN", 1, 110, ("roll", 1))
fill("ROLL", 142, -2, 4, 2, "CLOSE", 2, 110, references=[(new, 2, 196)], fifo=196)
# Missing fees prevent economic proceeds, but a tax figure is separately available.
mf = fill("FXFEE", 151, 1, 5, 1, "OPEN", 0, fee_ccy="CAD")
fill("FXFEE", 151, -1, 5.5, 1, "CLOSE", 1, references=[(mf, 1, 48)], fifo=48)
wo = fill("WASH", 161, 1, 100, 1, "OPEN", 0)
fill("WASH", 161, -1, 80, 1, "CLOSE", 1, references=[(wo, 1, -2002)], fifo=0)
asgn = fill("ASN", 171, -1, 4, 1, "OPEN", 0)
fill(
    "ASN",
    171,
    1,
    None,
    0,
    "CLOSE",
    1,
    references=[(asgn, 1, 0)],
    fifo=0,
    event="assignment",
)
# A shared strike opened as two distinct spreads; its close explicitly draws on both openings.
aa = fill("SPLIT", 181, 1, 4, 1, "OPEN", 0, 100, ("first", 0))
fill("SPLIT", 182, -1, 2, 1, "OPEN", 0, 105, ("first", 0))
bb = fill("SPLIT", 181, 1, 6, 1, "OPEN", 1, 100, ("second", 1))
fill("SPLIT", 183, -1, 2, 1, "OPEN", 1, 115, ("second", 1))
fill(
    "SPLIT",
    181,
    -2,
    5,
    2,
    "CLOSE",
    2,
    100,
    references=[(aa, 1, 98), (bb, 1, -102)],
    fifo=0,
)
fill("ABSENT", 191, -1, 2, 1, "CLOSE", 1, fifo=25)
fill("LIVE", 201, 1, 2, 0.5, None, 1, twsPermId="345")
fill(
    "LIVE",
    202,
    -1,
    1,
    0.5,
    None,
    1,
    fifo=132,
    twsPermId="345",
    realizedSource="TWS commission report",
)
fill("BAG", 211, 1, 2, 0.5, None, 1, twsPermId="346", comboId="BAG-346")
fill("BAG", 212, -1, 1, 0.5, None, 1, twsPermId="346", comboId="BAG-346")


def reversal_xml(records):
    account = "DUGRP001"
    root = ET.Element("FlexQueryResponse", type="AF")
    statements = ET.SubElement(root, "FlexStatements", count="1")
    report = ET.SubElement(
        statements,
        "FlexStatement",
        accountId=account,
        fromDate="20261110",
        toDate="20261110",
        whenGenerated="20261111;100000",
    )
    trades = ET.SubElement(report, "Trades")

    def timestamp(ms):
        return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime(
            "%Y%m%d;%H%M%S"
        )

    for event in records:
        effect = {"OPEN": "O", "CLOSE": "C", "MIXED": "C;O"}[event["openClose"]]
        side = event["side"]
        source = dict(
            accountId=account,
            assetCategory="OPT",
            levelOfDetail="EXECUTION",
            transactionType="ExchTrade",
            transactionID=event["transactionId"],
            conid=str(event["conId"]),
            symbol=event["localSymbol"],
            underlyingSymbol="FLIP",
            currency="USD",
            expiry=event["expiry"],
            putCall="C",
            strike=str(event["strike"]),
            dateTime=timestamp(event["at"]),
            tradePrice=str(event["price"]),
            ibExecID=event["id"],
            ibCommission=str(-event["commission"]),
            ibCommissionCurrency="USD",
            multiplier="100",
            buySell=side,
            quantity=str(event["qty"] if side == "BUY" else -event["qty"]),
            openCloseIndicator=effect,
        )
        if "realizedPnl" in event:
            source["fifoPnlRealized"] = str(event["realizedPnl"])
        ET.SubElement(trades, "Trade", **source)
        for lot in event.get("closedLots", []):
            ET.SubElement(
                trades,
                "Lot",
                accountId=account,
                levelOfDetail="CLOSED_LOT",
                conid=source["conid"],
                currency="USD",
                dateTime=source["dateTime"],
                buySell=side,
                transactionID=lot["openingTransactionId"],
                quantity=str(lot["qty"]),
                openDateTime=timestamp(lot["openedAt"]),
                fifoPnlRealized=str(lot["realizedPnl"]),
            )
    return ET.tostring(root, encoding="unicode")


def api(port, path, body=None):
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/{path}",
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as error:
        raise RuntimeError(
            f"{path} rejected synthetic records: {error.read().decode()}"
        ) from error


def near(value, expected):
    assert value is not None and math.isclose(value, expected, abs_tol=1e-7)


with tempfile.TemporaryDirectory(prefix="ibkr-group-verification-") as tmp:
    subprocess.run(["cargo", "build", "--locked", "--quiet"], cwd=ROOT, check=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = subprocess.Popen(
        [
            ROOT / "target/debug/tws-options-lab",
            "--port",
            str(port),
            "--tws-port",
            "1",
            "--data-dir",
            tmp,
            "--no-open",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for i in range(60):
            try:
                api(port, "library")
                break
            except OSError:
                if i == 59:
                    raise
                time.sleep(0.1)
        scope = api(port, "account-scope", {"accountId": "DUGRP001"})["accountScope"]
        alt = {**events[0], "symbol": "SCOPE-PRIVATE"}
        flip_records = [event for event in events if event["symbol"] == "FLIP"]
        archived = [
            event for event in events if event["symbol"] not in ("FLIP", "LIVE", "BAG")
        ]
        api(port, "ibkr-flex", {"timezone": "UTC", "xml": [reversal_xml(flip_records)]})
        for account, items in [("DUGRP001", archived), ("DUGRP002", [alt])]:
            api(
                port,
                "options-history/import",
                {
                    "source": "IBKR Flex",
                    "accounts": [
                        {
                            "accountId": account,
                            "from": T,
                            "to": T + 10 * 60000,
                            "executions": items,
                        }
                    ],
                },
            )
        db = sqlite3.connect(Path(tmp) / "options-history.sqlite")
        # Replay synthetic broker captures into this private temporary
        # archive. The Flex HTTP endpoint rejects live-only BAG/commission evidence.
        for event in events:
            if event["symbol"] in ("LIVE", "BAG"):
                db.execute(
                    "INSERT INTO executions VALUES(?,?,?,?,?)",
                    (scope, event["id"], 0, 0, json.dumps(event)),
                )
        db.execute("INSERT INTO active_scopes VALUES(?,?)", (scope, T))
        db.commit()
        db.close()
        envelope = api(port, "options-history")
        by = defaultdict(list)
        for trade in envelope["trades"]:
            by[trade["symbol"]].append(trade)
        assert len(envelope["rows"]) == len(events) and "SCOPE-PRIVATE" not in by
        old, new = sorted(by["SCALE"], key=lambda t: t["openedAt"])
        near(old["netRealizedPnl"], 888)
        assert (
            old["status"] == "closed"
            and new["status"] == "open"
            and len(old["fills"]) == 7
        )
        assert (
            old["label"] == "SCALE bull call spread" and "scaled" in old["groupSource"]
        )
        assert [(leg["openedQty"], leg["closedQty"]) for leg in old["legs"]] == [
            (3, 3),
            (3, 3),
        ]
        a, b = sorted(by["SAME"], key=lambda t: t["openedAt"])
        near(a["netRealizedPnl"], 198)
        assert b["status"] == "open"
        assert sorted(t["netRealizedPnl"] for t in by["FLIP"]) == [396, 594]
        assert (
            sum(
                f["commission"]
                for t in by["FLIP"]
                for f in t["fills"]
                if f["id"] == flip["id"]
            )
            == 5
        )
        (r,) = by["ROLL"]
        near(r["netRealizedPnl"], 392)
        assert "rolled" in r["label"]
        (m,) = by["FXFEE"]
        assert m["netRealizedPnl"] is None and m["brokerRealizedPnl"] == 48
        (w,) = by["WASH"]
        near(w["netRealizedPnl"], -2002)
        near(w["brokerRealizedPnl"], 0)
        (s,) = by["ASN"]
        near(s["netRealizedPnl"], 0)
        assert "delivered shares" in s["pnlSource"]
        assert sorted(t["netRealizedPnl"] for t in by["SPLIT"]) == [-102, 98]
        assert all(t["brokerRealizedPnl"] is None for t in by["SPLIT"])
        (detached,) = by["ABSENT"]
        assert (
            detached["netRealizedPnl"] is None and detached["brokerRealizedPnl"] == 25
        )
        assert (
            len(by["LIVE"]) == 2
            and len(by["BAG"]) == 1
            and by["BAG"][0]["status"] == "incomplete"
        )
        assert any(
            t["brokerRealizedPnl"] == 132 and t["netRealizedPnl"] is None
            for t in by["LIVE"]
        )
        assert envelope["tradeSummary"]["byCurrency"][0]["brokerRealizedPnl"] is None
        result = {
            "passed": True,
            "source": "Native option-history HTTP route with isolated accounts and deterministic broker records",
            "sourceRecords": len(events),
            "closedScalePnl": old["netRealizedPnl"],
            "rollPnl": r["netRealizedPnl"],
            "flipPnl": sorted(t["netRealizedPnl"] for t in by["FLIP"]),
            "separateSameSecondReopening": True,
            "unknownForeignFee": True,
            "washSale": {"cash": w["netRealizedPnl"], "broker": w["brokerRealizedPnl"]},
            "assignmentOptionOnly": True,
            "splitCloseCash": sorted(t["netRealizedPnl"] for t in by["SPLIT"]),
            "splitUnallocatableFifo": True,
            "verifiedComboIdentity": True,
            "accountScopesSeparated": True,
        }
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(result, indent=2) + "\n")
        print("Verified", OUT)
    finally:
        server.terminate()
        server.wait(timeout=10)
