#!/usr/bin/env python3
"""Checks the PRD set under docs/PRD.

Run with `python3 -I scripts/prd-check.py [--lane <lane>] [--root <dir>]`. Exit 0 when the set is valid, 1 with one
line per problem (`<file>: <problem>`). Rules (see docs/PRD/README.md):

- front matter keys, id matching the file name and lane, session matching the lane;
- no two PRDs own an overlapping path; only foundation PRDs have `seeds`, and each seed is owned by exactly one lane PRD;
- `depends_on` names existing PRDs and has no cycle;
- every FEATURE.md heading of sections 1-10, Lampiran A and Lampiran B is covered (itself, an ancestor, or all of its
  children); a listed feature heading must occur exactly once in FEATURE.md;
- every `architecture` entry is an ARCHITECTURE.md heading;
- the six body sections are present in order;
- no line under docs/PRD matches the owner's local scrub patterns ($QIREI_SCRUB_PATTERNS, default
  ~/.config/qirei/scrub-patterns); a match is reported by line and pattern number, never by its text.

`--lane` checks only that lane: no global coverage, no cross-lane overlap, and a dependency on another lane is accepted
when its id is well formed (that lane may not be written yet).
"""
import argparse
import os
import re
import sys

LANES = {
    "foundation": ("F", "S1"),
    "agent-runtime": ("A", "S2"),
    "integrations": ("I", "S3"),
    "terminal-data": ("T", "S4"),
    "ui": ("U", "S5"),
}
PREFIX_LANE = {p: lane for lane, (p, _) in LANES.items()}
KEYS = ["id", "lane", "session", "title", "tier", "block", "depends_on", "owns", "seeds", "features",
        "architecture", "checkpoint"]
LIST_KEYS = {"depends_on", "owns", "seeds", "features", "architecture"}
SECTIONS = ["## Goal", "## Scope", "## Contracts", "## Requirements", "## Tests", "## Done when"]
TIERS = {"A", "B", "C"}
CHECKPOINTS = {"none", "1", "2", "3"}
EXCLUDED_FEATURES = {"Sumber", "Daftar isi"}


def parse_list(text):
    """Parses `[a, "b, c", d]`: bare items have no comma, quoted items may."""
    text = text.strip()
    if not (text.startswith("[") and text.endswith("]")):
        return None
    body = text[1:-1]
    items, i = [], 0
    while i < len(body):
        c = body[i]
        if c in " \t,":
            i += 1
            continue
        if c == '"':
            j = body.find('"', i + 1)
            if j < 0:
                return None
            items.append(body[i + 1:j])
            i = j + 1
        else:
            j = body.find(",", i)
            j = len(body) if j < 0 else j
            items.append(body[i:j].strip())
            i = j
    return items


