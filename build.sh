#!/bin/bash
# Builds a signed APK using only the Android SDK command-line tools (no Gradle).
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
BT=$SDK/build-tools/36.0.0
JAR=$SDK/platforms/android-36/android.jar
rm -rf build && mkdir -p build/res build/classes build/dex build/assets
cp -R web build/assets/web && rm -rf build/assets/web/.claude

"$BT/aapt2" compile --dir res -o build/res
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml -A build/assets build/res/*.flat
javac --release 11 -encoding UTF-8 -cp "$JAR" -d build/classes $(find src -name '*.java')
"$BT/d8" --release --min-api 24 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk

[ -f weiqi.keystore ] || keytool -genkeypair -keystore weiqi.keystore -alias weiqi -keyalg RSA -keysize 2048 \
    -validity 10000 -storepass weiqi123 -keypass weiqi123 -dname "CN=Weiqi Bot"
"$BT/apksigner" sign --ks weiqi.keystore --ks-pass pass:weiqi123 --key-pass pass:weiqi123 \
    --out weiqi-coach.apk build/aligned.apk
"$BT/apksigner" verify weiqi-coach.apk && ls -la weiqi-coach.apk
