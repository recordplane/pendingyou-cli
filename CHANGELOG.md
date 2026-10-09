# Changelog

## 0.34.2 (2026-10-09)

- Fixed: in bypassPermissions or dontAsk mode, a Claude Code dialog for a tool its agent had used before (a subagent's
  second Bash) could get no card. Claude Code writes a prompted call to its transcript only once its dialog is
  answered, so 20 seconds in the check for an unanswered call found the agent's earlier call of the same tool,
  answered, and settled the prompt. Now only the prompt's own call counts: not in the transcript yet, it's still
  waiting and its card goes up; the same command answered before the prompt was asked is an earlier call and doesn't
  count; a call Claude Code denied by itself is written with its refusal at once, so it still gets no card. A
  Notification picks the prompt it shows the same way, so it names the second call rather than putting up a card in
  Claude Code's words.

## 0.34.1 (2026-10-09)

- Fixed: a Claude Code permission prompt answered through the permission channel (`npx pendingyou claude`) could get
  two cards, the relayed one with **Allow** and **Deny** and the old button-less “Claude Code is waiting for your OK”
  one. It happened to any tool the session had used before (a second Write): Claude Code writes a prompted call to its
  transcript only once it's answered, so the Notification hook, six seconds into the dialog, found the earlier call
  answered, took the dialog for one nothing explained and put up a card for it. A relayed prompt now counts as on
  screen, a Notification adds nothing while one is open, and a button-less card already up for a relayed dialog is
  withdrawn as the relayed card goes up at once (“It has a card of its own now, with Allow and Deny.”).

## 0.34.0 (2026-10-09)

