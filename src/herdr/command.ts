// `pendingyou herdr <what>` (0.17.0): Pending You in Herdr. `report` writes an agent's badges onto its pane (herdr.ts;
// the agents' hooks start it in the background, and the wake mod runs it through the hooks' script). The rest are the
// Pending You plugin for Herdr's (packages/herdr-plugin), which runs them through the same script:
//
// - `next`: focuses the next pane whose agent waits on you, most pressing first.
// - `open`: the popup that lists them (herdr/popup.ts). `popup <pane>` opens one of the plugin's popups from an action.
// - `setup`: checks toasts, offers the sidebar row (written only with a yes), prints the keybindings to add.
// - `doctor`: what's set up, and what isn't.
// - `view [on|off]`: the plugin's Agents view, waiting on you first.
// - `watch [--ensure]` and `event`: the watcher that raises a toast when a pane gains a card (herdr/watch.ts).
// - `unconfigure`: stops the watcher, takes every badge off and turns them off here, clears the view, takes the
//   sidebar row out of config.toml, and signs Herdr out of Pending You.
//
// Phase 0 was read-only. Since 0.21.0 (plugin 0.2) setup can sign Herdr in to Pending You (`pendingyou app login
// herdr`, app-login.ts), and then the popup answers your cards with a key, through the SDK with Herdr's own sign-in and
// key (herdr/queue.ts): only when you press one in it, never a high-stakes card. Without that sign-in nothing here
// answers, changes or reads a card in Pending You.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  appStatusLines,
  readAppSignIn,
  signedInWords,
  signInApp,
  signOutApp,
} from '../app-login.ts'
import { reportThreads } from '../apps/codex-wake.ts'
import { APP_IDS, APP_NAMES, type AppId } from '../apps/ids.ts'
import type { HerdrCommand } from '../args.ts'
import { configDir, readText, writeWhole } from '../files.ts'
import {
  badgesOn,
  clearHerdr,
  HERDR_SOURCE,
  herdrBin,
  herdrPane,
  herdrTarget,
  readPayload,
  setBadges,
  TOKEN_NAMES,
  writeHerdr,
} from '../herdr.ts'
import type { Io } from '../io.ts'
import { sessionName } from '../permission.ts'
import { presenceName } from '../presence.ts'
import { headlessReason } from '../remote.ts'
import { shimPath } from '../shim.ts'
import { VERSION } from '../version.ts'
import { badgedPanes, nextWaiting, readWaiting } from './panes.ts'
import {
  agentView,
  CARD_ROW,
  hasBlock,
  herdrConfigPath,
  KEYS_SNIPPET,
  ownSidebar,
  type PluginPlace,
  pluginOff,
  pluginPlace,
  SIDEBAR_BLOCK,
  saveView,
  setPluginOff,
  TOAST_SNIPPET,
  toastDelivery,
  viewOn,
  withBlock,
  withoutBlock,
} from './plugin.ts'
import { cardsPopup, originFor } from './popup.ts'
import { HerdrError, herdrRequest } from './socket.ts'
import { pluginEnabled, stopWatcher, watch, watching } from './watch.ts'

/** Says something in Herdr itself (an action's output goes only to the plugin's log). Never throws. */
async function toast(place: PluginPlace, title: string, body?: string): Promise<void> {
  if (!place.socket) return
  await herdrRequest(place.socket, 'notification.show', {
    title,
    ...(body ? { body } : {}),
    sound: 'none',
  }).catch(() => {})
}

/** `herdr report`: an agent's badges, written onto its pane. Quiet, and 0 whatever happens. */
async function report(io: Io, command: HerdrCommand): Promise<number> {
  try {
    const app = command.app ?? 'claude-code'
    const at = command.at ?? io.now()
    if (app !== 'claude-code') {
      await reportThreads(io, app, { session: command.session ?? null, closed: command.closed, at })
      return 0
    }
    const pane = await herdrTarget(io)
    if (!pane) return 0
    if (command.closed) {
      await clearHerdr(io, at, pane)
      return 0
    }
    // The wake mod hands its cards on stdin; the session-start hook names the session only.
    const payload = readPayload(await io.readStdin(500).catch(() => ''))
    const name =
      presenceName(payload?.name) ??
      presenceName(command.agentName) ??
      (await sessionName(command.transcript))
    await writeHerdr(
      io,
      {
        app,
        ...(name ? { agent: name } : {}),
        ...(payload ? { cards: payload.cards } : {}),
        at,
      },
      pane,
    )
  } catch {}
  return 0
}

