#!/usr/bin/env bash
# Tests for scripts/platform-boundary.sh. This file is sourced by scripts/tests/run.sh, which
# provides ok, bad, new_repo, run_in and expect; run that script, not this one. Every case builds
# a fixture tree in the scratch directory, never the real repository. The fixtures hold
# invented system paths only.
if ! declare -F run_in >/dev/null 2>&1; then
  exec bash "$(dirname "$0")/run.sh"
fi

# put <path> <line>...: writes the lines to <path> in the fixture repository.
put() {
  local path="$1"
  shift
  mkdir -p "$(dirname "$REPO/$path")"
  printf '%s\n' "$@" >"$REPO/$path"
}

# has <name> <text>: the output of the last run contains the text.
has() {
  case "$OUTPUT" in *"$2"*) ok "$1" ;; *) bad "$1 (missing: $2): $OUTPUT" ;; esac
}

hasnt() {
  case "$OUTPUT" in *"$2"*) bad "$1 (found: $2): $OUTPUT" ;; *) ok "$1" ;; esac
}

pb() { run_in platform-boundary.sh; }

boundary_script_rejects_a_new_literal() {
  new_repo
  put crates/daemon/src/x.rs 'fn a() {' '    let p = "/usr/local/bin/tool";' '}'
  pb
  expect "boundary_script_rejects_a_new_literal: status" 1
  has "boundary_script_rejects_a_new_literal: file, line and literal" 'crates/daemon/src/x.rs:2: "/usr/local/bin/tool"'
  has "boundary_script_rejects_a_new_literal: says the rule" "Rule: only crates/local/src/platform.rs"
  has "boundary_script_rejects_a_new_literal: says how to fix it" "Fix:"

  # Every root and name of the brief is caught, in a plain and a raw string.
  local lit n=0
  for lit in '"/bin/sh"' '"/sbin/x"' '"/opt/x"' '"/private/x"' '"/etc/hosts"' '"/var/x"' '"/Library/x"' \
    '"/System/x"' '"/Users/someone"' '"/dev/null"' '"/tmp/x"' '"~/Library/Caches"' '"a/Library/b"' \
    'home.join(".ssh")' 'home.join(".aws")' 'x.join("Keychains")' 'x.join("Library")' \
    'r#"/etc/x"#' 'r"/usr/x"' '"/proc/self"'; do
    n=$((n + 1))
    new_repo
    put crates/core/src/y.rs "fn a() { let _ = $lit; }"
    pb
    if [ "$STATUS" -eq 1 ]; then ok "boundary_script_rejects_a_new_literal: $lit"; else bad "boundary_script_rejects_a_new_literal: $lit not caught: $OUTPUT"; fi
  done

  # A word that only starts like a root is not a system folder.
  new_repo
  put crates/core/src/y.rs 'fn a() { let _ = "/optional"; let _ = "/devices/list"; let _ = "/variants"; }'
  pb
  expect "boundary_script_rejects_a_new_literal: a longer word is not a root" 0
}

boundary_script_allows_platform_and_tests() {
  new_repo
  put crates/local/src/platform.rs 'fn launcher() -> &'"'"'static str { "/usr/bin/sandbox-exec" }' 'fn k() { let _ = ".ssh"; }'
  put crates/daemon/tests/it.rs 'fn t() { let _ = "/Users/someone/.ssh"; }'
  put crates/client/examples/demo.rs 'fn main() { let _ = "/tmp/x"; }'
  put crates/engine/src/run_test.rs 'fn t() { let _ = "/etc/hosts"; }'
  put crates/engine/src/clean.rs 'fn a() { let _ = "~/work"; }'
  pb
  expect "boundary_script_allows_platform_and_tests: status" 0
  has "boundary_script_allows_platform_and_tests: says clean" "platform-boundary: clean"

  # A file named like the platform module elsewhere is not the platform module.
  new_repo
  put crates/daemon/src/platform.rs 'fn a() { let _ = "/etc/hosts"; }'
  pb
  expect "boundary_script_allows_platform_and_tests: only the local platform module is exempt" 1

  # Other file types are not scanned.
  new_repo
  put crates/core/README.md 'reads "/etc/hosts"'
  put crates/core/Cargo.toml 'path = "/opt/x"'
  pb
  expect "boundary_script_allows_platform_and_tests: only Rust and the sidecar sources are scanned" 0
}

