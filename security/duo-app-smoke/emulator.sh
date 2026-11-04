#!/usr/bin/env bash
# DUO development APK launch smoke using a DISPOSABLE Android emulator.
# No real login credentials, no registration, no real orders, no production writes.
set -euo pipefail

: "$DUO_APK_PATH"
: "$ANDROID_HOME"
if [[ ! -f "$DUO_APK_PATH" ]];then echo "DUO_APK_MISSING";exit 1;fi

echo "=== DUO ANDROID DEV APK EMULATOR LAUNCH ==="
AAPT="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -type f -name aapt | sort -V | tail -1)"
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -maxdepth 2 -type f -name apksigner | sort -V | tail -1)"
if [[ -z "$AAPT" || -z "$APKSIGNER" ]];then echo "ANDROID_BUILD_TOOLS_MISSING";exit 1;fi

unzip -tq "$DUO_APK_PATH" >/dev/null
unzip -Z1 "$DUO_APK_PATH" | grep -Fx 'AndroidManifest.xml' >/dev/null
unzip -Z1 "$DUO_APK_PATH" | grep -Eq '^classes([2-9])?\.dex$'
echo "APK_ZIP_AND_DEX: PASS"

"$APKSIGNER" verify "$DUO_APK_PATH"
echo "APK_SIGNATURE: PASS"

BADGING="$("$AAPT" dump badging "$DUO_APK_PATH")"
PACKAGE="$(printf '%s\n' "$BADGING" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)"
VERSION="$(printf '%s\n' "$BADGING" | sed -n "s/^package:.*versionName='\([^']*\)'.*/\1/p" | head -1)"
if [[ -z "$PACKAGE" || ! "$PACKAGE" =~ ^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$ ]];then
  echo "INVALID_PACKAGE_NAME";exit 1;
fi
echo "APK_PACKAGE: $PACKAGE"
echo "APK_VERSION_NAME: $VERSION"
"$AAPT" dump badging "$DUO_APK_PATH" | grep -q '^launchable-activity:'
echo "APK_LAUNCHABLE_ACTIVITY: PASS"

adb install -r "$DUO_APK_PATH"
echo "DUO_EMULATOR_INSTALL: PASS"
adb logcat -c
adb shell monkey -p "$PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null
sleep 15
PID="$(adb shell pidof "$PACKAGE" | tr -d '\r' || true)"
if [[ -z "$PID" ]];then
  echo "DUO_APP_PROCESS_NOT_RUNNING"
  exit 1
fi
echo "DUO_EMULATOR_PROCESS_ALIVE: PASS"

# Foreground activity is stronger evidence than only a process.
if adb shell dumpsys activity activities | grep -F "$PACKAGE" | grep -Eq 'mResumed|topResumed|ResumedActivity';then
  echo "DUO_EMULATOR_FOREGROUND_ACTIVITY: PASS"
else
  echo "DUO_EMULATOR_FOREGROUND_ACTIVITY: UNCONFIRMED"
fi
mkdir -p "$RUNNER_TEMP/duo-launch-check"
adb exec-out screencap -p > "$RUNNER_TEMP/duo-launch-check/login-screen.png"
test -s "$RUNNER_TEMP/duo-launch-check/login-screen.png"
echo "DUO_EMULATOR_SCREENSHOT_CAPTURED: PASS"
echo "NO_REAL_LOGIN_PERFORMED"
echo "NO_LIVE_ORDER_RECEIVED"
