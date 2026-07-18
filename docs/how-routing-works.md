# How routing works

Every message you send has to reach the *right* model. A coding question should go
to your coder; "hi" shouldn't wake a 70B. Deciding that, for every message, in
milliseconds, is the whole job of the router.

It does it with **three voters**, cheapest first.

---

## The three voters

| | reads | speed | ships |
|---|---|---|---|
| **1. Keyword** | the words themselves | instant | always |
| **2. kNN (memory)** | corrections you've made before | ~30 ms | always |
| **3. Context model** | what the sentence *means* | ~200 ms | opt-in |

They're deliberately different. Keyword is literal, memory is personal, the model
understands language. For all three to be wrong, three unrelated things have to
fail the same way — which is why together they beat any one alone.

---

## 1. Keyword — pattern matching

A list of patterns. `debug`, `refactor`, `write a python script`, `draw me a…`.

```
"debug this function"      →  code       ✅ instant, free
"draw me a fox"            →  image      ✅ instant, free
```

**Strength:** free and instant. Works the second you install, with no setup.
**Weakness:** brittle. It only knows the words it was told about.

```
"my script keeps blowing up"   →  no match
```

Obviously a coding problem — no keyword in it. So we ask the next voter.

> Keyword deliberately stays narrow. A bare `code` rule would hijack "what's the
> **dress code**?" and "my **postal code**". False matches are worse than misses,
> because something else can cover a miss.

---

## 2. kNN — your own corrections, remembered

Whenever you fix a routing decision, the router stores that message *as a
fingerprint* (an "embedding" — a list of numbers describing its meaning). Later
messages get the same treatment, and it compares fingerprints.

Similar meaning → similar numbers → **it recognises the message even in different
words**.

```
you once fixed:  "pip install fails"        →  code
now you send:    "npm install won't work"   →  0.81 similar  →  code  ✅
```

Similarity runs 0 to 1. Above the threshold (default **0.6**) it acts. Below, it
steps aside:

```
"my script keeps blowing up"   →  closest match 0.52  →  not confident enough
```

**Strength:** learns *your* habits. Free after a one-off embedding.
**Weakness:** knows nothing until you've corrected something. Empty on day one.

---

## 3. Context model — actually reading the message

A small LLM (~500 MB) that reads the message and picks a role. This one is
**opt-in**, because it uses memory.

```
"my script keeps blowing up"   →  the model reads it  →  code  ✅
```

No keyword, no memory — but *meaning* is obvious to a language model.

**Strength:** understands phrasing nobody anticipated.
**Weakness:** ~200 ms and some RAM. So it only runs when the free voters can't
answer.

---

## Putting it together

```
message
   │
   ├─ Have I been told this exact answer before?  ──── yes ──►  use it (instant)
   │
   ├─ 1. keyword     — do the words match a rule?
   ├─ 2. kNN         — does it resemble something you corrected?
   │
   │   both confident and they agree?  ──────────────────────►  go (free)
   │
   └─ 3. context model — only if the above were unsure or disagreed
                                                              ──►  decide
   still nobody sure?  ─────────────────────────────────────►  general
```

Two rules keep it honest:

**Cheap voters run first.** The model is only consulted when the free ones can't
settle it. As the router learns, that happens less and less.

**It always answers.** If nothing is sure, it routes to `general` — a capable
all-rounder. Never an error, never "I don't know".

---

## Why it guesses instead of playing safe

When signals are weak, the router still picks the **best guess** rather than
retreating to `general`. That's deliberate:

- Every reply shows which role was chosen (`↳ … · code`), so a wrong guess is
  **visible**.
- One click fixes it — and that fix is **remembered forever**.

A router that hides behind `general` whenever it's unsure never learns anything,
because it never makes a decision you can correct.

---

## How it gets smarter

```
   router guesses  →  you see the role on the reply  →  you click
                                                          │
                                    ✎ fix   — "wrong, it's code"
                                    ✓ right — "correct, remember it"
                                                          │
                                                    stored forever
                                                          │
                                  next time: instant, free, no model call
```

**Both buttons matter.** ✎ fix teaches it from mistakes. ✓ right captures wins —
without it, a correct-but-slow decision (the context model waking up) would stay
slow *forever*, because nothing recorded that it was right.

So the router gets **faster and cheaper the more you use it**: work that needed
the model in week one becomes an instant free lookup by week three.

---

## Seeing it for yourself

**Cockpit → Routing → Routing log.** Click any tier badge to see the votes:

```
keyword   role=—      conf 0.00  cov 0.00   no rule matched
knn       role=code   conf 0.00  cov 0.52   nearest correction 0.523 < 0.6
context   role=code   conf 0.70  cov n/a    qwen3:0.6b → code
```

Read as: keyword had nothing, memory *leaned* code but wasn't sure enough, the
model settled it.

Two numbers, because they answer different questions:

- **conf** — "how sure am I it's code?"
- **cov** — "did I understand the message at all?"

That kNN row is exactly why: `conf 0.00` but `cov 0.52` means *"I found something
related, but not close enough to act on."* A single number can't say that. (It's
`n/a` for the model — asking an LLM how well it understood gives you an answer you
can't trust.)

---

## Turning the context model on

It's off by default because it costs memory. To enable:

```bash
spag pull qwen3:0.6b
```

Then in `config/router_roles.yaml`:

```yaml
context_model: "qwen3:0.6b"   # any small model; swap freely
context_model_device: cpu     # cpu (default) keeps it off your GPU
context_model_paused: false   # true = keep installed but skip it
```

**Why CPU by default:** it only runs on the hard messages, so it doesn't need GPU
speed — and staying off the GPU means it never competes with the models doing the
real work. Set `gpu` if you have VRAM to spare.

**Turning it off breaks nothing.** Keyword + memory carry on exactly as before.

---

## In one line

> **Cheap voters first, the smart one only when needed, always an answer — and
> every correction makes the cheap path smarter.**

---

*Design detail and the roadmap: [PLANNED-smart-routing.md](PLANNED-smart-routing.md).*
