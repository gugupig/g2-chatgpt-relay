#!/usr/bin/env bash
# Builds and installs the G2 Relay Android app (../android/) with the Gradle
# wrapper. Needs JDK 21 and the Android SDK: set JAVA_HOME and ANDROID_HOME,
# or have them on PATH. G2_BUILD_ROOT, if set, moves all build output there
# instead of android/**/build.
#
#   scripts/android.sh build      # assembleDebug
#   scripts/android.sh install    # build, then adb install -r
#   scripts/android.sh logs       # follow the app's logcat (relay + page console)
#   scripts/android.sh gradle ... # any other gradle task
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
: "${ANDROID_HOME:=${ANDROID_SDK_ROOT:-}}"
if [ -z "$ANDROID_HOME" ] && [ ! -f "$ROOT/android/local.properties" ]; then
  echo "error: set ANDROID_HOME to the Android SDK (or write sdk.dir to android/local.properties)" >&2
  exit 1
fi
export ANDROID_HOME

ADB="adb"
[ -n "$ANDROID_HOME" ] && [ -x "$ANDROID_HOME/platform-tools/adb" ] && ADB="$ANDROID_HOME/platform-tools/adb"
OUT="${G2_BUILD_ROOT:-$ROOT/android}"
APK="$OUT/app/outputs/apk/debug/app-debug.apk"
[ -z "${G2_BUILD_ROOT:-}" ] && APK="$ROOT/android/app/build/outputs/apk/debug/app-debug.apk"

gradle() { "$ROOT/android/gradlew" -p "$ROOT/android" "$@"; }

case "${1:-build}" in
  build) gradle assembleDebug ;;
  install)
    gradle assembleDebug
    "$ADB" install -r "$APK"
    ;;
  logs) "$ADB" logcat -v time -s G2Relay:V GeckoConsole:V ;;
  gradle)
    shift
    gradle "$@"
    ;;
  *)
    echo "usage: $0 build|install|logs|gradle <task>" >&2
    exit 2
    ;;
esac
