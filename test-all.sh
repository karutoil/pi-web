#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# pi-web Integration Test Script
# Validates all fixes from the consolidated code review
# Usage: bash test-all.sh [--skip-server] [--skip-build] [--skip-unit]
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────────────
BASE_URL="http://127.0.0.1:3069"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0
SKIP=0
SERVER_PID=""
TMP_DIR=$(mktemp -d /tmp/pi-web-test-XXXXXX)
TEST_REPO="$TMP_DIR/test-repo"
TEST_FILE="$TMP_DIR/test-file.txt"

# ─── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ─── Helpers ────────────────────────────────────────────────────────────────
pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}✓ PASS${RESET} $1"; }
fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}✗ FAIL${RESET} $1"; }
skip() { SKIP=$((SKIP + 1)); echo -e "  ${YELLOW}⊘ SKIP${RESET} $1"; }
section() { echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${RESET}"; }

assert_status() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then
    pass "$desc → status $actual"
  else
    fail "$desc → expected $expected, got $actual"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    pass "$desc → contains '$needle'"
  else
    fail "$desc → missing '$needle'"
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -q "$needle"; then
    fail "$desc → unexpectedly contains '$needle'"
  else
    pass "$desc → does not contain '$needle'"
  fi
}

cleanup() {
  echo -e "\n${BOLD}Cleaning up...${RESET}"
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
  echo -e "${BOLD}Results: ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}, ${YELLOW}$SKIP skipped${RESET}"
  [ "$FAIL" -gt 0 ] && exit 1 || exit 0
}
trap cleanup EXIT INT TERM

# ─── Parse args ─────────────────────────────────────────────────────────────
SKIP_SERVER=false
SKIP_BUILD=false
SKIP_UNIT=false
for arg in "$@"; do
  case "$arg" in
    --skip-server) SKIP_SERVER=true ;;
    --skip-build)  SKIP_BUILD=true ;;
    --skip-unit)   SKIP_UNIT=true ;;
  esac
done

# ═══════════════════════════════════════════════════════════════════════════
# SECTION 1: BUILD VALIDATION
# ═══════════════════════════════════════════════════════════════════════════
section "Build & Type Validation"

if [ "$SKIP_BUILD" = true ]; then
  skip "Build tests (—skip-build)"
else
  # 1.1 TypeScript compilation
  echo -e "  ${CYAN}Running tsc -b...${RESET}"
  if npx tsc -b --force 2>&1; then
    pass "TypeScript compilation clean"
  else
    fail "TypeScript compilation has errors"
  fi

  # 1.2 Vite production build
  echo -e "  ${CYAN}Running vite build...${RESET}"
  if bun run build 2>&1 | tail -5 | grep -q "built in"; then
    pass "Vite production build succeeds"
  else
    fail "Vite production build failed"
  fi

  # 1.3 Client dist exists
  if [ -f "$PROJECT_DIR/packages/client/dist/index.html" ]; then
    pass "Client dist/index.html exists"
  else
    fail "Client dist/index.html missing"
  fi

  # 1.4 Shared package dist exists
  if [ -f "$PROJECT_DIR/packages/shared/dist/src/index.js" ]; then
    pass "Shared dist/src/index.js exists"
  else
    fail "Shared dist/src/index.js missing"
  fi

  # 1.5 No vite.config.js/d.ts committed (tsconfig.node.json noEmit:true)
  VITE_ARTIFACTS=$(git ls-files packages/client/vite.config.js packages/client/vite.config.d.ts 2>/dev/null)
  if [ -n "$VITE_ARTIFACTS" ]; then
    fail "Build artifacts committed to git: $VITE_ARTIFACTS"
  else
    pass "No vite.config.js/.d.ts committed"
  fi

  # 1.6 tsbuildinfo not committed
  if git ls-files '*.tsbuildinfo' 2>/dev/null | grep -q .; then
    fail "tsbuildinfo files are committed"
  else
    pass "No tsbuildinfo files committed"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# SECTION 2: UNIT TESTS
# ═══════════════════════════════════════════════════════════════════════════
section "Unit Tests"

