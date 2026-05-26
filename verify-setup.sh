#!/bin/bash

# Verification script to check if the plugin is ready for testing
# Run this before attempting to build or test

echo "🔍 Verifying OneDrive Sync Plugin Setup..."
echo ""

# Check Node.js version
echo "Checking Node.js version..."
NODE_VERSION=$(node -v)
echo "✓ Node.js: $NODE_VERSION"

if [[ ! "$NODE_VERSION" =~ ^v(18|19|20|21) ]]; then
    echo "⚠️  Warning: Node.js 18+ is recommended. Current version: $NODE_VERSION"
fi
echo ""

# Check if node_modules exists
if [ -d "node_modules" ]; then
    echo "✓ node_modules directory exists"
else
    echo "❌ node_modules not found. Run: npm install"
    exit 1
fi
echo ""

# Check critical source files
echo "Checking source files..."
REQUIRED_FILES=(
    "src/constants.ts"
    "src/types.ts"
    "src/auth/deviceCodeFlow.ts"
    "src/auth/tokenStorage.ts"
    "src/auth/authProvider.ts"
    "src/api/oneDriveClient.ts"
    "src/api/fileOperations.ts"
    "src/api/chunkUpload.ts"
    "src/sync/eventManager.ts"
    "src/sync/syncEngine.ts"
    "src/sync/syncState.ts"
    "src/sync/conflictResolver.ts"
    "src/ui/settings.ts"
    "src/ui/statusBar.ts"
    "src/ui/modals.ts"
    "src/ui/authModal.ts"
    "src/utils/errors.ts"
    "src/utils/logger.ts"
    "src/utils/retry.ts"
    "src/utils/pathUtils.ts"
    "main.ts"
)

MISSING_FILES=()
for file in "${REQUIRED_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "  ✓ $file"
    else
        echo "  ❌ $file (MISSING)"
        MISSING_FILES+=("$file")
    fi
done

if [ ${#MISSING_FILES[@]} -gt 0 ]; then
    echo ""
    echo "❌ Missing ${#MISSING_FILES[@]} required file(s)"
    exit 1
fi
echo ""

# Check if client ID is configured
echo "Checking Azure AD client ID configuration..."
if grep -q "YOUR_CLIENT_ID_HERE" src/constants.ts; then
    echo "⚠️  WARNING: Default client ID placeholder detected in src/constants.ts"
    echo "    You MUST register an Azure AD app and update this value before the plugin will work."
    echo "    See SETUP_GUIDE.md for instructions."
    echo ""
    echo "    Steps:"
    echo "    1. Register app at https://portal.azure.com"
    echo "    2. Copy Application (client) ID"
    echo "    3. Replace 'YOUR_CLIENT_ID_HERE' in src/constants.ts"
    echo "    4. Enable 'Allow public client flows' in Azure AD"
else
    echo "✓ Client ID appears to be configured (not using placeholder)"
fi
echo ""

# Check test files
echo "Checking test files..."
TEST_FILES=$(find tests -name "*.test.ts" | wc -l)
echo "✓ Found $TEST_FILES test file(s)"
echo ""

# Check configuration files
echo "Checking configuration files..."
CONFIG_FILES=(
    "package.json"
    "tsconfig.json"
    "vitest.config.ts"
    ".eslintrc.json"
    ".prettierrc"
    "manifest.json"
)

for file in "${CONFIG_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "  ✓ $file"
    else
        echo "  ❌ $file (MISSING)"
    fi
done
echo ""

# Try to run type check
echo "Running TypeScript type check..."
if npm run typecheck > /dev/null 2>&1; then
    echo "✓ TypeScript compilation successful"
else
    echo "❌ TypeScript compilation failed"
    echo "   Run: npm run typecheck"
    echo "   to see detailed errors"
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Setup Verification Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ${#MISSING_FILES[@]} -eq 0 ]; then
    echo "✅ All required files present"
else
    echo "❌ Missing ${#MISSING_FILES[@]} file(s)"
    exit 1
fi

if grep -q "YOUR_CLIENT_ID_HERE" src/constants.ts; then
    echo "⚠️  Azure AD client ID NOT configured (required)"
    echo ""
    echo "🔧 Next Steps:"
    echo "  1. Register Azure AD app (see SETUP_GUIDE.md)"
    echo "  2. Update src/constants.ts with client ID"
    echo "  3. Run: npm run build"
    echo "  4. Test in Obsidian"
else
    echo "✅ Azure AD client ID configured"
    echo ""
    echo "🎯 Ready to build and test!"
    echo ""
    echo "Next steps:"
    echo "  1. npm run build"
    echo "  2. Copy main.js and manifest.json to vault/.obsidian/plugins/obsidian-onedrive/"
    echo "  3. Enable plugin in Obsidian"
    echo "  4. Test authentication and sync"
fi

echo ""
echo "For detailed setup instructions, see SETUP_GUIDE.md"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
