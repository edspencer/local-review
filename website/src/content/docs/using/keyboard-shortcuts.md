---
title: Keyboard shortcuts
description: Move between PRs and files, and filter projects, without the mouse.
---

Shortcuts are ignored while you're typing in any text field (a comment, an editor, a filter) or a select.

## The root page

| Key | |
| --- | --- |
| `/` | Focus the filter. |
| Esc | In the filter: clear it, and leave it. |

## On a PR page

| Key | |
| --- | --- |
| `j` | Next PR. |
| `k` | Previous PR. |

`j` and `k` (and the **Prev** / **Next** buttons) walk every PR in the project in sidebar order: across stacks, and
across repos. They do nothing on the project and stack pages. The PRs either side of the one you're on are loaded in the background, so stepping through a stack is
instant; see [Moving between PRs](/using/ui-tour/#moving-between-prs).

## Files changed

| Key | |
| --- | --- |
| `n` | Next file. |
| `p` | Previous file. |

A folded thread's row is a button: Tab to it, then Enter or Space opens or folds it.

## The sidebar's edge

Tab to the handle on the sidebar's right edge (it lights up), then:

| Key | |
| --- | --- |
| ← / → | Narrower / wider, 16px at a time. |
| Shift + ← / → | 64px at a time. |
| Home / End | The narrowest / the widest. |

Double-clicking the handle puts the default width back.

## Editing

| Key | |
| --- | --- |
| Enter | Save a title. |
| ⌘/Ctrl + Enter | Post a comment or reply; save a description, project intro or stack note. |
| Esc | Cancel (asking first if you changed something). Also closes the project switcher and the **…** and **edited ▾** menus. |
| ⌘/Ctrl + B, I, K | Bold, italic, link, in an editor with a toolbar. |

To select a range of lines for a comment, click one line number and **shift-click** another.

## Image viewer

Click an image to open it ([Seeing an image up close](/using/editing-pr-text/#seeing-an-image-up-close)). While it's
open, no other shortcut on this page works.

| Key | |
| --- | --- |
| Enter or Space | Open the focused image. |
| ← / → | Previous / next image in the same description, note or comment. |
| Esc | Close the viewer. |
| Tab / Shift + Tab | Move between its buttons. |
