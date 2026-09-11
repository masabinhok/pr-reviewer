#!/usr/bin/env bash
# Regenerates git-edge-cases.diff with real git, so the parser is tested against what git
# actually writes rather than what we remember it writing. Run from this directory.
set -euo pipefail
work=$(mktemp -d)
cd "$work" && git init -q && git config user.email t@t && git config user.name t

printf 'line one\nline two\n' > "spaced name.txt"   # --- / +++ get a trailing tab
printf 'café\n' > "café.md"                          # quoted, octal-escaped path
printf 'a\r\nb\r\n' > crlf.txt                        # CR kept in line content
printf 'x' > nonl.txt                                # "\ No newline at end of file"
printf 'keep\n' > single.txt                         # @@ -1 +1 @@ (counts omitted)
printf 'gone\n' > "to delete.txt"                    # deletion, @@ -1 +0,0 @@
seq 1 30 | sed 's/^/row /' > multi.txt               # two hunks, section heading
git add -A && git commit -qm base

printf 'line one\nline 2\n' > "spaced name.txt"
printf 'café au lait\n' > "café.md"
printf 'a\r\nB\r\n' > crlf.txt
printf 'ytail\n' > nonl.txt
printf 'changed\n' > single.txt
git rm -q "to delete.txt"
: > empty.txt                                        # new empty file: no hunks at all
sed -i 's/^row 3$/row three/; s/^row 27$/row twenty-seven/' multi.txt
git add -A
git -c core.quotePath=true diff --cached -M > "$OLDPWD/git-edge-cases.diff"
rm -rf "$work"
