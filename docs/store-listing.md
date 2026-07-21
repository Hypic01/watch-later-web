# Chrome Web Store submission kit

## Single purpose

Syncs the user's own YouTube Watch Later playlist into their Laterlist account so it can be organized and summarized.

## Permission justifications

### scripting

The scripting permission injects the collector into the user's own YouTube tab to read their Watch Later list and captions. MAIN world execution is required because YouTube exposes this data only in the page world.

### storage

The storage permission stores the user's own Laterlist API token and their chosen sync schedule locally in Chrome.

### alarms

The alarms permission runs the scheduled background sync that the user controls from the extension popup. The user can choose every 6 hours, daily, or off.

### Host access to youtube.com

The youtube.com host permission lets the extension read the user's own Watch Later list and captions. YouTube is the only site the extension touches.

## Data usage disclosure

### Data collected

Website content: Yes. The extension collects video titles, channel names, durations, and captions from the user's own YouTube account.

Authentication information: Yes. The extension stores the user's Laterlist access token locally in Chrome.

### How the data is used

The data is used only for the extension's single purpose, syncing the user's own YouTube Watch Later playlist into their Laterlist account so it can be organized and summarized.

The data is transmitted to the developer's service only for the user's own Laterlist account.

The data is not sold. It is not shared with third parties. It is not used for creditworthiness or lending purposes.

### Remote code

No remote code is used. All extension code is bundled in the submitted Manifest V3 package. The extension does not use eval or download executable code.

## Reviewer notes

A full sync and a caption fetch may briefly open a muted background youtube.com tab. The tab closes itself when the task finishes. Nothing is downloaded or rehosted. The user watches every video on YouTube.

## Screenshot shot list

Capture each screenshot at 1280 by 800 pixels.

1. The board with videos arranged in sorted rows.
2. The import panel with the Chrome extension connected.
3. The extension popup with the Auto-sync setting visible.
4. A video detail view with its TL;DR visible.
5. The Laterlist landing page.
