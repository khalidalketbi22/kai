#!/bin/bash
# macOS: double-click to start The Liwan Ops (dashboard + 9pm / Sunday reports).
cd "$(dirname "$0")/.." || exit 1
mkdir -p data/inbox
echo "Starting The Liwan Ops — keep this window open. Dashboard: http://localhost:8787"
npm start