/** `herdr next`: the next pane waiting on you, focused (Herdr moves the views of the clients attached to it). */
async function next(_io: Io, place: PluginPlace): Promise<number> {
  if (!place.socket) throw new HerdrError('unreachable', 'Run this from Herdr.')
  const { snapshot, waiting } = await readWaiting(place.socket)
  const target = nextWaiting(waiting, snapshot.focusedPane)
  if (!target) {
    await toast(place, 'Pending You', 'Nothing in Herdr is waiting on you.')
    return 0
  }
  await herdrRequest(place.socket, 'pane.focus', { pane_id: target.paneId })
  return 0
}

/** `herdr popup <pane>`: one of the plugin's popups, from an action (actions run without a terminal). */
async function popup(place: PluginPlace, entrypoint: string): Promise<number> {
  if (!place.socket) throw new HerdrError('unreachable', 'Run this from Herdr.')
  try {
    await herdrRequest(place.socket, 'plugin.pane.open', {
      plugin_id: place.id,
      entrypoint,
    })
  } catch (error) {
    // Herdr's settings, copy mode or another popup is open.
    if (error instanceof HerdrError && error.code === 'ui_busy')
      await toast(place, 'Pending You', 'Close what’s open in Herdr first, then try again.')
    else throw error
  }
  return 0
}

/** `herdr view [on|off]`: the Agents view, waiting on you first; it switches when neither is given. */
async function view(place: PluginPlace, target: string | undefined): Promise<number> {
  if (!place.socket) throw new HerdrError('unreachable', 'Run this from Herdr.')
  const on = target === 'on' ? true : target === 'off' ? false : !(await viewOn(place))
  if (on) await herdrRequest(place.socket, 'agent.view.set', agentView(place.id))
  else
    await herdrRequest(place.socket, 'agent.view.clear', { source: `plugin:${place.id}` }).catch(
      () => {},
    )
  await saveView(place, on)
  await toast(
    place,
    'Pending You',
    on ? 'Agents waiting on you come first in the Agents panel.' : 'The Agents panel is as it was.',
  )
  return 0
}

/** Takes Pending You's badges off every pane that has them. How many it took them off. */
async function clearAll(place: PluginPlace, at: number): Promise<number> {
  if (!place.socket) return 0
  const { snapshot } = await readWaiting(place.socket)
  let cleared = 0
  for (const pane of badgedPanes(snapshot))
    try {
      await herdrRequest(place.socket, 'pane.report_metadata', {
        pane_id: pane.paneId,
        source: HERDR_SOURCE,
        tokens: Object.fromEntries(TOKEN_NAMES.map((name) => [name, null])),
        clear_state_labels: true,
        seq: at,
      })
      cleared++
    } catch {}
  return cleared
}

/** Asks Herdr to read its config again; false when it couldn't. */
async function reloadConfig(place: PluginPlace): Promise<boolean> {
  if (!place.socket) return false
  return herdrRequest(place.socket, 'server.reload_config').then(
    () => true,
    () => false,
  )
}

