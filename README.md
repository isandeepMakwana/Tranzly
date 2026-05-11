# Auto Page Translator

A Manifest V3 Chrome extension that translates configured pages to English.

## What it does

- Lets you add URL contains rules, such as `cloud.oppoer.me`.
- Automatically runs only when the current page URL contains one of those rules.
- Translates Chinese page text to English using Chrome's built-in Translator API when available.
- Adds popup controls for translate again, restore original, add current domain, and auto-translate on/off.
- Adds right-click menu items for translating or restoring the current page.
- Updates the toolbar icon and badge for idle, matched, translating, success, error, and paused states.
- Stores recent rule, translation, page, icon, lifecycle, error, and user-action logs in the Options page.
- Watches dynamic page updates, which helps with dashboard and console-style apps.

## Install locally

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder: `translate-extension`.

## Notes

Chrome's native toolbar/right-click translate button cannot be clicked programmatically by a normal extension. This extension translates webpage text in-place instead.

The built-in Translator API requires Chrome support for the `Translator` web API. If Chrome does not support it, the popup shows `Translator unavailable`.

## Icon badge states

- Idle: no badge
- Rule matched: `ON`, green
- Translating: `...`, blue
- Success: check badge, green
- Error: `ERR`, red
- Paused: `OFF`, gray


## SS 
<img width="474" height="752" alt="image" src="https://github.com/user-attachments/assets/65ba7be2-db02-448f-9a80-ae91c7ebf833" />
<img width="1920" height="912" alt="image" src="https://github.com/user-attachments/assets/f3305228-2eea-4232-947d-6351a64bc6df" />
<img width="1920" height="912" alt="image" src="https://github.com/user-attachments/assets/2b22346d-cba8-4e48-af84-5771e77c5bf5" />