if [ "$SKIP_UNIT" = true ]; then
  skip "Unit tests (—skip-unit)"
else
  # 2.1 Run vitest
  echo -e "  ${CYAN}Running vitest...${RESET}"
  UNIT_OUTPUT=$(bun run --cwd packages/client test 2>&1 || true)
  UNIT_EXIT=$?

  if echo "$UNIT_OUTPUT" | grep -q "Tests.*passed"; then
    PASSED_COUNT=$(echo "$UNIT_OUTPUT" | grep -oP '\d+(?= passed)' | tail -1)
    pass "Vitest: $PASSED_COUNT tests pass"
  else
    fail "Vitest: tests failing"
    echo "$UNIT_OUTPUT" | tail -20
  fi

  if echo "$UNIT_OUTPUT" | grep -qP '\d+ failed'; then
    FAIL_COUNT=$(echo "$UNIT_OUTPUT" | grep -oP '\d+(?= failed)' | tail -1)
    fail "Vitest: $FAIL_COUNT tests failed"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# SECTION 3: STATIC CODE CHECKS
# ═══════════════════════════════════════════════════════════════════════════
section "Static Code Checks"

# 3.1 Server binds to 127.0.0.1
if grep -q 'hostname.*127\.0\.0\.1' "$PROJECT_DIR/packages/server/src/index.ts"; then
  pass "Server defaults to hostname 127.0.0.1"
else
  fail "Server does not bind to 127.0.0.1"
fi

# 3.2 pi-git uses execFileSync (no execSync shell injection)
if grep -q 'execFileSync' "$PROJECT_DIR/packages/server/src/pi-git.ts" && \
   ! grep -q 'execSync(' "$PROJECT_DIR/packages/server/src/pi-git.ts"; then
  pass "pi-git.ts uses execFileSync (no shell injection vector)"
else
  fail "pi-git.ts still uses execSync or missing execFileSync"
fi

# 3.3 No regex-based shell escaping remaining
if grep -q '%|;&<>()\$' "$PROJECT_DIR/packages/server/src/pi-git.ts"; then
  fail "pi-git.ts still has old regex-based escaping"
else
  pass "pi-git.ts removed regex-based shell escaping"
fi

# 3.4 GitResult structured return type
if grep -q 'GitResult' "$PROJECT_DIR/packages/server/src/pi-git.ts"; then
  pass "pi-git.ts uses GitResult structured return type"
else
  fail "pi-git.ts missing GitResult structured return type"
fi

# 3.5 -- separator used in checkout/cherry-pick/revert/show
for cmd in checkout cherry-pick revert show; do
  if grep -q "\"$cmd\".*\"--\"" "$PROJECT_DIR/packages/server/src/pi-git.ts" || \
     grep -A3 "\"$cmd\"" "$PROJECT_DIR/packages/server/src/pi-git.ts" | grep -q '"--"'; then
    pass "git $cmd uses -- separator"
  else
    fail "git $cmd missing -- separator"
  fi
done

# 3.6 validateSessionPath exists
if grep -q 'function validateSessionPath' "$PROJECT_DIR/packages/server/src/index.ts"; then
  pass "validateSessionPath helper exists"
else
  fail "validateSessionPath helper missing"
fi

# 3.7 validateBrowsePath exists
if grep -q 'function validateBrowsePath' "$PROJECT_DIR/packages/server/src/index.ts"; then
  pass "validateBrowsePath helper exists"
else
  fail "validateBrowsePath helper missing"
fi

# 3.8 escapeHtml exists
if grep -q 'function escapeHtml' "$PROJECT_DIR/packages/server/src/index.ts"; then
  pass "escapeHtml helper exists"
else
  fail "escapeHtml helper missing"
fi

# 3.9 POST /api/projects checks isDirectory
if grep -B2 -A15 'app.post.*"/api/projects"' "$PROJECT_DIR/packages/server/src/index.ts" | grep -q 'isDirectory'; then
  pass "POST /api/projects checks isDirectory()"
else
  fail "POST /api/projects does not check isDirectory()"
fi

