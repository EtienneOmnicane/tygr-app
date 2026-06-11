#!/bin/bash
# Stop-loss TYGR (CLAUDE.md règle 5) — hook PreToolUse[Bash].
# Bloque tout `git commit` lancé par l'agent si lint ou typecheck échoue.
# Contrat Claude Code : exit 0 = autoriser, exit 2 = bloquer (stderr renvoyé à l'agent).

INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

# Ne cibler que les commits (pas les autres commandes git)
case "$CMD" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || cd "$(dirname "$0")/../.." || exit 0

if ! npm run lint --silent 2>&1; then
  echo "STOP-LOSS : eslint échoue — commit bloqué (CLAUDE.md règle 5). Corrige le lint avant de committer." >&2
  exit 2
fi
if ! npm run typecheck --silent 2>&1; then
  echo "STOP-LOSS : tsc --noEmit échoue — commit bloqué (CLAUDE.md règle 5). Corrige les types avant de committer." >&2
  exit 2
fi
exit 0
