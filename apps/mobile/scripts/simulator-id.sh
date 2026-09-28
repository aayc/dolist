#!/bin/sh
# Prints the id of the first installed iPhone simulator.
set -eu
xcrun simctl list devices available --json | python3 -c '
import json,sys
for devices in json.load(sys.stdin)["devices"].values():
    for device in devices:
        if device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
sys.exit("No iPhone simulator is installed")
'
