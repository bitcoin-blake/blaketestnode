#!/usr/bin/env bash
# The open epoch, rebuilt from the snapshot and the node's blocks, then put on R2 as epochs/<chain>-current.json.
# Run by pm2 on a schedule (see ops/epoch-current.config.cjs). Needs the Knots node up and the [r2] profile in
# ~/.aws/credentials; the keys are read into variables and never printed. Skips the upload when the tip has not moved.
set -euo pipefail
CHAIN=${CHAIN:-txbt4}
REPO=${REPO:-$HOME/remote/github.com/bitcoin-blake/blaketestnode}
DATA=${DATA:-$HOME/.blaketestnode/epoch-build}
BUCKET_URL=${BUCKET_URL:-https://d705ea401fbfa0d91735b26b0d1aa69d.r2.cloudflarestorage.com/assumeutxo}
PUBLIC_URL=${PUBLIC_URL:-https://pub-8cae8bad22cf4f44b22188af9b1c0064.r2.dev}
KEY="epochs/${CHAIN}-current.json"
OUT="$REPO/epochs/current.json"
LOG=${LOG:-$HOME/.blaketestnode/${CHAIN}/current.log}
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

prev_tip=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['end']['height'])" "$OUT" 2>/dev/null || echo 0)
cd "$REPO"
node --max-old-space-size=8192 bin/blaketestnode.mjs epoch build --source rpc --open --data "$DATA" 2>&1 | tail -n 4 | sed 's/^/  /'
tip=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['end']['height'])" "$OUT")
start=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['start']['height'])" "$OUT")
sum=$(sha256sum "$OUT" | cut -c1-64)
if [ "$tip" = "$prev_tip" ] && [ "${FORCE:-0}" != 1 ]; then say "tip still $tip, nothing to publish"; exit 0; fi

AKEY=$(awk '/^\[r2\]/{f=1;next} /^\[/{f=0} f && /aws_access_key_id/{print $3}' ~/.aws/credentials)
ASEC=$(awk '/^\[r2\]/{f=1;next} /^\[/{f=0} f && /aws_secret_access_key/{print $3}' ~/.aws/credentials)
code=$(curl -s -o /dev/null -w '%{http_code}' --aws-sigv4 "aws:amz:auto:s3" --user "$AKEY:$ASEC" -X PUT \
  -H "Content-Type: application/json" -H "Cache-Control: max-age=300" --data-binary @"$OUT" "$BUCKET_URL/$KEY")
[ "$code" = 200 ] || { say "upload failed: HTTP $code"; exit 1; }
got=$(curl -s "$PUBLIC_URL/$KEY" | sha256sum | cut -c1-64)
[ "$got" = "$sum" ] || { say "public copy does not match: $got vs $sum"; exit 1; }
say "open epoch $start→$tip published: $(stat -c %s "$OUT") B sha256 ${sum:0:16}… at $PUBLIC_URL/$KEY"
