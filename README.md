# serial-dev

**Give any AI agent the serial-dev playbook.** It watches Elon and the accounts you pick on X, Trump's
Truth Social, news headlines, posts going viral, and names other devs are piling into on pump.fun. It turns
each one into a coin in seconds with the name devs would use and the picture they'd use (the real picture
of the subject when one exists, or ChatGPT's image model drawing the name when none does), relaunches posts whose first coin died,
and collects the creator fee on every trade. MCP server, CLI, or autopilot.

The wallets you see on GMGN with hundreds of thousands of deploys run this loop. Here it is, open source,
with a written playbook your agent can read and follow.

```
post lands -> tier + filters -> name -> picture (own / remix / generate) -> IPFS -> create -> fees
                                                                                      -> dead in 90s? relaunch (new picture)
```

Built from watching real serial devs on-chain: 157 consecutive launches matched to their source posts.
Median dev launched 24 seconds after the post, the fastest in under a second, and the same post was
often launched many times. Details in [PLAYBOOK.md](PLAYBOOK.md), section 2.

## What one coin costs and earns

Measured against pump.fun mainnet, November 2026:

- **Launch:** ~0.0058 SOL to create the coin, plus whatever dev buy the agent picks (0.1 SOL is about 0.35% of supply).
- **You earn:** 0.30% of every buy and sell on the bonding curve, more after graduation.
- **Break-even:** ~2 SOL of trading on the coin.

Most coins never trade 2 SOL. The ones that do pay for the rest. It's a volume game, and
[PLAYBOOK.md](PLAYBOOK.md) is how to play it well.

## Setup (2 minutes)

Site: https://serial-dev.vercel.app. Needs Node 20+ and git.

```bash
npm install -g github:gumballchief/serial-dev
serial-dev init
```

Or from source: `git clone https://github.com/gumballchief/serial-dev && cd serial-dev && npm install`, then
use `node bin/serial-dev.js` wherever this page says `serial-dev`.

`init` makes a dev wallet at `~/.serial-dev/wallet.json` (outside the repo), starts you on **mainnet** (real SOL,
where pump.fun is), and runs the setup check: what works right now, what's missing, and the exact next step for each.
To practice first with free test SOL: `serial-dev config network devnet` (and `mainnet` to go back).
Run the check again any time:

```bash
serial-dev doctor
```

### Keys: only one is needed to launch

