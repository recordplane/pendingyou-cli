// What a card may say about a command, a file or an address (0.13.0, the permission-prompt cards: permission.ts): what
// Claude Code is waiting for the person's OK on, in a line, with anything that could be a secret taken out. A card's
// words sit in notifications, on every device it's opened on and in history, so this errs on the side of saying less:
//
// - the values after anything named like a secret: a flag (`--token …`, `--password=…`, `-p…`), a header
//   (`Authorization: …`, `Cookie: …`), an environment variable or a key in JSON, YAML or a form (`FOO_TOKEN=…`,
//   `"password": …`), and a bearer, basic or token credential;
// - a URL's user name and password, and the value of every query and fragment parameter;
// - anything that looks like a key or token: the well-known prefixes (ghp_, sk-, AKIA, xoxb-…), a JWT, a private key,
//   a long run of letters and digits that mixes upper and lower case, one long random-looking part, and long hex;
// - and when a command can't be read safely (more than one line, a heredoc, inline code like `node -e`, `eval`, or a
//   command that takes a secret on stdin), only the tool and the command's first word: "Bash: node …".
//
// Everything is cut to SUMMARY_MAX characters; the card's title is cut again to fit. Pure functions: nothing here reads
// or writes anything.

/** What stands in for whatever was taken out. */
export const BLANK = '…'

/** The most of a command, a path or a question a card shows. */
export const SUMMARY_MAX = 120

/** Parts of a flag's name that make its value secret: `--api-key`, `--auth-token`, `--session`. */
const SECRET_PARTS = new Set([
  'pass',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'pw',
  'secret',
  'secrets',
  'token',
  'tokens',
  'key',
  'keys',
  'apikey',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'cred',
  'creds',
  'cookie',
  'cookies',
  'session',
  'sessionid',
  'sid',
  'signature',
  'sig',
  'otp',
  'bearer',
  'private',
  'dsn',
  'jwt',
  'pat',
])

/**
 * Words that make a name secret wherever they are in it (in snake case): PGPASSWORD, GITHUB_TOKEN, client_secret,
 * BASIC_AUTH. Not "author".
 */
const SECRET_WORDS =
  /pass(?:word|wd|phrase)?|pwd|secret|token|api_?key|access_?key|private_?key|credential|cookie|signature|bearer|session|(?:^|_)auth(?:_|$|orization)|dsn|jwt|(?:^|_)keys?(?:_|$)|key$/i

/** Whether a flag's name (`--api-key`, `-p`) says its value is secret. */
export function isSecretFlag(flag: string): boolean {
  const name = flag.replace(/^-+/, '')
  if (/^[pP]$/.test(name)) return true
  // openssl's -pass, -passin and -passout; --password, --passphrase.
  if (/^pass|password|passwd|secret|token|apikey|credential/i.test(name)) return true
  return name
    .toLowerCase()
    .split(/[-_.]/)
    .some((part) => SECRET_PARTS.has(part))
}

/** Whether a variable's or a key's name (`GITHUB_TOKEN`, `"password"`, `clientSecret`) says its value is secret. */
export function isSecretName(name: string): boolean {
  const bare = name.replace(/^-+/, '')
  if (isSecretFlag(bare)) return true
  // camelCase and SCREAMING_CASE alike: clientSecret → client_secret.
  const snake = bare.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  return SECRET_WORDS.test(snake)
}

/** Letters and digits, and enough different characters that it isn't a placeholder like xxxx or 0000. */
const looksRandom = (run: string) =>
  /\d/.test(run) && /[A-Za-z]/.test(run) && new Set(run).size >= 8

/** The well-known shapes of keys and tokens, at any length that could be real. */
const KEY_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}/g,
  /\bwhsec_[A-Za-z0-9+/=]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bsntry[su]_[A-Za-z0-9+/=_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bcrsr_[A-Za-z0-9]{16,}/g,
  /\bya29\.[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*){0,2}/g,
]

/**
 * A run that looks like a key or token: long hex; or letters and digits that mix upper and lower case (a base62 or
 * base64 key); or one long part, split on - _ . /, that mixes letters and digits. Not a branch name, a slug or a path,
 * whose parts are short and mostly one case.
 */