- Codex can ask on your phone first. `npx pendingyou codex-answers --wait <minutes>` (0 to 10; 0, the default, is off)
  has Codex's permission prompts go to your Pending You card at once, with **Allow** and **Deny** and the whole command
  or patch, its secrets masked. Codex shows nothing while its hook waits, so tap one and Codex goes on, or is refused
  (“Denied in Pending You.”); with no answer within the wait, the card is withdrawn and Codex asks in its terminal as
  usual. It sets the PermissionRequest hook's timeout in Codex's hooks.json to the wait plus 30 seconds (Codex sets no
  upper limit for that hook), which changes the hook: trust it again in Codex's `/hooks`, as the command says. `init`
  names the setting when it sets Codex up and keeps it, `status` shows it, and `uninstall` clears it. Needs Pending You
  with `permissionPrompt` (0.33.0's server).

## 0.33.0 (2026-10-09)

- Answer Claude Code's permission prompts on their Pending You card. Start Claude Code with `npx pendingyou claude
  [args…]` (it runs `claude --dangerously-load-development-channels server:pendingyou-permissions [args…]`) and a
  prompt left waiting gets a card with **Allow** and **Deny** and the whole input, its secrets masked, instead of a
  card that only says where to answer. The terminal dialog stays open: whichever answer comes first wins, and Allow is
  for that one call only. `init` registers the channel (`pendingyou channel --app claude-code`, a stdio MCP server that
  sends nothing to the model) at user scope through the hooks' shim, beside the permission-prompt hooks, on Claude
  Code 2.1.234 or later; `uninstall` and `--no-permission-cards` take it out; `status` says whether it's there. The card
  still waits the same 10 seconds, so a prompt answered at the terminal gets none; answered there later, the card goes
  as before. A session started with plain `claude` keeps today's card, which now says it's a permission
  prompt's (`permissionPrompt` with `relay: false`). Needs Pending You with `post_request`'s `permissionPrompt`
  (deploy the server first). Claude Code warns about the development channel at each start until
  the channel is on its allowlist.

## 0.32.3 (2026-10-09)

- Claude Code's and Codex's permission prompts get their cards. The worker posted each card without `context`, which
  Pending You's `post_request` requires, so every post was refused, retried, and given up without a word: a prompt
  left waiting in the terminal never reached the queue. The card now carries a `context` with only what it already
  says (the prompt, as its title says it, and the session's link). The tests' pretend Pending You checks every
  `post_request` and `update_request` with Pending You's own input schemas, so a card the server would refuse fails
  them.

## 0.32.2 (2026-10-08)

- A Claude Code dialog in bypassPermissions or dontAsk mode always gets its card. A subagent's `rm -rf $S/*` met Claude
  Code's “Dangerous rm operation” check and its dialog waited an hour with no card: its prompt was written down, but
  its card waited for a Notification hook that never named it (one comes per dialog, it doesn't say which agent's, and
  with several subagents at work it could mean another's prompt). Now the session's worker also looks at every such
  prompt after 20 seconds: if the asking agent's transcript has no result for that call yet, its dialog is on screen
  and the card goes up; if it has one (a call Claude Code denied by itself), it's settled with no card. A Notification
  names the newest prompt whose call is still unanswered, and a card it makes due goes up within a second. A
  subagent's card says “A subagent (general-purpose) of Claude Code … needs your permission to run a command”, its
  title ends “(a subagent)”, and it goes once the person answers in Claude Code.

## 0.32.1 (2026-10-08)

- The Claude Code wake mod never announces a card that's already picked up. It checks cards while a turn runs but tells
  only once the session is idle, and it told what it had read then: a card the agent picked up in that turn (by posting
  the next card with `follows`, or with `ack_answer`) was announced minutes later as “your person answered …”. It now
  reads each card again just before telling it, unless it read it in the last 10 seconds; never tells a card picked up,
  whichever way; and takes the card a new card follows as heard. A card withdrawn under the agent is still told once.

## 0.32.0 (2026-10-08)

- Follow-ups are new cards that follow the one before (threads, guide 2.48). The Codex wake and the Claude Code wake mod
  no longer say "reply_in_thread with reopen": when the person answered and the agent needs more, or the next step, they
  say "If you need more from them, or the next step, post a new card with follows: that card’s requestId; never
  reopen." The stop hook's reminder for words asked for in the terminal says to post the card with follows after a
  card the person answered, instead of reopening it. Publish before guide 2.48 is deployed.

## 0.31.1 (2026-10-08)

- Your words on a card that's closed reach its assistant. "Write to …" (threads) writes on a thread's newest card even
  after its assistant picked it up, withdrew it or ran its fallback. `hold`, the hooks and the wake now say "Pending
  You: your person wrote to you on req_… after it closed.", quote your words, and tell the assistant to act on them,
  then ack_answer with a one-line outcome (or reply_in_thread if you asked it something). Before, they said the card
  was already handled and there was nothing to do. Servers that don't send `wrote` are heard as before.

## 0.31.0 (2026-10-08)

- “I’ll handle it” has one meaning (guide 2.45): the person will handle it themselves. `hold`, the hooks, the wake mod
  and the Codex wake say so in Pending You's own words, “The person will handle this themselves. Close it out: take no
  action on it, leave things as they are (an email stays in their inbox, untouched), and don’t follow up or ask
  again.”, then to ack_answer with an outcome like “Left to you”. The app no longer offers “Leave it”; a server since
  guide 2.45 sends an older one as the same. `leave` now means only a to-do's Skip: “your person won’t do it”, don't do
  it for them or follow up, and pick it up with an outcome like “Skipped”. Older command lines still stand down on
  both.

## 0.30.0 (2026-10-07)

- This computer's own sign-ins (the connections `init` made for Claude Code, Codex, OpenCode and Pi) now last while
  you use them. Each refresh carries a proof by this computer's key (a DPoP proof, RFC 9449, signed with the key in
  `~/.config/pendingyou/machine.json`), and Pending You renews a sign-in for 30 days from that refresh when it's proven
  by the key of the computer it's on. Before, every sign-in ended 30 days after it began, however much it was used. A
  computer left unused for 30 days still signs out; Pending You says so 3 days before. Its tokens are unchanged, and a
  refresh never fails for want of a proof: without a key, or when the proof isn't taken, it refreshes as before.

## 0.29.0 (2026-10-07)

- The command line links this computer's sign-ins to it by its key, so Pending You names every assistant here by this
  computer and shows one computer, not two. Besides the connections `init` made, it now finds the sign-ins your apps
  made on their own at this Pending You (Claude Code's `/mcp` Authenticate, or the Pending You plugin's server, kept in
  Claude Code's own credentials; Codex's and OpenCode's MCP sign-ins kept in their files) and proves this computer's key
  for each, reading only their OAuth clients, never a token. Pending You links the ones that are yours and on no other
  computer, and merges an app's older sign-ins here into the one in use. Nothing is ever linked by a computer's name.
  `init` links at once; the hooks, `hold`, the MCP headers helper and the wake do it in the background every few hours.
  `npx pendingyou machine link` does it now.
- Proving the key again no longer renames the computer: a name you gave it in Pending You stays.

## 0.28.0 (2026-10-07)

- When a card you asked was handed to another assistant and comes back to your person without its answer (handed
  back, brought back after the two of you traded too many messages or went quiet, taken back, its answer back with
  your person to send, or the helper removed), the session that asked hears it: “Pending You: req_… came back from
  codex-setup to your person.”, Pending You's line saying why, and to ack_answer it (nothing to answer; your person's
  answer reaches you as usual). Codex threads are woken with the same. Before, the card went quiet.

## 0.27.0 (2026-10-07)

- Claude Code's pendingyou MCP server no longer gets stuck on “needs authentication” after a computer sleeps. When it
  reconnected during a brief wake, the sign-in's 15-minute access token had run out, the refresh couldn't land in the
  headers helper's time, and the helper printed nothing. With no `Authorization` from its helper, Claude Code turns on
  its own OAuth, and the 401 left the server needing authentication, every pendingyou tool failing, until `/mcp`. Now
  the helper tries the refresh again every 1.5 seconds within its time when one fails (a network still coming up), and
  while it has a sign-in it always hands over a token, even one that has run out: that's refused as a failed connect,
  which Claude Code tries again by running the helper, never as a reason to start its own sign-in. It still prints
  nothing when there's no sign-in or the sign-in has ended.
- When the helper last handed over a token that had run out, the next-message hook says so: if a pendingyou tool fails,
  the agent tells you in chat to run `/mcp`, choose pendingyou and Reconnect (or restart Claude Code; Codex: restart
  it), and asks in chat until it works. Said only within 12 hours, and no more once a later connect got a fresh token.

## 0.26.0 (2026-10-07)

- A session that sat idle past its sign-in's 15-minute access token hears its answers again. The next message's
  hand-off started the background refresh, waited 1.2 seconds for it and gave up, often just before it landed, so an
  answered card went unannounced. Now the hand-off and the session start's pickup wait for an expired token until 0.9
  seconds before their 3-second deadline, leaving room to ask for answers; a token with seconds left still waits 1.2.
- Never silent: when the hand-off or the session start's pickup can't check for answers (Pending You unreachable, a
  server error, or the sign-in still being refreshed), they add “Pending You couldn't check for answers just now: call
  list_pending before you go on.” instead of only the plain reminder.

## 0.25.0 (2026-10-06)

- An answer reaches only the session that asked. The hooks asked Pending You for their folder's answers and open
  cards, and got every card asked from that folder, or from any folder above it, whoever asked: two sessions in one
  folder each heard the other's answers and were told to ack them, the next-message line listed the other's cards as
  "Your open cards here", and a card asked from a folder above another session's reached it on any computer. Now each
  hook says who its session is: the cards it posted (Claude Code's from its own transcript, with whether that's all of
  them; Codex's, OpenCode's and Pi's from what their hooks remember), the name it goes by, and this computer's names.
  Pending You hands it a card it posted (whatever name it asked under, the app's own included), else one asked under
  its name; only a session that can say neither falls back to its folder, that exact folder on this computer, and
  never for a card asked under another agent's name. The Stop check's look at open cards asks the same way. Needs
  Pending You's matching release; until then the hooks hear as before.

## 0.24.0 (2026-10-06)

- When your person approves a card that carried a draft, or picks a reply option that sends (`sends`), the hold, the
  hooks' hand-off and the wake mods (Claude Code's and Codex's) add one line: “The approved words are in
  get_request’s answer.approvedDrafts: send them exactly.” Pending You's `get_request` now gives those exact words with
  the answer (and every answer the card's title), so an agent that starts fresh, or a smaller model, sends what was
  approved instead of hunting for it or rewriting it. Needs Pending You's matching release; with an older one nothing
  changes.

## 0.23.0 (2026-10-06)

- The Claude Code wake mod survives upgrades. `init` now copies it to `~/.config/pendingyou/mod`, a folder that stays
  put across versions, and points `CLAUDE_CODE_PLUGIN_DIRS` there, so the entry never changes again. Before, it named
  the version's own folder, which the next upgrade removed: a session already open (Claude Code reads its plugin
  folders only as a session starts) was left with no wake mod and nothing said, and answers reached it only when you
  typed. Open interactive sessions reload the mod when `init` updates it. `init` keeps the newest older copy for
  sessions started before this version, and `status` says when the entry still names a version.
- A session the wake mod doesn't run in is told so, once: with its next message, the hooks say “Pending You can’t wake
  this session: Claude Code started before Pending You’s wake was set up. Ask your person to restart it (/exit, then
  claude --continue) at a good moment.”, and to background a hold until then. The mod notes each session it runs in
  (`~/.config/pendingyou/wake/sessions/`), and presence remembers when an older mod said a session is live.
- `init` names the Claude Code sessions open here that started before the wake mod was set up, by the name they go by
  and their folder, and says to restart each at a good moment.
- A question handed to your agent by its name reaches it in whatever folder it works. The wake mod and the hooks took
  one only in the folder Pending You heard it in (its task's, or the agent's last task's), so an agent working elsewhere
  never heard it. The hooks now send the session's name, and the mod reads Pending You's `byName`; one handed to the app
  with no agent still goes by its folder. Needs Pending You's matching release.

## 0.22.1 (2026-10-06)

- The Herdr plugin's popup finishes noting your last key press (what keeps your phone quiet while you're in Herdr)
  before it closes, rather than leaving it half-written in the plugin's state folder.

## 0.22.0 (2026-10-06)

- Trusting Codex's hooks is one command now. When `init` or `status` finds Pending You's hooks in Codex but not trusted
  yet, it prints the command that opens a Codex here (`codex` on PATH, else the Codex command line the ChatGPT app
  brings, by its full path, quoted) and says to type `/hooks` there, look over Pending You's hooks and trust them. At a
  terminal it then waits, looking again every 3 seconds for up to 10 minutes, and says "Ready: Codex hears answers
  right away" once they're trusted (Ctrl-C stops the wait; `npx pendingyou status` checks later). Run by an agent, it
  prints the same steps without waiting. It never trusts them for you.
- The instructions no longer send you to a Hooks page in the Codex app's Settings, which people couldn't find, nor to
  other ways of trusting the hooks that haven't been seen working: init's last lines and `status` lead with `/hooks`.
- Looking for the Codex inside the ChatGPT or Codex app, the command line tries the `CodexCLI.app` it carries first,
  then its `bin` folder.

## 0.21.0 (2026-10-06)

- Answer from Herdr. The Pending You plugin for Herdr (0.2) can now answer your cards from its popup, once you sign
  Herdr in. The command line itself still never answers anything: the plugin's popup does, with Herdr's own sign-in
  and its own key, only when you press a key in it, and never a high-stakes card.
- `pendingyou app login herdr` (also the plugin's setup) signs Herdr in to Pending You with a code, as `login --device`
  does: your phone or browser shows one card naming Herdr and this computer, with a tick for all your cards (off: it
  sees this computer's agents' cards only). This computer's key (0.18.0) vouches for the sign-in, naming Herdr and the
  new sign-in's own key, so run `npx -y pendingyou@latest init` here first. The sign-in and its private key are kept
  in `~/.config/pendingyou/apps/herdr.json` (readable only by you), which none of the agents' hooks, helpers or
  `hold` read; its tokens are useless without that key (DPoP). Signing in again on the same computer replaces it.
  `pendingyou app status` says what each app signed in here may do and until when (and warns in its last 3 days);
  `pendingyou app logout herdr` ends it at Pending You and removes it. Another registered app signs in with
  `--client-id` (and `--scope`).
- The popup (`prefix+y`), signed in: your cards from Pending You, the chosen one open with what it asks, how many wait
  elsewhere, and a key per decision: 1–9 for a choice (and Enter to send several), y or n to approve or decline, Enter
  to write an answer, y or n for a step done or not, Tab between a grouped card's questions. r writes to the agent, l
  puts the card in Later, d hands it to another of your agents, u undoes for 5 seconds, t goes to the agent's pane
  (from its badges, or its session running in this Herdr), o opens the card in Pending You (high-stakes cards are
  answered there), a opens all your cards. It follows Pending You's change feed while it's open. Not signed in, it's
  the read-only list it was, with a line saying how to sign in. `herdr open --demo` shows made-up cards, for
  screenshots.
- Your phone stays quiet while you're active in Herdr (moving between panes, tabs and workspaces, or pressing keys in
  the popup), for the cards Herdr can show, as it does while Pending You is open on your desk. The plugin's watcher
  also says in a toast when Herdr's sign-in has ended, and in its last 3 days that it's about to.
- The plugin's `unconfigure` signs Herdr out too. `doctor` says whether it's signed in.
- The plugin 0.2 runs the command line `init` put here only once that one can answer (`pendingyou app` exists);
  until then it runs 0.21.0 through npx. Run `npx pendingyou@latest init` once to switch.
- Answering works once Pending You turns on its person API for its own apps; until then sign-in says Pending You
  doesn't let Herdr sign in yet.

## 0.20.1 (2026-10-06)

- An older answer is no longer hidden behind newer ones. The session-start and next-message hooks asked for a folder's
  five newest answers and left out the ones already handed over, so a session with five newer answers it hadn't
  acknowledged yet never heard an older one, even on the person's own message (seen 2026-10-06: two answers waited
  over an hour). They now ask for 20 and hand over the newest five not handed over yet; the rest come with the next
  message.
- The wake mod (guide 2.33.1) makes room in a session's list of 50 cards with the answers its agent already heard,
  never a card still waiting on you while there's one of those: a session that ran many agents lost its oldest open
  cards, and their answers were never told.

## 0.20.0 (2026-10-06)

- “I’ll handle it”: a card you ended yourself in Pending You says so, and tells the agent to stand down. An answer can
  now carry `handled`: `self` (you'll do it yourself) or `leave` (nobody does it), with or without your note, and its
  words in `said` (“I’ll do it myself”, “Leave it”, then the note). Wherever the command line hands an answer over
  (`hold`, the session-start and next-message hooks, the wake mod in Claude Code, and the listeners that wake Codex,
  OpenCode and Pi), it says which instead of “Act on it”:
  - `self`: don't act on it, don't draft or send anything for it, and don't follow up.
  - `leave`: nobody does it, so an email or a task gets no reply and no follow-up, and nothing is archived or deleted
    unless the person's rules say so.
  - Either way: if the note asks for one thing, do just that; then `ack_answer` with an outcome like “Left to you”, and
    never post it again. No “reply_in_thread with reopen” hint for these.
  `watch` passes `handled` on with the rest of the request. An answer without it, from an older Pending You, reads as
  before.
- Hooks run the copy `init` installed: run `npx pendingyou@latest init` once to switch.

## 0.19.0 (2026-10-06)

- The Stop check lets a turn end on a recap of cards already waiting on you. It asked the agent to go on whenever its
  last message had something for you and the turn posted no card, so a closing line like “Two cards are waiting on
  you: CLI 0.18.0 (publish it) and the Herdr check (does the amber title show in the sidebar?).” was asked to go on,
  and Claude Code showed each of those as a “Stop hook error”. Now:
  - A recap counts as posted, for what it says: a sentence that says its cards wait on you (“Two cards are waiting on
    you: …”, “the card is still open for your answer”, “both cards are in your queue”, “… (both cards).”), or a heading
    that does, or names your cards (“**Cards waiting for you:**”, “Your open cards:”), with the list under it.
    Anything else in the message for you is checked as before, so a new ask beside a recap still goes on a card. Cards
    that aren't said to wait on you (“the two cards line up”, “add a credit card”) are no recap.
  - So does a card said to be coming, or one an item already is: “a card is coming”, “there'll be a card”, “I'll
    create a card”, “that one is already a card”, as “I'll send you a card” and “it's on a card” already did.
  - Anything else for you, in a message that talks about cards (not a credit card, a SIM card or a card number), is
    taken as a recap while this folder has a card waiting on you: one request (this folder's open cards, the one the
    next-message hook makes), made only for such a message and given up after 1.5 seconds. None open: the agent is
    asked to go on, as before. A permission prompt's card doesn't count. When Pending You can't say (offline, slow, an
    older server), the turn ends.
  - Everything else is as before: an ask to type something here, a question handed to the agent, once a turn at most,
    quiet when not signed in, silent on any error, the 3-second deadline. Codex's, OpenCode's and Pi's Stop checks do
    the same, each asking for its own app's cards.
- Hooks run the copy `init` installed: run `npx pendingyou@latest init` once to switch.

## 0.18.0 (2026-10-05)

- Presence says which terminal: in a Herdr pane (`HERDR_ENV=1` with `HERDR_BIN_PATH` and `HERDR_PANE_ID`), every
  presence report (`POST /mcp/cli/presence`: each session's start, its 5-minute heartbeat and its end, for Claude Code,
  Codex, OpenCode and Pi) also says where the session runs: `"terminal": { "app": "herdr", "paneId": "w2:p1", "server":
  "<16 hex>" }`. `server` names the Herdr server without the path of its socket: the first 16 hex characters of a
  SHA-256 of the computer's name and `HERDR_SOCKET_PATH`, left out when there's no socket path. Pending You keeps it with
  the session and lists it with the agent's sessions running now, so the Pending You plugin for Herdr can go from a card
  to its agent's pane. It goes whether or not the badges are on. Anywhere else a report is exactly as before, with no
  `terminal`. A Pending You from before it refuses the field (400): the same report goes again without it.
- This computer's key: Pending You knows a computer by a key, not by its name. The first time `init` (or `login`) signs
  anything in, it makes a P-256 key pair in `~/.config/pendingyou/machine.json` (0600, in the 0700 folder with its
  `.gitignore`), shared by every Pending You address. The private key never leaves the computer and is never printed or
  logged; Pending You keeps only its public key's RFC 7638 thumbprint. One that can't be read is never replaced: `init`
  says so and signs in without it.
  - Every device sign-in it starts (`POST /oauth/device`) carries `machine_attestation`: a JWS the key signs (ES256,
    `typ` `pendingyou-machine+jwt`, the public key in its header) for `<origin>/oauth/device`, the client signing in and
    the computer's name, good for 5 minutes and once (`jti`). It's dated by Pending You's own clock (its answer's
    `Date`), so a computer whose clock is off still proves its key. Whoever allows the sign-in enrolls the computer, and
    the connections it makes belong to it. A client registered again (a forgotten one) gets a new attestation of its
    own.
  - On the next `init`, each agent already signed in proves the key with its own sign-in (`POST /mcp/cli/machine`,
    `{ "attestation": … }` for `<origin>/mcp/cli/machine`): nothing to approve and no new sign-in, and the agents'
    sign-ins stay exactly as they were. That's how a computer set up before 0.18.0 gets its key; until then its hooks
    keep running the copy `init` installed, and nothing changes on it. A Pending You from before machines answers 404,
    taken quietly.
  - `pendingyou machine status` says whether Pending You knows each agent's connection by this key (from
    `/mcp/cli/answers`' `for.machineKey`), and exits 0 only when it knows every one. `machine attest --client-id <id>`
    (`--cnf <thumbprint>`, `--name`) prints an attestation for an app's own device sign-in, and nothing else.
    `machine rotate` makes a new key, after a yes (`--yes`, or at the terminal).

## 0.17.0 (2026-10-05)

- Herdr: an agent running in a Herdr pane (`HERDR_ENV=1` with `HERDR_BIN_PATH` and `HERDR_PANE_ID`) marks its pane with
  what it's waiting on you for, as display-only metadata (`src/herdr.ts`): `"$HERDR_BIN_PATH" pane report-metadata
  "$HERDR_PANE_ID" --source pendingyou` with `py_app`, `py_agent` (the name the session goes by with Pending You),
  `py_waiting` (how many cards wait on you), `py_card` (the most pressing one's title, redacted as permission cards' words
  are and cut to 80 characters), `py_cards` (their request ids, as many as fit in 80 characters), `py_urgency`
  (`blocking`, else `now`, `today` or `whenever`) and `py_asked` (those also asked in the conversation), and the state
  labels `idle` and `done` read "waiting on you" while something waits (`--agent` keeps them to the pane's own agent).
  Cleared when nothing waits and as the session ends. Herdr's program is run with an argument list, given one second,
  its outcome never thrown, and a hook only starts it in the background; `--seq` (the moment, in milliseconds) keeps a
  late write from winning, and `--ttl-ms 900000` lets tokens nobody repeats expire. Herdr's limits are kept: one source,
  7 tokens a report, its token names, 80 characters a value.
  - Claude Code: init's copy of the wake mod writes them whenever they change and every 5 minutes, through the hooks'
    script (`herdr report --app claude-code`, the session's cards on stdin), learning how pressing each card is from
    post_request and update_request; the session-start hook names the session in the background (from its transcript);
    the SessionEnd hook clears them in the background.
  - Codex: its card hook (`posted`) marks the thread as the pane's and writes them in the background; the thread's
    keeper writes them with each live (it now starts in Herdr even without a connection here, and keeps on for them when
    Pending You won't take its presence) and clears them as Codex quits; the listener writes them once a card is
    answered.
  - OpenCode and Pi: through what their plugin and extension already run: `posted` after each card call, `presence
    --state live` (the heartbeat) and `closed`, and the listener. A pane's badges are every session of the app marked
    there: OpenCode runs several in one pane.
  - `<app>-threads.json` remembers each card's urgency, whether it blocks and whether it was asked in the conversation,
    and the Herdr pane each session runs in; `herdr.json` whether the badges are off here.
- `pendingyou herdr <what>`: the Pending You plugin for Herdr's commands (`src/herdr/`), which its manifest runs through
  the hooks' script. `next` focuses the next pane waiting on you (blocking first, then by urgency); `open` is the popup
  that lists them (Enter opens the card in Pending You through a terminal hyperlink, `t` takes you to the pane; `--demo`
  shows made-up cards); `popup <pane>` opens one of the plugin's popups; `setup` checks Herdr's toasts, offers the
  sidebar row (`$py_card`) as a managed block in Herdr's `config.toml`, written only with a yes and checked with `herdr
  config check`, and prints the keybindings to add yourself; `doctor` says what's set up (also by hand in a terminal);
  `view` turns the plugin's Agents view on or off; `watch` is the watcher (one per Herdr server, held by a lease) that
  raises Herdr's toast when a pane gains a card, never for the tab you're looking at, cards that arrive together in one,
  a card also asked in the conversation after 3 minutes; `event` makes sure it runs; `unconfigure` stops it, takes the
  badges off every pane and turns them off here, clears the view, and takes the block out. Read-only: nothing asks
  Pending You anything. Herdr's socket API through `HERDR_SOCKET_PATH`.
- Tests never reach a real Herdr: the test setup drops every `HERDR_*` variable from their environment.

## 0.16.0 (2026-10-05)

- A word on one of your own cards that's neither an answer nor your person's (guide 2.32): `/mcp/cli/answers` marks it
  `notice` (`{ kind, from }`), and the hold, the pickup, the hooks and `watch` say what it is instead of “they wrote
  back”:
  - `follow_up`: the helper that answered it for your person followed up afterwards (“shipped in #231”): “Pending You:
    pending-you-chief followed up on req_…, which it answered for your person.”, the question, its words, then “Act on
    it if it needs anything, then call ack_answer … to mark it heard.” On an answer you haven't picked up yet, its
    words come with the answer (“Also: …”).
  - `handed_over`: your person handed your open cards to another assistant: “Pending You: your person handed your open
    cards to pending-you-chief, req_… among them.” and “Stop working on them: pending-you-chief answers them and
    follows up. Call ack_answer … to say you’ve stopped.”
  `watch` gives both as `message_ready`. A command line before 0.16.0 hears the same words as a message from them.
- Claude Code's permission prompts get a card in bypassPermissions mode too: a dangerous request from a background
  agent there waited minutes for an OK with no card. Claude Code still asks for a few things in that mode (a dangerous
  `rm`, an ask rule, a safety check it can't verify), but the PermissionRequest hook skipped bypassPermissions and
  dontAsk mode outright. It also runs for a call Claude Code then denies by itself, showing
  nothing, so in those two modes it now writes the prompt down quietly, and its card goes up only once a dialog is on
  screen. A new Notification hook says so: `pendingyou-hook notify --app claude-code`, with the matcher
  `permission_prompt`, so Claude Code runs it only for a dialog that has waited about six seconds with nobody typing,
  and never for its other notifications. A call denied without a dialog never gets a card: its PostToolUseFailure, the
  same agent's next call, your next message or the end of the turn settles it. In the other modes a card still goes up
  after 10 seconds, or as soon as the Notification comes.
- A dialog no PermissionRequest hook ran for (a sandboxed command's network request; one a Claude Code ran none for)
  gets a card from its Notification alone: “Claude Code is waiting for your OK”, with Claude Code's own words, redacted,
  in its summary (“It says: “Claude needs your permission”.”). Whose dialog it was isn't known, so only a turn that ends
  with no subagent running, or the session's end, takes it down.
- A background agent's prompt says so: “Claude Code is waiting for your OK: pnpm lint && git push (a background
  agent)”, and its summary names the agent's type (“A background agent (general-purpose) of Claude Code
  (billing-webhooks), in ~/… on work-mbp, is waiting for your OK to run a command.”). It stays on the session's one card,
  and only that agent's own calls settle it, not the session's or another agent's.
- `init` adds the Notification hook at the end of Claude Code's Notification hooks, after any of your own, and says so
  on a computer set up before (“Added a Notification hook to the permission-prompt hooks: …”); `status` marks the
  Permission prompts line missing without it; `uninstall` and `--no-permission-cards` take it out with the others.
  Codex is unchanged: it has no hook that says a dialog is on screen (its `notify` runs only when a turn completes).

## 0.15.0 (2026-10-05)

- Presence: Pending You hears which of your agents' sessions are open right now. Each app tells it with its own
  connection here, `POST <origin>/mcp/cli/presence` with `{"source", "name", "sessionId", "cwd", "state"}` (`name` the
  name the session goes by with Pending You, else null; `cwd` only as `~/…`, else null; `state` `live` or `closed`).
  Pending You counts a session live for 15 minutes after its last `live`, so an open session says so every 5 minutes,
  with no model involved:
  - Claude Code: its session-start hook says live; the wake mod (Claude Code 2.1.287 or later) says live as the
    session starts, after /clear or /resume, and every 5 minutes while it's open, by running the hooks' script; a new
    SessionEnd hook, `presence`, through the same script, says closed. Without the wake mod, the next-message hook
    says live again once the last was 4 minutes ago. Only `init`'s copy of the mod does it, never the plugin's.
  - Codex: its session-start and next-message hooks start a keeper for the thread (`presence --keep`, detached, a lease
    of its own), which says live every 5 minutes while the Codex process the hooks ran under is running (Codex CLI, or
    the Codex app's own codex), and closed once it's gone. A new SessionEnd hook (Codex fires it when a conversation
    is archived or deleted, when Codex closes, or after 30 idle minutes) says closed and stops the keeper; its timeout
    is 3 seconds, the most Codex gives one. Where the Codex process can't be found, the hooks say live as they run.
  - OpenCode's plugin and Pi's extension say live as a session starts (OpenCode: when it's created, or its first
    message) and every 5 minutes while the app runs, and closed when OpenCode deletes the session or goes, or Pi shuts
    the session down.
  A hook only starts the send in the background; a send gives up after 3 seconds; a Pending You from before presence
  answers 404, which is taken quietly. A sign-in that only hears (`--oauth`) sends nothing. Events are written down in
  `~/.config/pendingyou/presence/<app>.json` (ids, states and times), so a late `live` never overrides a newer
  `closed`, and a reload's `live` goes after its `closed`. `status` has a line for each app: “Presence: tells Pending
  You when this session is open”.
- Codex's permission prompts on a card, as Claude Code's since 0.13.0. `init` adds Codex's PermissionRequest hook (it
  fires when Codex is about to ask for approval: a shell command that needs more than the sandbox gives, an
  `apply_patch`, an MCP tool; `tool_name` Bash, apply_patch or the tool's, and `tool_input.description` when Codex has
  a reason), through the shim with `--app codex`. Codex reads that hook's output as its decision, so it prints nothing
  and exits 0: it declines, and Codex asks as before. Once a prompt has waited 10 seconds, the same detached worker
  posts one card with Codex's own connection: “Codex is waiting for your OK: git push origin main”, “…: edit
  src/app.ts and 1 more” for a patch (the files its `*** Update File:` lines name), “…: create_issue on github” for an
  MCP tool, with Codex's reason (redacted) in the summary, under the name the thread went by on Pending You's card tools,
  else “Codex”, and the same redaction. It's withdrawn when the call runs (a PostToolUse hook for every tool, which
  also settles a prompt for the same tool when Codex gives the call that ran its input in another form), with your
  next message, at the end of the turn, or when the thread ends (SessionEnd). `--no-permission-cards` leaves Codex's
  out too. The Codex app's browser-use prompts run no PermissionRequest hook, so they get no card.
- Presence keeps to Pending You's contract: the name trimmed to one line of at most 60 characters, a folder over 300
  characters sent as null, a 401 tried once more after a refresh in the background, a 429 waited out once (its
  `retry-after`, 60 seconds) by a send in its own process (never a hook), and 400, 403 and 404 taken quietly; Codex's
  keeper stops once a send is refused, its sign-in is gone, or the server has no presence.
- A question you handed an agent, when the assistant that asked answers what the helper asked it on the card (or you
  write in to them both, guide 2.30), wakes the helper with those words, not the handed question again: “Pending You:
  billing-webhooks replied on the question handed to you, “Which queue?” (req_…): “It's the jobs queue.”. Call
  get_request (requestId req_…, name “infra”) to read what you've said to each other. If you know now,
  answer_delegated …; if you need more, reply_in_thread to “asker”; if it's your person's to decide, reply_in_thread
  with escalate true; if not, hand_back …” (“your person wrote to you both …” for yours). The same from the hooks, the
  wake mod, OpenCode's plugin and Pi's extension; Codex's `codex queue` leaves the words out of its arguments, where any
  program could read them, and get_request has them. The wake mod now wakes a session for such a reply after it read
  the question itself (before, a question it had read never woke it again), and the Stop check and the hooks know a
  turn such a wake started.
- Switching an agent's own sign-in to this computer's says what becomes of the old one: once the agent shows up on this
  computer's sign-in, Pending You moves the old sign-in's agents over, with their cards and the questions you delegated
  to them, and signs it out. Where there's no browser (an SSH session) init says what it switched instead of switching
  without a word.
- Codex runs a hook only once you trust it, so the three new hooks (PermissionRequest, PostToolUse for every tool,
  SessionEnd) need trusting once. They go at the end of their lists, so the ones you trusted stay trusted. `init` says
  so when it adds them to a Codex set up before (“Codex has new Pending You hooks (session end and permission prompts),
  which it skips until you trust them once: …”), and `status` has a line for each, with each hook's trust:
  “Permission prompts: a card when Codex waits for your OK” and “Presence: …”. Neither keeps `status` from saying
  Ready. Codex's record of its hooks (`codex.json`) now names each by its event and command.

## 0.14.0 (2026-10-05)

- Questions your person hands one of your agents from another assistant (Delegate: Pending You's card link, or D on the
  desk). Once the delegation's 5-second hold is over, Pending You's `/mcp/cli/answers` brings such a question to the
  app's sign-in, marked `delegated` (who asked, `freely` or `loop`, the person's note), under the name the helper
  answers with (`sessionLabel`, the task the person picked) and in that task's folder (`cwd`). The hooks used to say
  “Pending You: they wrote back on req_…”; now a session start or message says “Pending You: your person handed you
  req_…, a question from billing-webhooks (answer freely: your answer goes straight to billing-webhooks).”, the
  question, “Their note: “…””, and “Call get_request (requestId req_…, name “infra”) to read it. If you know,
  answer_delegated with your answer and how you know; if not, hand_back with what you checked.” (“they’ll see your
  answer first” when the person kept themselves in the loop). The header says “your person handed you a question from
  another assistant” (or “answered, and handed you …”), never “your person answered”, and the line to tell the person
  first is “You handed me a question from …”.
- Which session hears one (`src/handed.ts`), the same for every app: a session that goes by its name in its folder
  (the task the person picked; the most recent of several), else the session in that folder that used Pending You
  most recently, never the one that asked it (a session that goes by the asking assistant's name), and never two: the
  session that takes it claims it first in `state.json` (`claimHanded`), and gives it back if it couldn't be told. A
  question with no folder (a task that never said one) goes to a session by its name anywhere, else the app's most
  recent. A sign-in that only hears (`--oauth`) hears every computer's questions, so it leaves one whose `machine`
  (the computer Pending You says it went to, as the Assistants page names it) is another computer than this one, by
  its name or its hostname (the hostname, the names its code sign-ins were given, a Mac's own name, and, outside a
  hook, Tailscale's); one with no `machine` goes by the folder. The hooks hand a session one at once when it goes by that name (or it's the session the listeners would
  wake); another session in the folder only after 5 minutes, so the one it went to hears it first.
- Claude Code's wake mod wakes the session it's for: while a session used Pending You in the last 12 hours (as long as
  Pending You offers its task as running), it asks `list_pending` with the session's name every minute for the first
  half hour, then every 3 minutes; reads each new one with `get_request` (who asked, how its answer travels, whether
  there's a note); and starts one turn, “Pending You: your person handed you “…” (req_…), a question from … Call
  get_request (requestId req_…, name “infra”) to read it and their note. If you know, answer_delegated …; if not,
  hand_back …”, never with the note. It claims each in its store (`handed:<requestId>`), so another session by the same
  name doesn't hear it too, and never wakes a session for one it read or answered itself. Among sessions by one name,
  the one working in the folder of the task it went to (`list_pending`'s `cwd`: the folder the session started in, or
  one it gave its own cards, `~/…` or full) takes it, one elsewhere never does, and one that can't tell its folder
  waits 5 minutes. The hand-off hook that
  runs for the mod's prompt claims it in `state.json` without saying it twice. `answer_delegated` and `hand_back` are
  among the calls it reads. Regenerated into the plugin's builds too, which reach installed plugins with the next guide
  release.
- Codex: one listener for the app, `pendingyou listen --app codex --handed` (detached, a lease of its own), started by
  the hooks while any thread may be handed a question, `codex queue`s each into the thread it's for, in the wake mod's
  words, and gives it back (forgetting the thread) when Codex doesn't know the thread. Codex's hooks now remember each
  thread's names and folder (`codex-threads.json`), and keep a thread for 12 hours after it last used the card tools,
  with no card of its own waiting; a session start or message marks it active. A thread's own listener is never woken
  for its own card while it's with another assistant.
- OpenCode and Pi: a session's listener also wakes it for a question handed to it, and keeps listening for one for 12
  hours after the session last used the card tools (`opencode-threads.json`, `pi-threads.json`), while the app is
  open. OpenCode's plugin starts it with each message while the record says so, and passes the session's folder to
  `posted`; Pi's extension starts it as before, now for that too. Both start a listener again when a card call asked for
  one while the last was on its way out: a card posted just as a session's first listener stopped (finding nothing to
  listen for) went unheard until the next message.
- `watch` names a handed question's event `delegated_ready` (`PENDINGYOU_EVENT`), with `delegated` in the JSON on
  stdin.
- The Stop check never asks a helper to post the question as a card of its own. `answer_delegated` and `hand_back`
  count as the turn's card calls (Claude Code's transcript, OpenCode's turn, Pi's extension); a turn a handed
  question's wake started (its first message the wake's words: Claude Code's transcript, OpenCode's turn, Pi's extension
  says `handed`, Codex's next-message hook records it when Codex gives the message) that left the person something in
  chat without either is asked once: “Your person handed you that question to answer, not to ask them back:
  answer_delegated if you know, or hand_back with what you checked, unless you already did. Never post it as a card of
  your own.” Codex's PostToolUse hook is trusted by its exact matcher, which names only the four card tools, so it never
  sees those two calls (a new matcher would have to be trusted again).
- The package names no one, and carries only what runs. Its JavaScript is built without the source's comments, and so is
  the wake mod's (`mod/hooks`); its examples and this changelog use made-up names (`--name build-01`); and the mod's
  test, which only `claude plugin test` reads, stays out of the package. Nothing the command line does changes.

## 0.13.0 (2026-10-04)

- Claude Code's permission prompts on a card: a card and a push, cleared once you answer in the terminal. A Claude Code
  agent kept asking to remove files and sat waiting until its person happened to look. `init` now adds Claude Code's
  PermissionRequest hook (https://code.claude.com/docs/en/hooks: it runs as Claude Code is about to ask for permission
  to use a tool, with `tool_name` and `tool_input`), through the shim with `--app claude-code`.
  It never decides: it prints nothing, so the prompt shows exactly as before, and it's done in about a tenth of a
  second. It writes the prompt down (its card's redacted words, never the tool's input) in the session's own file,
  `~/.config/pendingyou/permission-cards/<session>.json`, and starts that session's one worker, detached (`pendingyou
  permission-card`). Once a prompt has waited 10 seconds (one answered sooner gets no card), the worker posts one card
  through Pending You's MCP with Claude Code's own connection here (whoami, match_area, post_request): an action card
  titled “Claude Code is waiting for your OK: rm -rf dist/” (at most 90 characters; “…waiting for your answer: …” for
  a question it asked, “…on its plan” for a plan), the folder and the computer in its summary, one step, “Answer it in
  Claude Code on Ann-MBP” (with the session's link while Remote Control is on), asked in both places (`askedFirst`
  terminal, at the prompt's time) so a push comes only after the person's hand-off wait, not blocking, urgency now. It
  goes in the area `match_area` picks for the folder and its git remote (a new one for the work when nothing fits, as
  the guide says), under the name the session gave Pending You (read from its transcript), else “Claude Code”, with an
  idempotency key per prompt. One card per session: a newer prompt changes its words (`update_request`, with a
  changeNote), never a second card. It goes once the person answers: the call running (PostToolUse, or
  PostToolUseFailure) withdraws it with `answeredHere`; a denial runs neither, so the person's next message (the
  hand-off hook) or the end of the turn (the Stop hook) does; the session ending (SessionEnd) withdraws it without. A
  card they pressed Done on is acknowledged instead. A subagent's prompt outlasts the person's message, and the end of a
  turn while a subagent still runs in the background. No card where nobody sees the prompt (`claude -p` and the Agent
  SDK, whose CLAUDE_CODE_ENTRYPOINT starts `sdk-`; a dontAsk or bypassPermissions session), for a sign-in that only
  hears (`--oauth`), or on Windows.
- Nothing secret on those cards (`src/redact.ts`). A command is cut to 120 characters, with the values after anything
  named like a secret blanked (`--token …`, `--password=…`, `-p …` but not `mkdir -p`, `mysql -p…`, `-u user:…`,
  `Authorization: …`, `Cookie: …`, `Bearer …`, `FOO_TOKEN=…`, `"password": "…"`, `aws_secret_access_key …`), a URL's
  user and password and every query and fragment value blanked, and anything that looks like a key or token (the
  well-known prefixes, JWTs, private keys, long hex, long runs of letters and digits in both cases, a webhook's secret
  in a URL's path). A command that can't be shown safely (more than one line, a heredoc, inline code such as `node -e`
  or `bash -c`, `eval`, or one that takes or sets a secret, like `sudo -S`, `--password-stdin` or `gh secret set`)
  shows as the tool and its first word: “Bash: node …”. A path is shown under `~`, its end kept when it's long; a
  question or a search keeps its words with any key taken out. The git remote `match_area` gets has no user name or
  password.
- `init --no-permission-cards` leaves them out (later runs keep them out; `--permission-cards` puts them back), and
  `status` has a line: “Permission prompts: a card when Claude Code waits for your OK”, off as the person chose, or why
  this Claude Code can't have them. They need Claude Code 2.1.119 or later (PermissionRequest came in 2.0.45, and
  before 2.1.101 a hook event Claude Code didn't know made it ignore the whole settings file) and Claude Code signing
  in through this computer's sign-in. The SessionEnd hook sets no timeout of its own, so Claude Code's 1.5 seconds for
  SessionEnd hooks stays as it was. The shim skips Node for `permission-done` while no session has a prompt written
  down, so a tool call costs a few milliseconds (20 ms measured, 8 of them the shell's own); the PermissionRequest hook
  takes about 0.14 s, as long as the other hooks. `uninstall` takes the hooks and the sessions' files out.
- The hand-off hook names no permission prompt's card among the agent's open cards, and neither hook hands an agent a
  Done the person pressed on one: those close by themselves.
- The Codex app for macOS ("ChatGPT.app", bundle id com.openai.codex; 26.928 carries codex 0.159.2), which shares
  `~/.codex` with Codex CLI: its MCP servers (the headers helper too), `~/.agents/skills` and `~/.codex/hooks.json`
  with the same trust. Where `codex` isn't on PATH, `init` and `status` find the app's own codex
  (`Contents/Resources/codex-cli/bin/codex`, or the `CodexCLI.app` the app's own code looks for there, in
  `/Applications` or `~/Applications`, as ChatGPT.app or Codex.app) and run it for the version check (0.152 or later,
  for the headers helper), `codex mcp list` and `codex mcp logout`; init says it found "Codex 0.159.2 (the Codex
  app’s)", and `status` names its path. The listener runs it for `codex queue`: the app's own server reads the queue
  while the app is open, so a chat it has loaded is woken when you answer (0.149 or later; one it let go, idle 3 hours
  or behind 10 newer idle chats, hears it when it's opened again), and `status`'s Wake line says so.
- Codex's last lines name both ways to trust its hooks (“In Codex CLI choose “Trust all and continue” (or trust them in
  /hooks); in the Codex app click Review hooks › Allow all (or Settings › Hooks › Trust all)”; the app alone: open it
  and click Review hooks › Allow all), and say not to press Save on pendingyou in the Codex app's MCP settings: that
  writes the table again without `http_headers_helper` (and `default_tools_approval_mode`), so Codex no longer signs in
  through this computer's sign-in. `status` says so when the table has lost the helper init gave it (“has lost its
  http_headers_helper … (saving it in the Codex app’s MCP settings does that) … run npx pendingyou init --app codex
  again”), and init puts it back (“Put this computer’s sign-in back on Codex’s pendingyou MCP server”). Its Hooks line
  names both ways to trust them.
- The setup line every app's session start gives, and the Claude Code wake mod's setup turn, say exactly the three
  calls: “Pending You: Codex on Ann-MBP is connected, but its setup isn’t finished. Three calls, nothing to install or
  approve: 1. whoami with your name. If it says app.setUp is true, another session did this: stop. 2. report_setup with
  source codex, your name, skillSaved true, hears instant, and skillVersion set to whoami’s skill.latest. Its answer
  has a testAreaId. 3. post_request a short test question in that testAreaId, tell your person it’s on its way, and end
  your turn: you’re woken when they answer, so don’t ask them to type anything.” Pi's first live setup spent about
  20,000 tokens on the words before: “whoami with your name and guide true” answered with the whole guide
  (87,000 characters), which Pi cut into a file the model then parsed, and “your test question in its testAreaId” sent
  it looking for testAreaId in whoami's answer, where it isn't (report_setup's has it). A setup that has reported gets
  the same calls without whoami's way out (its whoami says app.setUp is true); a test card answered says who picks it
  up, with the call's exact arguments. Pi's extension knows the new lines (and 0.12.0's) to start the setup turn; the
  wake mod names the connection from whoami's answer.

## 0.12.0 (2026-10-04)

- The stdio bridge, `pendingyou mcp --app <app>`: a local MCP server for an agent that can't give its MCP client a
  header from a command (Claude Code's headersHelper, Codex's http_headers_helper), so its `pendingyou` server signs in
  through this computer's own sign-in all the same, with no second sign-in. The agent runs it by a path that never
  changes, `~/.config/pendingyou/bin/pendingyou-mcp --app <app>` (`--origin` off production), a small script that finds
  Node as the headers helper does and runs this version's private copy, so the agent's config never changes on an
  upgrade. It passes each JSON-RPC line from stdin on to `<origin>/mcp` with the agent's own connection, and each
  answer back on a line of its own (a JSON body, or each event of a stream), with nothing else on stdout and only a few
  plain lines on stderr. It keeps the server's session id, sends the protocol version the handshake agreed (and a
  2026-07-28 request's own headers), starts a session again when the server forgot it, refreshes the sign-in once after
  a 401 (in the background, as the helper does) and then answers with an error saying to run `npx -y
  pendingyou@latest init`; Pending You unreachable, a problem on its side, a redirect (never followed: the token goes
  nowhere else) or a cut-off answer each get a plain JSON-RPC error. It waits for what's under way when stdin closes,
  and stops at once on SIGTERM. `--check` says which Node runs it. A module asks for it with `bridged` (docs/apps.md
  has the contract), and init writes the launcher only then.
- OpenCode (1.17.0 or later; read from 1.18.34's source): `init` finds `opencode` beside Claude Code and Codex and sets
  it up with the same one approval, as its own connection ("OpenCode on Ann-MBP", a device sign-in with
  `assistant=opencode` and a client of its own). Its `pendingyou` MCP server runs the bridge, in OpenCode's global
  config (`~/.config/opencode/opencode.json` or `.jsonc`), edited in place by a small JSON-with-comments editor that
  keeps every comment and byte around it; a file it can't read or edit safely is left alone, with the entry to add by
  hand, and a new file gets OpenCode's `$schema`. A remote server at this Pending You that signs in by itself is moved
  as Codex's is (asked at a terminal, kept with nobody to ask), keeping its `enabled` and `timeout`; one at another
  Pending You is replaced only once the person says so. `--oauth` writes a remote server instead (`opencode mcp auth
  pendingyou`). A `permission` that would make OpenCode ask (`"ask"`, or a catch-all rule) gets `"pendingyou_*":
  "allow"`; a rule of the person's that names Pending You is kept. The skill goes in
  `~/.config/opencode/skills/pendingyou/SKILL.md`, unless OpenCode already reads the one Claude Code's or Codex's init
  saved (a second would be a duplicate).
- OpenCode's plugin, `~/.config/opencode/plugins/pendingyou.js`: one line re-exporting it from this version's private
  copy, which OpenCode loads at startup. It runs the hooks' script for what it decides: each message carries the
  hand-off (as a part the model reads and the TUI doesn't show), and a session's first message what a session start
  says (the setup line while setup isn't finished: `handoff` takes `source` for that); the cards a session posts are
  remembered (`posted`); a session that goes idle with something for the person left only in chat is asked once to put
  it on a card, never for the turn its own prompt started, one the person stopped or a subagent's, with a toast saying
  why; and when a card is answered, a listener per session (`listen --app opencode`, the plugin's child) hands the
  plugin the wake mod's words, and the plugin starts the turn in that session (`client.session.promptAsync`), idle or
  busy. The answer itself never leaves Pending You but through `get_request`. Its own prompts carry
  `metadata.pendingyou`. `init` ends: restart OpenCode (`/exit`, then `opencode --continue`); it finishes setting up the
  first time you write to it. `status` checks the bridge as OpenCode runs it and with a handshake; `uninstall` gives the
  config back as it was. Not on Windows yet.
- Pi (pi.dev, the `pi` command; 0.99.0 or later, whose MCP client came in 0.99.0; read from 1.0.2's source): `init`
  finds `pi` and sets it up with the others, on the same one approval, as its own connection ("Pi on Ann-MBP"). Its
  `pendingyou` server runs the bridge, in `~/.pi/agent/mcp.json` (or `$PI_CODING_AGENT_DIR`'s), with `"exposure":
  "direct"`, without which Pi's model reaches an MCP server's tools only from scripts. Only that member is written,
  every other byte of the file as it was (a small JSON editor, `json.ts`, that checks each edit by reading it back); a
  file that isn't JSON, or a `mcpServers` that isn't an object, is left alone, with the entry to add by hand. A server
  at another Pending You is replaced only once the person says so; one Pi signs in to by itself (`pi mcp login`) is
  moved on Yes (the default) at a terminal, or `--yes`; one with a command or an Authorization of its own is kept.
  `--oauth` writes Pending You's address instead, signed in with `pi mcp login pendingyou`, as pi.dev's own client
  (`oauth.clientRegistration: "cimd"`) from Pi 1.0.1. The skill goes in `~/.pi/agent/skills/pendingyou/SKILL.md`,
  unless the same stub is already in `~/.agents/skills` (Codex's), which Pi reads too.
- Pi's extension, in place of hooks (Pi has none): `~/.config/pendingyou/pi/pendingyou.js`, listed in Pi's
  `settings.json` `extensions` by a path that never changes (upgrading rewrites the file). It runs the hooks' script for
  Pi: as a session starts (`pickup`, for Pi's next turn), with each message (`handoff`), after Pending You's card tools
  (`posted --app pi`) and as a run settles (`stopcheck`: a run that left the person something only in chat goes on
  once). When a card is answered, written back on or its fallback comes due, the listener the extension keeps per
  session (`listen --app pi`, the same as OpenCode's) hands it the wake mod's words, and the extension starts the turn
  (`pi.sendMessage`, at once when Pi is idle, after the run when it's busy), never with the answer in it. In Pi's
  terminal the first session finishes setting up by itself: the session start's setup line starts the turn, once Pending
  You's tools are there (Pi waits for MCP servers only before a typed prompt), and Pi's line waits 10 minutes after the
  last, so two sessions reloaded together don't both set up. `init` ends: `/reload` in each Pi session that's open, or
  start `pi`. `status` checks the bridge as Pi runs it and with a handshake; `uninstall` gives both files back as they
  were (or takes away the ones `init` made). Not on Windows yet.
- `hold` inside Pi (which marks its processes `AI_AGENT=pi`, `PI_CODING_AGENT=true`) answers at once: Pi's shell waits
  for a command to end, so a hold would stop the session for hours. The extension wakes the session anyway; without
  it, `hold` says to check with `get_request` instead.

## 0.11.0

- One step for the coding agents on a computer: `npx -y pendingyou@latest init` finds Claude Code
  and Codex (`--app claude-code,codex` names some), says what it found and which it can't set up (an agent too old for
  it is named, with the version it needs), and sets each up with one approval. Then: restart the agent, and its first
  session finishes setting up by itself (whoami, report_setup, a test card). Asked for by name and not installed, or
  nothing found at all: it says so and stops before anyone signs in.
- One sign-in everywhere: each agent's MCP server signs in through this computer's own connection ("Claude Code on
  Ann-MBP", "Codex on Ann-MBP"), through the headers helper, on every computer but Windows; 0.10.0 did that only over
  SSH. The hooks use the same connection, so there's nothing to Authenticate and no second sign-in. Each agent gets a
  sign-in and a client of its own (`credentials.json`: Claude Code's under the address as before, another agent's under
  `<address>#<app>`, so a 0.10.0 process still running keeps it; a `.gitignore` of `*` in the folder).
- Several agents, one approval: a device sign-in each, started together and shown as one link,
  `/device?code=A&code=B`, which Pending You turns into one consent card naming each agent and the computer, with one
  Allow (needs Pending You's Worker from this release). On a computer with a browser, the browser opens on it ("Your
  browser is open on Pending You: press Allow once for Claude Code and Codex (codes …)"); over SSH, the link, a QR code
  and each code. `--device` shows the codes anywhere, `--browser` opens the browser anyway, `--no-browser` only prints
  the address. Cancel stops `init` before it changes anything. `login --app <app>` signs one agent in again, with its
  own client, so it keeps its connection; `login --browser` no longer refuses a connection.
- Codex CLI (0.152 or later, whose `http_headers_helper` can give Authorization): its `[mcp_servers.pendingyou]` table
  in `~/.codex/config.toml`, edited in place with every other line as it was, signed in through the helper
  (`--app codex`) with `default_tools_approval_mode = "approve"`; a stored OAuth sign-in, which would win over the
  helper, is logged out first. Its skill in `~/.agents/skills/pendingyou/SKILL.md`, and four hooks in
  `~/.codex/hooks.json`, added after the person's own: a session start (startup, resume, clear), each message, Pending
  You's card tools, and the Stop check (pattern matching on Codex's final message, once a turn at most). Codex runs a
  hook only once the person trusts it: `init` says to choose “Trust all and continue”, `status` says which are trusted
  (from Codex's own hash of each), and `uninstall` keeps the trust of the person's own hooks that move up when ours go.
  When a card a Codex thread posted is answered, a listener the hooks start for that thread runs `codex queue` in the
  wake mod's words (never with the answer itself, which other programs could read in its arguments) (Codex 0.157 or later starts a turn on an idle thread; `init` says so on an older
  one). A server and hooks Codex's `/import` copied from Claude Code are replaced. Not on Windows yet.
- What happens to a `pendingyou` server that's there is decided before anyone signs in. At this Pending You, signing
  in by itself (the agent's own OAuth, or the Pending You plugin with no server added by hand): moved to this
  computer's sign-in without a word where there's no browser, on Yes (the default) at a terminal after saying what
  that means, or with `--yes`; with nobody to ask, kept, with the command that switches it. Kept, the agent's hooks get
  a sign-in that only hears, and a kept plugin carries the skill, so none is saved. At another Pending You: replaced
  once the person says so (or `--yes`); kept, that agent is left as it is.
- `--oauth`: every agent signs in to its MCP server by itself, as before 0.11.0 (Claude Code's `claude mcp add`; Codex's
  table without the helper, then `codex mcp login pendingyou`).
- Finishing setup by itself: a session start (new, resumed or cleared, never a compaction) adds one line while Pending
  You says the agent's setup isn't finished (hear_answers' `for.setup`, on the request the hook makes anyway): what to
  call, or that the test card's answer is waiting to be picked up; at most 3 times per `init`, none after 7 days, never
  once it's verified. `init`'s copy of the wake mod starts that turn itself in Claude Code 2.1.287 or later. `init`
  ends with the sentence to say when it doesn't, on its own line: “Finish setting up Pending You: it’s connected here
  already.” (`FINISH_SAY`, the same as Pending You's pages).
- The hooks run a script with a path that never changes, `~/.config/pendingyou/bin/pendingyou-hook <command> --app
  <app>`, which runs this version's private copy: upgrading rewrites the script, never the hook lines. Every request a
  hook or the listener makes names its app (`source`).
- Node, without the shell's PATH (a Claude Code started from its desktop app or an IDE, Codex's stripped environment):
  `init` records the Node it ran with by its stable path (`/opt/homebrew/bin/node`, not the Cellar folder an upgrade
  removes), and the helper and the hooks' script also look in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.volta/bin`.
  A Mac is named by its own name (`scutil --get ComputerName`) unless `--name` says otherwise.
- `status` has a section for each agent `init` set up, a `Setup:` line (finished, waiting for the first session with
  the sentence to say, the test card waiting on you, or answered and being picked up) that never changes Ready, and
  "no browser here" in its header only when that's true. `uninstall` covers each agent, takes out the shared parts once
  none is left, says which connections stay on your Assistants page, and ends with how to connect again.
- `pendingyou mcp --app <app>` is reserved for a stdio MCP server for an agent that can't run a headers helper; it says
  it isn't ready yet.

## 0.10.0

- The wake mod: Claude Code 2.1.287 or later is woken when you answer, with nothing waiting in the background. A
  session heard your answer only while `npx pendingyou hold` ran, and a hold stops: after its own 4 hours, or sooner
  when Claude Code stops a background command. Then it said "Don't start another hold now", and an answer that came
  later waited until you next typed in that session; two sessions missed answers that way overnight (2026-10-04).
  `init` now adds the Pending You plugin's mod, which this package carries in `mod/`, to `CLAUDE_CODE_PLUGIN_DIRS`
  (`env` in `~/.claude/settings.json`), from the hooks' own copy in `~/.config/pendingyou/cli/0.10.0/`, keeping any
  other folders there and replacing an older version's copy. Each session then learns the cards it posts, checks them
  through its own Pending You connection (every 20 seconds while a card changed in the last half hour, then every
  minute), and starts one turn when you answer, write back or a fallback comes due: “Pending You: your person
  answered … Call get_request for it …, act on their words, then ack_answer.” Under the prompt it shows
  `⚠ pendingyou-wake: 2 waiting on you`. It answers `npx pendingyou hold` itself, so an agent that still runs one waits on
  nothing. With the Pending You plugin installed too (it carries the same mod, plugin 2.24), only one copy acts. On an
  older Claude Code, or none, `init` skips it without a word. `uninstall` takes it out; `status` says whether it's
  loaded, from where, and what to do when it isn't.
- Without the mod, a hold that stops without an answer (its own `--timeout`, or Claude Code stopping it) says to start
  it again in the background, with the exact command, `--origin` and `--timeout` included when they aren't the
  defaults.
- The next-message hook looks for this folder's answers with every message, not only while a hold had left an entry
  behind: one request, as before, given up after 2 seconds, inside the hook's 3-second deadline. `state.json` no
  longer keeps holds' waits.
- A computer with no browser (a server you SSH into): one code approved on your phone sets Claude Code up.
  `/mcp`'s Authenticate opened a browser on that machine, which nobody could reach, and `login --device` only signed
  this command in. Now `init` there (an SSH session, or Linux with no display; `--device` forces it, `--browser` the
  browser) signs the machine in by code as a Claude Code connection of its own ("Claude Code on build-01" on your
  Assistants page, named by `--name`, else Tailscale's name for it, else its hostname; `login --name` with a new name
  renames the connection with one more approval, which `login` suggests for a cloud's own name like `ip-10-42-1-252`;
  QR code of the link at a terminal), then adds the MCP server with a `headersHelper` instead of OAuth
  (`claude mcp add-json`), the wake mod in `env.CLAUDE_CODE_PLUGIN_DIRS` with `mcp__pendingyou` allowed, the skill and
  the hooks. The helper, `~/.config/pendingyou/bin/pendingyou-mcp-headers`, is a small sh script Claude Code runs on
  each connection: it finds Node on PATH, then nvm's default, then the Node `init` ran with, runs this version's own
  copy (never npx) and prints only `{"Authorization":"Bearer …"}` (`pendingyou mcp-headers`), refreshing the sign-in in
  the background when it's due. A browser sign-in at the same address (0.9.0's) is switched over; another's
  `headersHelper` is kept. `login` there signs in that connection again, with the same client, so the machine keeps
  one connection. `status` says what's set up and what's missing (it runs the helper as Claude Code would with a bare
  PATH), each with the command that fixes it, `--origin` included off production. `uninstall` takes the helper out and
  says the connection stays on your Assistants page. Needs Pending You's Worker from the same release.
- `login` over SSH signs in by code without `--device`. A sign-in by code names the computer, and the phone asks "Let
  build-01 hear your answers for the assistants running on it?"; in the browser, "Let this computer hear…". Neither
  offers a choice of assistant any more: a computer hears for the assistants running on it. A sign-in
  pointed at one assistant before then keeps hearing it, so `watch` for a Muse or another app can't be set up anew.
- Routing by sender: the hooks and `hold` ask Pending You for Claude Code's cards only (`source=claude-code`), so a card
  Codex or another app posted from the same folder never reaches a Claude Code session, even with a sign-in pointed at
  that app. `watch` names no app: it hands answers to a script, not a session. Pending You treats a folder's request
  from an older version the same way.
- Hooks still run 0.9.0 from `~/.config/pendingyou/cli/0.9.0/`: run `npx pendingyou@latest init` once to switch, and
  to add the mod.

## 0.9.0

- The Stop check catches a final message that asks you to type or reply something in Claude Code's own chat
  ("Reply “yes, erase disk12” here", "To confirm, type `yes`", "Confirm here"). Some steps an agent takes only on your
  own words in its conversation, not on a card answer (something that can't be undone, credentials, anything outside
  its sandbox), and that's right; but when it asks only in its chat, you never learn where you're needed. Unless a
  Pending You card posted in that turn, or one still open from this folder, asks for the same thing, Claude Code is
  asked once to post an action card that sends you there (about 76 tokens, plus the link): titled “Confirm in Claude
  Code on <computer>: <step>”, with the exact words as a step's command (so the card shows them with a copy button),
  where to type them, and what it'll do then; or, for a card you already answered, to reopen it with the same ask.
- The link is the session's own when Claude Code says it: `https://claude.ai/code/<id>` from
  `CLAUDE_CODE_BRIDGE_SESSION_ID` while Remote Control is on, or from `CLAUDE_CODE_REMOTE_SESSION_ID` on the web.
- It counts as an ask: an imperative or a request to you ("please …", "can you …", "I need you to …") with the words
  quoted, in backticks, or a plain "yes", tied to this chat ("here", "in this chat") or to going ahead ("to confirm",
  "and I'll …"). Not in code, block quotes or quoted text; not what a program, prompt, page or message says; not a step
  in your terminal, at a prompt or on a page; not a standing offer ("anytime"); not a command or slash command. A card
  matches when its words name what's being confirmed ("erase" and "disk12"), or, with only a "yes" to go on, when it
  was posted in the turn or its title asks to confirm.
- Only such a message costs a request: this folder's open cards (the same one the next-message hook makes), given up
  after 1.5 seconds. When Pending You can't say (offline, slow, an older server), the message's own word that it's on
  a card is taken. Everything else the Stop check does is as before, with no request.
- Hooks still run this version from `~/.config/pendingyou/cli/0.9.0/`: run `npx pendingyou@latest init` once to switch.

## 0.8.0

- The hooks say when a session is on another Pending You. A Claude Code session stayed connected to staging after its
  person moved to production, so its cards went where they no longer looked. Now both hooks (`pickup` at session
  start, `handoff` with every message) compare the `pendingyou` MCP server Claude Code uses in the session's folder
  with the origin they run against (`--origin`), and when they're different sites add one line (about 45 tokens):
  `Pending You: your MCP server is https://staging.pendingyou.com but your hooks and sign-in are
  https://www.pendingyou.com, so your cards and their answers may not meet. Ask your person which one they use, and
  restart the session after fixing it (npx pendingyou init --origin <that one>).` The server is the one Claude Code
  would use there: local scope (`~/.claude.json`'s `projects`), then the folder's `.mcp.json`, then user scope, then
  the Pending You plugin when `~/.claude/settings.json` enables it (production's server). All read only, and only the
  `pendingyou` server's address is looked at; nothing is sent. `pendingyou.com` and `www.pendingyou.com` are the same
  site; a file that can't be read is never a mismatch. The line is said even when the hooks' origin isn't signed in,
  and it's kept when a hook reaches its 3-second deadline.
- `status` says the same: a `Mismatch:` line naming both sites and what to do, a line for a folder's own
  (local- or project-scope) server that points elsewhere, and "Not ready" (exit 1) until they agree.

## 0.7.0

- Faster hooks. They ran `npx -y --prefer-offline pendingyou@<version> …`, and npx alone took about half a second
  (and real CPU) before each one started; sessions starting or resuming together queued on npm's cache lock. `init`
  now keeps a copy of this version in `~/.config/pendingyou/cli/<version>/` (copied from the package it runs from, or
  installed with `npm install --prefix`, checked before it's used) and the hooks run it with Node directly:
  `"<node>" "~/.config/pendingyou/cli/0.7.0/node_modules/pendingyou/dist/cli.js" handoff || true`. A signed-out
  pickup went from 0.42 s to 0.04 s; a hand-off with its request from 0.77 s to 0.26 s. When the copy can't be made,
  the hooks keep the npx form. Running `init` again upgrades the copy in place and removes old versions;
  `uninstall` removes it; `status` says how the hooks run. To switch: `npx pendingyou@latest init`.
- `init` no longer looks hung: it says before each slow step what it's waiting on ("Adding the pendingyou MCP server
  to Claude Code (this can take a minute)…"), gives Claude Code 3 minutes, and says plainly if it ran out. It reads
  the MCP server from `~/.claude.json` (read only) instead of asking `claude mcp get`, which takes a minute, so a
  server that's already there costs no `claude` call at all.
- Fixed: `init` kept a `pendingyou` MCP server that pointed at another origin (staging, when you asked for
  production) and only said "check Claude Code didn't add the MCP server". It now names both addresses and replaces
  the old one once you say so: asked at the terminal, or `--yes` to replace without asking. With nobody to ask, it
  prints the two `claude mcp` commands. Then restart Claude Code, run `/mcp` and Authenticate.
- Everything from 0.6.0 stays: the 3-second deadline (which no longer loses half a second to npx), the background
  refresh and the Stop check.

## 0.6.0

- Fixed: a hook could run past Claude Code's 10 seconds (`UserPromptSubmit hook … timed out after 10s — output
  discarded`), mostly when the sign-in needed refreshing, which no time limit covered. Every hook (`pickup`,
  `handoff`, `stopcheck`) now stops 3 seconds after it starts, printing only its plain fallback (the hand-off's
  one-line reminder; nothing from the others, so the Stop check lets the turn end) and exiting 0. Requests give up
  sooner too: 2.5 seconds for `pickup` (was 5), 2 for `handoff` with answers (was 2.5), 1.5 for open cards.
- A hook never refreshes the sign-in itself. Cut off halfway, a refresh can end the sign-in, so when the access token
  runs out within 5 minutes a hook starts `pendingyou refresh` in the background, detached, which finishes under the
  credentials lock however the hook ends (one at a time: none starts while another holds the lock). The hook goes on
  with the token it has; one that has run out waits up to 1.2 seconds for the new one, then falls back.
- A refresh now gives up within 20 seconds in all (it could take 35), inside the lock's 30, so a slow one is never
  taken over while it's still running.
- The Stop check no longer asks Claude Code to go on over "There's nothing waiting on you" or "no cards from me
  waiting on you" (a negation before "waiting on you"), or "say if it needs you to download it" (what another agent
  will say, if it ever does). A message that says nothing needs a card ("No card needed.", "Nothing needs your
  attention.", "doesn't need a card") is taken at its word, as the Stop reason offers.

## 0.5.0

- A card with several questions (guide 2.6) prints each answer on its own line when `hold` ends (and when a hook
  hands the answer over): `1. Pay Kaiser’s invoice 09/30 for $1,200? (pay): Approved`, numbered in the card's order,
  with the question's id as `answer.answers` has it. A question your person split out into a card of its own is named
  with its new request id: hear its answer there.
- When an answer is ready, the line telling Claude Code to call `ack_answer` (or `reply_in_thread`) now names the
  session too (`name “billing-webhooks”`): since guide 2.5 the sessions sharing a computer's sign-in each act only on
  their own cards, and pass their name to do so.
- The next-message hook's open-cards line names the session that asked each card (`(req_…, by dns-setup)`, from
  servers on guide 2.5, cut to 24 characters) and says to cancel only one of yours, with `answeredHere` and your name.

## 0.4.0

- The next-message hook's reminder now names this folder's open cards still waiting on you, so a question you answer
  in chat gets its card cancelled: `Pending You: anything you need from your person also goes on a card. Your open
  cards here: "Which DNS host?" (req_…); … +2 more. If this message answers or settles one, cancel_request it with
  answeredHere (or update_request if it changed).` At most 3 cards, newest first, titles cut to 50 characters; the
  plain reminder when none are open. One small request per message while signed in (answers too while a hold is
  outstanding), given up after 1.5 seconds; on any error, or against a server that doesn't list open cards yet, the
  line is the plain reminder.
- The Stop check no longer asks Claude Code to go on when its message says a card is coming ("you'll get a card to
  publish it once it's merged", "I'll post a card", "I'll send you a card").

## 0.3.0

- New Stop hook, `pendingyou stopcheck`: when Claude Code ends a turn with a question for you, a step only you can do
  or a "Your part:" list, and posted nothing to Pending You in that turn, it's asked once to post them as cards (or
  say they don't need one). Pattern matching only, on the last turn, at most 4 MB of the transcript; quiet when not
  signed in, never twice in a row (`stop_hook_active`), and silent on any error.
- The next-message hook adds one line while you're signed in: “Pending You: anything you need from your person also
  goes on a card.”
- `init` adds the Stop hook (run it again on 0.2.x to get it), `uninstall` removes it, and `status` lists it.

## 0.2.1

- Fixed: after `init --origin <url>` (any origin but the default), every Claude Code message was blocked with
  `UserPromptSubmit operation blocked by hook: … There's no "--origin" command.` 0.2.0 wrote its hooks with `--origin`
  before the command, which it couldn't read. To repair: `npx pendingyou@latest init --origin <url>` (or, if you ran
  `uninstall` to get unblocked, the same command sets it up again).
- Hooks now name the command first (`pendingyou@0.2.1 handoff --origin <url>`), add `--origin` only when it isn't the
  default, and end in `|| true`.
- Options can come before or after the command.
- `pickup` and `handoff` never block: on any error (bad options, no network, not signed in) they exit 0, print nothing
  for Claude Code, and leave at most a short note on stderr.
- Running `init` again repairs hook lines an older version wrote.

## 0.2.0

- `login --device` for computers with no browser, and `watch` for always-on scripts.