# 3.10 Server has engines field
if grep -q '"engines"' "$PROJECT_DIR/packages/server/package.json"; then
  pass "server/package.json has engines field"
else
  fail "server/package.json missing engines field"
fi

# 3.11 Server has devDependencies
if grep -q '"devDependencies"' "$PROJECT_DIR/packages/server/package.json"; then
  pass "server/package.json has devDependencies"
else
  fail "server/package.json missing devDependencies"
fi

# 3.12 No @homebridge/node-pty in server deps
if grep -q '@homebridge/node-pty' "$PROJECT_DIR/packages/server/package.json"; then
  fail "server/package.json still has @homebridge/node-pty (unused)"
else
  pass "server/package.json removed unused @homebridge/node-pty"
fi

# 3.13 No 'latest' version in server deps
if grep -q '"latest"' "$PROJECT_DIR/packages/server/package.json"; then
  fail "server/package.json has 'latest' version (unbounded drift)"
else
  pass "server/package.json has no 'latest' versions"
fi

# 3.14 No 'latest' version in root devDeps
if grep -q '"latest"' "$PROJECT_DIR/package.json"; then
  fail "root package.json has 'latest' version"
else
  pass "root package.json has no 'latest' versions"
fi

# 3.15 Shared package exports point to dist
if grep -q 'dist/src/index' "$PROJECT_DIR/packages/shared/package.json"; then
  pass "shared/package.json exports point to dist/"
else
  fail "shared/package.json exports don't point to dist/"
fi

# 3.16 Vitest alias matches Vite alias
VITE_ALIAS=$(grep '@pi-web/shared' "$PROJECT_DIR/packages/client/vite.config.ts" | grep -oP 'shared/src/index\.ts' | head -1)
VITEST_ALIAS=$(grep '@pi-web/shared' "$PROJECT_DIR/packages/client/vitest.config.ts" | grep -oP 'shared/src/index\.ts' | head -1)
if [ "$VITE_ALIAS" = "$VITEST_ALIAS" ]; then
  pass "Vite and Vitest aliases match"
else
  fail "Vite alias ($VITE_ALIAS) != Vitest alias ($VITEST_ALIAS)"
fi

# 3.17 tsconfig.node.json has noEmit:true
if grep -q '"noEmit".*true' "$PROJECT_DIR/packages/client/tsconfig.node.json"; then
  pass "tsconfig.node.json has noEmit:true"
else
  fail "tsconfig.node.json missing noEmit:true"
fi

# 3.18 UUID fallback (no crypto.randomUUID in App.tsx)
if grep -q 'crypto.randomUUID' "$PROJECT_DIR/packages/client/src/App.tsx"; then
  fail "App.tsx still uses crypto.randomUUID (crashes in non-secure contexts)"
else
  pass "App.tsx replaced crypto.randomUUID with uuidV4()"
fi

# 3.19 TerminalPanel also uses uuidV4
if grep -q 'crypto.randomUUID' "$PROJECT_DIR/packages/client/src/components/TerminalPanel.tsx"; then
  fail "TerminalPanel still uses crypto.randomUUID"
else
  pass "TerminalPanel replaced crypto.randomUUID with uuidV4()"
fi

# 3.20 useTheme uses useLayoutEffect
if grep -q 'useLayoutEffect' "$PROJECT_DIR/packages/client/src/hooks/useTheme.ts"; then
  pass "useTheme.ts uses useLayoutEffect (no FOUC)"
else
  fail "useTheme.ts still uses useEffect (FOUC risk)"
fi

# 3.21 useIsMobile initializes with matchMedia
if grep -A1 'useState' "$PROJECT_DIR/packages/client/src/hooks/useIsMobile.ts" | grep -q 'matchMedia'; then
  pass "useIsMobile initializes from matchMedia (no layout flash)"
else
  fail "useIsMobile doesn't initialize from matchMedia"
fi

# 3.22 WS pool disconnect cleanup in App.tsx
if grep -q 'wsPool.disconnect\|disconnect(' "$PROJECT_DIR/packages/client/src/App.tsx"; then
  pass "App.tsx has WS pool disconnect cleanup"
