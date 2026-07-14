#!/usr/bin/env python3
"""Backfill the Fireberry `pcfconveraiagent` field with a signed conversation-view
iframe for existing leads. Deterministic: URL = HMAC(phone|product).

Usage:
  # dry run — prints what it WOULD write, changes nothing:
  EMBED_LINK_SECRET=... python3 scripts/admin/backfill-conversation-view.py
  # write for real:
  EMBED_LINK_SECRET=... python3 scripts/admin/backfill-conversation-view.py --apply
  # single lead (for verification / to eyeball a URL):
  EMBED_LINK_SECRET=... python3 scripts/admin/backfill-conversation-view.py --one 0525188599 B
"""
import hashlib
import hmac
import json
import os
import platform
import re
import subprocess
import sys
import urllib.request

BASE = "https://richer-ai-agents-hub.vercel.app"
API = "https://api.fireberry.com"
# Map the Fireberry product field (pcfsystemfield122) value -> mooz product code (B/R).
# CONFIRM these against real values before --apply (see notes at bottom).
PRODUCT_MAP = {"שיווק שותפים": "B", "שיווק דיגיטלי": "R"}


def get_token():
    v = os.environ.get("FIREBERRY_API_TOKEN")
    if v:
        return v
    if platform.system() == "Darwin":
        r = subprocess.run(
            ["security", "find-generic-password", "-s", "FIREBERRY_API_TOKEN",
             "-a", os.environ.get("USER", ""), "-w"],
            capture_output=True, text=True)
        if r.returncode == 0:
            return r.stdout.strip()
    return None


def canonical_phone(raw):
    t = re.sub(r"[\s\-()]", "", (raw or "").strip())
    if re.fullmatch(r"\+972\d{8,9}", t):
        return t[1:]
    if re.fullmatch(r"972\d{8,9}", t):
        return t
    if re.fullmatch(r"0\d{8,9}", t):
        return "972" + t[1:]
    return None


def sign(phone, product, secret):
    payload = f"{phone}|{product}".encode()
    return hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()


def build_url(phone, product, secret):
    p = canonical_phone(phone)
    if not p or product not in ("B", "R"):
        return None
    return f"{BASE}/embed/c?p={p}&product={product}&sig={sign(p, product, secret)}"


def iframe(url):
    return (f'<iframe src="{url}" style="width:100%;height:720px;border:0;'
            f'border-radius:12px;" title="שיחה עם הליד"></iframe>')


def query_leads(token, page):
    body = {
        "objectType": 1,
        "fields": [{"name": "accountid"}, {"name": "telephone1"},
                   {"name": "pcfsystemfield122"}],
        "pageSize": 200, "pageNumber": page,
    }
    req = urllib.request.Request(
        f"{API}/api/v3/query", data=json.dumps(body).encode(),
        headers={"tokenid": token, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read()).get("data", [])


def update_lead(token, rec_id, value):
    # Endpoint/verb MUST be confirmed on one record before bulk (see notes).
    body = {"pcfconveraiagent": value}
    req = urllib.request.Request(
        f"{API}/api/record/1/{rec_id}", data=json.dumps(body).encode(),
        headers={"tokenid": token, "Content-Type": "application/json"}, method="PUT")
    with urllib.request.urlopen(req) as resp:
        return resp.status


def main():
    secret = os.environ.get("EMBED_LINK_SECRET")
    if not secret:
        sys.exit("ERROR: EMBED_LINK_SECRET not set")

    # --one is a pure local HMAC computation — no Fireberry call, so it
    # doesn't need FIREBERRY_API_TOKEN. Check it before requiring the token.
    if len(sys.argv) >= 4 and sys.argv[1] == "--one":
        url = build_url(sys.argv[2], sys.argv[3], secret)
        print(url or "INVALID phone/product")
        return

    token = get_token()
    if not token:
        sys.exit("ERROR: FIREBERRY_API_TOKEN not found (env or Keychain)")

    apply = "--apply" in sys.argv
    page, done, skipped = 1, 0, 0
    while True:
        rows = query_leads(token, page)
        if not rows:
            break
        for r in rows:
            phone = r.get("telephone1")
            product = PRODUCT_MAP.get((r.get("pcfsystemfield122") or "").strip())
            url = build_url(phone or "", product or "", secret) if product else None
            if not url:
                skipped += 1
                continue
            if apply:
                update_lead(token, r["accountid"], iframe(url))
            done += 1
            print(f"{'WROTE' if apply else 'DRY'} {r['accountid']} {phone} {product}")
        page += 1
    print(f"\n{'Applied' if apply else 'Dry-run'}: {done} leads, skipped {skipped}.")


if __name__ == "__main__":
    main()
