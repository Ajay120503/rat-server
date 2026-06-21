#!/bin/bash
# ========================================
# APK Builder Script
# App: TestApp
# Package: com.test.app
# Build ID: 8df9466b-9ea6-4737-8d04-e7328f4fd577
# Server URL: http://localhost:5000
# ========================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}[*] Building APK: TestApp${NC}"

# Check Android SDK
if [ -z "$ANDROID_HOME" ] && [ -z "$ANDROID_SDK_ROOT" ]; then
    echo -e "${RED}[!] ANDROID_HOME not set${NC}"
    echo "Set it: export ANDROID_HOME=/path/to/android/sdk"
    exit 1
fi

echo -e "${GREEN}[✓] Android SDK found${NC}"

# Navigate to android-agent directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/android-agent"

if [ ! -f "gradlew" ]; then
    echo -e "${RED}[!] android-agent directory not found at: $(pwd)${NC}"
    echo -e "${YELLOW}Please ensure android-agent/ is in the same directory as this script${NC}"
    exit 1
fi

# Update strings.xml with server URLs
STRINGS_FILE="app/src/main/res/values/strings.xml"
if [ -f "$STRINGS_FILE" ]; then
    echo -e "${YELLOW}[*] Updating server URLs...${NC}"
    # Replace server_url in strings.xml
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' 's|<string name="server_url".*</string>|<string name="server_url" translatable="false">http://localhost:5000</string>|g' "$STRINGS_FILE"
        sed -i '' 's|<string name="ws_url".*</string>|<string name="ws_url" translatable="false">http://localhost:5000</string>|g' "$STRINGS_FILE"
    else
        sed -i 's|<string name="server_url".*</string>|<string name="server_url" translatable="false">http://localhost:5000</string>|g' "$STRINGS_FILE"
        sed -i 's|<string name="ws_url".*</string>|<string name="ws_url" translatable="false">http://localhost:5000</string>|g' "$STRINGS_FILE"
    fi
    echo -e "${GREEN}[✓] Server URLs updated${NC}"
fi

# Make gradlew executable
chmod +x gradlew

# Clean and build
echo -e "${YELLOW}[*] Building APK (this may take a few minutes)...${NC}"
./gradlew clean assembleDebug

# Check if build succeeded
APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK_PATH" ]; then
    echo ""
    echo -e "${GREEN}========================================"
    echo "  BUILD SUCCESSFUL!"
    echo "========================================${NC}"
    echo ""
    echo "  APK Location: $(pwd)/$APK_PATH"
    echo "  Size: $(ls -lh "$APK_PATH" | awk '{print $5}')"
    echo ""
    echo "  Install on device:"
    echo "  adb install $APK_PATH"
    echo ""
else
    echo ""
    echo -e "${RED}========================================"
    echo "  BUILD FAILED"
    echo "========================================${NC}"
    echo ""
    echo "  Check the error above or run:"
    echo "  ./gradlew assembleDebug --stacktrace"
    echo ""
    exit 1
fi