export function looksLikeToken(run: string): boolean {
  const bare = run.replace(/^[-_.:/+=]+|[-_.:/+=]+$/g, '')
  if (bare.length < 20) return false
  if (/^[0-9a-f]{32,}$/i.test(bare)) return true
  if (bare.length >= 24 && /[a-z]/.test(bare) && /[A-Z]/.test(bare) && /\d/.test(bare)) {
    // A path's parts are words: a run of upper, lower and digits is a key only when it isn't split into short words.
    const parts = bare.split(/[/.]/)
    if (parts.some((part) => part.length >= 20 && looksRandom(part))) return true
  }
  return bare.split(/[-_./]/).some((part) => part.length >= 20 && looksRandom(part))
}

/** Takes keys and tokens out of any text: their well-known shapes, then long random-looking runs. */
export function redactTokens(text: string): string {
  let out = text
  for (const shape of KEY_SHAPES) out = out.replace(shape, BLANK)
  return out.replace(/[A-Za-z0-9+/=_.:-]{20,}/g, (run) => {
    // A URL's own address isn't a token: only its parts are looked at (redactUrls blanks its query).
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(run)) return run
    return looksLikeToken(run) ? BLANK : run
  })
}

/**
 * A URL without its user name and password, with every query and fragment parameter's value blanked, and any part of
 * its path that looks like a token (a webhook's secret: hooks.slack.com/services/T…/B…/<secret>) blanked too.
 */
export function redactUrl(url: string): string {
  const match = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#\s]*)([^?#\s]*)(.*)$/is.exec(url)
  if (!match) return url
  const [, scheme, authority = '', path = '', rest = ''] = match
  const host = authority.includes('@')
    ? `${BLANK}@${authority.slice(authority.lastIndexOf('@') + 1)}`
    : authority
  const parts = path
    .split('/')
    .map((part) => (part.length >= 20 && looksLikeToken(part) ? BLANK : part))
    .join('/')
  const tail = rest
    .replace(/([?&;][^=&#;\s]*)=([^&#;\s]*)/g, (_all, name: string, value: string) =>
      value ? `${name}=${BLANK}` : `${name}=`,
    )
    .replace(/(#|&)([^=&#\s]+)=([^&#\s]*)/g, (_all, mark: string, name: string, value: string) =>
      value ? `${mark}${name}=${BLANK}` : `${mark}${name}=`,
    )
  return `${scheme}${host}${parts}${tail}`
}

/** Every URL in the text, without its credentials and query values (redactUrl). */
export function redactUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)\]}]+/gi, redactUrl)
}

/** A quoted value or a bare word, as a shell or a JSON object writes it. */
const VALUE = `("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s"'&;,|}\\])]+)`

/** A blanked value, keeping its quotes so the line still reads. */
function blankValue(value: string): string {
  if (value.startsWith('"')) return `"${BLANK}"`
  if (value.startsWith("'")) return `'${BLANK}'`
  return BLANK
}