def read_prd(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, None, "no front matter"
    try:
        end = lines[1:].index("---") + 1
    except ValueError:
        return None, None, "front matter not closed"
    meta = {}
    for line in lines[1:end]:
        if not line.strip():
            continue
        if ":" not in line:
            return None, None, "bad front matter line"
        key, value = line.split(":", 1)
        key, value = key.strip(), value.strip()
        if key in LIST_KEYS:
            parsed = parse_list(value)
            if parsed is None:
                return None, None, f"`{key}` is not a flow list"
            meta[key] = parsed
        else:
            meta[key] = value
    return meta, lines[end + 1:], None


def expand_braces(pattern):
    m = re.search(r"\{([^{}]*)\}", pattern)
    if not m:
        return [pattern]
    out = []
    for alt in m.group(1).split(","):
        out.extend(expand_braces(pattern[:m.start()] + alt + pattern[m.end():]))
    return out


class Glob:
    """One owned path: a directory prefix (`x/**`), a wildcard pattern, or an exact path."""

    def __init__(self, text):
        self.text = text
        if text.endswith("/**"):
            self.kind, self.prefix = "dir", text[:-2]
        elif re.search(r"[*\[]", text):
            self.kind = "pattern"
            self.regex = re.compile("^" + self._translate(text) + "$")
            self.head = re.split(r"[*\[]", text, 1)[0]
        else:
            self.kind = "exact"

    @staticmethod
    def _translate(p):
        out, i = "", 0
        while i < len(p):
            c = p[i]
            if c == "*":
                out += "[^/]*"
            elif c == "[":
                j = p.index("]", i)
                out += p[i:j + 1]
                i = j
            else:
                out += re.escape(c)
            i += 1
        return out

    def samples(self):
        """Concrete paths this pattern stands for, enough to test overlap with another pattern."""
        parts = [""]
        i, p = 0, self.text
        while i < len(p):
            c = p[i]
            if c == "*":
                parts = [s + "x" for s in parts]
            elif c == "[":
                j = p.index("]", i)
                chars = []
                body = p[i + 1:j]
                k = 0
                while k < len(body):
                    if k + 2 < len(body) and body[k + 1] == "-":
                        chars.extend(chr(o) for o in range(ord(body[k]), ord(body[k + 2]) + 1))
                        k += 3
                    else:
                        chars.append(body[k])
                        k += 1
                parts = [s + ch for s in parts for ch in chars]
                i = j
            else:
                parts = [s + c for s in parts]
            i += 1
        return parts

    def matches_path(self, path):
        if self.kind == "dir":
            return path.startswith(self.prefix)
        if self.kind == "pattern":
            return bool(self.regex.match(path))
        return path == self.text


def overlaps(a, b):
    if a.kind == "dir" and b.kind == "dir":
        return a.prefix.startswith(b.prefix) or b.prefix.startswith(a.prefix)
    if a.kind == "dir" or b.kind == "dir":
        d, o = (a, b) if a.kind == "dir" else (b, a)
        if o.kind == "exact":
            return o.text.startswith(d.prefix)
        return o.head.startswith(d.prefix) or d.prefix.startswith(o.head)
    if a.kind == "exact" and b.kind == "exact":
        return a.text == b.text
    if a.kind == "exact":
        return b.matches_path(a.text)
    if b.kind == "exact":
        return a.matches_path(b.text)
    return any(b.matches_path(s) for s in a.samples()) or any(a.matches_path(s) for s in b.samples())


def headings(path):
    """Returns [(level, text, line)] for markdown headings outside fenced code."""
    out, fenced = [], False
    with open(path, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if line.startswith("```"):
                fenced = not fenced
                continue
            if fenced:
                continue
            m = re.match(r"^(#{1,6})\s+(.*?)\s*$", line)
            if m:
                out.append((len(m.group(1)), m.group(2), n))
    return out


def feature_tree(path):
    """Headings of FEATURE.md in scope, each with its ancestors and children."""
    nodes, stack, in_scope = [], [], False
    for level, text, _ in headings(path):
        if level == 1:
            stack = []
            continue
        if level == 2:
            in_scope = bool(re.match(r"^\d+\.", text)) or text.startswith("Lampiran A") or text.startswith(
                "Lampiran B")
            if text in EXCLUDED_FEATURES:
                in_scope = False
        while stack and stack[-1]["level"] >= level:
            stack.pop()
        node = {"level": level, "text": text, "parent": stack[-1] if stack else None, "children": [],
                "scope": in_scope}
        if node["parent"]:
            node["parent"]["children"].append(node)
        nodes.append(node)
        stack.append(node)
    return nodes


def check(root, lane_only):
    problems = []
    prd_root = os.path.join(root, "docs", "PRD")
    feature_path = os.path.join(root, "FEATURE.md")
    arch_path = os.path.join(root, "ARCHITECTURE.md")
    rel = lambda p: os.path.relpath(p, root)

    lanes = [lane_only] if lane_only else list(LANES)
    prds = []
    for lane in lanes:
        d = os.path.join(prd_root, lane)
        if not os.path.isdir(d):
            problems.append(f"{rel(d)}: lane folder missing")
            continue
        for name in sorted(os.listdir(d)):
            if not re.match(r"^\d{2}-.*\.md$", name):
                continue
            path = os.path.join(d, name)
            meta, body, err = read_prd(path)
            if err:
                problems.append(f"{rel(path)}: {err}")
                continue
            prds.append((lane, name, path, meta, body))

    ids = {}
    for lane, name, path, meta, body in prds:
        r = rel(path)
        missing = [k for k in KEYS if k not in meta]
        if missing:
            problems.append(f"{r}: missing keys {', '.join(missing)}")
            continue
        prefix, session = LANES[lane]
        if meta["id"] != prefix + name[:2]:
            problems.append(f"{r}: id {meta['id']} does not match file name and lane (want {prefix + name[:2]})")
        if meta["lane"] != lane:
            problems.append(f"{r}: lane {meta['lane']} does not match folder {lane}")
        if meta["session"] != session:
            problems.append(f"{r}: session {meta['session']} is not {session}")
        if meta["tier"] not in TIERS:
            problems.append(f"{r}: tier must be A, B or C")
        if meta["checkpoint"] not in CHECKPOINTS:
            problems.append(f"{r}: checkpoint must be none, 1, 2 or 3")
        if meta["seeds"] and lane != "foundation":
            problems.append(f"{r}: seeds are allowed in foundation PRDs only")
        if meta["id"] in ids:
            problems.append(f"{r}: duplicate id {meta['id']}")
        ids[meta["id"]] = (lane, r, meta)
        pos = -1
        for section in SECTIONS:
            try:
                k = body.index(section)
            except ValueError:
                problems.append(f"{r}: missing body section {section}")
                continue
            if k < pos:
                problems.append(f"{r}: body section {section} out of order")
            pos = k

    # dependencies
    for pid, (lane, r, meta) in ids.items():
        for dep in meta["depends_on"]:
            if dep in ids:
                continue
            other = PREFIX_LANE.get(dep[:1])
            if lane_only and other and other != lane_only and re.match(r"^[FAITU]\d{2}$", dep):
                continue
            problems.append(f"{r}: unknown dependency {dep}")
    state = {}

    def visit(pid, trail):
        if state.get(pid) == 1:
            return trail[trail.index(pid):] + [pid]
        if state.get(pid) == 2 or pid not in ids:
            return None
        state[pid] = 1
        for dep in ids[pid][2]["depends_on"]:
            cyc = visit(dep, trail + [pid])
            if cyc:
                return cyc
        state[pid] = 2
        return None

    for pid in ids:
        cyc = visit(pid, [])
        if cyc:
            problems.append(f"{ids[pid][1]}: dependency cycle {' -> '.join(cyc)}")
            break

    # ownership
    owned = []
    for pid, (lane, r, meta) in ids.items():
        for entry in meta["owns"]:
            for g in expand_braces(entry):
                owned.append((pid, lane, r, Glob(g)))
    for i in range(len(owned)):
        for j in range(i + 1, len(owned)):
            a, b = owned[i], owned[j]
            if a[0] == b[0]:
                continue
            if overlaps(a[3], b[3]):
                problems.append(f"{a[2]}: owns overlaps {b[2]} ({a[3].text} / {b[3].text})")
    if not lane_only:
        for pid, (lane, r, meta) in ids.items():
            for entry in meta["seeds"]:
                for g in expand_braces(entry):
                    seed = Glob(g)
                    owners = {o[0] for o in owned if o[1] != "foundation" and overlaps(seed, o[3])}
                    if len(owners) != 1:
                        problems.append(f"{r}: seed {g} must be owned by exactly one lane PRD (found {len(owners)})")

    # architecture headings
    arch = {t for _, t, _ in headings(arch_path)} if os.path.exists(arch_path) else set()
    for pid, (lane, r, meta) in ids.items():
        for h in meta["architecture"]:
            if h not in arch:
                problems.append(f"{r}: unknown architecture heading \"{h}\"")

    # features
    nodes = feature_tree(feature_path) if os.path.exists(feature_path) else []
    counts = {}
    for n in nodes:
        counts[n["text"]] = counts.get(n["text"], 0) + 1
    listed = set()
    for pid, (lane, r, meta) in ids.items():
        for f in meta["features"]:
            c = counts.get(f, 0)
            if c == 0:
                problems.append(f"{r}: unknown feature heading \"{f}\"")
            elif c > 1:
                problems.append(f"{r}: ambiguous feature heading \"{f}\"")
            else:
                listed.add(f)
    if not lane_only:
        def covered(n):
            a = n
            while a:
                if a["text"] in listed and counts[a["text"]] == 1:
                    return True
                a = a["parent"]
            return bool(n["children"]) and all(covered(c) for c in n["children"])

        for n in nodes:
            if n["scope"] and not covered(n):
                problems.append(f"FEATURE.md: heading \"{n['text']}\" is covered by no PRD")

    # local scrub patterns
    pat_file = os.environ.get("QIREI_SCRUB_PATTERNS", os.path.expanduser("~/.config/qirei/scrub-patterns"))
    patterns = []
    if os.path.exists(pat_file):
        with open(pat_file, encoding="utf-8") as f:
            for n, line in enumerate(f, 1):
                line = line.rstrip("\n")
                if line and not line.startswith("#"):
                    patterns.append((n, re.compile(line, re.I)))
    scan = [os.path.join(prd_root, lane_only)] if lane_only else [prd_root]
    for base in scan:
        for dirpath, _, files in os.walk(base):
            for name in sorted(files):
                if not name.endswith(".md"):
                    continue
                path = os.path.join(dirpath, name)
                with open(path, encoding="utf-8") as f:
                    for ln, line in enumerate(f, 1):
                        for pn, rx in patterns:
                            if rx.search(line):
                                problems.append(f"{rel(path)}:{ln}: matches local pattern {pn}")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lane", choices=list(LANES))
    ap.add_argument("--root", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = ap.parse_args()
    problems = check(os.path.abspath(args.root), args.lane)
    for p in problems:
        print(p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
