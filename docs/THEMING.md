# Theming and branding

Users pick from twelve built-in themes and an accent colour in **Settings → Appearance**. Every built-in
theme is checked in CI for WCAG AA contrast. A custom accent is nudged automatically until it stays
readable on every panel.

| Light | Dark |
|---|---|
| Daylight, Paper, Solarized Light, Rosé Dawn, High Contrast Light | Midnight, Carbon, Nord, Solarized Dark, Rosé, Forest, High Contrast Dark |

Admins can brand an installation with environment variables. Name, logo, default accent, sign-in
message and support link are listed in [CONFIGURATION.md](CONFIGURATION.md#branding).

## Custom CSS

Set `TIDINGS_CUSTOM_CSS_FILE` to a stylesheet that every user loads after the built-in styles. Only the
custom properties below are a stable interface. Class names may change between minor versions.

| Property | Used for |
|---|---|
| `--bg` | App background behind the panels |
| `--surface` | List and reading panes |
| `--sunken` | Sidebar, inputs at rest |
| `--raised` | Menus, dialogs, composer |
| `--border` | Borders and dividers |
| `--text`, `--text-2`, `--text-3` | Primary, secondary and tertiary text |
| `--accent`, `--accent-text` | Brand colour and text on top of it |
| `--unread` | Unread dots |
| `--danger`, `--warn`, `--ok`, `--star` | Status colours |
| `--font` | UI font stack |
| `--r-1` … `--r-4` | Corner radii |
| `--rail` | Width of the accent rail marking the focused row, folder and tab |

Themes set these on `<html>` with inline styles, so override them with `!important` and scope them by
theme if needed:

```css
/* Our brand purple in every theme, slightly rounder corners */
:root { --accent: #6d28d9 !important; --accent-text: #fff !important; --r-3: 14px; }
/* Only adjust dark themes */
:root[data-dark='true'] { --surface: #101014 !important; }
```

Under the [licence exception](../LICENSE-EXCEPTION.md), branding assets and custom CSS that use these
properties are not modifications of Tidings and can stay private.
