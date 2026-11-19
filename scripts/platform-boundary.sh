#!/usr/bin/env bash
# Only crates/local/src/platform.rs names where the system keeps things. Fails, with file:line
# and the literal, when a string literal in another production source names a system folder
# (/usr, /etc, /Users, ~/Library ...) or a secret folder (.ssh, .aws ...).
#
# Scanned: crates/**/*.rs, and sidecars/claude/src/*.ts as a second pass. Not scanned: the
# platform module itself (only its markers are checked), test files (/tests/, /examples/,
# *_test.rs), inline `#[cfg(test)] mod ... { }` blocks (skipped by brace matching; code after
# the block is scanned again), comments, and generated sources. The rules mirror
# crates/local/tests/platform_boundary.rs, which scans the same crate sources from Rust.
# A line that must keep a literal carries `platform-boundary: allow (reason)`; a marker
# without a reason is an error of its own.
# Limits: only a literal that STARTS with a system root, or holds a secret folder name or a
# bare system name, is found. Not caught: a path assembled at run time (concatenation,
# format!, concat!, Path::join of a root, an escape such as \x2f), a root in the middle of a
# literal (a shell command string such as "cat /etc/..."), and upper-case variants. Review
# catches those; extending this scan to them is deliberately not attempted.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# The scanner reads one file and prints "<file>:<line>: <what>" for every finding. It walks the
# characters so that comments, character literals and multi-line strings are told apart from
# code; it never prints anything it did not find in a string literal or a marker.
read -r -d '' SCANNER <<'AWK' || true
function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
function word(ch) { return ch ~ /^[A-Za-z0-9_]$/ }

# A system folder as the start of a literal, a folder name inside it, or a bare system name.
function hit(lit,    k, r, p, nd, rest, off, before, after, lead) {
  if (!literals) return 0
  for (k = 1; k <= nroots; k++) {
    r = roots[k]
    if (substr(lit, 1, length(r)) == r && !word(substr(lit, length(r) + 1, 1))) return 1
  }
  for (k = 1; k <= nneedles; k++) {
    nd = needles[k]
    rest = lit
    off = 0
    while ((p = index(rest, nd)) > 0) {
      before = (off + p > 1) ? substr(lit, off + p - 1, 1) : ""
      after = substr(lit, off + p + length(nd), 1)
      lead = substr(nd, 1, 1)
      # A name such as .ssh counts as a folder, so core.sshCommand (a git setting) does not:
      # a letter before the dot or after the name means it is part of a longer word.
      if (!((lead == "." || word(lead)) && word(before)) \
          && !(word(substr(nd, length(nd), 1)) && word(after))) return 1
      off += p
      rest = substr(lit, off + 1)
    }
  }
  for (k = 1; k <= nnames; k++) if (tolower(lit) == names[k]) return 1
  return 0
}

function emit(lit, ln) {
  if (skipping || marked[ln]) return
  if (hit(lit)) printf "%s:%d: \"%s\"\n", file, ln, lit
}

BEGIN {
  nroots = split("/usr /bin /sbin /opt /private /etc /var /Library /System /Users /dev /tmp /proc /Volumes /Applications /.vol", roots, " ")
  nneedles = split("Library/|.ssh|.aws|.gnupg|.kube|.azure|Keychains|/.vol", needles, "|")
  nnames = split("library|keychains|launchagents|application support|admin", names, "|")
  marker = "platform-boundary: allow"
  st = 0; depth = 0; skipping = 0; attr = 0; modwait = 0
}

