# Google Photos Toolkit (patched + Duplicate Finder)

A Tampermonkey userscript for bulk-organizing your Google Photos library in the browser:

- find the photos and videos that use up your storage
- find media that isn't in any album
- find duplicates and near-duplicates, compare them side by side, and keep the best copy
- move your whole library (or any filtered part of it) to the trash

Based on [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) by **xob0t** (MIT). This build adds bug fixes, a dry-run mode, safer confirmations and a built-in duplicate finder. The full list is in the header of the script.

> ⚠️ This script changes your real library. Use **Dry run** first. Anything you trash can be restored from Google Photos' Trash for 60 days.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension (Chrome, Edge, Firefox or Safari; Mac or Windows).
2. **Chrome / Edge only:** turn on userscripts. Open `chrome://extensions` and either turn on **Developer mode** (top-right), or, on newer versions, open Tampermonkey's **Details** and turn on **Allow User Scripts**.
3. Click **[Install the latest version](https://github.com/GuerraSa/googlephotos-toolkit/releases/latest/download/googlephotos-toolkit.user.js)**, then press **Install** in Tampermonkey.
4. Open [photos.google.com](https://photos.google.com) and reload the page.

Tampermonkey checks this repo's latest release for updates on its own.

**Upgrading from the separate scripts?** Disable or delete the old "Google Photos Toolkit" and "GP Duplicate Finder" scripts in Tampermonkey. This one replaces both.

## How to use

The toolkit adds a button to the Google Photos top bar that opens its window. The basic flow is always:
**Source** (where to look) → **Filters** (what to match) → **Action** (what to do) → run.

Tick **Dry run** to see how many items match, and which ones, without changing anything. Real runs ask you to confirm after showing the exact item count.

### Find space-consuming media
1. Source: **Library**.
2. Filters → **Space**: choose **Consuming**. This matches items that count against your storage (original quality, not "Storage saver").
3. Optionally, Filters → **Size**: set a minimum in bytes (100 MB = `104857600`).
4. Tick **Sort by size** (at the bottom of the filters), then pick an action, such as *Add to new album* (to review them) or *Move to trash*.

### Find media not in any album
1. Source: **Library**.
2. Filters → **Exclude Albums**: press the refresh icon, then **All**.
3. Action: **Add to new album** (for example "No album") to see them all in one place.

Albums you create later aren't included until you refresh and press **All** again.

### Find duplicates and similar photos
1. Click the blue **Find duplicates** button in the bottom-right corner.
2. Choose what to scan (whole library or one album, photos and/or videos) and how to match:
   - **Same name + size**: exact copies (for example uploaded twice).
   - **Same moment**: taken in the same second with the same shape (burst shots, edited copies).
   - **Look-alike**: visually similar. Set **strictness** to strict / normal / loose.
3. Press **Scan**. The first look-alike scan downloads a tiny thumbnail of every photo, so it's slow on big libraries. Later scans are fast.
4. For each group, choose which copy to **keep** (the sharpest and largest one is pre-selected), then **Duplicates: keep selected** or **Not duplicates**. Your decisions are remembered between visits.
5. Press **Move N to trash**. Optional extras:
   - *Add kept photo to the albums of removed copies* (on by default), so albums don't lose photos. This covers your own albums only, not shared albums.
   - *Give kept photo the oldest date taken*.
6. **Download log** saves a CSV of what was kept and what was removed.

### Delete everything in your library
1. Source: **Library**, no filters.
2. Action: **Move to trash**. Run it with **Dry run** first to check the count, then run it for real and confirm.
3. To free the storage right away, empty the Trash in Google Photos. Otherwise Google empties it after 60 days.

Shared albums, partner-shared items and the Locked Folder are separate sources. They aren't affected by a Library run.

## Notes

- Everything runs in your browser using your own Google session. Nothing is sent anywhere else.
- Google Photos has no public API for this, so the script uses the same internal requests the website itself makes. If Google changes those, parts of the script may stop working until it's updated.
- Very large libraries (tens of thousands of items) take a while to read. Keep the tab open and in the foreground.

## Development

`node test.js` checks the date-from-filename parser and the duplicate finder's trash list. Run it before each release.

## Credits & license

- Original toolkit: [xob0t/Google-Photos-Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) © 2024 xob0t.
- Patches and duplicate finder: GuerraSa.

MIT licensed. See [LICENSE](LICENSE).