marker_allows_one_line() {
  new_repo
  put crates/core/src/m.rs \
    'fn a() {' \
    '    let _ = "/dev/null"; // platform-boundary: allow (fixed profile text)' \
    '    let _ = "/dev/zero";' \
    '}'
  pb
  expect "marker_allows_one_line: the next line is still flagged" 1
  has "marker_allows_one_line: flags line 3" 'crates/core/src/m.rs:3: "/dev/zero"'
  hasnt "marker_allows_one_line: line 2 is excused" 'm.rs:2:'

  new_repo
  put crates/core/src/m.rs 'fn a() { let _ = "/dev/null"; } // platform-boundary: allow (fixed profile text)'
  pb
  expect "marker_allows_one_line: a marked line passes" 0

  new_repo
  put crates/core/src/m.rs 'fn a() { let _ = "/dev/null"; } // platform-boundary: allow'
  pb
  expect "marker_allows_one_line: a marker without a reason fails" 1
  has "marker_allows_one_line: names the bare marker" "crates/core/src/m.rs:1: marker without a reason"

  new_repo
  put crates/core/src/m.rs 'fn a() { let _ = "/dev/null"; } // platform-boundary: allow ()'
  pb
  expect "marker_allows_one_line: an empty reason fails" 1

  new_repo
  put crates/core/src/m.rs 'fn a() { let _ = "/dev/null"; } // platform-boundary: allow because'
  pb
  expect "marker_allows_one_line: a reason must be in parentheses" 1

  new_repo
  put crates/local/src/platform.rs 'fn a() {} // platform-boundary: allow'
  pb
  expect "marker_allows_one_line: a bare marker fails in the platform module too" 1

  new_repo
  put crates/core/src/m.rs '// platform-boundary: allow (about the next line)' 'fn a() { let _ = "/dev/null"; }'
  pb
  expect "marker_allows_one_line: a marker on the line above excuses nothing" 1
}

inline_test_modules_are_skipped_and_code_after_them_is_scanned() {
  new_repo
  put crates/daemon/src/t.rs \
    'fn a() {}' \
    '#[cfg(test)]' \
    'mod tests {' \
    '    const P: &str = "/usr/bin/x";' \
    '    fn braces() { let _ = "}"; let _ = '"'}'"'; /* } */ let _ = r#"}"#; }' \
    '    mod inner { const Q: &str = "/tmp/y"; }' \
    '    const R: &str = "/etc/z";' \
    '}' \
    'fn after() { let p = "/usr/bin/y"; }'
  pb
  expect "inline_test_modules_are_skipped_and_code_after_them_is_scanned: status" 1
  has "inline_test_modules_are_skipped_and_code_after_them_is_scanned: code after the block is flagged" 't.rs:9: "/usr/bin/y"'
  hasnt "inline_test_modules_are_skipped_and_code_after_them_is_scanned: block lines are not" 't.rs:4:'
  hasnt "inline_test_modules_are_skipped_and_code_after_them_is_scanned: nested module is not" 't.rs:6:'
  hasnt "inline_test_modules_are_skipped_and_code_after_them_is_scanned: later block line is not" 't.rs:7:'

  # A module with nothing after it passes.
  new_repo
  put crates/daemon/src/t.rs 'fn a() {}' '#[cfg(test)]' 'mod tests {' '    const P: &str = "/usr/bin/x";' '}'
  pb
  expect "inline_test_modules_are_skipped_and_code_after_them_is_scanned: a trailing module passes" 0

  # #[cfg(test)] on a single item starts no block.
  new_repo
  put crates/daemon/src/t.rs '#[cfg(test)]' 'fn only_in_tests() {}' 'fn b() { let p = "/usr/bin/x"; }'
  pb
  expect "inline_test_modules_are_skipped_and_code_after_them_is_scanned: a single test item does not skip" 1
  has "inline_test_modules_are_skipped_and_code_after_them_is_scanned: names line 3" 't.rs:3:'

  # A module in its own file has no block, so the code after it stays scanned.
  new_repo
  put crates/daemon/src/t.rs '#[cfg(test)]' 'mod tests;' 'fn b() { let p = "/usr/bin/x"; }'
  pb
  expect "inline_test_modules_are_skipped_and_code_after_them_is_scanned: an external test module does not skip" 1

  # Two blocks in one file, code between them is scanned.
  new_repo
  put crates/daemon/src/t.rs '#[cfg(test)]' 'mod one {' '    const A: &str = "/tmp/a";' '}' 'fn mid() { let _ = "/tmp/m"; }' '#[cfg(test)]' 'mod two {' '    const B: &str = "/tmp/b";' '}'
  pb
  has "inline_test_modules_are_skipped_and_code_after_them_is_scanned: code between two blocks is flagged" 't.rs:5: "/tmp/m"'
  hasnt "inline_test_modules_are_skipped_and_code_after_them_is_scanned: second block is skipped" 't.rs:8:'
}

