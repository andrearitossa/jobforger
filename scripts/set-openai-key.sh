#!/usr/bin/env bash
# Paste your OpenAI key when prompted (input is hidden), or pass --clipboard to read it
# from the Windows clipboard. Stores it as a Pages secret
# for production, and in .dev.vars (gitignored) for local testing.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == "--clipboard" ]]; then
  KEY="$(powershell.exe -NoProfile -Command Get-Clipboard 2>/dev/null)"   # Windows clipboard (WSL)
else
  read -rsp "Paste OpenAI API key, then press Enter: " KEY; echo
fi
# Strip whitespace and the bracketed-paste markers terminals wrap pasted text in.
KEY="$(printf '%s' "$KEY" | sed 's/\x1b\[20[01]~//g' | tr -d '[:space:][:cntrl:]')"
[[ "$KEY" == sk-* ]] || { echo "That doesn't look like an OpenAI key (should start with sk-, got ${#KEY} chars starting '${KEY:0:3}')."; exit 1; }
printf '%s' "$KEY" | npx wrangler pages secret put OPENAI_API_KEY --project-name jobforger >/dev/null
echo "✓ Saved as a Cloudflare Pages secret (production)"
touch .dev.vars
grep -q '^SESSION_SECRET=' .dev.vars || echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .dev.vars
sed -i '/^OPENAI_API_KEY=/d' .dev.vars && echo "OPENAI_API_KEY=$KEY" >> .dev.vars
echo "✓ Saved to .dev.vars for local testing"
