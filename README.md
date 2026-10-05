[![GitHub Release](https://img.shields.io/github/v/release/dmhendricks/style-detective?style=flat-square)](https://github.com/dmhendricks/style-detective/releases)
[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/dmhendricks/style-detective/release.yml?style=flat-square)](https://github.com/dmhendricks/style-detective/actions)
[![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/fbfplfafboelbaogjidoamdjjcckemib?style=flat-square)](https://chromewebstore.google.com/detail/style-detective/fbfplfafboelbaogjidoamdjjcckemib)
[![License](https://img.shields.io/github/license/dmhendricks/style-detective.svg?style=flat-square)](https://github.com/dmhendricks/style-detective/blob/main/LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub-ea4aaa.svg?logo=github-sponsors&logoColor=white)](https://github.com/sponsors/dmhendricks)

# Style Detective

A modern rewrite of the popular [CSS Viewer](https://github.com/miled/cssviewer) extension for Chromium-based browsers. Hover over any element on a page to inspect its computed styles in a floating panel.

![Style Detective](store/screenshot-1280x800-01.png)

#### Features:

- Hover over any element to view its CSS properties in a floating panel
- Freeze the panel in place to inspect it
- DevTools-style box model diagram for margin, border, and padding — turn it off in settings for a shorter panel or plain text values
- Copy an element's style to clipboard, or freeze the panel to copy individual property values
- Copy the same properties as JSON (`J`) for diffing or feeding other tools
- Keyboard shortcut to toggle the viewer (`Alt+Shift+S`; macOS: `Option+Shift+S`)
- WCAG contrast ratio for color vs background-color
- Ability to increase/decrease font size
- Dark mode support
- Iframe support
- Classes section with click-to-copy chips or "Copy All"

## Installation

The easiest way to install this extension is from the [Chrome Web Store](https://chromewebstore.google.com/detail/style-detective/fbfplfafboelbaogjidoamdjjcckemib).

## Development

Requires Node 20+. Clone the repository, then run:

```bash
npm install
npm run dev      # Watches for changes, rebuilds the extension
npm run lint
npm run test
```

Then open `chrome://extensions` (Google Chrome) or `edge://extensions` (Microsoft Edge), turn on **Developer mode** (top-right in Chrome, bottom left in Edge), click **Load Unpacked** and choose the `dist/` directory.

## Usage

Click the toolbar icon (or press `Alt+Shift+S` (Windows) or `Option+Shift+S` (macOS)) to enable or disable the viewer on the current page. While enabled, hover over any element to inspect it.

You can customize the toggle shortcut at `chrome://extensions/shortcuts`.

#### Keyboard Shortcuts

- `F` to freeze or unfreeze the panel in place
- `C` to copy a simple CSS definition for the selected element to the clipboard
- `Shift+C` to copy the element's classes (space-separated)
- `J` to copy the same properties as JSON (`{ selector, properties }`)
- `L` to show or hide the Classes row
- `+` / `-` to increase or decrease the panel font size (`0` / zero resets to default)
- `S` to open the settings page
- `Esc` to close the viewer

On elements with a `class` attribute, a **Classes** row appears below the header with click-to-copy chips and **Copy All** (long lists cap at a configurable number of wrap lines — default 3 — with `+N more`). The header shows the tag and `#id` only. Toggle the row anytime with **`L`** or **Show CSS Classes** in settings (`Shift+C` still copies classes).

## Configuration

![Style Detective settings](store/screenshot-1280x800-02.png)

Press **`S`** while inspecting to open the settings page. A live **Panel Preview** beside the settings shows each change as you make it.

| Setting | Default | What it does |
| --- | --- | --- |
| **Panel Theme** | System | Light, Dark, or System (follows your OS appearance). |
| **Show Box Model Diagram** | On | Draws the DevTools-style margin / border / padding diagram in the Box section. Off shows those values as normal property rows instead. |
| **Show CSS Classes** | On | Shows the Classes row with click-to-copy chips. Toggle without leaving the page with **`L`**; `Shift+C` still copies classes when the row is hidden. |
| **CSS Class Lines** | 3 | How many lines of class chips to show before collapsing into `+N more` (1–9). |
| **Panel Font Size** | 11px | Base font size for the overlay (8–18px). The panel width scales with it. Adjust while inspecting with `+` / `-`, or press `0` to reset. |

Between the box model and Classes toggles you can trim the panel down to just the property rows, which is useful on small screens or when the diagram and chips crowd out what you are actually inspecting.

**Reset to Defaults** at the bottom of the settings page restores every option above.

## What the Panel Shows

Values are the element’s **current computed styles**—what the browser is rendering right now—not authored CSS or cascade sources.

That includes interaction state: hovering a link shows its `:hover` color (and any other hover styles), which matches what you see under the cursor. Press **`F`** to freeze while hovered if you want to keep that snapshot and move the mouse away.

Copied CSS (`C`) and JSON (`J`) use the same live computed values as the panel, including colors in the form shown (hex when opaque, `rgba()` with alpha).

The **Box** section shows a DevTools-style margin / border / padding diagram by default; turn off **Show Box Model Diagram** in settings to see those values as normal property rows instead.
