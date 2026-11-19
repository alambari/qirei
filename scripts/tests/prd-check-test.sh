#!/usr/bin/env bash
# Fixture tests for scripts/prd-check.py. Each case builds a small tree with its own FEATURE.md, ARCHITECTURE.md and
# docs/PRD, runs the checker with --root, and checks the exit code and one expected line.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../prd-check.py"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

feature() {
  cat >"$1/FEATURE.md" <<'EOF'
# Fitur
## Sumber
## 1. Menu
### Tab
### Isi
## 2. Dashboard
### Tab
## Lampiran A: belakang
### Aturan
### Sandbox
## Lampiran C: urutan
EOF
}

arch() {
  printf '# Architecture\n## API\n## Crates\n### Session screen\n' >"$1/ARCHITECTURE.md"
}

# prd <root> <lane> <file> <id> <session> <owns> <seeds> <features> <depends> [omit-section]
prd() {
  local root=$1 lane=$2 file=$3 id=$4 session=$5 owns=$6 seeds=$7 features=$8 deps=$9 omit=${10:-}
  mkdir -p "$root/docs/PRD/$lane"
  {
    echo "---"
    echo "id: $id"
    echo "lane: $lane"
    echo "session: $session"
    echo "title: Test"
    echo "tier: B"
    echo "block: D1-morning"
    echo "depends_on: [$deps]"
    echo "owns: [$owns]"
    echo "seeds: [$seeds]"
    echo "features: [$features]"
    echo 'architecture: ["API"]'
    echo "checkpoint: none"
    echo "---"
    for s in Goal Scope Contracts Requirements Tests "Done when"; do
      [ "$s" = "$omit" ] && continue
      echo "## $s"
      echo "text"
    done
  } >"$root/docs/PRD/$lane/$file"
}

base() {
  local root="$TMP/$1"
  mkdir -p "$root"
  feature "$root"
  arch "$root"
  for lane in agent-runtime integrations terminal-data ui; do mkdir -p "$root/docs/PRD/$lane"; done
  prd "$root" foundation 01-a.md F01 S1 "crates/core/src/lib.rs" "" '"1. Menu", "2. Dashboard"' ""
  prd "$root" agent-runtime 01-b.md A01 S2 "crates/engine/src/runs/**" "" '"Aturan", "Sandbox"' "F01"
  echo "$root"
}

expect() { # name root want-exit [want-substring] [forbidden-substring]
  local name=$1 root=$2 want=$3 sub=${4:-} forbid=${5:-}
  local out code
  out="$(QIREI_SCRUB_PATTERNS="$root/patterns" python3 -I "$CHECK" --root "$root" 2>&1)"
  code=$?
  if [ "$code" -ne "$want" ]; then echo "FAIL $name: exit $code, want $want"; echo "$out"; fail=1; return; fi
  if [ -n "$sub" ] && ! grep -qF -- "$sub" <<<"$out"; then echo "FAIL $name: missing '$sub'"; echo "$out"; fail=1; return; fi
  if [ -n "$forbid" ] && grep -qF -- "$forbid" <<<"$out"; then echo "FAIL $name: output holds '$forbid'"; fail=1; return; fi
  echo "ok $name"
}

r=$(base valid); expect valid_set_passes "$r" 0

r=$(base overlap)
prd "$r" integrations 01-c.md I01 S3 "crates/engine/src/runs/mod.rs" "" "" ""
expect overlapping_owns_fail "$r" 1 "owns overlaps"

r=$(base seed_ok)
prd "$r" foundation 01-a.md F01 S1 "crates/core/src/lib.rs" "crates/engine/src/runs/mod.rs" '"1. Menu", "2. Dashboard"' ""
expect seed_owned_by_lane_passes "$r" 0

r=$(base seed_lane)
prd "$r" agent-runtime 01-b.md A01 S2 "crates/engine/src/runs/**" "crates/x.rs" '"Aturan", "Sandbox"' "F01"
expect seed_in_lane_prd_fails "$r" 1 "seeds are allowed in foundation PRDs only"

r=$(base missing_feature)
prd "$r" agent-runtime 01-b.md A01 S2 "crates/engine/src/runs/**" "" '"Aturan"' "F01"
expect missing_feature_fails "$r" 1 'heading "Sandbox" is covered by no PRD'

r=$(base ancestor); expect ancestor_covers_child_passes "$r" 0

r=$(base arch_bad)
sed -i '' 's/architecture: \["API"\]/architecture: ["Nope"]/' "$r/docs/PRD/foundation/01-a.md"
expect unknown_architecture_heading_fails "$r" 1 'unknown architecture heading "Nope"'

r=$(base dep_unknown)
prd "$r" agent-runtime 01-b.md A01 S2 "crates/engine/src/runs/**" "" '"Aturan", "Sandbox"' "F09"
expect unknown_dependency_fails "$r" 1 "unknown dependency F09"

r=$(base cycle)
prd "$r" foundation 01-a.md F01 S1 "crates/core/src/lib.rs" "" '"1. Menu", "2. Dashboard"' "A01"
expect dependency_cycle_fails "$r" 1 "dependency cycle"

r=$(base section)
prd "$r" agent-runtime 01-b.md A01 S2 "crates/engine/src/runs/**" "" '"Aturan", "Sandbox"' "F01" "Tests"
expect missing_body_section_fails "$r" 1 "missing body section ## Tests"

r=$(base idname)
prd "$r" agent-runtime 01-b.md A02 S2 "crates/engine/src/runs/**" "" '"Aturan", "Sandbox"' "F01"
expect id_filename_mismatch_fails "$r" 1 "does not match file name"

r=$(base ambiguous)
prd "$r" foundation 01-a.md F01 S1 "crates/core/src/lib.rs" "" '"1. Menu", "2. Dashboard", "Tab"' ""
expect ambiguous_feature_heading_fails "$r" 1 'ambiguous feature heading "Tab"'

r=$(base pattern)
echo "secretword" >"$r/patterns"
echo "this mentions SecretWord here" >>"$r/docs/PRD/foundation/01-a.md"
expect local_pattern_match_fails "$r" 1 "matches local pattern 1" "ecretword"

r=$(base migrations)
prd "$r" integrations 01-c.md I01 S3 "crates/store/migrations/01[0-4]*" "" "" ""
prd "$r" terminal-data 01-d.md T01 S4 "crates/store/migrations/01[5-9]*" "" "" ""
expect disjoint_ranges_pass "$r" 0

exit $fail