/** The values of headers that carry credentials: `Authorization: …`, `Cookie: …`, `X-Api-Key: …`. */
function redactHeaders(text: string): string {
  return text.replace(
    /\b((?:proxy-)?authorization|(?:set-)?cookie|x-[a-z0-9-]*(?:key|token|auth|secret|signature|session)[a-z0-9-]*|api-?key|private-token|x-amz-security-token)(\s*:\s*)([^"'\n]+)/gi,
    (_all, name: string, colon: string) => `${name}${colon}${BLANK}`,
  )
}

/** `Bearer …`, `Basic …`, `Token …`: a credential after the word that says what it is. */
function redactSchemes(text: string): string {
  return text.replace(
    /\b(Bearer|Basic|Token|Digest)(\s+)(?!…)[A-Za-z0-9._~+/=:-]{6,}/g,
    (_all, scheme: string, space: string) => `${scheme}${space}${BLANK}`,
  )
}

/**
 * Values after names that say they're secret: environment variables and keys (`FOO_TOKEN=…`, `"password": …`,
 * `password: …`, a form's `&pass=…`) and flags (`--token=…`).
 */
function redactNamedValues(text: string): string {
  const pattern = new RegExp(`(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\\1(\\s*[:=]\\s*)${VALUE}`, 'g')
  return text.replace(pattern, (all, quote: string, name: string, sign: string, value: string) => {
    // A URL's own `scheme:` isn't a name and its value.
    if (sign.trim() === ':' && /^\/\//.test(value)) return all
    // `--user=name:password` (curl) holds a password too.
    const user = name === 'user' && sign.trim() === '=' && value.includes(':')
    if (!isSecretName(name) && !user) return all
    return `${quote}${name}${quote}${sign}${blankValue(value)}`
  })
}

/** Programs whose `-p` (or `-P`) is a switch or a number, never a password: `mkdir -p`, `git add -p`, `ps -p`. */
const P_IS_PLAIN = new Set([
  'mkdir',
  'cp',
  'ls',
  'git',
  'tar',
  'rsync',
  'scp',
  'install',
  'lsof',
  'ps',
  'pgrep',
  'pkill',
  'du',
  'grep',
  'rg',
])

/** Flags that hold a password for one program only: `redis-cli -a`. */
const PROGRAM_SECRETS: Readonly<Record<string, readonly string[]>> = {
  'redis-cli': ['-a', '--pass', '--user'],
}

/** Programs that take a password glued to `-p` (`mysql -pS3cret`, `7z x -pS3cret`). */
const P_ATTACHED = /^(?:mysql\w*|mariadb\w*|7z\w*|7za|7zr)$/

/** A command line's parts between `&&`, `||`, `;` and `|`, outside quotes, each with what joined it to the next. */
function segments(text: string): { text: string; join: string }[] {
  const found: { text: string; join: string }[] = []
  let current = ''
  let quote: string | null = null
  for (let index = 0; index < text.length; index++) {
    const char = text[index] as string
    if (quote) {
      current += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const two = text.slice(index, index + 2)
    if (two === '&&' || two === '||') {
      found.push({ text: current, join: two })
      current = ''
      index++
      continue
    }
    if (char === ';' || char === '|') {
      found.push({ text: current, join: char })
      current = ''
      continue
    }
    current += char
  }
  found.push({ text: current, join: '' })
  return found
}

/**
 * The value after a flag that says it's secret, in each part of the command line: `--token abc`, `-p hunter2` (not
 * `mkdir -p`), `-u user:pass`, `-pS3cret`, `redis-cli -a …`; and after a variable's name that says it's secret,
 * given as a word of its own (`aws configure set aws_secret_access_key …`, `netlify env:set API_KEY …`).
 */
function redactFlags(text: string): string {
  const spaced = new RegExp(`(^|\\s)(--?[A-Za-z][A-Za-z0-9_.-]*)(\\s+)(?!-)${VALUE}`, 'g')
  const named = new RegExp(
    `(^|\\s)([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*|[A-Z][A-Z0-9_]{2,})(\\s+)(?![-|&;])${VALUE}`,
    'g',
  )
  return segments(text)
    .map((part) => {
      const program = firstWord(part.text) ?? ''
      const plainP = P_IS_PLAIN.has(program)
      const extra = PROGRAM_SECRETS[program] ?? []
      const secret = (flag: string) =>
        extra.includes(flag) || (isSecretFlag(flag) && !(plainP && /^-[pP]$/.test(flag)))
      let out = part.text.replace(
        spaced,
        (all, lead: string, flag: string, space: string, value: string) => {
          const user = /^(-u|--user)$/.test(flag) && value.includes(':')
          if (!secret(flag) && !user) return all
          return `${lead}${flag}${space}${blankValue(value)}`
        },
      )
      // A password glued to its flag (mysql -pS3cret).
      if (P_ATTACHED.test(program))
        out = out.replace(/(^|\s)(-[pP])(?=[^\s-])(\S+)/g, (_all, lead: string, flag: string) => {
          return `${lead}${flag}${BLANK}`
        })
      out = out.replace(named, (all, lead: string, name: string, space: string, value: string) =>
        isSecretName(name) && name !== program ? `${lead}${name}${space}${blankValue(value)}` : all,
      )
      return `${out}${part.join}`
    })
    .join('')
}

/** Repeated blanks read as one: "… …" stays, "……" doesn't happen. */
const tidy = (text: string) =>
  text
    .replace(new RegExp(`${BLANK}{2,}`, 'g'), BLANK)
    .replace(/\s+/g, ' ')
    .trim()

/** Cuts text to `max` characters, saying so with a final "…". */
export function cut(text: string, max = SUMMARY_MAX): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}${BLANK}`
}

/** Any text a card shows (a question, a search): keys, tokens and URLs' secrets out, one line, cut. */
export function redactText(text: string, max = SUMMARY_MAX): string {
  return cut(tidy(redactTokens(redactSchemes(redactHeaders(redactUrls(text))))), max)
}

/**
 * The whole of a text with its secrets masked, and nothing else changed (0.33.0: a relayed permission prompt's input, on
 * its card in full, PA2): every masking redactCommand does, on every line, but never cut, never folded to its first
 * word, its lines and spaces kept.
 */
export function maskSecrets(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      redactTokens(redactFlags(redactNamedValues(redactSchemes(redactHeaders(redactUrls(line)))))),
    )
    .join('\n')
}

/** A shell or an interpreter given its code on the command line: `bash -c …`, `node -e …`, `python3 -c …`. */
const INLINE_CODE =
  /(?:^|[\s;&|(`$/])(?:(?:ba|z|da|k)?sh|fish|python[0-9.]*|node(?:js)?|deno|bun|ruby|perl|php|osascript|pwsh|powershell|lua|Rscript)\b[^;&|]*?\s(?:-c|-e|-E|--eval|-p|--print|-r|-Command|-command|-EncodedCommand)(?=\s|=|$)/i

/** Commands that take a secret on stdin or set one: what follows them could be the secret itself. */
const TAKES_SECRET =
  /\bsudo\s+(?:-\w+\s+)*-S\b|--password-stdin|\b(?:ch)?passwd\b|\bhtpasswd\b|\bsecurity\s+(?:add|set|import)-|\bsecrets?\s+(?:set|put|add|create|edit)\b|\bvault\s+(?:kv\s+)?(?:put|write)\b|\bkubectl\s+create\s+secret\b|\bop\s+(?:item|read|run|inject)\b|\bssh-add\b|\bgpg\b|\bpass\s+(?:insert|edit)\b|\bbase64\s+(?:-d|-D|--decode)\b/i

/**
 * Whether a command can't be shown safely, even with secrets taken out: more than one line, a heredoc or here-string
 * (its body could be anything), inline code for a shell or an interpreter, `eval`, or a command that takes a secret on
 * stdin or sets one.
 */
export function unsafeCommand(command: string): boolean {
  const text = command.trim()
  if (/[\r\n]/.test(text)) return true
  if (/<<-?\s*['"]?\w|<<</.test(text)) return true
  if (/(?:^|[\s;&|(`$])eval\s/.test(text)) return true
  return INLINE_CODE.test(text) || TAKES_SECRET.test(text)
}

/** The command's own name, for "Bash: rm …": past variables, sudo and the like; null when it isn't a plain word. */
export function firstWord(command: string): string | null {
  const words = command.trim().split(/\s+/)
  for (const word of words) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (/^(?:sudo|env|time|nohup|exec|command|nice|caffeinate)$/.test(word)) continue
    if (word.startsWith('-')) continue
    const name =
      word
        .replace(/^['"]|['"]$/g, '')
        .split('/')
        .at(-1) ?? ''
    return /^[A-Za-z0-9][\w.+-]{0,31}$/.test(name) ? name : null
  }
  return null
}

/**
 * What a card says about a shell command: the command with every secret taken out, on one line, cut to SUMMARY_MAX;
 * or, when it can't be shown safely (unsafeCommand), the tool and its first word: "Bash: node …".
 */
export function redactCommand(
  command: string,
  tool = 'Bash',
  max = SUMMARY_MAX,
): { text: string; doubt: boolean } {
  const word = firstWord(command)
  const doubtful = { text: word ? `${tool}: ${word} ${BLANK}` : `${tool} ${BLANK}`, doubt: true }
  if (!command.trim() || unsafeCommand(command)) return doubtful
  let text = redactUrls(command)
  text = redactHeaders(text)
  text = redactSchemes(text)
  text = redactNamedValues(text)
  text = redactFlags(text)
  text = redactTokens(text)
  text = tidy(text)
  if (!text || text === BLANK) return doubtful
  return { text: cut(text, max), doubt: false }
}

/** A path as the person reads it: under ~ when it's in their home, its secrets out, and its end kept when it's long. */
export function shortPath(path: string, home: string, max = 60): string {
  const base = home.replace(/\/+$/, '')
  let shown =
    base && (path === base || path.startsWith(`${base}/`)) ? `~${path.slice(base.length)}` : path
  shown = redactTokens(redactUrls(shown.replace(/\s+/g, ' ').trim()))
  const chars = [...shown]
  if (chars.length <= max) return shown
  const tail = chars.slice(chars.length - (max - 1)).join('')
  const slash = tail.indexOf('/')
  return `${BLANK}${slash > 0 && slash < tail.length - 1 ? tail.slice(slash) : tail}`
}
