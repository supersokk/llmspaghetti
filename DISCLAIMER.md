# LLMSpaghetti — Disclaimer

## Plain English Version

This is a hobby project named after its own code quality. It was built for fun, runs on vibes, and the code
is best described as "enthusiastic spaghetti." Nobody is getting paid to
maintain it. Nobody is on call. Nobody is coming to save you if something
goes wrong.

**Use it at your own risk. Seriously.**

---

## What This Project Is

- A personal hobby project shared publicly in the hope it's useful
- Community-maintained — meaning it gets better when people contribute,
  and gets worse (or stagnant) when they don't
- An experiment in building a minimal LLM appliance OS
- Fun to work on, occasionally functional, never guaranteed

## What This Project Is Not

- A commercial product
- Production-ready software
- Something with a support team behind it
- Regularly updated on any schedule whatsoever
- Tested on every GPU, motherboard, or Ubuntu version in existence

---

## No Warranty

This software is provided **"as is"**, without warranty of any kind, express
or implied, including but not limited to the warranties of merchantability,
fitness for a particular purpose, and non-infringement.

In no event shall the authors or contributors be liable for any claim,
damages, or other liability — whether in an action of contract, tort, or
otherwise — arising from, out of, or in connection with the software or
the use of other dealings in the software.

---

## Specific Things That Could Go Wrong

To be concrete about the risks:

- **GPU drivers** — Installing CUDA or ROCm on a running system can break
  things. Test in a VM first. Always.

- **API keys** — You are responsible for your own API keys and any costs
  incurred. If LiteLLM routes a million tokens to OpenAI because you
  misconfigured something, that's on you.

- **Data** — Models and configs are stored on your disk. If the install
  script does something unexpected to your storage layout, we warned you.

- **Network** — This opens ports on your machine. You are responsible for
  your own firewall and network security.

- **Updates** — "Works today" does not mean "works after the next Ubuntu
  update, Docker update, Ollama update, or any other update."

---

## Updates and Maintenance

There is no update schedule. Updates happen when:
- A contributor submits a PR
- Someone hits a bad enough bug that they fix it themselves
- The maintainer feels like it (no promises on when that is)

If you need something fixed urgently — fix it and submit a PR. That's
how open source works, and it's especially how *hobby* open source works.

---

## Contributing

The flip side of "no guarantees" is "everyone can make it better."

If you find a bug, fix it. If you want a feature, build it. If the
documentation is wrong, correct it. The barrier to contributing is low
because the project isn't precious — it's just code.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to submit changes.

---

## Summary

Great for: home labs, learning, personal AI setups, tinkering.

Not great for: hospitals, banks, anything where downtime costs money,
anything where you need someone to blame.

Have fun. Don't blame us.
