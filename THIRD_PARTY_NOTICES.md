# Third-party notices

This repository is MIT-licensed (see `LICENSE`). Some code in it is ported from other open-source projects, which keep their own licences.

## herdr-relevo (Apache License 2.0)

- Source: https://github.com/johnny4young/herdr-relevo, `lib/prompt.js`
- Here: `mods/telemetry/data.js` — `readMenu` and `moveKeys` (reading a waiting agent's menu, and the arrow keys that answer it), and the answer steps in `mods/telemetry/caution.js`.
- Modified: taken by way of quaresc/cockpit's Rust port (below), translated back to JavaScript for this Herdr mod, with the box text above the question added.
- The full licence text is in `LICENSES/Apache-2.0.txt`.

herdr-relevo's NOTICE file, as reproduced in quaresc/cockpit:

```text
herdr-relevo
Licensed under the Apache License, Version 2.0 (see LICENSE).

mods/relevo-agents is derived from the `agents` mod that ships with Herdr
(Apache License 2.0). Changes: account and ticket chips on each agent, read
from the agent's terminal labels and the Relevo mod's shared setup.

mods/relevo-files is derived from the `files` mod that ships with Herdr
(Apache License 2.0). Changes: a right-click menu on files and folders (New
file, New folder, Rename, Move to Trash, Reveal in Finder, Copy path, Copy
relative path), editing with ⌘S, and a file view in its own pane.

mods/relevo/spinner.svg comes from Herdr's `workspace-chrome` mod
(Apache License 2.0), unchanged.
```

## quaresc/cockpit (MIT License)

- Source: https://github.com/quaresc/cockpit, `herdr/tui/agents/src/prompt.rs` and the answer steps in `herdr/tui/agents/src/gui.rs`
- Here: the same parts of `mods/telemetry/data.js` and `mods/telemetry/caution.js`, translated from Rust to JavaScript.

```text
MIT License

Copyright (c) 2026 quaresc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
