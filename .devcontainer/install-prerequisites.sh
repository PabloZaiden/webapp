#!/usr/bin/env bash

set -e

sudo apt-get update

npx playwright install-deps
npx playwright install