/** `herdr unconfigure`: everything the plugin set up, undone; the plugin itself stays until you unlink it. */
async function unconfigure(io: Io, place: PluginPlace): Promise<number> {
  await setBadges(io, false)
  // Off until setup runs again: an agent's next event starts no watcher.
  await setPluginOff(place, true)
  const stopped = await stopWatcher(place)
  const cleared = await clearAll(place, io.now()).catch(() => 0)
  if (place.socket)
    await herdrRequest(place.socket, 'agent.view.clear', { source: `plugin:${place.id}` }).catch(
      () => {},
    )
  await saveView(place, false).catch(() => {})
  const path = herdrConfigPath(io)
  const doc = await readText(path).catch(() => null)
  let removed = false
  if (doc !== null && hasBlock(doc)) {
    await writeWhole(path, withoutBlock(doc))
    removed = true
    await reloadConfig(place)
  }
  // Its sign-in too: an app you've removed shouldn't still be able to answer your cards.
  const { said } = await signOutApp(io, 'herdr').catch(() => ({ said: 'none' as const }))
  io.out(
    `Pending You: ${[
      stopped ? 'stopped its watcher' : 'no watcher was running',
      `took the badges off ${cleared} pane${cleared === 1 ? '' : 's'} and turned them off here`,
      removed ? `took its sidebar row out of ${path}` : 'no sidebar row of its to take out',
      said === 'none'
        ? 'Herdr wasn’t signed in'
        : said === 'signed-out'
          ? 'signed Herdr out of Pending You'
          : 'signed Herdr out here (remove it in Settings › Apps and devices too: Pending You couldn’t be reached)',
    ].join('; ')}.\n`,
  )
  await toast(
    place,
    'Pending You is off in Herdr',
    `Badges, toasts, its sidebar row and its sign-in are gone. Remove the plugin itself with: herdr plugin unlink ${place.id} (or uninstall).`,
  )
  return 0
}

/** The Pending You this computer's agents use (what init recorded), else `fallback`. */
async function originHere(io: Io, fallback: string): Promise<string> {
  for (const app of APP_IDS) {
    const origin = await originFor(io, app, '')
    if (origin) return origin
  }
  return fallback
}

/** What a line of setup or doctor says: ✓ fine, ! needs you, · for your information. */
const line = (mark: '✓' | '!' | '·', text: string) => `${mark} ${text}\n`

/** `herdr setup`: toasts checked, the sidebar row offered (written only with a yes), the keys to add, the view. */
async function setup(
  io: Io,
  place: PluginPlace,
  options: { yes: boolean; origin: string },
): Promise<number> {
  const ask = async (question: string) => {
    if (options.yes) return true
    if (!io.interactive) return false
    return /^y(es)?$/i.test((await io.ask(`${question} (y/N) `)).trim())
  }
  io.out('Pending You for Herdr: setup\n\n')
  // On again after an unconfigure: its watcher, and the agents' badges.
  await setPluginOff(place, false)
  if (!(await badgesOn(io))) {
    await setBadges(io, true)
    io.out(line('✓', 'Badges are back on: your agents mark their panes when they wait on you.'))
  }
  const path = herdrConfigPath(io)
  const doc = (await readText(path).catch(() => null)) ?? ''
  // Toasts: Herdr's are off unless each client's own config says otherwise.
  const delivery = toastDelivery(doc)
  if (delivery === 'off')
    io.out(
      `${line('!', `Herdr's toasts are off here (${path} doesn't turn them on).`)}  To see Pending You's toasts, add this to config.toml on the computer you attach from (here, or the one you run herdr --remote on):\n\n${indent(TOAST_SNIPPET)}\n`,
    )
  else if (delivery === 'unknown')
    io.out(line('·', `Couldn't tell how ${path} delivers toasts; Pending You's follow it.`))
  else io.out(line('✓', `Toasts reach you here (delivery = "${delivery}").`))
  // The sidebar row.
  if (hasBlock(doc)) io.out(line('✓', `The sidebar row is in ${path}.`))
  else if (ownSidebar(doc))
    io.out(
      `${line('·', `${path} sets the agents' sidebar rows itself, so the plugin leaves it alone.`)}  Add this row to its rows to show the card each agent waits on you for:\n\n    ${CARD_ROW},\n\n`,
    )
  else {
    io.out(
      `\nHerdr's sidebar can show, under each agent waiting on you, the card it's waiting on. That's this block, added to ${path}:\n\n${indent(SIDEBAR_BLOCK)}\n`,
    )
    if (await ask('Add it?')) {
      const written = await writeBlock(io, place, path, doc)
      io.out(line(written.ok ? '✓' : '!', written.said))
    } else io.out(line('·', 'Left config.toml as it was. Run setup again any time to add it.'))
  }
  io.out(
    `${line('·', "Herdr reads the sidebar's rows and toasts on the computer you attach from: attach from another one (herdr --remote) and they go in its config.toml.")}\n`,
  )
  // Keys: never written for you.
  io.out(
    `Keys: Herdr leaves your keybindings to you. Add these to config.toml to open your cards with prefix+y and jump to the next pane waiting on you with prefix+shift+y:\n\n${indent(KEYS_SNIPPET)}\n`,
  )
  // Answering from Herdr: its own sign-in.
  await signInStep(io, options, ask)
  // The Agents view.
  if (place.socket && !(await viewOn(place))) {
    if (await ask('Show agents waiting on you first in Herdr’s Agents panel?')) {
      await view(place, 'on').catch(() => {})
      io.out(line('✓', 'Agents waiting on you come first in the Agents panel.'))
    }
  }
  if (place.socket && !(await watching(place))) io.background(['herdr', 'watch'])
  if (io.interactive && !options.yes) await io.ask('\nPress Enter to close. ')
  return 0
}