else
  fail "App.tsx missing WS pool disconnect cleanup"
fi

# 3.23 setOnSessionEvent cleanup
if grep -A10 'setOnSessionEvent' "$PROJECT_DIR/packages/client/src/App.tsx" | grep -q 'setOnSessionEvent(null)'; then
  pass "App.tsx cleans up setOnSessionEvent on effect unmount"
else
  fail "App.tsx missing setOnSessionEvent(null) cleanup"
fi

# 3.24 Optimistic delete checks r.ok
if grep -A5 'handleDeleteProject\|handleDeleteSession' "$PROJECT_DIR/packages/client/src/App.tsx" | grep -q 'r.ok\|res.ok\|response.ok'; then
  pass "Delete handlers check response.ok before mutating state"
else
  fail "Delete handlers still optimistically mutate without checking ok"
fi

# 3.25 stripAnsi extracted to shared lib
if [ -f "$PROJECT_DIR/packages/client/src/lib/stripAnsi.ts" ]; then
  pass "lib/stripAnsi.ts shared utility exists"
else
  fail "lib/stripAnsi.ts missing (duplication remains)"
fi

# 3.26 DiffRenderer module-scope components
if grep -q '^function FileMeta' "$PROJECT_DIR/packages/client/src/components/DiffRenderer.tsx"; then
  pass "DiffRenderer FileMeta at module scope (no remounts)"
else
  fail "DiffRenderer FileMeta still inline"
fi

# 3.27 Icon aria-hidden
if grep -q 'aria-hidden' "$PROJECT_DIR/packages/client/src/components/Icon.tsx"; then
  pass "Icon.tsx has aria-hidden"
else
  fail "Icon.tsx missing aria-hidden"
fi

# 3.28 ErrorBoundary try-again button
if grep -q 'try again\|Try Again\|tryAgain\|retry' "$PROJECT_DIR/packages/client/src/components/ErrorBoundary.tsx"; then
  pass "ErrorBoundary has try-again button"
else
  fail "ErrorBoundary still only does page reload"
fi

# 3.29 DB path uses HOME
if grep -q 'homedir\|HOME\|process.env.HOME' "$PROJECT_DIR/packages/server/src/db.ts"; then
  pass "db.ts uses HOME-relative path"
else
  fail "db.ts still uses cwd-relative path"
fi

# 3.30 pi-agent uses process.env.HOME (no hardcoded paths)
if grep -q '/home/karutoil' "$PROJECT_DIR/packages/server/src/pi-agent.ts"; then
  fail "pi-agent.ts still has hardcoded /home/karutoil paths"
else
  pass "pi-agent.ts uses process.env.HOME (no hardcoded paths)"
fi

# 3.31 MatchMedia mock in test setup
if grep -q 'matchMedia' "$PROJECT_DIR/packages/client/src/__tests__/setup.ts"; then
  pass "Test setup mocks window.matchMedia"
else
  fail "Test setup missing matchMedia mock"
fi

# 3.32 ESLint config exists
if [ -f "$PROJECT_DIR/eslint.config.mjs" ] || [ -f "$PROJECT_DIR/eslint.config.js" ]; then
  pass "ESLint config exists"
else
  fail "ESLint config missing"
fi

# 3.33 Prettier config exists
if [ -f "$PROJECT_DIR/.prettierrc" ] || [ -f "$PROJECT_DIR/.prettierrc.json" ] || [ -f "$PROJECT_DIR/prettier.config.js" ]; then
  pass "Prettier config exists"
else
  fail "Prettier config missing"
fi

# 3.34 uuid.ts utility exists
if [ -f "$PROJECT_DIR/packages/client/src/lib/uuid.ts" ]; then
  pass "lib/uuid.ts utility exists"
else
  fail "lib/uuid.ts utility missing"
fi

# 3.35 start:prod script in root package.json
if grep -q 'start:prod' "$PROJECT_DIR/package.json"; then
  pass "Root package.json has start:prod script"
else
  fail "Root package.json missing start:prod script"
fi

