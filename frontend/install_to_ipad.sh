#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f ".env.ipad.local" ]]; then
  set -a
  source ".env.ipad.local"
  set +a
fi

: "${VITE_API_BASE_URL:?Please set VITE_API_BASE_URL in frontend/.env.ipad.local}"
: "${APPLE_TEAM_ID:?Please set APPLE_TEAM_ID in frontend/.env.ipad.local}"
: "${IOS_XCODE_DEVICE_ID:?Please set IOS_XCODE_DEVICE_ID in frontend/.env.ipad.local}"
: "${IOS_COREDEVICE_UUID:?Please set IOS_COREDEVICE_UUID in frontend/.env.ipad.local}"
BUNDLE_ID="${IOS_BUNDLE_ID:-app.studydiary.companion}"

VITE_API_BASE_URL="$VITE_API_BASE_URL" ./node_modules/.bin/tsc -b
VITE_API_BASE_URL="$VITE_API_BASE_URL" ./node_modules/.bin/vite build
./node_modules/.bin/cap sync ios

xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination "id=${IOS_XCODE_DEVICE_ID}" \
  -derivedDataPath ios/build \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  build

xcrun devicectl device install app \
  --device "$IOS_COREDEVICE_UUID" \
  ios/build/Build/Products/Release-iphoneos/App.app

xcrun devicectl device process launch \
  --device "$IOS_COREDEVICE_UUID" \
  "$BUNDLE_ID" || true