/** Setup's sign-in: Herdr signed in to Pending You, so its popup answers your cards (asked first, never with --yes). */
async function signInStep(
  io: Io,
  options: { yes: boolean; origin: string },
  ask: (question: string) => Promise<boolean>,
): Promise<void> {
  const stored = await readAppSignIn(io, 'herdr').catch(() => null)
  if (stored) {
    io.out(
      `${line('✓', `Herdr is signed in to Pending You at ${stored.origin}: its popup (prefix+y) answers your cards with a key.`)}  npx pendingyou app status herdr says what it may do and for how long.\n\n`,
    )
    return
  }
  io.out(
    `\nAnswer from Herdr: once Herdr is signed in to Pending You, its popup (prefix+y) answers your cards with a key (a choice, yes or no, your words, Later, or handing it to another agent), only when you press one. High-stakes cards still open in Pending You. It sees only this computer's agents' cards unless you tick "all" when you allow it.\n`,
  )
  // A sign-in needs you on your phone or in a browser: never with --yes.
  if (options.yes || !io.interactive || !(await ask('Sign Herdr in now?'))) {
    io.out(
      `${line('·', 'Herdr isn’t signed in: its popup lists what’s waiting. Sign it in any time: setup again, or npx pendingyou app login herdr')}\n`,
    )
    return
  }
  const origin = await originHere(io, options.origin)
  const result = await signInApp(io, {
    app: 'herdr',
    origin,
    open: headlessReason(io) === null,
  })
  io.out(
    result.ok
      ? `${line('✓', signedInWords(io, 'herdr', result.me).replaceAll('\n', '\n  '))}\n`
      : `${line('!', result.said)}\n`,
  )
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((each) => (each ? `    ${each}` : each))
    .join('\n')

/** Adds the managed block, checks Herdr still reads the file (else puts it back), and reloads it. */
async function writeBlock(
  io: Io,
  place: PluginPlace,
  path: string,
  doc: string,
): Promise<{ ok: boolean; said: string }> {
  const before = await readText(path).catch(() => null)
  await writeWhole(path, withBlock(doc))
  const bin = herdrBin(io.env)
  if (bin) {
    const checked = await io.run(bin, ['config', 'check'], 10_000)
    // 0 is fine; Herdr's from before `config check` has no such command (2), which tells nothing.
    if (checked.code !== 0 && checked.code !== 2) {
      if (before === null) await writeWhole(path, '')
      else await writeWhole(path, before)
      return { ok: false, said: `Herdr didn't take the block, so ${path} is as it was.` }
    }
  }
  const reloaded = await reloadConfig(place)
  return {
    ok: true,
    said: reloaded
      ? `Added the sidebar row to ${path}; Herdr has it now.`
      : `Added the sidebar row to ${path}. Reload Herdr's config (herdr server reload-config) to see it.`,
  }
}

/** `herdr doctor`: what's set up for Pending You in Herdr, a line each. */
async function doctor(io: Io, place: PluginPlace, options: { wait: boolean }): Promise<number> {
  io.out(`Pending You for Herdr (pendingyou ${VERSION})\n\n`)
  // Run by hand in a terminal: whether that's one of Herdr's panes (the plugin's popups have none).
  const pane = herdrPane(io.env)
  if (!io.env.HERDR_PLUGIN_ID)
    io.out(
      pane
        ? line('✓', `In a Herdr pane (${pane.pane}).`)
        : line('·', 'Not run from a Herdr pane: agents mark their panes when they run in one.'),
    )
  if (await pluginOff(place))
    io.out(line('!', 'The plugin is off here (its unconfigure). Its setup turns it on again.'))
  io.out(
    (await badgesOn(io))
      ? line('✓', 'Badges are on: agents in Herdr mark their panes when they wait on you.')
      : line('!', 'Badges are off here (the plugin’s unconfigure). Its setup turns them on again.'),
  )
  const shim = await readFile(shimPath(io), 'utf8').catch(() => null)
  io.out(
    shim
      ? line('✓', `Your agents' hooks run ${shimPath(io)}.`)
      : line(
          '!',
          'Pending You isn’t set up for your agents here: run npx -y pendingyou@latest init',
        ),
  )
  if (await readAppSignIn(io, 'herdr').catch(() => true)) {
    const status = await appStatusLines(io, 'herdr')
    io.out(line(status.ok ? '✓' : '!', status.lines[0] ?? ''))
  } else
    io.out(
      line(
        '·',
        'Herdr isn’t signed in to Pending You: its popup lists what’s waiting. Setup signs it in.',
      ),
    )
  const apps: AppId[] = []
  for (const app of APP_IDS)
    if ((await readText(join(configDir(io), `${app}.json`)).catch(() => null)) !== null)
      apps.push(app)
  if (apps.length)
    io.out(line('✓', `Set up here: ${apps.map((app) => APP_NAMES[app]).join(', ')}.`))
  if (place.socket) {
    try {
      const pong = await herdrRequest<{ version?: unknown }>(place.socket, 'ping')
      io.out(line('✓', `Herdr ${String(pong?.version ?? '')} answers on its socket.`))
      const enabled = await pluginEnabled(place.socket, place.id).catch(() => false)
      io.out(
        enabled
          ? line('✓', `The plugin (${place.id}) is enabled.`)
          : line('!', `The plugin (${place.id}) isn't linked or is disabled.`),
      )
      const { snapshot, waiting } = await readWaiting(place.socket)
      const badged = badgedPanes(snapshot).length
      io.out(
        line(
          '·',
          `${badged} pane${badged === 1 ? '' : 's'} with Pending You's badges, ${waiting.length} waiting on you.`,
        ),
      )
      io.out(
        (await watching(place))
          ? line('✓', 'Its watcher is running (toasts when a pane gains a card).')
          : line('!', 'Its watcher isn’t running: it starts with Herdr, or with setup.'),
      )
      io.out(line('·', `Its Agents view is ${(await viewOn(place)) ? 'on' : 'off'}.`))
    } catch (error) {
      io.out(line('!', error instanceof HerdrError ? error.message : 'Herdr isn’t answering.'))
    }
  } else io.out(line('·', 'No Herdr socket here: run it from Herdr to check the plugin.'))
  const path = herdrConfigPath(io)
  const doc = await readText(path).catch(() => null)
  const delivery = toastDelivery(doc ?? '')
  io.out(
    delivery === 'off'
      ? line('!', `Toasts are off in ${path}: setup says how to turn them on.`)
      : line('·', `Toasts here: ${delivery}.`),
  )
  io.out(
    doc !== null && hasBlock(doc)
      ? line('✓', `The sidebar row is in ${path}.`)
      : line('·', `No sidebar row of the plugin's in ${path}: setup offers it.`),
  )
  if (options.wait && io.interactive) await io.ask('\nPress Enter to close. ')
  return 0
}

/** `pendingyou herdr <what>`. */
export async function herdr(io: Io, command: HerdrCommand): Promise<number> {
  const place = pluginPlace(io)
  switch (command.sub) {
    case 'report':
      return report(io, command)
    case 'watch':
      return watch(io, place, { ensure: command.ensure === true })
    case 'event':
      // A Herdr event hook: make sure the watcher runs (a plugin just linked or enabled runs no startup hook).
      return watch(io, place, { ensure: true }).catch(() => 0)
    case 'next':
      return next(io, place)
    case 'popup':
      return popup(place, command.target ?? 'cards')
    case 'open':
      return cardsPopup(io, place, { origin: command.origin, demo: command.demo === true })
    case 'view':
      return view(place, command.target)
    case 'setup':
      return setup(io, place, { yes: command.yes === true, origin: command.origin })
    case 'doctor':
      return doctor(io, place, { wait: command.wait === true })
    case 'unconfigure':
      return unconfigure(io, place)
  }
}