| Key | Needed? | What it unlocks | Where |
|---|---|---|---|
| `pinata` | **to launch** | hosts each coin's picture and info | pinata.cloud, free plan: API Keys > New Key > Admin > copy the JWT |
| `twitterapi` | for autopilot on X | live feed of the accounts you watch + viral posts (posts arrive ~8-10 s after they go up) | twitterapi.io: ~$1 free credits to start, then 15 credits ($0.00015) per post from accounts you watch |
| `fal` or `openai` | optional | drawn pictures (ChatGPT's GPT Image) when no real picture exists | fal.ai or platform.openai.com |
| `rpc` | recommended on mainnet | a private Solana connection: faster, no throttling | helius.dev, free plan |
| `brave` | optional | image search for news coins | api-dashboard.search.brave.com, free plan |

Save each one with a hidden prompt. Keys go to `~/.serial-dev/keys.json`, never into a project:

```bash
serial-dev keys set pinata
serial-dev keys          # what each key does and which are set
```

Env vars work too and win over saved keys: `PINATA_JWT`, `TWITTERAPI_KEY`, `FAL_KEY` (or `FAL_KEY_FILE`),
`OPENAI_API_KEY`, `SOLANA_RPC_URL`, `BRAVE_API_KEY`. Also `PINATA_GATEWAY` (your dedicated gateway) and
`SERIAL_DEV_SECRET` (wallet as base58, for servers).

Free without any key: reading tweets, Truth Social, news headlines, the pump.fun trend feed, and real pictures.

Agents don't need you to read any of this: the MCP server tells the agent to call `setup_check` first, and
that tool returns the missing keys with plain-English steps to pass on to you.

## Plug it into your agent (MCP)

Claude Code:

```bash
claude mcp add serial-dev --scope user -- serial-dev-mcp
```

On Windows, wrap it: `claude mcp add serial-dev --scope user -- cmd /c serial-dev-mcp`.

It shows up in the next Claude Code session you open (type `/mcp` to see it). It does not appear under
claude.ai's Connectors page; that page is only for hosted connectors. Keys saved with `keys set` are picked
up automatically, no need to pass them here.

Cursor, Claude Desktop, Windsurf, OpenClaw, anything that speaks MCP:

```json
{
  "mcpServers": {
    "serial-dev": {
      "command": "serial-dev-mcp"
    }
  }
}
```

Then tell your agent: *"Read the serial-dev playbook and start launching off the accounts I watch."*
For Claude Code, also drop [SKILL.md](SKILL.md) into `.claude/skills/serial-dev/SKILL.md`.

### Tools

| Tool | Does |
|---|---|
| `read_playbook` | The strategy, with what real serial devs launch (measured) |
| `wallet_status` | Address, balance, network, limits, sources, image generator |
| `next_items` | Live feed from every source: post + tier + coin draft + filter verdict |
| `draft_coin` | Preview the coin a post becomes |
| `image_options` | Every picture option for a post, **shown to the agent as images**, plus ready prompts |
| `generate_image` | Generate a picture, or remix the subject's real picture (`reference_url`) |
| `launch_coin` | Pick picture, upload, create, optional dev buy, `copies`. `dry_run` simulates |
| `relaunch` | Another copy of a coin's post with a new picture |
| `watch_list` / `sources` | Accounts with tiers (S / A / news), and which feeds are on |
| `coin_status` | Market cap, bonding progress, your bag, unswept fees |
| `buy` / `sell` | Trade any pump.fun coin, on the curve or after graduation |
| `creator_fees` / `claim_fees` | What you've earned, and collect it |
| `review` / `stats` | What's pulling volume by source, account, picture; spend and net |

## CLI

```bash
serial-dev watch add elonmusk --tier S      # coin everything Elon posts
serial-dev watch add Daily_Express StockMKTNewz --tier news
serial-dev sources truth on                 # Trump's Truth Social
serial-dev sources trend on                 # names other devs are piling into
serial-dev images <tweet link> --generate   # see picture options, make one
serial-dev run --dry-run                    # autopilot, simulated
serial-dev run                              # autopilot, for real
serial-dev launch <tweet link> --ticker BIRD --copies 2
serial-dev relaunch <mint>
serial-dev review                           # what's working
serial-dev fees
serial-dev claim
serial-dev stats
```

Every command takes `--json`. `serial-dev help` lists everything.

## Settings

`serial-dev config` shows them all. The ones that matter:

| Setting | Default | |
|---|---|---|
| `network` | `mainnet` | real SOL. `devnet` = practice with free test SOL. Only the CLI can change it, never the MCP server |
| `devBuySol` | `0.1` | dev buy used when the agent doesn't pick one (`limits.minDevBuySol` sets an optional floor) |
| `limits.maxDevBuySol` | `0.5` | the most an agent may ask for |
| `limits.maxLaunchesPerHour` | `20` | |
| `limits.maxSolPerDay` | `5` | dev buys included |
| `tiers.S` / `A` / `news` / `viral` / `trend` | see playbook | per tier: needs a picture?, replies?, copies, relaunch, max post age |
| `relaunch.maxCopies` | `3` | copies of one post at most |
| `relaunch.checkAfterSeconds` / `deadBelowSol` | `90` / `1` | when a copy counts as dead |
| `image.mode` | `smart` | `smart`: the real picture of the subject first, GPT Image draws the name only when nothing real exists. `fast`: never generate |
| `image.quality` | `medium` | GPT Image quality: medium ~20 s, high ~50 s |
| `relaunch.samePicture` | `true` | every copy keeps the first copy's picture, like real relaunches |
| `filters.blockWords` | tragedy words | never coin a death |
| `exit.takeProfitX` / `exit.sellAfterSeconds` | `0` (off) | auto-sell the dev buy |
| `priorityFeeMicroLamports` | `200000` | ~0.00003 SOL a launch, lands faster |

## How it works

- Coins are created with pump.fun's current `create_v2` instruction through the official `@pump-fun/pump-sdk`.
- Launch and dev buy go in one transaction, so nobody gets in before the dev. The first dev-buy launch
  makes a small address lookup table (~0.006 SOL, once) because create + buy is just over Solana's
  transaction size limit without one.
- Every transaction can be simulated against the real chain first (`--dry-run` / `dry_run`), which costs nothing.
- Everything you do is logged to `~/.serial-dev/ledger.jsonl`; `stats` reads it.

## What it won't do

No bundled wallets, no wash trading, no fake holders, no hidden devs. The creator wallet is the dev, in
the open. See section 8 of the [playbook](PLAYBOOK.md) for why that's also the version that lasts.

## Tests

```bash
npm test
```

Unit tests cover naming (with cases from real launches), tiers, filters, feeds, stream handling and
decoding live pump.fun launches. `npm run test:mcp` drives the MCP server like an agent;
`npm run test:autopilot` runs the autopilot against a fake X stream. The chain code was checked by
simulating launch, launch + dev buy, buy, sell (curve and PumpSwap), coin status and fees against
pump.fun mainnet.

MIT license. Not financial advice. Memecoins are mostly zero.
