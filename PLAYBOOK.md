# The Serial Dev Playbook

How tweet-coin devs on pump.fun actually operate and make money, written for an AI agent that is about
to become one. Section 2 was measured on-chain on November 9, 2026, not guessed.

## 1. The business in one paragraph

A serial dev turns posts into coins within seconds: a tweet from Elon, a Truth from Trump, a news
headline, a meme going viral, or a name other devs are already launching. Traders and sniper bots hunt
for "the coin" of every moment, so the first well-named coin with the right picture gets the volume.
pump.fun pays the creator a cut of every trade. Each coin costs about 50 cents. Most earn nothing,
some earn a few dollars, a few run. Serial devs launch the same post more than once, because sometimes
copy 3 is the one that runs. The game: **right sources, speed, the right name, the right picture, many shots.**

## 2. What real serial devs launch (measured)

We pulled 157 consecutive pump.fun launches (Nov 9, 2026, 15:04 to 15:33 UTC), read every coin's
metadata and matched it to the post it came from. pump.fun was doing about 30 launches a minute.

**Where the coins come from**
- 29% link a source post on X. About a quarter of all launches went through tweet-deploy terminals:
  J7 Tracker (16), Uxento (14), Padre (7). J7 watches X, Truth Social, Instagram, TikTok, YouTube,
  Binance Square and Telegram, and can deploy the same coin up to 10 times in one call.
- **News accounts:** @Daily_Express, @StockMKTNewz, @CGTNEurope, @gulf_news, @dajiyuan. One news dev
  coined 7 different news accounts in 30 minutes, 16 to 32 seconds after each post.
- **Meme-alert accounts** on crypto Twitter post things like *"HE HAS A DOG CALLED MAX??"* or
  *"HE CREATED A BRAINROT MEME!!!!"*. Devs coin them in seconds. One such post was coined by 5
  different devs within 40 seconds.
- **Big individuals:** Elon above everyone. Even hour-old Elon posts still get coined.

**Speed:** median launch was **24 seconds** after the post. The fastest tools launched in **0 to 1 second**.

**Repeats are normal:**
- One dev launched the same post **12 times, in waves of 4**, 13 to 14 minutes after it.
- Same-name coins from different devs are everywhere. We watched a **trend copier** wallet live as it
  copied two names other devs had launched seconds before.

**Names** (the coin is named after what the post is about, not the whole sentence):

| Post | Coin |
|---|---|
| "BREAKING: Russell Brand sentenced to 10 and a half years in prison" | Russell Brand |
| "Eli Lilly $LLY said its new obesity pill..." | Eli Lilly |
| "...saying the effort will "end in failure."" | end in failure |
| "First Abu Dhabi Bank acquires..." | fab |
| "HE HAS A DOG CALLED MAX??" | MAX |
| "id for creatine but not voting LMFAOOOO" | creatinu |
| "Solana just talked about edging crypto with housing? HELLO" | Housecoin |

**Pictures**: see section 7, measured on 678 launches.

## 3. The numbers that matter

| | |
|---|---|
| Cost to create a coin | **~0.0058 SOL** (measured: rent + fees) |
| Dev buy at launch | your call; 0.1 SOL (~0.35% of supply) if you don't choose |
| Creator fee on the bonding curve | **0.30% of every buy and sell** (pump.fun fee config, live) |
| pump.fun's own cut | 0.95% |
| Break-even volume per coin | **~2 SOL** of trading (0.0058 / 0.003) |
| GPT Image picture | ~20 s at medium quality, ~50 s at high |
| Graduation | ~85 SOL in the curve, ~$36K market cap at SOL ~$87 |

Public results: one wallet ran ~18,000 coins for ~$3.76M; another ~17,000 for ~$840K. Wallets with
hundreds of thousands of deploys average a few dollars a coin. **The money is in the average across
thousands of launches.** If your average coin trades under 2 SOL, you lose money. Watch `review`.

## 4. Sources and tiers

| Tier | Who | Rule |
|---|---|---|
| **S** | Elon (X), Trump (Truth Social) | Coin everything they post, even text and replies. Burst copies and relaunches on. |
| **A** | Crypto-Twitter meme-alert accounts, big personalities | Only posts with a picture or link. |
| **news** | Breaking-news accounts on X, headline feeds | Name the coin after the person, company, place or quoted phrase. Use the news photo as it is. |
| **viral** | Anyone's post blowing up right now (likes per minute) | Only with a picture. |
| **trend** | Names several devs are launching on pump.fun right now | Launch your copy fast or skip. Borrow the post link from their metadata. |