{
  line = $0
  n = length(line)
  at = index(line, marker)
  if (at > 0 && !skipping) {
    if (substr(line, at + length(marker)) ~ /^[ \t]*\([^)]*[A-Za-z0-9][^)]*\)/) marked[NR] = 1
    else printf "%s:%d: marker without a reason\n", file, NR
  }
  if (lang == "rs" && st == 0) {
    t = trim(line)
    if (t == "#[cfg(test)]") attr = 1
    else if (t != "") {
      if (attr && (t ~ /^mod / || t ~ /^pub mod /)) modwait = 1
      attr = 0
    }
  }
  i = 1
  while (i <= n) {
    c = substr(line, i, 1)
    c2 = substr(line, i, 2)
    if (st == 0) {
      if (c2 == "//") break
      if (c2 == "/*") { st = 1; cdepth = 1; i += 2; continue }
      if (lang == "rs") {
        if (c == "r" || c == "b") {
          j = (c == "b" && substr(line, i + 1, 1) == "r") ? i + 1 : i
          if (substr(line, j, 1) == "r" && (i == 1 || !word(substr(line, i - 1, 1)))) {
            k = j + 1
            h = 0
            while (substr(line, k + h, 1) == "#") h++
            if (substr(line, k + h, 1) == "\"") {
              st = 3; rh = h; buf = ""; litline = NR
              i = k + h + 1
              continue
            }
          }
        } else if (c == "\"") {
          st = 2; delim = "\""; buf = ""; litline = NR; i++; continue
        } else if (c == "'") {
          # A character literal is 'x' or '\x..'; anything else is a lifetime.
          if (substr(line, i + 1, 1) == "\\") {
            i += 3
            while (i <= n && substr(line, i, 1) != "'") i++
            i++
            continue
          }
          if (substr(line, i + 2, 1) == "'") { i += 3; continue }
        } else if (c == "{") {
          if (modwait) { skipping = 1; skipdepth = depth; modwait = 0 }
          depth++
        } else if (c == "}") {
          depth--
          if (skipping && depth == skipdepth) skipping = 0
        } else if (c == ";") {
          modwait = 0
        }
      } else if (c == "\"" || c == "'" || c == "`") {
        st = 2; delim = c; buf = ""; litline = NR; i++; continue
      }
      i++
    } else if (st == 1) {
      if (c2 == "*/") { cdepth--; i += 2; if (cdepth == 0) st = 0; continue }
      if (lang == "rs" && c2 == "/*") { cdepth++; i += 2; continue }
      i++
    } else if (st == 2) {
      if (c == "\\") { buf = buf c substr(line, i + 1, 1); i += 2; continue }
      if (c == delim) { emit(buf, litline); st = 0; i++; continue }
      buf = buf c
      i++
    } else {
      # Raw string: it ends at a quote followed by as many hashes as it began with.
      endq = "\""
      for (q = 0; q < rh; q++) endq = endq "#"
      if (substr(line, i, length(endq)) == endq) {
        emit(buf, litline); st = 0; i += length(endq); continue
      }
      buf = buf c
      i++
    }
  }
  if (st == 2 && lang == "ts" && delim != "`") st = 0
  else if (st == 2 || st == 3) buf = buf " "
}
AWK

found=0
scan() { # <lang> <literals 1|0> <file>
  local out
  out="$(awk -v lang="$1" -v literals="$2" -v file="$3" "$SCANNER" "$3")"
  if [ -n "$out" ]; then
    found=1
    printf '%s\n' "$out"
  fi
}

# Tracked and untracked-but-not-ignored files, NUL separated.
while IFS= read -r -d '' file; do
  [ -f "$file" ] || continue
  case "$file" in
    crates/*/tests/* | crates/*/examples/* | crates/*_test.rs) continue ;;
    crates/local/src/platform.rs) scan rs 0 "$file" ;;
    crates/*.rs) scan rs 1 "$file" ;;
    sidecars/claude/src/generated/*) ;;
    sidecars/claude/src/*.test.ts | sidecars/claude/src/*.spec.ts) ;;
    sidecars/claude/src/*.ts) scan ts 1 "$file" ;;
  esac
done < <(git ls-files -z --cached --others --exclude-standard)

if [ "$found" -ne 0 ]; then
  cat >&2 <<'TEXT'

platform-boundary: failed
Rule: only crates/local/src/platform.rs names a system folder (/usr, /etc, /Users, ~/Library ...)
      or a secret folder (.ssh, .aws ...). Tests, comments and inline test modules are exempt.
Fix:  add a function to the platform module and call it, or take the value as data from the
      caller. A line that must keep a literal carries a marker with a reason, for example
      `// platform-boundary: allow (fixed profile text)`.
TEXT
  exit 1
fi
echo "platform-boundary: clean"
