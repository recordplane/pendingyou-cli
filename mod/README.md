# Pending You wake mod

The pendingyou command line’s copy of the Pending You plugin’s wake mod, for Claude Code 2.1.287 and later. `npx pendingyou init` copies it to `~/.config/pendingyou/mod`, a folder that stays put when pendingyou updates, and adds that folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, so every Claude Code session started after loads it (one already open needs a restart: /exit, then claude --continue); `npx pendingyou uninstall` takes it out.

In each session it learns the cards the session posts to Pending You, checks them through the session’s own Pending You connection, and starts a turn when your person answers, writes back or a fallback comes due, or hands the session a question from another of their assistants (CLI 0.14.0), even while it sits idle. It answers `npx pendingyou hold` itself, so nothing waits in the background, and shows “2 waiting on you” under the prompt, after the plugin’s name. With the Pending You plugin installed too, only one copy acts.

Generated from Pending You’s own repository (packages/claude-plugin/src/wake) with Pending You’s guide 2.50.0, with each release: a change made here is overwritten.