Starter lists (prune by `review` after a day):
- S: `elonmusk`; turn on `sources truth on` for Trump.
- news: `Daily_Express`, `StockMKTNewz`, `CGTNEurope`, `gulf_news`, `WatcherGuru`, `DeItaone`, `BNONews`, `disclosetv`, `spectatorindex`, `PopBase`.
- A: the crypto-Twitter accounts whose posts keep getting coined (find them in `trend` items: the post link tells you who).

## 5. Speed

- Run the X stream (twitterapi.io filter rules) at 0.1 to 1 second. Truth Social and news are polled every 15 to 30 seconds.
- A paid RPC (Helius, Triton, QuickNode). Priority fee on.
- A post with a real picture (its own or its link's) launches in ~2 to 3 seconds. A generated picture
  adds ~15 to 25 seconds, which lands near the median dev's 24. It's only needed when nothing real exists.
- `postAgeSeconds` is recorded on every launch.

## 6. Naming

- **Name** = what the post is about: the person, company, place, animal or quoted phrase, up to 32 characters.
- **Ticker** = the word people will type, up to 13 characters. A `$CASHTAG` in the post wins.
- Wordplay beats literal: creatine + inu = creatinu. The heuristics get you "Creatine"; an agent should
  push it to the meme.
- The description quotes the post, links it, and says the coin isn't affiliated with the author. Keep that.
  Never link someone else's post under a famous account's name (we saw a dev do it).

## 7. Pictures (measured)

We pulled the picture of 678 launches (Nov 9, 2026), traced 240 of them to the post they came from,
fingerprinted every picture and looked at all of them.

**The one rule: the picture is the name.** Someone who reads the ticker gets it from the picture in one
glance. Almost every coin did this. Pictures of something else, however funny, were essentially absent.

| What devs did | How often |
|---|---|
| Copied the picture another dev already used for that name | 47 of 56 names launched by 2+ devs |
| Kept the same picture when relaunching their own coin | 33 of 37 |
| News devs used the news post's own picture | 16 of 19 |
| Post linked a source (article, Instagram, YouTube, a game page): used the source's clean picture, not the post's screenshot of it | most of the 105 "post had a picture, coin used another" cases |
| Used the poster's profile picture (the coin is about the poster) | 7% |
| No real picture anywhere: made the name as a picture, a literal or a pun, mostly AI | most of the 45 "post had no picture" cases |
| A lazy screenshot of the post | rare |

Examples straight from the chain:
- "Google posted a duck and named it Cal" -> the actual Google duck.
- "Roblox is removing Fart Together" -> the game's real logo.
- "Elon 2028" -> the real logo from the CoinDesk story (6 devs used it).
- MAGAZINE -> a red MAGA hat sitting on a gun magazine. IMPEACH -> a man in a suit standing on a giant peach.
  HIGHCAP / MEGA CAP -> a capybara wearing a cap. CREATINU -> a buff shiba with a creatine scoop.

**So the bot picks in this order:**
1. A name other devs already launched: their picture.
2. The coin is about an account the post mentions or quotes (Elon posts about @grok -> $GROK): that
   account's own profile picture. Nobody launches a Grok coin with an AI drawing of Grok.
3. The post links out: the source's real picture, as it is.
4. The post's own picture, as it is (news photos, memes).
5. The poster's profile picture, when the coin is about the poster.
6. Nothing real: GPT Image draws **the name**, literally or as a pun. Never a scene from the post.
7. Last resorts: Wikipedia or image search for a name in the news, then a screenshot card.

Real pictures from posts, profiles and links are what devs use, other people's included. That's the norm in the trenches.

Real pictures are only cropped square around the subject (pump.fun shows squares and circles), never
remixed. Generated pictures look like real photos, not cartoons or glossy 3D. No words in generated
pictures, and never put a real person's face in a made-up scene.

## 8. Copies and relaunches

- Tier S posts launch as a burst (default 1 copy, raise `tiers.S.copies`). Every copy keeps the same
  name, ticker and picture, like 33 of 37 real relaunches (`relaunch.samePicture`, or `relaunch(mint, new_picture: true)`).
- After `relaunch.checkAfterSeconds` (90), if every copy so far has less than `relaunch.deadBelowSol`
  (1 SOL) in its curve and the post is under `relaunch.maxAgeMinutes` (20) old, the next copy launches,
  up to `relaunch.maxCopies` (3). As soon as one copy is alive, relaunching stops so you don't compete with it.
- Every copy is its own coin from the same visible dev wallet. Nobody is hidden.

## 9. Your calls: dev buy, hold or sell, how to launch

The kit doesn't decide these. You do, per coin. Here's what each choice does.

**Dev buy (`dev_buy_sol`)**

First, know the two ways a coin gets created, because "no buy" means different things in each:

- **pump.fun's website (its free create):** a coin made with no buy is **off chain and hidden from the
  public** until a first buy deploys it (~0.02 SOL fee + gas, paid by whoever buys first). If someone
  else makes that first buy, *they* show on chain as the deployer while pump.fun still credits you as
  the creator, and the coin keeps an "offchain" label. pump.fun's own tooltip: "This coin was created
  offchain, so the contract deployer shown on-chain may not match the actual creator." (pump.fun help
  center, "Create a coin on Pump.fun", checked Nov 9 2026.)
