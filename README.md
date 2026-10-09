# pendingyou

Pending You for your coding agents. Your agents ask you in [Pending You](https://www.pendingyou.com) when you're away;
this command sets Claude Code, Codex, OpenCode and Pi up to ask there and to hear your answer the moment it's ready,
even while they sit idle at the prompt.

```sh
npx -y pendingyou@latest init
```

Run it once on each computer, in a terminal. It finds the agents on the computer (Claude Code, Codex, OpenCode, Pi;
`--app` names some), says what it found, and for each one:

- connects it to Pending You through **this computer's own sign-in**: its own connection ("Claude Code on Ann-MBP",
  "Codex on Ann-MBP" on your Assistants page), which its MCP server and its hooks share, so there's nothing to
  Authenticate in the agent and no second sign-in,
- signs them all in with **one approval**: your browser opens on Pending You with one card naming each agent and this
  computer, and you press Allow once (over SSH: a code and a QR code for your phone, [below](#a-computer-with-no-browser)),
- adds the Pending You MCP server for every project, signed in through a small helper script (OpenCode and Pi:
  through a small local bridge, [below](#opencode)), and lets the agent use Pending You's tools without asking each
  time,
- saves the Pending You skill (Claude Code: `~/.claude/skills/pendingyou/SKILL.md`; Codex:
  `~/.agents/skills/pendingyou/SKILL.md`; OpenCode reads either, else `~/.config/opencode/skills/pendingyou/SKILL.md`;
  Pi reads Codex's, else `~/.pi/agent/skills/pendingyou/SKILL.md`),
- adds the hooks that hand it your answers: a new session picks up answers that arrived while nothing was running,
  your next message brings a waiting answer with it, and a check when it finishes a turn catches what it left you only
  in chat ([below](#nothing-left-only-in-chat)); for Claude Code and Codex, a card when it waits for your OK to run
  something ([below](#when-claude-code-waits-for-your-ok)); and they tell Pending You which sessions are open
  ([below](#which-sessions-are-open)),
- and wakes it when you answer: Claude Code 2.1.287 or later through the wake mod, Codex through `codex queue`, OpenCode
  through its plugin and Pi through its extension (which also do the hooks' work there); and when you hand it a
  question from another of your assistants ([below](#when-you-hand-an-agent-a-question)).

Then it says what to do next, and the one sentence to say if it's needed:

```
Next: restart Claude Code here (/exit, then claude --continue), or start it in the folder you work in.
It finishes setting up by itself and sends you a test card. If it doesn't, say this to it:

Finish setting up Pending You: it’s connected here already.
```

The first session finishes setting up on its own: it checks in with Pending You, reports what's set up and sends you a
test card. Claude Code 2.1.287 or later starts that turn by itself; otherwise (and in Codex, after you trust its hooks in
`/hooks`) the session start adds one line with
the three calls that are left, and you say the sentence.
`npx pendingyou status` says what's set up for each agent, what's missing with the command that fixes it, and how setup
stands. `npx pendingyou uninstall` removes exactly what `init` added.

Your other settings are kept as they are: `init` merges into Claude Code's `~/.claude/settings.json`, Codex's
`~/.codex/config.toml` (its `[mcp_servers.pendingyou]` table and nothing else, every other line as it was) and
`~/.codex/hooks.json`, OpenCode's config and Pi's `~/.pi/agent/mcp.json` and `settings.json` (Pending You's own entry
in each, every other byte as it was), and running it again changes nothing it doesn't need to.

**A pendingyou server that's there already** is decided on before anyone signs in. One at another Pending You
(staging, say) is named and replaced only once you say so (`--yes` replaces it without asking); keep it and that agent
is left as it is. One at this Pending You that signs in by itself (Claude Code's `/mcp` → Authenticate, Codex's
`codex mcp login`, or the Pending You plugin for Claude) is moved to this computer's sign-in: where there's no browser
(it can't finish there anyway) without asking, saying what it switched; on Yes (the default) at a terminal; or with
`--yes`; with nobody to ask it's kept, and `init` prints the command that switches it. Once the agent shows up on this
computer's sign-in, Pending You moves the old sign-in's agents over to it, with their cards and the questions you
delegated to them, and signs the old one out. A kept plugin
carries the skill, so none is saved. `--oauth` keeps every agent signing in by itself, as before 0.11.0.

The hooks run a copy of this version kept in `~/.config/pendingyou/cli/<version>/`, through a small script with a path
that never changes, `~/.config/pendingyou/bin/pendingyou-hook`:

```
"~/.config/pendingyou/bin/pendingyou-hook" pickup --app claude-code || true
```

(the path in full). Upgrading rewrites that script, never the hook lines, so Codex, which runs a hook only while you
trust its exact definition, doesn't ask again. The script runs the copy with the Node `init` ran with, by its stable
path (Homebrew's `/opt/homebrew/bin/node`, which outlives an upgrade), or the first Node it finds. If the copy can't be
made (no npm, no network), the hooks run through `npx -y --prefer-offline pendingyou@<version>` instead.

The hooks never get in your way: if anything goes wrong (no network, not signed in, a bad option), they print nothing
and let your message through. Each one stops within 3 seconds whatever happens, with at most its one-line reminder, and
never refreshes the sign-in itself: when that's due, it starts the refresh in the background, which finishes on its
own. Each hands an agent only its own app's cards from its folder, never one another agent posted there.

If the `pendingyou` MCP server Claude Code uses in a session's folder is another Pending You than the hooks' (staging
and production, say), both hooks add one line telling Claude Code so, and to ask you which one you use: its cards
would otherwise go where you don't look. `npx pendingyou status` flags it too. Fix it with `npx pendingyou init
--origin <the one you use>`, then restart the session. Codex's hooks do the same for Codex's server.

## Codex

Codex CLI 0.152 or later (its `http_headers_helper` gives the sign-in; 0.157 or later wakes an idle thread by itself).
`init` writes, in `~/.codex/config.toml`:

```toml
[mcp_servers.pendingyou]
url = "https://www.pendingyou.com/mcp"
http_headers_helper = "/Users/ann/.config/pendingyou/bin/pendingyou-mcp-headers --app codex"
default_tools_approval_mode = "approve"
```

and hooks in `~/.codex/hooks.json`: a session start, each message, Pending You's card tools (so the Stop check knows a
turn posted, and so the thread is woken), and the Stop check; and (0.15.0) Codex's permission prompt and every tool
call that ran (a card when Codex waits for your OK, [below](#when-claude-code-waits-for-your-ok)) and the session's end
([below](#which-sessions-are-open)). **Codex runs a hook only once you trust it**, in Codex's `/hooks`. When `init` or
`status` finds Pending You's hooks not trusted yet, it prints the one command that opens a Codex here (`codex`, or
the one the ChatGPT app brings, by its full path) and says to type `/hooks` there and trust them; at a terminal it
then waits (every 3 seconds, for up to 10 minutes; Ctrl-C stops it) until Codex trusts them, and says whether Codex is
ready. It never trusts them for you. `status` says which are trusted. Upgrading from 0.14.0 adds three hooks, which Codex
skips until you trust them once; `init` says so, and the ones you trusted stay trusted. A `pendingyou` server or
hooks Codex's `/import` copied from Claude Code (without its sign-in) are replaced.

**The Codex app** (on a Mac, in the ChatGPT app) shares all of this with Codex CLI: the same `~/.codex`, server, hooks
and trust. With no `codex` on PATH, `init` uses the app's own (inside `/Applications/ChatGPT.app` or
`~/Applications`), for the version and everything else it runs. Don't press Save on pendingyou in the app's MCP
settings: that writes the table again without `http_headers_helper` (and `default_tools_approval_mode`), so Codex stops
signing in through this computer's sign-in. `status` says so when it happens; `npx -y pendingyou@latest init` puts it
back.

When you answer a card a Codex thread posted, a small listener `init`'s hooks start for that thread puts a message into
it with `codex queue`: “Pending You: your person answered “…” (req_…). Call get_request …”, which reads your answer (the
answer itself never goes in a command's arguments, where other programs could see it). Codex starts a turn at
once when the thread is open and idle, after the current one when it's working, or when you next open it. In the Codex
app, a chat it has open is woken while the app runs (one it let go, idle 3 hours or behind 10 newer idle chats, when
you open it again). One more listener, for the whole app, queues a question you hand a thread from another assistant
([below](#when-you-hand-an-agent-a-question)).

## OpenCode

OpenCode 1.17.0 or later. Its MCP clients can't take a header from a command, so `init` gives it a local server instead:
the stdio bridge, `pendingyou mcp`, which passes each message on to Pending You with OpenCode's own connection here
("OpenCode on Ann-MBP"), so there's still one sign-in and nothing to Authenticate. In OpenCode's global config
(`~/.config/opencode/opencode.json` or `.jsonc`, edited in place with your comments and everything else kept):

```json
"mcp": {
  "pendingyou": {
    "type": "local",
    "command": ["/Users/ann/.config/pendingyou/bin/pendingyou-mcp", "--app", "opencode"]
  }
}
```

That path never changes: upgrading rewrites the small script there, never OpenCode's config. If your config's
`permission` makes OpenCode ask (`"ask"`), `init` adds `"pendingyou_*": "allow"` so a question you're away for doesn't
wait on a prompt; a rule of your own for Pending You's tools is kept. `--oauth` adds `{"type": "remote", "url":
"https://www.pendingyou.com/mcp"}` instead, which you sign in to with `opencode mcp auth pendingyou`.

And a plugin, `~/.config/opencode/plugins/pendingyou.js`, one line that loads this version's from its private copy. It
does in OpenCode what the hooks do elsewhere, through the same hooks' script: each message you send carries the
reminder and any answer waiting (hidden in OpenCode's view, read by the model), a session's first message also says
what setup has left, a session that left you a question in chat is asked once to put it on a card (with a toast saying
why), and when you answer a card a session posted, the plugin starts a turn in that session: “Pending You: your person
answered “…” (req_…). Call get_request …” (never the answer itself). That works while OpenCode is open, idle or busy,
and for a question you hand the session from another assistant too ([below](#when-you-hand-an-agent-a-question)).

Then restart OpenCode (`/exit`, then `opencode --continue`): it finishes setting up the first time you write to it.

## Pi

Pi 0.99.0 or later (pi.dev, the `pi` command; its MCP client came in 0.99.0). Like OpenCode, Pi runs the bridge as a
local server, with its own connection here ("Pi on Ann-MBP"). In `~/.pi/agent/mcp.json` (or `$PI_CODING_AGENT_DIR`'s,
edited in place, everything else kept):

```json
"pendingyou": {
  "command": "/Users/ann/.config/pendingyou/bin/pendingyou-mcp",
  "args": ["--app", "pi"],
  "exposure": "direct",
  "description": "Ask your person through Pending You when a decision, fact or step is theirs, and hear their answers."
}
```

`direct` puts Pending You's tools in front of Pi's model (Pi's default leaves an MCP server's tools to scripts). Pi asks
nobody before it runs a tool, so there's nothing to allow. `--oauth` adds Pending You's address instead, which you sign
in to with `pi mcp login pendingyou` (from Pi 1.0.1 as pi.dev's own client).

Pi has no hooks, so `init` gives it an extension: `~/.config/pendingyou/pi/pendingyou.js`, in the `extensions` of Pi's
`~/.pi/agent/settings.json`, by a path that never changes (upgrading rewrites the file, never your settings). It runs
the same hooks' script as a session starts, with each message, after Pending You's card tools and as a run ends (a run
that leaves you something only in chat goes on once), and when you answer a card a session posted it starts a turn in
that session, idle or busy: “Pending You: your person answered “…” (req_…). Call get_request …” (never the answer
itself), and the same for a question you hand it from another assistant
([below](#when-you-hand-an-agent-a-question)). In Pi's terminal the first session finishes setting up by itself, once
Pending You's tools are there.

Then run `/reload` in each Pi session that's open, or start `pi`. Pi's shell waits for a command to end, so in Pi
`npx pendingyou hold` answers at once instead of waiting.

## Nothing left only in chat

Deep into a long conversation, Claude Code tends to end a turn with a question for you, a step only you can do, or a
"Your part:" list, and not put it in Pending You. Two small things catch that while you're signed in:

- Each message you send carries one line for Claude Code (about 18 tokens): *Pending You: anything you need from your
  person also goes on a card.* While cards Claude Code posted from this folder are still waiting on you, the same line
  names them (at most 3, newest first, about 20 tokens each) and asks it to `cancel_request` one with `answeredHere`
  when your message answers it, so a question you answer in chat doesn't stay in your queue. That costs one small
  request per message, which brings any answer waiting for this folder too, given up after 2 seconds.
- When Claude Code finishes a turn, `pendingyou stopcheck` looks at its last message. If it has something for you and
  nothing was posted, updated or replied to in Pending You that turn (and the message doesn't say it's on a card, or
  that one is coming),
  Claude Code is asked to go on once (about 31 tokens): post them as cards, or say they don't need one. It never asks
  twice in a row.

The check is pattern matching on your computer: no model. It reads only the last turn from the end of the
transcript (at most 4 MB) and skips code blocks and quotes. It counts as for you: a question to you (a sentence ending
in "?" with "you" or "your"); "you'll need to", "your step", "can you", "please run", "in your terminal", "only you
can", "waiting on you" and the like; or a list under a heading like "Your part", "Your steps", "For you", "Waiting on
you" or "Left for you". It lets the turn end when the message says nothing needs a card ("No card needed.", "Nothing
needs your attention.", "There's nothing waiting on you.").

Since 0.19.0 it also lets the turn end on a recap of cards already waiting on you. A sentence that says its cards wait
on you ("Two cards are waiting on you: …", "… (both cards).") covers what it asks, and so does a heading that does
("Cards waiting for you:") over its list; anything else for you in the message is checked as before, so a new ask
beside a recap still goes on a card. And anything else for you, in a message that talks about cards, is taken as a
recap while this folder has a card waiting on you: only such a message costs a request (this folder's open cards,
given up after 1.5 seconds), and when Pending You can't say, the turn ends.

Since 0.9.0 it also catches a message asking you to type or reply something in Claude Code's own chat ("Reply “yes,
erase disk12” here", "To confirm, type `yes`", "Confirm here"). Some steps an agent takes only on your own words in
its conversation, never on a card answer; that's fine, but then a card has to send you there. Unless a card posted in
that turn, or one still open from this folder, asks for the same thing, Claude Code is asked once to post an action
card titled “Confirm in Claude Code on <computer>: <step>”, with the exact words to copy, where to type them (the
session's link when Remote Control or Claude Code on the web gives one) and what it'll do then. Only such a message
costs a request: this folder's open cards, given up after 1.5 seconds.

Codex gets the same two (0.11.0). Its Stop check reads Codex's final message, and whether the turn posted, updated or
replied on a card comes from Codex's own hook for Pending You's tools in that turn; it asks once a turn at most, for an
action card titled “Confirm in Codex on <computer>: <step>” when it asked you to type something there. OpenCode's plugin
and Pi's extension (0.12.0) do the same in theirs.

A question you hand an agent from another assistant (0.14.0) is never asked to go on a card of its own: answering it
(`answer_delegated`) or giving it back (`hand_back`) puts it in front of you, so it counts as the turn's card call. A
turn that such a question started, and that left you something in chat without doing either, is asked once to answer
it or hand it back instead (about 45 tokens). Codex's hook for Pending You's tools is trusted by its exact list of
tools, which doesn't name those two, so there the check knows only that the turn started with one (when Codex gives the
message to its next-message hook), and says “unless you already did”.

**On 0.2.0 with another origin?** Its hooks blocked every message (`There's no "--origin" command`). Run
`npx pendingyou@latest init --origin <url>` again to repair them; see [CHANGELOG.md](CHANGELOG.md).

## When Claude Code waits for your OK

Claude Code stops to ask before it runs something it isn't allowed to run by itself (`rm -rf dist/`, a push, a file
outside the folder), and waits, however long you're away. Since 0.13.0, when you don't answer within 10 seconds, a card
says so: “Claude Code is waiting for your OK: rm -rf dist/”, with the folder and the computer, and one step: answer it
in Claude Code there (with the session's link while Remote Control is on, where you can answer it from your phone).
It's asked in both places, so you get a push only once it has waited your hand-off time (3 minutes unless you changed
it). It goes away by itself once you answer in Claude Code: allowed, denied, or the session closed. One card per
session: a newer prompt changes it.

The hook (Claude Code's PermissionRequest) never answers for you: it prints nothing, so the prompt shows exactly as
before, and it's done in about a tenth of a second. A small process in the background posts, changes and withdraws the
card through Pending You, with Claude Code's own connection here. Nothing secret goes on the card: values after
anything named like a key, token or password, a URL's user and password and query values, and anything that looks like
a key are blanked (`curl -H "Authorization: …" https://api.example.com/items?token=…`), and a command that can't be
shown safely (several lines, inline code like `node -e`, one that takes a secret) shows only as “Bash: node …”. No card
for `claude -p` or the Agent SDK, where nobody sees a prompt.

In bypassPermissions mode (`--dangerously-skip-permissions`) Claude Code still asks for a few things: a dangerous `rm`,
an ask rule of yours, a safety check it can't verify. Since 0.16.0 those get a card too, once Claude Code says the
dialog has waited a few seconds with nobody typing (its Notification hook, which `init` adds for permission dialogs
only): a call it denies by itself, showing you nothing, never gets one. The same hook puts up a card for a dialog no
other hook sees (a sandboxed command asking for the network), in Claude Code's own words, and in the other modes puts
a card up as soon as Claude Code says so, without waiting the full 10 seconds. A background agent's prompt says so:
“Claude Code is waiting for your OK: pnpm lint && git push (a background agent)”.

It needs Claude Code 2.1.119 or later, signing in through this computer's sign-in (not `--oauth`), and isn't on
Windows yet. Don't want it? `npx pendingyou init --no-permission-cards` (later runs keep it off; `--permission-cards`
turns it back on). `npx pendingyou status` says which.

**Codex** (0.15.0) gets the same: when Codex stops to ask for your approval (a command that needs more than its sandbox
gives, a patch, an MCP tool) and you don't answer within 10 seconds, a card says “Codex is waiting for your OK: git push
origin main” (“…: edit src/app.ts and 1 more” for a patch), with Codex's reason for asking, blanked like the rest. Its
PermissionRequest hook prints nothing, so Codex asks exactly as before; the card goes once the call runs, you write to
Codex, the turn ends or the thread closes. It needs Codex signing in through this computer's sign-in, and trusting the
new hooks once. The Codex app's browser-use prompts don't run that hook, so they get no card.

### Allow or Deny on the card (0.33.0)

Start Claude Code with `npx pendingyou claude` (any of `claude`'s own arguments after it) and a prompt left waiting gets
a card with **Allow** and **Deny**, and the whole command or input it asks about, secrets masked: “Allow Claude Code
(billing-webhooks) to run a command?”. Tap one and the terminal's dialog closes and the call runs, or is refused. The
dialog stays open meanwhile, so you can still answer at the terminal: the first answer wins, and the card goes. Allow
is for that one call only; nothing is allowed after it.

It works through Claude Code's channels (a research preview): `init` registers a small local MCP server,
`pendingyou-permissions`, that Claude Code relays its permission prompts to in a session started this way, and that
sends Claude nothing. Until it's on Claude Code's allowlist, Claude Code shows a warning about development channels at
each start (`pendingyou claude` runs `claude --dangerously-load-development-channels server:pendingyou-permissions`).
It needs Claude Code 2.1.234 or later and the permission cards on; a session started with plain `claude` gets the card
without buttons, as above.

### Codex: ask on my phone first (0.34.0)

Codex shows nothing while its PermissionRequest hook runs, so its prompt can't be on the card and in the terminal at
once. Instead you can have it ask on your phone first:

```sh
npx pendingyou codex-answers --wait 2
```

Now when Codex needs your OK, a card goes up at once with **Allow** and **Deny** and the whole command or patch, secrets
masked: “Allow Codex (infra) to run a command?”. Tap one and Codex goes on (or is refused, told “Denied in Pending
You.”). With no answer within the wait, the card goes and Codex asks in its terminal as usual. The wait is 0 to 10
minutes, per computer; 0, the default, turns it off (the card without buttons, as above). `init` names it when it sets
Codex up, `status` shows it, and `uninstall` clears it.

It gives Codex's PermissionRequest hook the wait plus 30 seconds (630 seconds for 10 minutes; Codex sets no upper limit
for that hook). Codex trusts a hook by its whole definition, timeout included, so after changing the wait trust the hook
again: open Codex, type `/hooks`, and trust it. Allow is for that one call only; nothing is allowed after it.

## Which sessions are open

Since 0.15.0 Pending You hears which of your agents' sessions are open right now, so it can say so and offer an open
one a question. Each app tells it with its own connection here: the session's id, the name it goes by with Pending You,
its folder (under `~` only) and `live` or `closed`. Pending You counts a session open for 15 minutes after its last
`live`, so an open session says so every 5 minutes, with no model involved:

- **Claude Code**: as a session starts (its session-start hook, and the wake mod), then every 5 minutes from the wake
  mod while it's open (without the mod, with your messages); closed as it ends (a SessionEnd hook).
- **Codex**: as a thread starts or you write to it, a small process in the background says so every 5 minutes while
  Codex (or the Codex app) runs, and closed once it's gone; its SessionEnd hook (a conversation archived or closed, or
  idle 30 minutes) says closed.
- **OpenCode and Pi**: the plugin and the extension, as a session starts and every 5 minutes while the app runs, and
  closed as it goes.

It's never in your way: the hooks only start it in the background, each send gives up after 3 seconds, and a Pending
You from before presence is taken quietly. A sign-in that only hears (`--oauth`) sends nothing. `npx pendingyou status`
has a Presence line for each agent.

Since 0.18.0, a session in a [Herdr](https://herdr.dev) pane also says which pane (`HERDR_PANE_ID`, such as `w2:p1`)
and which Herdr server (16 hex characters of a hash of the computer's name and Herdr's socket path, never the path
itself), so Pending You can list where each of an agent's running sessions is and the Pending You plugin for Herdr can
take you to it. Anywhere else nothing of the kind is sent.

## In Herdr

Since 0.17.0, an agent running in a [Herdr](https://herdr.dev) pane marks its pane with what it's waiting on you for,
so Herdr's sidebar and Agents panel can show it: display-only metadata Herdr keeps on this computer (`herdr agent list`
shows it), written with Herdr's own command line:

- `py_app` and `py_agent`: the app and the name the session goes by with Pending You;
- `py_waiting`: how many of its cards wait on you; `py_card` the most pressing one's title (anything that looks like a
  secret taken out, at most 80 characters); `py_cards` their request ids; `py_urgency` how pressing (`blocking`, `now`,
  `today`, `whenever`); `py_asked` the ones it also asked you in its conversation;
- and its state reads "waiting on you" instead of idle or done while something waits.

Claude Code's wake mod writes them whenever they change, Codex's card hook and keeper, OpenCode's plugin and Pi's
extension through the commands they already run; every 5 minutes again, and they're taken off when nothing waits and as
the session ends. Herdr is given one second for each, never through a shell, and never waited on by a hook; it forgets
them after 15 minutes unless told again.

The Pending You plugin for Herdr puts them to use: the card on each waiting agent's row in the sidebar, a toast when a
pane gains one, a key to the next pane waiting on you, a popup that lists them (Enter opens the card in Pending You), and
an Agents view with them first. Its commands are this command line's: `npx pendingyou herdr doctor` says what's set
up. Its `unconfigure` takes the badges off every pane and stops writing them on this computer (and signs Herdr out);
its setup turns them on again.

### Answering from Herdr (0.21.0)

Sign Herdr in, from the plugin's setup or here:

```sh
npx pendingyou app login herdr
```

Your phone or browser shows one card naming Herdr and this computer: press and hold Allow. Herdr then sees the cards
of this computer's agents (tick "all" on that card for every card of yours), and its popup (`prefix+y`) answers them
with a key: 1–9 for a choice (Enter sends several), y or n to approve or decline, Enter to write an answer, y or n for
a step done or not, Tab between a grouped card's questions; r writes to the agent, l puts it in Later, d hands it to
another of your agents, u undoes for 5 seconds, t goes to the agent's pane, o opens the card in Pending You. A
high-stakes card (it spends money, can't be undone or goes public) is never answered from Herdr: o opens it where you
hold to approve. Pending You says on the card and to the agent "Answered in Herdr on build-01". While you're active in
Herdr (moving between panes, tabs and workspaces, or pressing keys in the popup) your phone stays quiet for those cards,
as it does while Pending You is open on your desk.

`npx pendingyou app status` says what each app signed in here may do and until when (a sign-in lasts 30 days from its
last use here; it warns in the last 3), and `npx pendingyou app logout herdr` ends Herdr's sign-in. Settings › Apps and devices in Pending You
lists it too, with Remove. It needs `init` to have run here first: this computer's key vouches for the sign-in.

## How Claude Code hears your answer

**Claude Code 2.1.287 or later: the wake mod.** There's nothing to run. In each session the mod learns the cards
Claude Code posts, checks them through the session's own Pending You connection (every 20 seconds while a card changed
in the last half hour, then every minute), and when you answer (after the 5-second window to undo), write back, or a
fallback comes due, it starts a turn naming the card and what to do: read it with `get_request`, act, then
`ack_answer`. That works while the session sits idle at the prompt, for as long as it's open, and across a restart
with `claude --continue`. Under the prompt it shows `⚠ pendingyou-wake: 2 waiting on you`. If Claude Code still runs
`npx pendingyou hold`, the mod answers it at once and nothing runs in the background. With the Pending You plugin
installed as well, only one copy acts. `npx pendingyou status` says whether the mod is loaded.

Claude Code loads the mod only as a session starts, so a session that was already open when you ran `init` the first
time can't be woken until you restart it (`/exit`, then `claude --continue`): `init` names those sessions, and the
session itself is told once with your next message. Later upgrades don't need a restart: the mod lives in
`~/.config/pendingyou/mod`, which `init` updates in place, and open sessions reload it.

The mod's checks are Pending You tool calls like Claude Code's own, so they need Pending You's tools allowed, which
`init` does (`mcp__pendingyou`). If they aren't, the line under the prompt says which rule to add in `/permissions`, and
holds run as before.

**Older Claude Code: a background hold.** After it posts a question to Pending You, Claude Code runs this in the
background and keeps working:

```sh
npx pendingyou hold req_0123456789abcdef0123
```

When you answer, write back, or the question's fallback comes due, it prints a few lines (the question, your answer,
the next step) and exits. Claude Code wakes up with them. It stops on its own after 4 hours (`--timeout`), and Claude
Code may stop a background command sooner; either way it then says to start it again, with the exact command. Your
next message brings any answer with it too.

When you're at the terminal, Claude Code asks you there and puts the same question in Pending You at once; the
first answer wins. If you answer in the terminal, it withdraws the card and the hold ends by itself.

**When you'll handle it yourself (0.20.0; one meaning in 0.31.0).** A card you end with “I’ll handle it” in Pending
You reaches the agent the same ways, in these words: “The person will handle this themselves. Close it out: take no
action on it, leave things as they are (an email stays in their inbox, untouched), and don’t follow up or ask again.”
Then it picks it up with `ack_answer` and an outcome like “Left to you”, and never posts it again. A to-do you Skip
says you won't do it: the agent doesn't do it for you or follow up, and picks it up with an outcome like “Skipped”.

**Finishing setup by itself (0.11.0).** In `init`'s copy of the mod, a few seconds after a session you're at opens
(never `claude -p`), it asks Pending You whether Claude Code is set up here (`whoami`, once Pending You's tools are
allowed and the server has connected). When it isn't, it starts one turn once the session is idle: “Finish setting up
Pending You: it’s connected here already.” and exactly what to do. Once per session, in at most three sessions, never
two within ten minutes, and never again once Pending You says it's set up.

## When you hand an agent a question

In Pending You you can hand a card to another of your assistants, a coding task included (Delegate: the card's link,
or D on the desk): it answers for you (“Answer freely”), or its answer comes back to you first (“Keep me in the loop”),
or it hands the card back with what it checked. Since 0.14.0 the task you picked hears it the way it hears your
answers, once the 5-second window to undo is over:

- **Which session**: the one that goes by the task's name in its folder (the most recent, when several do); else the
  session in that folder that used Pending You most recently; never the one that asked, and never two. A sign-in that
  only hears (`--oauth`) hears every computer's, so it leaves one Pending You says went to another computer (by its
  name or its hostname); one that names no computer goes by the folder.
- **Claude Code**: the wake mod looks for questions handed to the session's name (`list_pending`, every minute while
  the session used Pending You in the last half hour, then every 3 minutes, for 12 hours), reads each with
  `get_request`, and starts a turn: “Pending You: your person handed you “Which AWS account for staging?” (req_…), a
  question from billing-webhooks (answer freely: your answer goes straight to billing-webhooks). Call get_request
  (requestId req_…, name “infra”) to read it and their note. If you know, answer_delegated with your answer and how you
  know; if not, hand_back with what you checked.” Among sessions by one name, the one working in the task's folder
  takes it (as `list_pending` gives it, `~/…` or a full path), one in another folder never does, and one that can't
  tell its folder waits 5 minutes.
- **Codex**: one listener for the app queues it into the thread it's for (`codex queue`, the same words).
- **OpenCode and Pi**: the session's listener starts the turn through the plugin or extension; a session that used
  Pending You's card tools keeps listening for 12 hours, while the app is open.
- **Otherwise**: a session start or your next message in that folder brings it, with your note: at once in the
  session that goes by the task's name, after 5 minutes in any other.

Your note never goes in a program's arguments, where any other program on the computer could read it: the agent reads
it with `get_request`.

## A computer with no browser

On a computer you reach over SSH (a build server, a machine in the cloud), an agent's own sign-in opens a browser on
that machine, which you can't reach. `init` signs in with a code there instead: SSH in, and at the prompt there run

```sh
npx -y pendingyou@latest init
```

It sees it's an SSH session (or Linux with no display) and shows a link for your phone, a QR code of it, and each code,
for every agent it found. Open it on your phone, sign in, check the codes match and press Allow once. Only allow codes
your own computer is showing you. `--device` shows codes like this anywhere; `--browser` opens the browser anyway;
`--no-browser` only prints the address.

Run it at an interactive prompt after you SSH in, not as `ssh host npx pendingyou init`: on stock Ubuntu that one-line
form doesn't read your shell's setup, so nvm's Node, `claude` and `codex` may not be on PATH. The helper script and the
hooks find Node anyway when the agents run without your shell's PATH (a systemd service, a terminal multiplexer,
Remote Control): on PATH, nvm's default, the one `init` ran with, or where Node usually is.

The machine is called by its Tailscale name when Tailscale is installed and running (as `tailscale status` shows it),
else by its hostname, or by `--name build-01` on `init` or `login`; a Mac by its own name (Sharing in System Settings).
A cloud's own hostname (AWS's `ip-10-42-1-252`) is kept when there's nothing better, and `login` says how to change it:
`npx pendingyou login --name <name>` asks for one more approval and renames the connection, which stays the same one.
If an agent's sign-in ends (30 days unused, or you remove it on your Assistants page), `npx pendingyou login`
(`--app codex` for Codex's; `--force` while it still works) approves a new code and keeps the same connection.

Only want this command's own sign-in (for `watch`, below)? `npx pendingyou login --device` signs it in with a code,
hearing answers only, and adds no connection. Your phone asks "Let build-01 hear your answers for the assistants
running on it?", with no choice of assistant.

## This computer's key

The first time `init` (or `login`) signs anything in, it makes this computer a key pair, kept in
`~/.config/pendingyou/machine.json`: readable only by you, beside your sign-ins. Pending You knows the computer by that
key, not by its name: two computers called "MacBook Pro" are two computers, and one you rename is still one. The
private key never leaves this computer and is never printed; Pending You keeps only its public key's fingerprint.

Every sign-in with a code proves the key, for that sign-in only and only once, so pressing Allow adds this computer,
by its key, with the agents' connections it makes. A computer set up before 0.18.0 gets its key the next time you run
`npx -y pendingyou@latest init`: each agent already signed in proves it with its own sign-in, with nothing to approve,
and its sign-ins stay exactly as they are. Until then nothing changes on it. Pending You uses the key to keep your
computers apart: an app you sign in on one computer later (such as the Pending You plugin for Herdr) sees only that
computer's agents.

- `npx pendingyou machine status` says whether Pending You knows each agent's connection here by this key.
- `npx pendingyou machine rotate` makes a new key (it asks first; `--yes` doesn't). Pending You then knows this
  computer as a new one, and its agents' connections stay with the old key until you remove that computer from your
  account; the next `init` then proves the new one.
- `npx pendingyou machine attest --client-id <id>` prints a proof of this computer for an app's own sign-in with a code
  (`--cnf <thumbprint>` for that app's own key, `--name` for another name). It never prints the key.
- `npx pendingyou machine link` (0.29.0) links this computer's sign-ins to it now: the agents' connections, and the
  sign-ins your apps made on their own (Claude Code's `/mcp` Authenticate or the Pending You plugin, Codex's and
  OpenCode's MCP sign-ins), found by their OAuth clients in those apps' own stores here, never a token. Pending You then
  names them all by this computer and merges an app's older sign-ins here into the one in use. `init` does it, and the
  hooks every few hours in the background; nothing is linked by a computer's name. Rename a computer once, in Settings
  › Apps and devices, and every assistant on it follows.

`uninstall` leaves the key: it names the computer and grants nothing on its own.

## Always-on scripts

`watch` runs a command each time an answer is ready, for a script on your assistant's own machine:

```sh
npx pendingyou watch -- ./on-answer.sh
```

It hears your Claude Code assistants' answers. Signing in asks no choice of assistant (since 2026-10-04: "Let pi hear
your answers for the assistants running on it?"); a sign-in pointed at one assistant before then keeps hearing that
one. The command runs without a shell, once per answer, message or fallback that comes due, or (0.14.0) question you
hand the assistant from another one, oldest first. It gets the request as JSON on stdin (a handed question with
`delegated`: who asked, how its answer travels, your note), and `PENDINGYOU_REQUEST_ID`, `PENDINGYOU_EVENT`
(`answer_ready`, `message_ready`, `fallback_due` or `delegated_ready`), `PENDINGYOU_VERSION` and `PENDINGYOU_ORIGIN` in
its environment. A failing command is tried twice more, then skipped. `--once` stops after the first.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Set up every agent on this computer (`--app`, `--oauth`, `--no-login`, `--no-browser`, `--device`, `--browser`, `--yes`, `--name`, `--no-permission-cards`) |
| `hold <requestId>` | Wait for the answer, print it, exit (`--timeout 4h`); the wake mod answers it itself |
| `status` | What's set up for each agent; exits 0 when each hears answers right away (`--app`) |
| `login` / `logout` | Sign an agent in again, or out (`--app`, `--device`, `--browser`, `--force`, `--name`, `--all`) |
| `claude [args…]` | Claude Code with the permission channel: a prompt's card has Allow and Deny; `claude`'s own arguments after it |
| `codex-answers --wait <minutes>` | Codex's permission prompts go to your card first, with Allow and Deny, for up to that many minutes (0 to 10; 0, the default, is off) before Codex asks in its terminal |
| `watch -- <command>` | Run a command each time an answer is ready (`--once`) |
| `pickup` / `handoff` | The session-start and next-message hooks (`--app`) |
| `stopcheck` | The Stop hook: items for you left only in chat (`--app`) |
| `uninstall` | Remove what `init` added, and sign out (`--app`) |
| `mcp --app <app>` | The stdio bridge: a local MCP server for an agent that can't run a headers helper (OpenCode, Pi), which passes each message on to Pending You with that agent's own sign-in here (`--check`) |
| `herdr doctor` | Pending You in Herdr: the badges, the plugin, its toasts and its sidebar row. The plugin runs `herdr next`, `open`, `setup`, `view` and `unconfigure`; the agents' writers `herdr report` |
| `machine status` / `attest` / `rotate` / `link` | This computer's key: whether Pending You knows each agent's connection by it (exits 0 when it does), a proof of it for an app's own sign-in (`--client-id`, `--cnf`, `--name`), a new key (`--yes`), or this computer's sign-ins linked to it now, your apps' own ones too (`--quiet`) |
| `app login` / `logout` / `status` | An app that answers your cards when you press a key in it, signed in on this computer (`herdr`, or another app with `--client-id` and `--scope`; `--device`, `--browser`, `--name`), out again, or what each may do and until when |

Every command takes `--origin` (default `https://www.pendingyou.com`, or `$PENDINGYOU_ORIGIN`). `--app` takes
`claude-code`, `codex`, `opencode` or `pi` (several with commas where a command sets up or reports several); with none,
a command that acts for one agent acts for Claude Code. Options can come before or after the command.

## What it can see, and where it keeps things

**The command line never answers for you.** None of its commands, hooks or helpers answers, replies to, snoozes or
hands over a card, and no agent's sign-in can. An app you sign in with `pendingyou app login` (the Pending You plugin
for Herdr) answers only from its own sign-in and its own key, kept apart in `apps/<app>.json`, which nothing an agent
runs here reads, and only when you press a key in it; never a high-stakes card, and Pending You labels every answer
with the app and the computer.

Each agent's sign-in is that agent's own connection on Pending You, signed in from this computer: it can post cards,
change or cancel its own, read the answers to them and reply in their threads, and it can't answer anything for you.
The hooks use the same sign-in, and hand a session only the cards its own app posted from its folder. An agent that
signs in by itself (`--oauth`, or one you kept) gets a sign-in that only hears its answers instead: it can't ask,
answer or change anything, and doesn't show up as an assistant. They're stored in `~/.config/pendingyou/credentials.json`
(readable only by you, in a folder with a `.gitignore` of `*` so a dotfiles repository never takes it), refresh
themselves, last 30 days from their last use (0.30.0: each refresh proves this computer's key, and Pending You renews
the sign-in from then), and end once unused that long, or on `logout`. The headers helper hands an agent's token only
to that agent's Pending You (Claude Code says which server it's for; Codex's is the one `init` wrote). `clients.json` remembers which
sign-in each agent's connection used, so signing in again keeps it. `machine.json` (0.18.0) holds this computer's key
pair, private like the rest; only its proofs leave the computer, each for one sign-in, once. `apps/<app>.json` (0.21.0)
holds an app's own sign-in and the private key its tokens are bound to (DPoP), private like the rest; the Pending You
plugin for Herdr also keeps, in Herdr's state folder for it, when you last pressed a key in its popup (a time, nothing
else).

`state.json` beside them remembers which answers were already handed over (ids only) and how many session starts
reminded an unfinished setup, and when; `permission-cards/` each Claude Code session's (and Codex thread's) prompts
still waiting on your OK and its card (ids, hashes and the card's redacted words: never what the tool was given), gone once nothing waits;
`presence/` the last presence each session said (ids, states and times), and Codex threads' keepers;
`claude-code.json`, `codex.json`, `opencode.json` and `pi.json` what `init`
added; `codex-threads.json`, `opencode-threads.json` and `pi-threads.json` which cards each Codex thread or OpenCode or
Pi session waits on, and (0.14.0) the names it went by and its folder, kept 12 hours for a question you may hand it
(ids, names, folders and titles: never an answer or a note); `pi/` Pi's extension; and `cli/` the hooks' copy of the
command line. `init`, `status` and the hooks read `~/.claude.json` (and a folder's `.mcp.json`, and
`~/.claude/settings.json`'s enabled plugins), `~/.codex/config.toml`, OpenCode's config and Pi's `mcp.json` only to see
whether the agent has a `pendingyou` MCP server and where it points. In a Herdr pane (0.17.0) the agents' writers hand
Herdr's own command line, on this computer, the badges above: a card's title (redacted, 80 characters at most) and its
request id, never an answer or a note; `<app>-threads.json` remembers the pane each session runs in, and `herdr.json`
whether the badges are off. Presence there (0.18.0) also sends Pending You the pane's id and the hash that names its
Herdr server. With a sign-in that only hears, the hooks and
listeners tell this computer's handed questions from another's by its names: its hostname, the names its sign-ins by
code were given, a Mac's own name (`scutil --get ComputerName`) and, outside a hook, Tailscale's (`tailscale status`). For a permission prompt's card, the worker reads
the end of the Claude Code session's transcript only for the name the session gave Pending You, and `git remote
get-url origin` in its folder (sent without any user name or password in it). To tell when a Codex thread's Codex has quit, its
keeper asks `ps` about the Codex process its hooks ran under (its id and program name, nothing else). Nothing is sent
anywhere but Pending You. OpenCode's plugin reads its session's messages only when it goes idle, for the check that
nothing was left in chat, and hands the hooks' script just that turn's words and tool names.

The wake mod runs inside Claude Code and reaches Pending You only through the session's own connection, with
`get_request` on the session's own cards (and, in `init`'s copy, `whoami` to see whether setup is finished), and (0.14.0)
`list_pending` with the session's name and `get_request` on a question you handed it. It keeps each session's cards (id,
title, the agent's name, where each stands), and which handed questions a session was told of (ids and when), in Claude
Code's store for mods, `~/.claude/plugins/store/`, and forgets them once they close or after 7 days. It marks the copy
acting for a session in that session's environment (`PENDINGYOU_WAKE_OWNER`). `init`'s copy (0.15.0) also reads
`~/.config/pendingyou/claude-code.json` for the Pending You it's for, and runs the hooks' script to say the session is
open.

## Development

This repository is the command line as npm has it, copied from Pending You's own repository with each release, so a
change made here would be overwritten. A comment that names a file this repository doesn't have (`packages/…`,
`apps/…`, `docs/…`, `test/…`) means one there.

It has no dependencies; building it takes TypeScript and Node 20 or later:

```sh
npm install
npm run build
HOME="$(mktemp -d)" node dist/cli.js status
```

The throwaway `HOME` keeps a try-out away from your own agents' settings.

## License

Apache-2.0. Copyright 2026 RecordPlane. See [LICENSE](LICENSE).