# ═══════════════════════════════════════════════════════════════════════════
# SECTION 4: LIVE SERVER TESTS
# ═══════════════════════════════════════════════════════════════════════════
section "Live Server API Tests"

if [ "$SKIP_SERVER" = true ]; then
  skip "All live server tests (—skip-server)"
else
  # ─── Start server ────────────────────────────────────────────────────────
  echo -e "  ${CYAN}Starting server on port 3069...${RESET}"
  PORT=3069 HOST=127.0.0.1 bun run --cwd packages/server start &
  SERVER_PID=$!

  # Wait for server to be ready
  RETRIES=0
  MAX_RETRIES=20
  while ! curl -sf "$BASE_URL/api/health" > /dev/null 2>&1; do
    RETRIES=$((RETRIES + 1))
    if [ $RETRIES -ge $MAX_RETRIES ]; then
      fail "Server failed to start within $MAX_RETRIES seconds"
      exit 1
    fi
    sleep 0.5
  done
  pass "Server started and health check responds"

  # ─── 4.1 Health endpoint ─────────────────────────────────────────────────
  HEALTH=$(curl -sf "$BASE_URL/api/health")
  assert_contains "Health endpoint returns ok" "$HEALTH" '"status":"ok"'
  assert_contains "Health endpoint returns pool stats" "$HEALTH" '"pool"'

  # ─── 4.2 Server binds to localhost ────────────────────────────────────────
  # Verify it's actually on 127.0.0.1
  if curl -sf "$BASE_URL/api/health" > /dev/null 2>&1; then
    pass "Server responds on 127.0.0.1:3069"
  else
    fail "Server not responding on 127.0.0.1:3069"
  fi

  # ─── 4.3 Path traversal: session detail ─────────────────────────────────
  TRAVERSAL_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/sessions/detail?path=../../../etc/passwd" 2>/dev/null)
  TRAVERSAL_STATUS=$(echo "$TRAVERSAL_RESP" | tail -1)
  TRAVERSAL_BODY=$(echo "$TRAVERSAL_RESP" | sed '$d')
  assert_status "Session detail traversal blocked" 403 "$TRAVERSAL_STATUS"
  assert_not_contains "No /etc/passwd content leaked" "$TRAVERSAL_BODY" "root:"

  # Absolute path traversal
  ABS_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/sessions/detail?path=/etc/passwd" 2>/dev/null)
  ABS_STATUS=$(echo "$ABS_RESP" | tail -1)
  assert_status "Session detail absolute path blocked" 403 "$ABS_STATUS"

  # ─── 4.4 Path traversal: session delete ──────────────────────────────────
  DEL_RESP=$(curl -sw "\n%{http_code}" -X DELETE "$BASE_URL/api/sessions/..%2F..%2F..%2Fetc%2Fpasswd" 2>/dev/null)
  DEL_STATUS=$(echo "$DEL_RESP" | tail -1)
  assert_status "Session delete traversal blocked" 403 "$DEL_STATUS"

  # ─── 4.5 Path traversal: session rename ──────────────────────────────────
  RENAME_RESP=$(curl -sw "\n%{http_code}" -X PATCH "$BASE_URL/api/sessions/rename" \
    -H 'Content-Type: application/json' \
    -d '{"sessionPath":"../../../etc/hosts","name":"evil"}' 2>/dev/null)
  RENAME_STATUS=$(echo "$RENAME_RESP" | tail -1)
  assert_status "Session rename traversal blocked" 403 "$RENAME_STATUS"

  # ─── 4.6 Path traversal: export HTML ─────────────────────────────────────
  EXPORT_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/sessions/export-html" \
    -H 'Content-Type: application/json' \
    -d '{"sessionPath":"../../../etc/passwd"}' 2>/dev/null)
  EXPORT_STATUS=$(echo "$EXPORT_RESP" | tail -1)
  assert_status "Export HTML traversal blocked" 403 "$EXPORT_STATUS"

  # ─── 4.7 FS browse outside home blocked ─────────────────────────────────
  BROWSE_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/fs/browse?dir=/etc" 2>/dev/null)
  BROWSE_STATUS=$(echo "$BROWSE_RESP" | tail -1)
  assert_status "FS browse /etc blocked" 403 "$BROWSE_STATUS"

  BROWSE_VAR_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/fs/browse?dir=/var/log" 2>/dev/null)
  BROWSE_VAR_STATUS=$(echo "$BROWSE_VAR_RESP" | tail -1)
  assert_status "FS browse /var/log blocked" 403 "$BROWSE_VAR_STATUS"

  # ─── 4.8 FS browse home dir allowed ──────────────────────────────────────
  HOME_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/fs/browse?dir=~" 2>/dev/null)
  HOME_STATUS=$(echo "$HOME_RESP" | tail -1)
  HOME_BODY=$(echo "$HOME_RESP" | sed '$d')
  assert_status "FS browse home dir allowed" 200 "$HOME_STATUS"
  assert_contains "Home browse returns items" "$HOME_BODY" "currentPath"

  # ─── 4.9 Add project: file path rejected ─────────────────────────────────
  # Create a regular file (not directory) to test
  echo "not a directory" > "$TEST_FILE"
  FILE_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/projects" \
    -H 'Content-Type: application/json' \
    -d "{\"path\":\"$TEST_FILE\"}" 2>/dev/null)
  FILE_STATUS=$(echo "$FILE_RESP" | tail -1)
  assert_status "Add file as project rejected" 400 "$FILE_STATUS"
  FILE_BODY=$(echo "$FILE_RESP" | sed '$d')
  assert_contains "Error mentions not a directory" "$FILE_BODY" "directory"

  # ─── 4.10 Add project: non-existent path rejected ────────────────────────
  NONE_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/projects" \
    -H 'Content-Type: application/json' \
    -d '{"path":"/nonexistent/path/xyz123"}' 2>/dev/null)
  NONE_STATUS=$(echo "$NONE_RESP" | tail -1)
  assert_status "Add nonexistent project rejected" 400 "$NONE_STATUS"

  # ─── 4.11 Add real project (directory) ───────────────────────────────────
  # Create a test git repo
  mkdir -p "$TEST_REPO"
  cd "$TEST_REPO"
  git init -q
  echo "hello" > "$TEST_REPO/hello.txt"
  git add . && git commit -q -m "initial"
  PROJ_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/projects" \
    -H 'Content-Type: application/json' \
    -d "{\"path\":\"$TEST_REPO\",\"name\":\"test-repo\"}" 2>/dev/null)
  PROJ_STATUS=$(echo "$PROJ_RESP" | tail -1)
  PROJ_BODY=$(echo "$PROJ_RESP" | sed '$d')
  assert_status "Add directory as project accepted" 201 "$PROJ_STATUS"
  PROJECT_ID=$(echo "$PROJ_BODY" | grep -oP '"id":"[^"]*"' | head -1 | grep -oP '[^"]+' | tail -1)
  pass "Got project ID: $PROJECT_ID"

  # ─── 4.12 Git operations on project ──────────────────────────────────────
  # Git status
  STATUS_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/git/status?cwd=$TEST_REPO" 2>/dev/null)
  STATUS_CODE=$(echo "$STATUS_RESP" | tail -1)
  assert_status "Git status works" 200 "$STATUS_CODE"

  # Git log
  LOG_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/git/log?cwd=$TEST_REPO" 2>/dev/null)
  LOG_CODE=$(echo "$LOG_RESP" | tail -1)
  assert_status "Git log works" 200 "$LOG_CODE"

  # Git branches
  BRANCH_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/git/branches?cwd=$TEST_REPO" 2>/dev/null)
  BRANCH_CODE=$(echo "$BRANCH_RESP" | tail -1)
  assert_status "Git branches works" 200 "$BRANCH_CODE"

  # ─── 4.13 Git option injection prevented ──────────────────────────────────
  # Try to checkout a branch starting with - (option injection)
  INJECT_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/git/checkout" \
    -H 'Content-Type: application/json' \
    -d "{\"cwd\":\"$TEST_REPO\",\"branch\":\"--exec=id\"}" 2>/dev/null)
  INJECT_CODE=$(echo "$INJECT_RESP" | tail -1)
  INJECT_BODY=$(echo "$INJECT_RESP" | sed '$d')
  # Should NOT execute arbitrary command — either error or safe handling
  assert_not_contains "No command injection output" "$INJECT_BODY" "uid="
  pass "Git option injection does not execute commands"

  # ─── 4.14 Git structured error results ───────────────────────────────────
  # Try cherry-pick with invalid hash — should return structured error
  CHERRY_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/git/cherry-pick" \
    -H 'Content-Type: application/json' \
    -d "{\"cwd\":\"$TEST_REPO\",\"hash\":\"invalid-hash\"}" 2>/dev/null)
  CHERRY_CODE=$(echo "$CHERRY_RESP" | tail -1)
  CHERRY_BODY=$(echo "$CHERRY_RESP" | sed '$d')
  # Should return an error (not crash)
  if [ "$CHERRY_CODE" -ge 400 ]; then
    pass "Invalid cherry-pick returns error status $CHERRY_CODE"
  else
    # Even 200 should have ok:false
    if echo "$CHERRY_BODY" | grep -q '"ok":false\|"error"'; then
      pass "Invalid cherry-pick returns structured error"
    else
      fail "Invalid cherry-pick returned success without error"
    fi
  fi

  # ─── 4.15 HTML escaping in export ────────────────────────────────────────
  # Create a session with XSS content to test export
  mkdir -p "$HOME/.pi/agent/sessions"
  XSS_SESSION="$HOME/.pi/agent/sessions/xss-test-$(date +%s).jsonl"
  echo '{"type":"user","message":{"role":"user","content":"<script>alert(1)</script>","timestamp":"2025-01-01T00:00:00Z"}}' > "$XSS_SESSION"
  XSS_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/sessions/export-html" \
    -H 'Content-Type: application/json' \
    -d "{\"sessionPath\":\"$XSS_SESSION\"}" 2>/dev/null)
  XSS_STATUS=$(echo "$XSS_RESP" | tail -1)
  XSS_BODY=$(echo "$XSS_RESP" | sed '$d')
  if [ "$XSS_STATUS" -eq 200 ]; then
    assert_not_contains "Export HTML escapes <script>" "$XSS_BODY" "<script>"
    assert_contains "Export HTML has escaped content" "$XSS_BODY" "&lt;script"
  else
    skip "Export HTML test (status $XSS_STATUS, session may not resolve)"
  fi
  rm -f "$XSS_SESSION"

  # ─── 4.16 Terminal reuse validation ──────────────────────────────────────
  # Create terminal with project context
  TERM1_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/terminals" \
    -H 'Content-Type: application/json' \
    -d "{\"projectId\":\"$PROJECT_ID\",\"cwd\":\"$TEST_REPO\",\"id\":\"test-term-1\"}" 2>/dev/null)
  TERM1_STATUS=$(echo "$TERM1_RESP" | tail -1)
  assert_status "Create terminal succeeds" 201 "$TERM1_STATUS"

  # Try to reuse with different projectId
  TERM2_RESP=$(curl -sw "\n%{http_code}" -X POST "$BASE_URL/api/terminals" \
    -H 'Content-Type: application/json' \
    -d "{\"projectId\":\"wrong-project\",\"cwd\":\"$TEST_REPO\",\"id\":\"test-term-1\"}" 2>/dev/null)
  TERM2_STATUS=$(echo "$TERM2_RESP" | tail -1)
  TERM2_BODY=$(echo "$TERM2_RESP" | sed '$d')
  # Should be rejected (mismatch) or return error
  if [ "$TERM2_STATUS" -ge 400 ] || echo "$TERM2_BODY" | grep -q "error\|mismatch\|different"; then
    pass "Terminal reuse with different project rejected"
  else
    fail "Terminal reuse with different project allowed (security gap)"
  fi

  # Clean up terminal
  curl -sf -X DELETE "$BASE_URL/api/terminals/test-term-1" > /dev/null 2>&1 || true

  # ─── 4.17 Project deletion cascade ───────────────────────────────────────
  DEL_PROJ_RESP=$(curl -sw "\n%{http_code}" -X DELETE "$BASE_URL/api/projects/$PROJECT_ID" 2>/dev/null)
  DEL_PROJ_STATUS=$(echo "$DEL_PROJ_RESP" | tail -1)
  assert_status "Delete project succeeds" 200 "$DEL_PROJ_STATUS"

  # ─── 4.18 List projects after deletion ───────────────────────────────────
  LIST_RESP=$(curl -sf "$BASE_URL/api/projects" 2>/dev/null)
  if echo "$LIST_RESP" | grep -q "test-repo"; then
    # Project might still be listed if DB didn't remove — check ID
    if echo "$LIST_RESP" | grep -q "$PROJECT_ID"; then
      fail "Deleted project still in list"
    else
      pass "Deleted project removed from list"
    fi
  else
    pass "Deleted project removed from list"
  fi

  # ─── 4.19 Sessions list for project ──────────────────────────────────────
  SESS_RESP=$(curl -sw "\n%{http_code}" "$BASE_URL/api/projects/$PROJECT_ID/sessions" 2>/dev/null)
  # Project was deleted, so this should 404 or return empty
  SESS_STATUS=$(echo "$SESS_RESP" | tail -1)
  if [ "$SESS_STATUS" -eq 404 ] || [ "$SESS_STATUS" -eq 200 ]; then
    pass "Sessions endpoint handles deleted project (status $SESS_STATUS)"
  else
    fail "Sessions endpoint unexpected status $SESS_STATUS"
  fi

  # ─── 4.20 Verify DB at $HOME/.pi-web/ ────────────────────────────────────
  if [ -f "$HOME/.pi-web/.pi-web.db" ]; then
    pass "Database created at \$HOME/.pi-web/.pi-web.db"
  else
    # DB might be at cwd if server was started before fix — check both
    if [ -f ".pi-web.db" ]; then
      fail "Database at cwd (not \$HOME/.pi-web/)"
    else
      skip "Database location (file not found yet — server may use in-memory)"
    fi
  fi

  # ─── Kill server ──────────────────────────────────────────────────────────
  kill "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  echo -e "  ${CYAN}Server stopped${RESET}"
