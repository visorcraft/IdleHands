#!/usr/bin/env bash
set -euo pipefail

# Exit codes
EXIT_SUCCESS=0
EXIT_ERROR=1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if running in git repository
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log_error "Not in a git repository"
    exit $EXIT_ERROR
fi

# Check for uncommitted changes
if [[ -n "$(git status --porcelain)" ]]; then
    log_error "Working directory is not clean. Please commit or stash changes first."
    git status
    exit $EXIT_ERROR
fi

# Get current version from package.json
CURRENT_VERSION=$(node -p "require('./package.json').version")
log_info "Current version: $CURRENT_VERSION"

# Parse version components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"

log_info "Updating to version: $NEW_VERSION"

# Step 1: Run validation checks
log_info "Running validation checks..."

# Run TypeScript compilation
log_info "Running TypeScript compilation..."
if ! pnpm tsgo; then
    log_error "TypeScript compilation failed"
    exit $EXIT_ERROR
fi

# Run targeted tests for changed areas
# Get list of changed files to determine what tests to run
if git diff --quiet HEAD~1..HEAD; then
    # No recent commits, run full test suite
    log_info "No recent commits detected, running full test suite..."
    if ! pnpm test; then
        log_error "Tests failed"
        exit $EXIT_ERROR
    fi
else
    # Run tests for changed files
    log_info "Running tests for changed files..."
    if ! pnpm test:impacted; then
        log_error "Tests for changed files failed"
        exit $EXIT_ERROR
    fi
fi

log_info "Validation checks passed"

# Step 2: Bump package version
log_info "Bumping package version to $NEW_VERSION..."

# Update package.json version
node -e "const fs = require('fs'); const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')); pkg.version = '$NEW_VERSION'; fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');"

# Update package-lock.json if it exists
if [ -f "package-lock.json" ]; then
    sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" package-lock.json 2>/dev/null || true
fi

log_info "Package version updated"

# Step 3: Commit and push
log_info "Committing and pushing changes..."

# Add package.json and package-lock.json
git add package.json package-lock.json 2>/dev/null || true

# Commit the changes
git commit -m "chore: release $NEW_VERSION"

# Push to main
git push origin main

log_info "Changes pushed to main"

# Step 4: Create tag and release
log_info "Creating git tag v$NEW_VERSION..."

# Create the tag
git tag -a "v$NEW_VERSION" -m "Release version $NEW_VERSION"

# Push the tag
git push origin "v$NEW_VERSION"

log_info "Tag v$NEW_VERSION created and pushed"

# Get the changelog for this release
CHANGELOG_SECTION=$(awk -v ver="$NEW_VERSION" '/^## / { if (found) exit; if ($0 ~ ver) found=1; next } found' CHANGELOG.md)

if [ -n "$CHANGELOG_SECTION" ]; then
    log_info "Changelog for v$NEW_VERSION:"
    echo "$CHANGELOG_SECTION"
    
    # Create GitHub release using gh CLI
    log_info "Publishing GitHub release..."
    
    # Extract just the release notes (lines after the version header until next header or EOF)
    RELEASE_NOTES=$(awk -v ver="$NEW_VERSION" '
        /^## / { 
            if (found) exit
            if ($0 ~ ver) {
                found=1
                next
            }
        }
        found && /^## / { exit }
        found { print }
    ' CHANGELOG.md)
    
    if [ -n "$RELEASE_NOTES" ]; then
        # Create release with notes
        gh release create "v$NEW_VERSION" \
            --title "Release $NEW_VERSION" \
            --notes "$RELEASE_NOTES" \
            --generate-notes 2>/dev/null || \
        gh release create "v$NEW_VERSION" \
            --title "Release $NEW_VERSION" \
            --notes "$RELEASE_NOTES"
        
        log_info "GitHub release created successfully"
    else
        log_warn "No changelog found for this version, creating release without notes"
        gh release create "v$NEW_VERSION" --title "Release $NEW_VERSION"
        log_info "GitHub release created"
    fi
else
    log_warn "Could not find changelog entry for v$NEW_VERSION"
    log_info "Creating GitHub release without changelog..."
    gh release create "v$NEW_VERSION" --title "Release $NEW_VERSION"
    log_info "GitHub release created"
fi

log_info "Release $NEW_VERSION completed successfully!"
exit $EXIT_SUCCESS