- **This kit:** creates the coin straight on pump.fun's program from your wallet, so it's on chain from
  the first second, with or without a buy. A no-buy coin made this way (example: FOMO, Nov 9) had its
  own page and no offchain label, just "Dev 0%" and an empty chart.

| You buy (with this kit) | What happens |
|---|---|
| 0 SOL | On chain right away, visible on pump.fun, but "Dev 0%", one holder and an empty chart until someone trades. Cheapest: ~0.0058 SOL. |
| 0.05 SOL | First trade on the chart, ~0.18% of supply. |
| 0.1 SOL (used if you don't choose) | ~0.35% of supply. Too small to scare buyers. |
| 1 SOL | ~3.4% of supply. |
| 10 SOL | ~27% of supply. Buyers will see a big dev bag. |

Of 280 real launches we measured, 59% bought in at launch and 41% didn't. Every dev buy is public
("dev holds X%"), and so is every dev sale ("dev sold").

**Hold or sell.** Holding keeps "dev holds" on the coin page; selling early is visible as "dev sold".
Sell when you want with `sell`, or let the config do it (`exit.sellAfterSeconds`, `exit.takeProfitX`).

**How the coin gets launched.** This kit creates coins straight on pump.fun's program (the official
`@pump-fun/pump-sdk`, create and buy in one transaction), from your one visible dev wallet. Other routes
exist (pump.fun's website, PumpPortal's API, deploy terminals like J7 Tracker), but they launch the same
coin on the same program. Bundler tools that spread the dev's buy across hidden wallets are the one route
this kit won't take (section 11).

**Limits the human sets:** `limits.maxDevBuySol` (the most you may buy per launch), `limits.minDevBuySol`
(optional floor, 0 by default), `limits.maxSolPerDay`. Claim fees on a schedule (`claim_fees`).

## 10. Guardrails

- `limits.maxLaunchesPerHour`, `limits.maxSolPerDay`, `limits.cooldownSeconds` stop a runaway loop.
- Start on devnet, then mainnet with the default 0.1 SOL dev buy and a small daily budget. Read `review` after 100 launches.
- Only a human can switch to mainnet (`serial-dev config network mainnet`). The MCP server can't.
- Tragedy filter: deaths, killings, shootings and the like are skipped by default (`filters.blockWords`).
  Real devs coin those too. It's ghoulish and it gets reported; leave the filter on.

## 11. What this kit will not do

- **Bundle** (secret buys from many wallets in the launch block to hide how much the dev holds).
- **Wash trade** or run volume bots on your own coins.
- **Fake holders**, fake comments, bought accounts.
- **Hide the dev** behind hop wallets or staggered funding.

Those tricks deceive the people buying your coins and are market manipulation in most of the world.
Speed, sources, names, pictures and relaunches are where the edge is, and none of it needs deception.

**Holder-reward coins** (`holder_reward: true`, mainnet) send the creator fee to the coin's holders instead of you.

## 12. The agent loop

```
read_playbook, wallet_status                      once
loop:
  next_items(wait_seconds: 20)                    posts from every source + drafts + verdicts
  for the best 0 to 2:
    sharpen name and ticker (go for the meme, not the literal word)
    picture: image_options -> the real one if it exists; nothing real -> generate_image(promptFromScratch) = the name as a picture
    launch_coin(post, name, ticker, image)
  died young and the post is still hot? relaunch(mint)
  every ~30 min: claim_fees, review -> drop sources and accounts that never pull volume
```

Not financial advice. Memecoins are mostly zero. Know your local law before you run this with real money.
