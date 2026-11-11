# Telemetry for Herdr

A flight-HUD layout for the [Herdr](https://herdr.dev) desktop app. It puts every coding agent you run on one screen:

- **Agents**: a radar of your agents and their status counts.
- **Sessions**: what every agent is doing, in a few lines each. Agents that need you come first, and you answer them there: one choice, several ticked then Submit, or your own words. For Claude Code the card shows the exact tool call it waits on (the whole command, the file) and each option's description, read from its transcript.
- **Plan limits**: Claude Code and Codex usage for the machine of the space you're in, with the account and plan.
- **Pull requests**: open and just-merged PRs as five stages (open, checks, review, merge, deploy).
- **Resources**: CPU and memory per space, with CRYO / WAKE to put a space's agents to sleep and resume the same conversations.

![Telemetry](preview.png)

## Install

Ask your agent:

> Read ~/.config/herdr-app/AGENTS.md, then add the Herdr layout from https://github.com/kyujonglee/herdr-telemetry

Or copy the files yourself:

```sh
git clone https://github.com/kyujonglee/herdr-telemetry
cp herdr-telemetry/layouts/telemetry.* ~/.config/herdr-app/layouts/
cp -R herdr-telemetry/mods/telemetry ~/.config/herdr-app/mods/
herdr-app check ~/.config/herdr-app/mods/telemetry
herdr-app do layout.switch '{"name":"telemetry"}'
```

`ctrl-shift-l` switches layouts back.

## Before you add it

This mod runs programs on your machine and reads files outside its own folder:

- `claude`, `codex app-server`, `gh`, `git`, `ps`, `lsof`, `sysctl` and `open`.
- `kill -TERM`, only when you press CRYO twice.
- `hc exec` on your connected machines.
- `~/.claude/sessions/*.json`, and the last 400 KB of a blocked Claude Code agent's transcript (`~/.claude/projects/…/<session>.jsonl`).

It shows your account email on screen only. It types into a terminal only when you answer an agent from its card.

It is built and tested on macOS. Read [RECIPE.md](RECIPE.md) for every detail and the known limits.

## Fonts

The bundled fonts are under the SIL Open Font License; their license files are in `mods/telemetry/fonts/`:

- Rajdhani (Indian Type Foundry)
- IBM Plex Mono (IBM)

## Credits

The menu reader and the key sequences that answer it are ported from [herdr-relevo](https://github.com/johnny4young/herdr-relevo)'s `lib/prompt.js` (Apache-2.0) by way of [quaresc/cockpit](https://github.com/quaresc/cockpit)'s Rust port (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT, see [LICENSE](LICENSE). The bundled fonts keep their own SIL Open Font License, and the ported parts listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) keep theirs (Apache-2.0 and MIT).
