# CLAUDE.md

The guidance for this repository lives in [AGENTS.md](AGENTS.md), shared by every coding agent. Claude Code loads it through this import:

@AGENTS.md

## Notes for Claude Code

- When a rule applies to every agent, change AGENTS.md, not this file. Keep this file for notes only Claude Code needs.
- This app also drives Claude Code as one of its agents (`src/server/agents/claude.ts`). If you change the arguments it passes to `claude`, keep `test/claude.test.ts` passing: it covers the pre-approved and removed tools, `--system-prompt-snapshot off`, the flags an older `claude` rejects, and the `sandbox` settings below full access (tried end to end with the real CLI on a Mac before they went in).