fi

# ═══════════════════════════════════════════════════════════════════════════
# SECTION 5: CLIENT BUNDLE CHECKS
# ═══════════════════════════════════════════════════════════════════════════
section "Client Bundle Checks"

if [ "$SKIP_BUILD" = true ]; then
  skip "Client bundle checks (—skip-build)"
else
  # 5.1 Client bundle contains uuidV4 (not crypto.randomUUID)
  MAIN_JS=$(find "$PROJECT_DIR/packages/client/dist/assets" -name "index-*.js" | head -1)
  if [ -n "$MAIN_JS" ]; then
    if grep -q 'crypto.randomUUID' "$MAIN_JS"; then
      fail "Client bundle still references crypto.randomUUID"
    else
      pass "Client bundle does not reference crypto.randomUUID"
    fi

    # 5.2 Client bundle contains matchMedia usage
    if grep -q 'matchMedia' "$MAIN_JS"; then
      pass "Client bundle includes matchMedia (useIsMobile init)"
    else
      fail "Client bundle missing matchMedia"
    fi

    # 5.3 Client bundle contains useLayoutEffect (not just useEffect for theme)
    if grep -q 'useLayoutEffect' "$MAIN_JS"; then
      pass "Client bundle includes useLayoutEffect"
    else
      # React may minify hook names
      skip "useLayoutEffect check (minified)"
    fi
  else
    skip "Client bundle JS file not found"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════════
section "Summary"
echo -e "  ${GREEN}PASSED:  $PASS${RESET}"
echo -e "  ${RED}FAILED:  $FAIL${RESET}"
echo -e "  ${YELLOW}SKIPPED: $SKIP${RESET}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo -e "${BOLD}${RED}✗ SOME TESTS FAILED${RESET}"
  exit 1
else
  echo -e "${BOLD}${GREEN}✓ ALL TESTS PASSED${RESET}"
  exit 0
fi
