#!/usr/bin/env bash

set -e

sudo apt-get update

npx playwright install-deps
npx playwright install
npm install -g @playwright/cli@latest
(cd && playwright-cli install)