git_setting_names_are_not_flagged() {
  # core.sshcommand is a git setting, not the ssh folder: the folder names (.ssh, .aws, ...)
  # count only when no letter or digit comes before the dot or after the name, so a dotted
  # setting name passes (a name inside a longer word, before or after, is not a folder) while ".ssh", "~/.ssh" and "x/.ssh/config" are found.
  new_repo
  put crates/core/src/g.rs \
    'fn a() {' \
    '    let _ = "core.sshcommand";' \
    '    let _ = "core.sshCommand";' \
    '    let _ = "user.awsprofile";' \
    '    let _ = "core.ssh";' \
    '    let _ = "~/";' \
    '    let _ = "~/work";' \
    '    let _ = "/srv/work";' \
    '}'
  pb
  expect "git_setting_names_are_not_flagged: settings and tilde syntax pass" 0

  local lit
  for lit in '".ssh"' '"~/.ssh"' '"x/.ssh/config"' '".ssh/config"' '".aws"' '".gnupg"'; do
    new_repo
    put crates/core/src/g.rs "fn a() { let _ = $lit; }"
    pb
    if [ "$STATUS" -eq 1 ]; then ok "git_setting_names_are_not_flagged: $lit is a folder and is found"; else bad "git_setting_names_are_not_flagged: $lit not caught"; fi
  done
}

comments_are_not_flagged() {
  new_repo
  put crates/core/src/c.rs \
    '//! Reads "/etc/hosts" and ~/.ssh in the module docs.' \
    '/// Where `/usr/local/bin` is; also "/Users/someone".' \
    'fn a() {' \
    '    // let p = "/opt/x";' \
    '    let _ = 1; // not "/tmp/x"' \
    '    /* a block "/var/x"' \
    '       across lines /etc/passwd "/dev/null" */' \
    '    /* outer /* nested "/usr/x" */ still "/usr/y" */' \
    '}'
  pb
  expect "comments_are_not_flagged: comments of every kind pass" 0

  # A quote or apostrophe inside a comment or a character literal does not open a string.
  new_repo
  put crates/core/src/c.rs \
    'fn a() {' \
    '    // it'"'"'s a "quote' \
    '    let q = '"'"'"'"'"';' \
    '    let l: &'"'"'static str = "ok";' \
    '    let _ = "/usr/bin/x";' \
    '}'
  pb
  expect "comments_are_not_flagged: quotes in comments and char literals do not derail the scan" 1
  has "comments_are_not_flagged: the real literal is found on its own line" 'c.rs:5: "/usr/bin/x"'

  # A slash pair inside a string is not a comment.
  new_repo
  put crates/core/src/c.rs 'fn a() { let _ = "http://x/y"; let _ = "/etc/hosts"; }'
  pb
  expect "comments_are_not_flagged: // inside a string does not hide the rest of the line" 1
}

typescript_literals_are_scanned() {
  new_repo
  put sidecars/claude/src/a.ts \
    "const a = '/usr/local/bin/node';" \
    'const b = "/Users/someone/work";' \
    'const c = `${x}/.ssh/config`;' \
    "const d = 'core.sshCommand'; // not a folder" \
    '// const e = "/etc/hosts";' \
    '/* const f = "/tmp/x" */' \
    "const g = '/etc/hosts'; // platform-boundary: allow (fixed fixture)"
  pb
  expect "typescript_literals_are_scanned: status" 1
  has "typescript_literals_are_scanned: single quotes" 'sidecars/claude/src/a.ts:1: "/usr/local/bin/node"'
  has "typescript_literals_are_scanned: double quotes" 'sidecars/claude/src/a.ts:2: "/Users/someone/work"'
  has "typescript_literals_are_scanned: template literal" 'sidecars/claude/src/a.ts:3:'
  hasnt "typescript_literals_are_scanned: setting name passes" 'a.ts:4:'
  hasnt "typescript_literals_are_scanned: comments pass" 'a.ts:5:'
  hasnt "typescript_literals_are_scanned: block comments pass" 'a.ts:6:'
  hasnt "typescript_literals_are_scanned: marker excuses its line" 'a.ts:7:'

  new_repo
  put sidecars/claude/src/a.ts "const g = '/etc/hosts'; // platform-boundary: allow"
  pb
  expect "typescript_literals_are_scanned: a marker without a reason fails" 1

  # Tests, generated sources and other trees are not scanned.
  new_repo
  put sidecars/claude/test/a.test.ts "const a = '/etc/hosts';"
  put sidecars/claude/src/generated/types.ts 'export const a = "/etc/hosts";'
  put sidecars/claude/src/b.test.ts "const a = '/etc/hosts';"
  put sidecars/claude/src/clean.ts "const a = '~/work'; const t = \`\${a}/x\`;"
  pb
  expect "typescript_literals_are_scanned: tests and generated files are not scanned" 0
}

boundary_script_rejects_a_new_literal
boundary_script_allows_platform_and_tests
marker_allows_one_line
inline_test_modules_are_skipped_and_code_after_them_is_scanned
git_setting_names_are_not_flagged
comments_are_not_flagged
typescript_literals_are_scanned
