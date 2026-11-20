// ==UserScript==
// @name        Google Photos Toolkit (patched)
// @description Bulk organize your media: find space hogs, items not in albums, duplicates, bulk delete. Patched GPTK 3.3.0 + duplicate finder.
// @version     3.4.1
// @author      xob0t (original); GuerraSa (patches, duplicate finder)
// @homepageURL https://github.com/GuerraSa/googlephotos-toolkit#readme
// @supportURL  https://github.com/GuerraSa/googlephotos-toolkit/issues
// @downloadURL https://github.com/GuerraSa/googlephotos-toolkit/releases/latest/download/googlephotos-toolkit.user.js
// @updateURL   https://github.com/GuerraSa/googlephotos-toolkit/releases/latest/download/googlephotos-toolkit.user.js
// @match       *://photos.google.com/*
// @license     MIT
// @namespace   https://github.com/GuerraSa/googlephotos-toolkit
// @icon        https://raw.githubusercontent.com/xob0t/Google-Photos-Toolkit/main/media/icon.png
// @run-at      body
// @grant       GM_registerMenuCommand
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// @connect     googleusercontent.com
// @noframes
// ==/UserScript==
//
// 3.4.1
//  - FIX: Duplicate Finder trashed every copy of a confirmed group when its last "Keep" was un-ticked.
//  - FIX: a failed album read during "Exclude Albums" returned a partial list, so album photos could be acted on
//         (e.g. trashed). Any failed page read now stops the run instead.
//  - FIX: Duplicate Finder's "Move to trash" stayed clickable during a second scan and could trash the wrong photos.
//  - FIX: Duplicate Finder skipped "add kept photo to albums" silently if the album list failed or was still loading.
//  - REMOVED: the Similarity filter. With Move to Trash it trashed originals too; use the Duplicate Finder.
//  - Duplicate Finder look-alike comparison yields to the page, so big libraries don't freeze the tab.
//
// 3.4.0
//  - NEW: Duplicate Finder merged in ("Find duplicates" button, bottom-right). No separate script needed.
//  - Auto-updates from the GitHub releases of GuerraSa/googlephotos-toolkit (not from upstream GPTK).
//
// PATCH NOTES (vs 3.3.0)
//  - FIX: with source Trash or Locked, every action was silently turned into Restore / Unlock
//         (e.g. "Export Metadata" from Trash restored everything). Actions are now allow-listed per source.
//  - FIX: one failed API request rejected Promise.race/Promise.all and aborted the whole bulk operation.
//  - FIX: "Date from Name" used the browser's time zone instead of each photo's own offset.
//  - FIX: date-from-filename parser dropped minutes when the hour was 00, ignored HHMMSS after
//         YYYY-MM-DD, ignored Pixel-style times with milliseconds, and rejected times in DST gaps.
//  - FIX: library scan could loop forever on an empty page response.
//  - FIX: "Favorite: Yes" / "Archived: Yes" matched items with unknown status.
//  - FIX: items with no ownership data were treated as "not owned".
//  - FIX: crash in getItemInfoExt when field 12 is missing.
//  - FIX: CSV export always reported hasLocation=true and exported raw micro-degree coordinates.
//  - FIX: CSV export is protected against spreadsheet formula injection, and opens correctly in Excel (UTF-8 BOM).
//  - FIX: preserve-order re-sorted every pre-existing album item (one request each); now only new items move.
//  - FIX: refreshing albums during a running task cleared the "running" flag.
//  - FIX: Trusted Types 'default' policy creation could throw and stop the UI from loading.
//  - FIX: hidden filters were re-shown with display:block, breaking radio-button layout.
//  - UI: "Choose Action" bar stays pinned on top; long filter descriptions collapse to 2 lines with Show more / Show less.
//  - NEW: Media Key filter (regex, include/exclude); paste several keys joined with | to match exactly those items.
//  - NEW: Dry run checkbox: find and list matching items without changing anything.
//  - NEW: Confirmation now happens AFTER matching and shows the exact item count.
//  - NEW: Toolbar button re-inserts itself if Google re-renders the toolbar.
//  - NEW: Esc closes the window; filter preview updates while typing; log is capped at 3000 lines.
//  - PERF: albums / shared links are fetched one at a time to avoid rate limits; retries use
//          exponential backoff with jitter and do not retry on permanent 4xx errors.
(function () {
  'use strict';

  const GPTK_VERSION = '3.3.0-patch.3';
  const HOMEPAGE = 'https://github.com/xob0t/Google-Photos-Toolkit#readme';

  var gptkMainTemplate = (`
<div class="overlay"></div>
<div id="gptk" class="container">

  <!-- ── HEADER ─────────────────────────────────── -->
  <div class="header">
    <div class="header-info">
      <div class="header-icon">
        <svg width="18" height="18" viewBox="0 0 17 17" fill="currentColor">
          <path d="M6.838,11.784 L12.744,5.879 C13.916,6.484 15.311,6.372 16.207,5.477 C16.897,4.786 17.131,3.795 16.923,2.839 L15.401,4.358 L14.045,4.624 L12.404,2.999 L12.686,1.603 L14.195,0.113 C13.24,-0.095 12.248,0.136 11.557,0.827 C10.661,1.723 10.549,3.117 11.155,4.291 L5.249,10.197 C4.076,9.592 2.681,9.705 1.784,10.599 C1.096,11.29 0.862,12.281 1.069,13.236 L2.592,11.717 L3.947,11.452 L5.59,13.077 L5.306,14.473 L3.797,15.963 C4.752,16.17 5.744,15.94 6.434,15.249 C7.33,14.354 7.443,12.958 6.838,11.784 Z"></path>
        </svg>
      </div>
      <div class="header-text">GPTK</div>
    </div>
    <div class="header-steps">
      <span class="step-badge">1</span> Source
      <span class="step-arrow">&rarr;</span>
      <span class="step-badge">2</span> Filter
      <span class="step-arrow">&rarr;</span>
      <span class="step-badge">3</span> Action
    </div>
    <div id="hide" title="Hide (Esc)">
      <svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 -960 960 960" width="18"><path d="M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z"/></svg>
    </div>
  </div>

  <!-- ── BODY: LEFT PANEL (Source + Filters) | RIGHT PANEL (Actions + Log) ── -->
  <div class="window-body">

    <!-- ─── LEFT: Source → Filters ────────────── -->
    <div class="sidebar scroll">

      <!-- STEP 1: Source -->
      <div class="panel-section">
        <div class="section-label"><span class="step-badge">1</span> Select Source</div>
        <div class="sources">
          <div class="source">
            <input type="radio" name="source" id="library" class="sourceHeaderInput" checked="checked">
            <label class="sourceHeader" for="library">
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zm-5-7l-3 3.72L9 13l-3 4h12l-4-5z"></path></svg>
              Library
            </label>
          </div>
          <div class="source">
            <input type="radio" name="source" id="search" class="sourceHeaderInput">
            <label class="sourceHeader" for="search">
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M20.49 19l-5.73-5.73C15.53 12.2 16 10.91 16 9.5A6.5 6.5 0 1 0 9.5 16c1.41 0 2.7-.47 3.77-1.24L19 20.49 20.49 19zM5 9.5C5 7.01 7.01 5 9.5 5S14 7.01 14 9.5 11.99 14 9.5 14 5 11.99 5 9.5z"></path></svg>
              Search
            </label>
          </div>
          <div class="source">
            <input type="radio" name="source" id="albums" class="sourceHeaderInput">
            <label class="sourceHeader" for="albums">
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 18H6V4h6v7l2.5-1.88L17 11V4h1v16zm-4.33-6L17 18H7l2.5-3.2 1.67 2.18 2.5-2.98z"></path></svg>
              Albums
            </label>
          </div>
          <div class="source">
            <input type="radio" name="source" id="sharedLinks" class="sourceHeaderInput">
            <label class="sourceHeader" for="sharedLinks">
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M17 7h-4v2h4c1.65 0 3 1.35 3 3s-1.35 3-3 3h-4v2h4c2.76 0 5-2.24 5-5s-2.24-5-5-5zm-6 8H7c-1.65 0-3-1.35-3-3s1.35-3 3-3h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-2zm-3-4h8v2H8z"></path></svg>
              Shared
            </label>
          </div>
          <div class="source">
            <input type="radio" name="source" id="favorites" class="sourceHeaderInput">
            <label class="sourceHeader" for="favorites">
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"></path></svg>
              Favorites
            </label>
          </div>
          <div class="source">
            <input type="radio" name="source" id="trash" class="sourceHeaderInput">
            <label class="sourceHeader" for="trash">
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M15 4V3H9v1H4v2h1v13c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V6h1V4h-5zm2 15H7V6h10v13zM9 8h2v9H9zm4 0h2v9h-2z"></path></svg>
              Trash
            </label>
          </div>
          <div class="source">
            <input type="radio" name="source" id="lockedFolder" class="sourceHeaderInput">
            <label class="sourceHeader" for="lockedFolder">
              <svg width="16" height="16" viewBox="0 0 24 24"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z"></path></svg>
              Locked
            </label>
          </div>
        </div>
      </div>

      <!-- STEP 2: Filters -->
      <div class="panel-section">
        <div class="section-label">
          <span class="step-badge">2</span> Filters
          <div class="flex centered" title="Reset all filters" id="filterResetButton">
            <svg xmlns="http://www.w3.org/2000/svg" height="14" viewBox="0 -960 960 960" width="14"><path d="M440-122q-121-15-200.5-105.5T160-440q0-66 26-126.5T260-672l57 57q-38 34-57.5 79T240-440q0 88 56 155.5T440-202v80Zm80 0v-80q87-16 143.5-83T720-440q0-100-70-170t-170-70h-3l44 44-56 56-140-140 140-140 56 56-44 44h3q134 0 227 93t93 227q0 121-79.5 211.5T520-122Z"/></svg>
            Reset
          </div>
        </div>
      </div>

      <form class="filters-form">
        <details open class="include-albums">
          <summary>Select Albums</summary>
          <fieldset>
            <select size="5" multiple="multiple" class="select-multiple albums-select scroll" name="albumsInclude" required>
              <option value="" title="First Album">Press Refresh</option>
            </select>
            <div class="select-control-buttons-row">
              <div class="refresh-albums svg-container" title="Refresh Albums">
                <svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20"><path d="M482-160q-134 0-228-93t-94-227v-7l-64 64-56-56 160-160 160 160-56 56-64-64v7q0 100 70.5 170T482-240q26 0 51-6t49-18l60 60q-38 22-78 33t-82 11Zm278-161L600-481l56-56 64 64v-7q0-100-70.5-170T478-720q-26 0-51 6t-49 18l-60-60q38-22 78-33t82-11q134 0 228 93t94 227v7l64-64 56 56-160 160Z"></path></svg>
              </div>
              <button type="button" name="selectAll">All</button>
              <button type="button" name="resetAlbumSelection">Reset</button>
            </div>
            <div class="select-control-buttons-row">
              <button type="button" name="selectShared">Shared</button>
              <button type="button" name="selectNonShared">Non-Shared</button>
            </div>
          </fieldset>
        </details>

        <details open class="search">
          <summary>Search</summary>
          <fieldset>
            <label class="form-control">
              <legend>Search Query:</legend>
              <input name="searchQuery" value="" type="input" placeholder="Enter search query..." required>
            </label>
          </fieldset>
        </details>

        <details class="exclude-albums"><summary>Exclude Albums</summary><fieldset>
          <select size="5" multiple="multiple" class="select-multiple albums-select scroll" name="albumsExclude"><option value="" title="First Album">Press Refresh</option></select>
          <div class="select-control-buttons-row">
            <div class="refresh-albums svg-container" title="Refresh Albums"><svg xmlns="http://www.w3.org/2000/svg" height="20" viewBox="0 -960 960 960" width="20"><path d="M482-160q-134 0-228-93t-94-227v-7l-64 64-56-56 160-160 160 160-56 56-64-64v7q0 100 70.5 170T482-240q26 0 51-6t49-18l60 60q-38 22-78 33t-82 11Zm278-161L600-481l56-56 64 64v-7q0-100-70.5-170T478-720q-26 0-51 6t-49 18l-60-60q38-22 78-33t82-11q134 0 228 93t94 227v7l64-64 56 56-160 160Z"></path></svg></div>
            <button type="button" name="selectAll">All</button>
            <button type="button" name="resetAlbumSelection">Reset</button>
          </div>
          <div class="select-control-buttons-row">
            <button type="button" name="selectShared">Shared</button>
            <button type="button" name="selectNonShared">Non-Shared</button>
          </div>
        </fieldset></details>

        <details class="date-interval"><summary>Date Interval</summary><fieldset>
          <legend>From:</legend>
          <div class="flex centered input-wrapper">
            <input type="datetime-local" name="lowerBoundaryDate">
            <div class="date-reset flex centered" title="Reset Input" name="dateReset"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><path d="M 13.7851 49.5742 L 42.2382 49.5742 C 47.1366 49.5742 49.5743 47.1367 49.5743 42.3086 L 49.5743 13.6914 C 49.5743 8.8633 47.1366 6.4258 42.2382 6.4258 L 13.7851 6.4258 C 8.9101 6.4258 6.4257 8.8398 6.4257 13.6914 L 6.4257 42.3086 C 6.4257 47.1602 8.9101 49.5742 13.7851 49.5742 Z M 19.6913 38.3711 C 18.5429 38.3711 17.5820 37.4336 17.5820 36.2852 C 17.5820 35.7461 17.8163 35.2305 18.2382 34.8086 L 25.0351 27.9649 L 18.2382 21.1445 C 17.8163 20.7227 17.5820 20.2071 17.5820 19.6680 C 17.5820 18.4961 18.5429 17.5352 19.6913 17.5352 C 20.2539 17.5352 20.7460 17.7461 21.1679 18.1680 L 28.0117 25.0118 L 34.8554 18.1680 C 35.2539 17.7461 35.7695 17.5352 36.3085 17.5352 C 37.4804 17.5352 38.4413 18.4961 38.4413 19.6680 C 38.4413 20.2071 38.2070 20.7227 37.7851 21.1445 L 30.9648 27.9649 L 37.7851 34.8086 C 38.2070 35.2305 38.4413 35.7461 38.4413 36.2852 C 38.4413 37.4336 37.4804 38.3711 36.3085 38.3711 C 35.7695 38.3711 35.2539 38.1602 34.8788 37.7852 L 28.0117 30.8945 L 21.1444 37.7852 C 20.7460 38.1602 20.2773 38.3711 19.6913 38.3711 Z"/></svg></div>
          </div>
          <legend>To:</legend>
          <div class="flex centered input-wrapper">
            <input type="datetime-local" name="higherBoundaryDate">
            <div class="date-reset flex centered" title="Reset Input" name="dateReset"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><path d="M 13.7851 49.5742 L 42.2382 49.5742 C 47.1366 49.5742 49.5743 47.1367 49.5743 42.3086 L 49.5743 13.6914 C 49.5743 8.8633 47.1366 6.4258 42.2382 6.4258 L 13.7851 6.4258 C 8.9101 6.4258 6.4257 8.8398 6.4257 13.6914 L 6.4257 42.3086 C 6.4257 47.1602 8.9101 49.5742 13.7851 49.5742 Z M 19.6913 38.3711 C 18.5429 38.3711 17.5820 37.4336 17.5820 36.2852 C 17.5820 35.7461 17.8163 35.2305 18.2382 34.8086 L 25.0351 27.9649 L 18.2382 21.1445 C 17.8163 20.7227 17.5820 20.2071 17.5820 19.6680 C 17.5820 18.4961 18.5429 17.5352 19.6913 17.5352 C 20.2539 17.5352 20.7460 17.7461 21.1679 18.1680 L 28.0117 25.0118 L 34.8554 18.1680 C 35.2539 17.7461 35.7695 17.5352 36.3085 17.5352 C 37.4804 17.5352 38.4413 18.4961 38.4413 19.6680 C 38.4413 20.2071 38.2070 20.7227 37.7851 21.1445 L 30.9648 27.9649 L 37.7851 34.8086 C 38.2070 35.2305 38.4413 35.7461 38.4413 36.2852 C 38.4413 37.4336 37.4804 38.3711 36.3085 38.3711 C 35.7695 38.3711 35.2539 38.1602 34.8788 37.7852 L 28.0117 30.8945 L 21.1444 37.7852 C 20.7460 38.1602 20.2773 38.3711 19.6913 38.3711 Z"/></svg></div>
          </div>
          <hr>
          <div class="radio-group">
            <label class="form-control"><input name="intervalType" type="radio" value="include" checked="checked"><span>Include</span></label>
            <label class="form-control"><input name="intervalType" type="radio" value="exclude"><span>Exclude</span></label>
          </div>
          <hr>
          <div class="radio-group">
            <label class="form-control"><input name="dateType" type="radio" value="taken" checked="checked"><span>Date Taken</span></label>
            <label class="form-control"><input name="dateType" type="radio" value="uploaded"><span>Date Uploaded</span></label>
          </div>
        </fieldset></details>

        <details class="mediakey"><summary>Media Key</summary><fieldset>
          <label class="form-control"><legend>Regex:</legend><input name="mediaKeyRegex" value="" type="input" placeholder="e.g. ^AF1Qip|key1|key2"></label>
          <span class="filter-note">Tip: paste several keys separated by | to match exactly those items.</span>
          <div class="radio-group">
            <label class="form-control"><input name="mediaKeyMatchType" value="include" type="radio" checked="checked"> Include</label>
            <label class="form-control"><input name="mediaKeyMatchType" value="exclude" type="radio"> Exclude</label>
          </div>
        </fieldset></details>

        <details class="filename"><summary>Filename</summary><fieldset>
          <label class="form-control"><legend>Regex:</legend><input name="fileNameRegex" value="" type="input" placeholder="e.g. \\.png$"></label>
          <div class="radio-group">
            <label class="form-control"><input name="fileNameMatchType" value="include" type="radio" checked="checked"> Include</label>
            <label class="form-control"><input name="fileNameMatchType" value="exclude" type="radio"> Exclude</label>
          </div>
        </fieldset></details>

        <details class="description"><summary>Description</summary><fieldset>
          <label class="form-control"><legend>Regex:</legend><input name="descriptionRegex" value="" type="input" placeholder="e.g. vacation"></label>
          <div class="radio-group">
            <label class="form-control"><input name="descriptionMatchType" value="include" type="radio" checked="checked"> Include</label>
            <label class="form-control"><input name="descriptionMatchType" value="exclude" type="radio"> Exclude</label>
          </div>
        </fieldset></details>

        <details class="space"><summary>Space</summary><fieldset><div class="radio-group">
          <label class="form-control"><input name="space" value="" type="radio" checked="checked"> Any</label>
          <label class="form-control"><input name="space" value="consuming" type="radio"> Consuming</label>
          <label class="form-control"><input name="space" value="non-consuming" type="radio"> Non-Consuming</label>
        </div></fieldset></details>

        <details class="size"><summary>Size</summary><fieldset>
          <legend>More Than</legend><div class="input-wrapper"><input name="lowerBoundarySize" type="number" placeholder="Bytes"></div>
          <legend>Less Than</legend><div class="input-wrapper"><input name="higherBoundarySize" type="number" placeholder="Bytes"></div>
        </fieldset></details>

        <details class="resolution"><summary>Resolution</summary><fieldset>
          <legend>Min Width</legend><div class="input-wrapper"><input name="minWidth" type="number" placeholder="Pixels"></div>
          <legend>Max Width</legend><div class="input-wrapper"><input name="maxWidth" type="number" placeholder="Pixels"></div>
          <legend>Min Height</legend><div class="input-wrapper"><input name="minHeight" type="number" placeholder="Pixels"></div>
          <legend>Max Height</legend><div class="input-wrapper"><input name="maxHeight" type="number" placeholder="Pixels"></div>
        </fieldset></details>

        <details class="duration"><summary>Duration</summary><fieldset>
          <legend>Min Duration</legend><div class="input-wrapper"><input name="minDuration" type="number" min="0" step="0.1" placeholder="Seconds"></div>
          <legend>Max Duration</legend><div class="input-wrapper"><input name="maxDuration" type="number" min="0" step="0.1" placeholder="Seconds"></div>
        </fieldset></details>

        <details class="quality"><summary>Quality</summary><fieldset><div class="radio-group">
          <label class="form-control"><input name="quality" value="" type="radio" checked="checked"> Any</label>
          <label class="form-control"><input name="quality" value="original" type="radio"> Original</label>
          <label class="form-control"><input name="quality" value="storage-saver" type="radio"> Storage Saver</label>
        </div></fieldset></details>

        <details class="type"><summary>Type</summary><fieldset><div class="radio-group">
          <label class="form-control"><input name="type" value="" type="radio" checked="checked"> Any</label>
          <label class="form-control"><input name="type" value="image" type="radio"> Image</label>
          <label class="form-control"><input name="type" value="video" type="radio"> Video</label>
          <label class="form-control"><input name="type" value="live" type="radio"> Live Photo</label>
        </div></fieldset></details>

        <details class="upload-status"><summary>Upload Status</summary><fieldset><div class="radio-group">
          <label class="form-control"><input name="uploadStatus" value="" type="radio" checked="checked"> Any</label>
          <label class="form-control"><input name="uploadStatus" value="full" type="radio"> Full</label>
          <label class="form-control"><input name="uploadStatus" value="partial" type="radio"> Partial</label>
        </div></fieldset></details>

        <details class="archive"><summary>Archived</summary><fieldset><div class="radio-group">
          <label class="form-control"><input name="archived" value="" type="radio" checked="checked"> Any</label>
          <label class="form-control"><input name="archived" value="true" type="radio"> Yes</label>
          <label class="form-control"><input name="archived" value="false" type="radio"> No</label>
        </div></fieldset></details>

        <details class="owned"><summary>Ownership</summary><fieldset><div class="radio-group">
          <label class="form-control"><input name="owned" value="" type="radio" checked="checked"> Any</label>
          <label class="form-control"><input name="owned" value="true" type="radio"> Owned</label>
          <label class="form-control"><input name="owned" value="false" type="radio"> Not Owned</label>
        </div></fieldset></details>

        <details class="location"><summary>Location</summary><fieldset><div class="radio-group">
          <label class="form-control"><input name="hasLocation" value="" type="radio" checked="checked"> Any</label>
          <label class="form-control"><input name="hasLocation" value="true" type="radio"> Has Location</label>
          <label class="form-control"><input name="hasLocation" value="false" type="radio"> No Location</label>
        </div></fieldset>
        <fieldset>
          <legend>Bounding Box (optional)</legend>
          <span class="filter-note">Only items within this area are kept. Use decimal degrees (e.g. 48.85 for Paris).</span>
          <legend>South Latitude</legend><div class="input-wrapper"><input name="boundSouth" type="number" placeholder="-90 to 90" step="any" min="-90" max="90"></div>
          <legend>West Longitude</legend><div class="input-wrapper"><input name="boundWest" type="number" placeholder="-180 to 180" step="any" min="-180" max="180"></div>
          <legend>North Latitude</legend><div class="input-wrapper"><input name="boundNorth" type="number" placeholder="-90 to 90" step="any" min="-90" max="90"></div>
          <legend>East Longitude</legend><div class="input-wrapper"><input name="boundEast" type="number" placeholder="-180 to 180" step="any" min="-180" max="180"></div>
        </fieldset></details>

        <details class="favorite"><summary>Favorite</summary><fieldset><div class="radio-group">
          <label class="form-control"><input name="favorite" value="" type="radio" checked="checked"> Any</label>
          <label class="form-control"><input name="favorite" value="true" type="radio"> Yes</label>
          <label class="form-control"><input name="favorite" value="false" type="radio"> No</label>
        </div></fieldset></details>

        <hr>
        <fieldset class="exclude-shared"><label class="form-control checkbox-control"><input name="excludeShared" value="true" type="checkbox"><span>Exclude Shared Links</span></label></fieldset>
        <fieldset class="exclude-favorites"><label class="form-control checkbox-control"><input name="excludeFavorites" value="true" type="checkbox"><span>Exclude Favorites</span></label></fieldset>
        <fieldset class="sort-by-size"><label class="form-control checkbox-control"><input name="sortBySize" value="true" type="checkbox"><span>Sort by size</span></label></fieldset>
      </form>

      <form class="settings-form">
        <details class="settings"><summary>Advanced Settings</summary><fieldset>
          <legend>Max Concurrent Per-Item Requests</legend><div class="input-wrapper"><input name="maxConcurrentSingleApiReq" value="3" min="1" type="number" required></div>
          <legend>Max Concurrent Bulk Requests</legend><div class="input-wrapper"><input name="maxConcurrentBatchApiReq" value="3" min="1" type="number" required></div>
          <legend>API Operation Batch Size</legend><div class="input-wrapper"><input name="operationSize" value="250" max="500" min="1" type="number" required></div>
          <legend>Locked Folder API Operation Size</legend><div class="input-wrapper"><input name="lockedFolderOpSize" value="100" max="100" min="1" type="number" required></div>
          <legend>Bulk Info API Batch Size</legend><div class="input-wrapper"><input name="infoSize" value="5000" max="10000" min="1" type="number" required></div>
          <div class="settings-controls">
            <button name="save" type="submit" class="btn-primary">Save</button>
            <button name="default" type="button">Default</button>
          </div>
        </fieldset></details>
      </form>
    </div>

    <!-- ─── RIGHT: Actions + Log ─────────────── -->
    <div class="main">

      <!-- STEP 3: Actions -->
      <div class="action-bar">
        <div class="section-label"><span class="step-badge">3</span> Choose Action
          <label class="dry-run-toggle" title="Find and list matching items without changing anything"><input type="checkbox" id="dryRun"><span>Dry run</span></label>
        </div>
        <div class="action-buttons">
          <button id="showExistingAlbumForm" type="button" title="Add To Existing Album">Add to Album</button>
          <button id="showNewAlbumForm" type="button" title="Add To New Album">New Album</button>
          <button type="button" id="removeFromAlbum" title="Remove items from their album (Albums source only)">Remove from Album</button>
          <button type="button" id="toTrash" title="Move To Trash">Trash</button>
          <button type="button" id="restoreTrash" title="Restore From Trash">Restore</button>
          <button type="button" id="toArchive" title="Archive">Archive</button>
          <button type="button" id="unArchive" title="Remove From Archive">Un-Archive</button>
          <button type="button" id="toFavorite" title="Set Favorite">Favorite</button>
          <button type="button" id="unFavorite" title="Remove From Favorites">Un-Favorite</button>
          <button type="button" id="lock" title="Move to Locked Folder">Lock</button>
          <button type="button" id="unLock" title="Move out of Locked Folder">Unlock</button>
          <button type="button" id="copyDescFromOther" title="Copy captions from EXIF to description">Copy EXIF Desc</button>
          <button type="button" id="setDateFromFilename" title="Set photo date from filename (like exiftool)">Date from Name</button>
          <button type="button" id="exportMetadata" title="Download metadata as a CSV file">Export Metadata</button>
        </div>
        <div class="to-existing-container">
          <form id="toExistingAlbum" class="album-form" title="Add To Existing Album">
            <div class="refresh-albums svg-container" title="Refresh Albums"><svg xmlns="http://www.w3.org/2000/svg" height="22" viewBox="0 -960 960 960" width="22"><path d="M482-160q-134 0-228-93t-94-227v-7l-64 64-56-56 160-160 160 160-56 56-64-64v7q0 100 70.5 170T482-240q26 0 51-6t49-18l60 60q-38 22-78 33t-82 11Zm278-161L600-481l56-56 64 64v-7q0-100-70.5-170T478-720q-26 0-51 6t-49 18l-60-60q38-22 78-33t82-11q134 0 228 93t94 227v7l64-64 56 56-160 160Z"/></svg></div>
            <select id="existingAlbum" class="dropdown albums-select" name="targetAlbumMediaKeyExisting" required><option value="">Press Refresh</option></select>
            <button type="submit" class="btn-primary">Add</button>
          </form>
          <button type="button" class="return" title="Back to Actions">&larr; Back</button>
        </div>
        <div class="to-new-container">
          <form id="toNewAlbum" class="album-form" title="Add To A New Album">
            <input id="newAlbumName" type="text" placeholder="Album name..." required>
            <button type="submit" class="btn-primary">Create</button>
          </form>
          <button type="button" class="return" title="Back to Actions">&larr; Back</button>
        </div>
      </div>

      <!-- Filter preview + Log -->
      <div class="filter-preview" title="Filter Preview">
        <span class="fp-text">Filter: None</span>
        <button type="button" class="fp-toggle">Show more</button>
      </div>
      <div class="button-container">
        <button id="stopProcess" type="button">Stop</button>
        <button id="clearLog" type="button">Clear Log</button>
      </div>
      <div id="logArea" class="logarea scroll"></div>
    </div>
  </div>

  <!-- ── FOOTER ─────────────────────────────────── -->
  <div class="footer">
    <div class="info-container"><a class="homepage-link" href="%homepage%" target="_blank" rel="noopener">%version%</a></div>
    <div class="auto-scroll-container">
      <label for="autoScroll"><input type="checkbox" id="autoScroll" checked="checked"><span>Auto-scroll</span></label>
    </div>
  </div>
</div>

`);

  var buttonHtml = (`
<div
  id="gptk-button"
  role="button"
  class="U26fgb JRtysb WzwrXb YI2CVc G6iPcb"
  aria-label="GPTK"
  aria-disabled="false"
  tabindex="0"
  data-tooltip="Google Photos Toolkit"
  aria-haspopup="true"
  aria-expanded="false"
  data-dynamic="true"
  data-alignright="true"
  data-aligntop="true"
  data-tooltip-vertical-offset="-12"
  data-tooltip-horizontal-offset="0"
  style="transition: opacity 0.15s ease;"
>
  <div class="NWlf3e MbhUzd" jsname="ksKsZd"></div>
  <span jsslot="" class="MhXXcc oJeWuf"
    ><span class="Lw7GHd snByac">
      <svg width="24px" height="24px" viewBox="0 0 17 17" style="fill: #1a9fff">
        <g xmlns="http://www.w3.org/2000/svg" stroke-width="1">
          <path
            d="M6.838,11.784 L12.744,5.879 C13.916,6.484 15.311,6.372 16.207,5.477 C16.897,4.786 17.131,3.795 16.923,2.839 L15.401,4.358 L14.045,4.624 L12.404,2.999 L12.686,1.603 L14.195,0.113 C13.24,-0.095 12.248,0.136 11.557,0.827 C10.661,1.723 10.549,3.117 11.155,4.291 L5.249,10.197 C4.076,9.592 2.681,9.705 1.784,10.599 C1.096,11.29 0.862,12.281 1.069,13.236 L2.592,11.717 L3.947,11.452 L5.59,13.077 L5.306,14.473 L3.797,15.963 C4.752,16.17 5.744,15.94 6.434,15.249 C7.33,14.354 7.443,12.958 6.838,11.784 L6.838,11.784 Z"
          ></path>
        </g>
      </svg>
      <div class="oK50pe eLNT1d" aria-hidden="true" jsname="JjzL4d"></div></span
  ></span>
</div>

`);

  var css = (`
:root {
    --accent: #3b82f6; --accent-hover: #60a5fa; --accent-muted: rgba(59, 130, 246, 0.15); --accent-glow: rgba(59, 130, 246, 0.25); --bg-base: #0c0c0e; --bg-raised: #111114; --bg-overlay: #161619; --bg-surface: #1c1c20; --bg-surface-hover: #242429; --bg-surface-active: #2a2a30; --border-subtle: rgba(255, 255, 255, 0.06); --border-default: rgba(255, 255, 255, 0.09); --border-strong: rgba(255, 255, 255, 0.14); --text-primary: #e4e4e8; --text-secondary: #9a9aa5; --text-tertiary: #65656f; --text-disabled: #45454d; --danger: #ef4444; --danger-muted: rgba(239, 68, 68, 0.12); --danger-hover: #f87171; --success: #34d399; --warning-text: #fbbf24; --overlay-filter: blur(12px) brightness(0.3) saturate(0.8); --radius-xs: 4px; --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px; --radius-xl: 16px; --ease: cubic-bezier(0.4, 0, 0.2, 1); --duration-fast: 0.12s; --duration: 0.2s; --shadow-panel: 0 24px 80px rgba(0, 0, 0, 0.6),
                     0 0 0 1px var(--border-subtle); }
.overlay { position: fixed; display: none; left: 0; top: 0; width: 100%; height: 100%; z-index: 499; backdrop-filter: var(--overlay-filter); -webkit-backdrop-filter: var(--overlay-filter); transition: opacity var(--duration) var(--ease); }
@media only screen and (min-width: 700px) { .window-body { display: grid; grid-template-columns: 300px 1fr; }
}
@media only screen and (max-width: 700px) { .window-body { display: flex; flex-direction: column; }
    #gptk { top: 0% !important; bottom: 0% !important; width: 100% !important; border-radius: 0 !important; .header-steps { display: none; }
        .sidebar { flex: 1 1 0; min-height: 0; border-right: none; }
        .main { flex: 0 0 auto; height: auto !important; max-height: 40vh !important; border-top: 1px solid var(--border-subtle); }
        #logArea { max-height: 20vh; }
    }
}
#gptk { position: fixed; top: 4%; left: 50%; transform: translateX(-50%); width: 92%; bottom: 4%; min-height: 300px; max-width: 1280px; min-width: 300px; z-index: 500; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif; font-size: 13px; line-height: 1.4; padding: 0; display: none; flex-direction: column; cursor: default; border-radius: var(--radius-xl); color-scheme: dark; background-color: var(--bg-base); color: var(--text-primary); border: 1px solid var(--border-subtle); box-shadow: var(--shadow-panel); box-sizing: border-box; overflow: hidden; * { box-sizing: border-box; }
    .flex { display: flex; }
    .centered { align-items: center; }
    .grid { display: grid; }
    .columns { gap: 1px; margin-bottom: 1px; grid-auto-flow: column; }
    hr { border: none; margin: 0; width: 100%; border-bottom: 1px solid var(--border-subtle); }
    button { background-color: var(--bg-surface); color: var(--text-primary); cursor: pointer; border: 1px solid var(--border-default); align-items: center; display: inline-flex; gap: 5px; padding: 0 10px; border-radius: var(--radius-sm); height: 28px; font-size: 11.5px; font-weight: 500; letter-spacing: 0.02em; text-transform: uppercase; white-space: nowrap; transition: all var(--duration-fast) var(--ease); font-family: inherit; svg { flex-shrink: 0; fill: currentColor; }
    }
    button:not(:disabled):not(.not-applicable):hover { background-color: var(--bg-surface-hover); border-color: var(--border-strong); }
    button:not(:disabled):not(.not-applicable):active { background-color: var(--bg-surface-active); transform: scale(0.97); }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    button:disabled, button.not-applicable { background-color: var(--bg-raised); color: var(--text-disabled); border-color: transparent; cursor: not-allowed; opacity: 0.5; svg { opacity: 0.4; }
    }
    button.btn-primary { background-color: var(--accent); border-color: transparent; color: #fff; }
    button.btn-primary:not(:disabled):hover { background-color: var(--accent-hover); }
    legend, label { font-size: 12px; line-height: 16px; font-weight: 500; }
    input[type="text"],
    input[type="input"],
    input[type="number"],
    input[type="datetime-local"] { background-color: var(--bg-raised); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); padding: 5px 10px; font-size: 12.5px; font-family: inherit; height: 30px; transition: border-color var(--duration-fast) var(--ease),
                    box-shadow var(--duration-fast) var(--ease); width: 100%; }
    input[type="text"]:focus,
    input[type="input"]:focus,
    input[type="number"]:focus,
    input[type="datetime-local"]:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
    input[type="text"]::placeholder,
    input[type="input"]::placeholder,
    input[type="number"]::placeholder { color: var(--text-tertiary); }
    select { background-color: var(--bg-raised); color: var(--text-primary); border: 1px solid var(--border-default); border-radius: var(--radius-sm); font-size: 12px; font-family: inherit; transition: border-color var(--duration-fast) var(--ease); }
    select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-glow); }
    option.shared { background-color: rgba(59, 130, 246, 0.1); }
    option:checked { background-color: var(--accent); color: white; }
    .radio-group { display: flex; flex-wrap: wrap; gap: 2px 12px; padding: 2px 0; }
    .radio-group label,
    .checkbox-control { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; padding: 3px 0; font-size: 12px; color: var(--text-secondary); transition: color var(--duration-fast) var(--ease); }
    .radio-group label:hover,
    .checkbox-control:hover { color: var(--text-primary); }
    input[type="radio"],
    input[type="checkbox"] { accent-color: var(--accent); }
    .header { padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; background: linear-gradient(135deg, rgba(59, 130, 246, 0.06) 0%, transparent 50%); border-bottom: 1px solid var(--border-subtle); gap: 12px; flex-shrink: 0; .header-info { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
        .header-icon { color: var(--accent); display: flex; align-items: center; }
        .header-text { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; color: var(--text-primary); }
    }
    .header-steps { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase; color: var(--text-secondary); user-select: none; }
    .step-badge { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 50%; background-color: var(--accent); color: #fff; font-size: 11px; font-weight: 700; line-height: 1; flex-shrink: 0; }
    .step-arrow { color: var(--text-tertiary); font-size: 14px; font-weight: 400; }
    #hide { cursor: pointer; fill: var(--text-tertiary); display: flex; align-items: center; padding: 4px; border-radius: var(--radius-sm); transition: all var(--duration-fast) var(--ease); }
    #hide:hover { fill: var(--text-primary); background-color: var(--bg-surface-hover); }
    .panel-section { padding: 0; flex-shrink: 0; }
    .panel-section + .panel-section { border-top: 1px solid var(--border-subtle); padding-top: 2px; }
    .section-label { display: flex; align-items: center; gap: 8px; padding: 10px 4px 8px; font-size: 11.5px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-secondary); user-select: none; }
    .dry-run-toggle { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-size: 11px; font-weight: 600; color: var(--warning-text); text-transform: uppercase; letter-spacing: 0.03em; }
    .sources { gap: 3px; display: flex; flex-wrap: wrap; padding: 4px 0 8px; user-select: none; .sourceHeader { display: inline-flex; align-items: center; gap: 5px; fill: var(--text-tertiary); color: var(--text-secondary); cursor: pointer; font-weight: 600; font-size: 11.5px; letter-spacing: 0.03em; text-transform: uppercase; transition: all var(--duration) var(--ease); border-radius: var(--radius-md); padding: 6px 10px; svg { transition: fill var(--duration-fast) var(--ease); }
            span { line-height: 1; }
        }
        .source input { display: none; }
        input:disabled + .sourceHeader { cursor: not-allowed; color: var(--text-disabled); fill: var(--text-disabled); opacity: 0.4; }
        input:not(:disabled) + .sourceHeader:hover { fill: var(--text-primary); color: var(--text-primary); background-color: var(--bg-surface); }
        .source input:checked + .sourceHeader { background-color: var(--accent); fill: #fff; color: #fff; box-shadow: 0 2px 8px rgba(59, 130, 246, 0.35),
                        inset 0 1px 0 rgba(255, 255, 255, 0.1); }
    }
    .action-bar { display: flex; flex-direction: column; background-color: var(--bg-raised); user-select: none; border-bottom: 1px solid var(--border-subtle); min-height: 0; padding-top: 4px; .section-label { padding: 6px 12px 4px; }
        .action-buttons { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 12px 8px; align-items: flex-start; }
        .to-existing-container,
        .to-new-container { display: none; flex-wrap: wrap; gap: 6px; padding: 8px 12px; align-items: center; }
        .album-form { display: flex; gap: 6px; align-items: center; flex: 1; min-width: 0; }
        .album-form select { flex: 1; min-width: 120px; max-width: 400px; height: 30px; }
        .album-form input[type="text"] { flex: 1; min-width: 120px; max-width: 300px; }
        button.running { background-color: var(--accent); border-color: var(--accent); color: #fff; animation: pulse-running 2s infinite; opacity: 1; }
        svg { fill: currentColor; }
    }
    @keyframes pulse-running { 0%, 100% { opacity: 1; }
        50% { opacity: 0.7; }
    }
    .refresh-albums { cursor: pointer; fill: var(--text-secondary); background-color: var(--bg-surface); border-radius: var(--radius-sm); padding: 3px; border: 1px solid var(--border-default); transition: all var(--duration-fast) var(--ease); display: flex; justify-content: center; align-items: center; }
    .refresh-albums:hover { fill: var(--text-primary); background-color: var(--bg-surface-hover); }
    .svg-container { display: flex; justify-content: center; }
    .window-body { flex: 1 1 0; min-height: 0; overflow: hidden; }
    .sidebar { height: 100%; position: relative; display: flex; flex-direction: column; background-color: var(--bg-raised); overflow-y: auto; overflow-x: hidden; max-height: 100%; padding: 0 10px 10px 10px; border-right: 1px solid var(--border-subtle); form { width: 100%; }
        .filters-form { flex: 1 1 auto; }
        .settings-form { margin-bottom: 4px; flex-shrink: 0; summary { color: var(--text-tertiary); font-size: 12px; }
        }
        summary { font-size: 12.5px; font-weight: 600; line-height: 20px; position: relative; overflow: hidden; margin-bottom: 2px; padding: 7px 8px; cursor: pointer; white-space: nowrap; text-overflow: ellipsis; border-radius: var(--radius-sm); flex-shrink: 0; transition: all var(--duration-fast) var(--ease); color: var(--text-secondary); }
        summary:hover { background-color: var(--bg-surface); color: var(--text-primary); }
        summary::marker { color: var(--text-tertiary); }
        details[open] > summary { color: var(--text-primary); }
        details[open] > summary::marker { color: var(--accent); }
        details.filter-active > summary { color: var(--accent); background-color: var(--accent-muted); }
        details.filter-active > summary::marker { color: var(--accent); }
        fieldset.filter-active > label { color: var(--accent); }
        fieldset { flex-direction: column; margin: 0 4px 0 16px; padding: 0; border: 0; font-weight: inherit; font-style: inherit; font-family: inherit; font-size: 100%; vertical-align: baseline; }
        legend,
        label { display: block; width: 100%; margin-bottom: 4px; }
        .radio-group label { display: inline-flex; width: auto; }
        legend { margin-bottom: 3px; color: var(--text-tertiary); text-transform: uppercase; font-size: 10.5px; letter-spacing: 0.05em; }
        select { width: 100%; }
        .select-control-buttons-row { display: flex; flex-wrap: wrap; height: auto; gap: 3px; margin-top: 4px; }
        .input-wrapper { margin-left: 0; margin-bottom: 8px; }
        #filterResetButton { width: 100%; fill: var(--text-tertiary); color: var(--text-tertiary); cursor: pointer; border-radius: var(--radius-sm); padding: 5px 8px; transition: all var(--duration-fast) var(--ease); gap: 6px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
        #filterResetButton:hover { fill: var(--text-primary); color: var(--text-primary); background-color: var(--bg-surface); }
        .form-control { cursor: pointer; }
        .filter-note { display: block; font-size: 11px; color: var(--text-tertiary); line-height: 1.4; margin-top: 2px; }
        .date-reset { cursor: pointer; fill: var(--text-tertiary); stroke-width: 0; stroke-linejoin: round; stroke-linecap: round; height: 28px; width: 28px; stroke: var(--bg-base); transition: stroke-width 1s cubic-bezier(0, 2.5, 0.30, 2.5),
                        fill var(--duration-fast) var(--ease); margin-left: 4px; border-radius: var(--radius-xs); }
        .date-reset.clicked { stroke-width: 2; }
        .date-reset:hover { fill: var(--text-secondary); }
        .settings-controls { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 0; }
    }
    .main { height: 100%; overflow: auto; display: grid; grid-auto-flow: row; grid-template-rows: auto auto auto 1fr; max-width: 100%; background-color: var(--bg-base); .filter-preview { background-color: var(--bg-overlay); padding: 6px 14px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--border-subtle); svg { flex-shrink: 0; opacity: 0.4; }
            span { text-wrap: pretty; font-size: 12px; color: var(--text-secondary); letter-spacing: 0.01em; }
        }
        #logArea { height: 100%; font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', 'JetBrains Mono',
                         Consolas, 'Liberation Mono', Menlo, monospace; font-size: 12px; line-height: 1.6; overflow: auto; padding: 12px 16px; user-select: text; cursor: auto; color: var(--text-secondary); div { padding: 1px 0; white-space: pre-wrap; }
            .error { color: var(--danger); }
            .success { color: var(--success); }
            .warn { color: var(--warning-text); }
        }
        .button-container { background-color: var(--bg-raised); display: flex; gap: 4px; padding: 5px 10px; border-bottom: 1px solid var(--border-subtle); #stopProcess { display: none; background-color: var(--danger); border-color: transparent; color: #fff; }
            #stopProcess:hover { background-color: var(--danger-hover); }
        }
    }
    .footer { width: 100%; padding: 6px 14px; height: 34px; background-color: var(--bg-raised); border-top: 1px solid var(--border-subtle); display: flex; align-items: center; justify-content: space-between; .auto-scroll-container { label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; margin: 0; span { font-size: 10.5px; color: var(--text-tertiary); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
            }
        }
        .info-container,
        .info-container a { font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace; color: var(--text-tertiary); font-size: 10.5px; text-decoration: none; transition: color var(--duration-fast) var(--ease); }
        .info-container a:hover { color: var(--accent-hover); }
    }
    .scroll::-webkit-scrollbar { width: 5px; height: 5px; }
    .scroll::-webkit-scrollbar-corner { background-color: transparent; }
    .scroll::-webkit-scrollbar-thumb { background-clip: padding-box; border-radius: 3px; background-color: var(--bg-surface-active); min-height: 30px; }
    .scroll::-webkit-scrollbar-thumb:hover { background-color: var(--text-tertiary); }
    .scroll::-webkit-scrollbar-track { background-color: transparent; }
    .scroll::-webkit-scrollbar-thumb,
    .scroll::-webkit-scrollbar-track { visibility: hidden; }
    .scroll:hover::-webkit-scrollbar-thumb,
    .scroll:hover::-webkit-scrollbar-track { visibility: visible; }
}

/* layout: keep "Choose Action" pinned on top; long filter text collapses */
#gptk .main { display: flex; flex-direction: column; grid-template-rows: none; overflow-x: hidden; overflow-y: auto; }
#gptk .main > * { flex: 0 0 auto; min-width: 0; }
#gptk .main > .action-bar { position: sticky; top: 0; z-index: 10; box-shadow: 0 8px 14px -8px rgba(0, 0, 0, 0.6); }
#gptk .main > #logArea { flex: 1 1 0; min-height: 140px; height: auto; }
#gptk .main .filter-preview { align-items: flex-start; }
#gptk .main .filter-preview .fp-text { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
#gptk .main .filter-preview.expanded .fp-text { display: block; -webkit-line-clamp: unset; line-clamp: unset; max-height: 32vh; overflow-y: auto; }
#gptk .main .filter-preview .fp-toggle { display: none; flex-shrink: 0; height: 22px; padding: 0 8px; font-size: 10.5px; }
#gptk .main .filter-preview.overflowing .fp-toggle { display: inline-flex; }
`);

  // ════════════════════════════════════════════════════════════
  //  Page globals (guarded: Google changes these occasionally)
  // ════════════════════════════════════════════════════════════
  const wiz = unsafeWindow.WIZ_global_data;
  if (!wiz || !wiz.SNlM0e) {
      console.error('[GPTK] WIZ_global_data / session token not found. Reload the page; if it persists, Google changed the page and GPTK needs an update.');
      return;
  }
  const windowGlobalData = {
      rapt: wiz.Dbw5Ud,
      account: wiz.oPEP7c,
      'f.sid': wiz.FdrFJe,
      bl: wiz.cfb2h,
      path: wiz.eptZe ?? '/',
      at: wiz.SNlM0e,
  };

  // ════════════════════════════════════════════════════════════
  //  Small utilities
  // ════════════════════════════════════════════════════════════
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
  }
  function dateToHHMMSS(date) {
      return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function timeToHHMMSS(time) {
      const totalSeconds = Math.floor(time / 1000);
      const hours = Math.floor(totalSeconds / 3600); // no %24: long runs no longer wrap around
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      return [hours, minutes, seconds].map((n) => n.toString().padStart(2, '0')).join(':');
  }
  function isPatternValid(pattern) {
      try {
          new RegExp(pattern);
          return true;
      }
      catch (e) {
          return e;
      }
  }
  function debounce(fn, wait) {
      let timer = null;
      return (...args) => {
          clearTimeout(timer);
          timer = setTimeout(() => fn(...args), wait);
      };
  }
  function splitArrayIntoChunks(arr, chunkSize = 500) {
      chunkSize = Math.max(1, Math.floor(chunkSize) || 1);
      const chunks = [];
      for (let i = 0; i < arr.length; i += chunkSize) {
          chunks.push(arr.slice(i, i + chunkSize));
      }
      return chunks;
  }
  /** True when `list` is an array containing a sub-array that includes `code`. */
  function containsCode(list, code) {
      return Array.isArray(list) && list.some((sub) => Array.isArray(sub) && sub.includes(code));
  }
  /** Google returns coordinates either as decimal degrees or as degrees × 1e7. */
  function toDecimalDegrees(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return undefined;
      return Math.abs(n) > 360 ? n / 1e7 : n;
  }

  const LOG_MAX_LINES = 3000;
  function log(logMessage, type = null) {
      const logPrefix = '[GPTK]';
      const timestamp = dateToHHMMSS(new Date());
      const line = `[${timestamp}] ${logMessage}`;
      if (type === 'error') console.error(`${logPrefix} ${line}`);
      else console.log(`${logPrefix} ${line}`);
      try {
          const logContainer = document.querySelector('#logArea');
          if (!logContainer) return;
          const logDiv = document.createElement('div');
          logDiv.textContent = line;
          if (type) logDiv.classList.add(type);
          logContainer.appendChild(logDiv);
          while (logContainer.childElementCount > LOG_MAX_LINES) {
              logContainer.firstElementChild?.remove();
          }
          const autoScrollCheckbox = document.querySelector('#autoScroll');
          if (autoScrollCheckbox?.checked) {
              // scrollTop instead of scrollIntoView: does not scroll the Google Photos page behind the overlay
              logContainer.scrollTop = logContainer.scrollHeight;
          }
      }
      catch (error) {
          console.error(`${logPrefix} ${String(error)}`);
      }
  }

  // ════════════════════════════════════════════════════════════
  //  Storage (per Google account)
  // ════════════════════════════════════════════════════════════
  function readUserStorage() {
      try {
          return JSON.parse(localStorage.getItem(windowGlobalData.account) ?? '{}') ?? {};
      }
      catch {
          return {};
      }
  }
  function getFromStorage(key) {
      if (typeof Storage === 'undefined') return null;
      const storedData = readUserStorage()[key];
      return storedData === undefined ? null : storedData;
  }
  function saveToStorage(key, value) {
      if (typeof Storage === 'undefined') return;
      try {
          const userStorage = readUserStorage();
          userStorage[key] = value;
          localStorage.setItem(windowGlobalData.account, JSON.stringify(userStorage));
      }
      catch (error) {
          log(`Could not save ${key} to local storage: ${errorMessage(error)}`, 'error');
      }
  }

  // ════════════════════════════════════════════════════════════
  //  Filter description + validation (single source of truth)
  // ════════════════════════════════════════════════════════════
  function parseSize(value) {
      return parseInt(value ?? '0', 10) || 0;
  }
  function parseNumber(value) {
      return parseFloat(value ?? '');
  }
  function formatDate(value) {
      return value ? new Date(value).toLocaleString('en-GB') : null;
  }
  function pluralAlbums(keys, noun) {
      return Array.isArray(keys)
          ? `in the ${keys.length} ${noun} albums`
          : `in the ${noun} album`;
  }
  const rules = [
      { test: (f) => f.owned === 'true', describe: () => 'owned' },
      { test: (f) => f.owned === 'false', describe: () => 'not owned' },
      { test: (f) => f.space === 'consuming', describe: () => 'space consuming' },
      { test: (f) => f.space === 'non-consuming', describe: () => 'non-space consuming' },
      { test: (f) => f.uploadStatus === 'full', describe: () => 'fully uploaded' },
      { test: (f) => f.uploadStatus === 'partial', describe: () => 'partially uploaded' },
      { test: (f) => f.excludeShared === 'true', describe: () => 'non-shared' },
      { test: (f) => f.favorite === 'true', describe: () => 'favorite' },
      { test: (f) => f.excludeFavorites === 'true' || f.favorite === 'false', describe: () => 'non-favorite' },
      { test: (f) => f.quality === 'original', describe: () => 'original quality' },
      { test: (f) => f.quality === 'storage-saver', describe: () => 'storage-saver quality' },
      { test: (f) => f.hasLocation === 'true', describe: () => 'with location' },
      { test: (f) => f.hasLocation === 'false', describe: () => 'without location' },
      {
          test: (f) => Boolean(f.boundSouth && f.boundWest && f.boundNorth && f.boundEast),
          describe: (f) => `within area S${f.boundSouth} W${f.boundWest} N${f.boundNorth} E${f.boundEast}`,
      },
      { test: (f) => f.archived === 'true', describe: () => 'archived' },
      { test: (f) => f.archived === 'false', describe: () => 'non-archived' },
      {
          test: () => true,
          describe: (f) => ({ video: 'videos', live: 'live photos', image: 'images' })[f.type ?? ''] ?? 'media',
      },
      { test: (f) => !!f.searchQuery, describe: (f) => `in search results of query "${f.searchQuery}"` },
      {
          test: (f) => !!f.mediaKeyRegex,
          describe: (f) => `with media key ${f.mediaKeyMatchType === 'exclude' ? 'not matching' : 'matching'} regex "${f.mediaKeyRegex}"`,
      },
      {
          test: (f) => !!f.fileNameRegex,
          describe: (f) => `with filename ${f.fileNameMatchType === 'exclude' ? 'not matching' : 'matching'} regex "${f.fileNameRegex}"`,
      },
      {
          test: (f) => !!f.descriptionRegex,
          describe: (f) => `with description ${f.descriptionMatchType === 'exclude' ? 'not matching' : 'matching'} regex "${f.descriptionRegex}"`,
      },
      {
          test: (f) => parseSize(f.minWidth) > 0 || parseSize(f.maxWidth) > 0 || parseSize(f.minHeight) > 0 || parseSize(f.maxHeight) > 0,
          describe: (f) => {
              const parts = [];
              if (parseSize(f.minWidth) > 0) parts.push(`width >= ${parseSize(f.minWidth)}px`);
              if (parseSize(f.maxWidth) > 0) parts.push(`width <= ${parseSize(f.maxWidth)}px`);
              if (parseSize(f.minHeight) > 0) parts.push(`height >= ${parseSize(f.minHeight)}px`);
              if (parseSize(f.maxHeight) > 0) parts.push(`height <= ${parseSize(f.maxHeight)}px`);
              return `with resolution ${parts.join(', ')}`;
          },
      },
      {
          test: (f) => !isNaN(parseNumber(f.minDuration)) || !isNaN(parseNumber(f.maxDuration)),
          describe: (f) => {
              const parts = [];
              if (!isNaN(parseNumber(f.minDuration))) parts.push(`duration >= ${parseNumber(f.minDuration)}s`);
              if (!isNaN(parseNumber(f.maxDuration))) parts.push(`duration <= ${parseNumber(f.maxDuration)}s`);
              return `with ${parts.join(', ')}`;
          },
      },
      {
          test: (f) => parseSize(f.lowerBoundarySize) > 0 || parseSize(f.higherBoundarySize) > 0,
          describe: (f) => {
              const lo = parseSize(f.lowerBoundarySize);
              const hi = parseSize(f.higherBoundarySize);
              const parts = [];
              if (lo > 0) parts.push(`larger than ${lo} bytes`);
              if (lo > 0 && hi > 0) parts.push('and');
              if (hi > 0) parts.push(`smaller than ${hi} bytes`);
              return parts;
          },
      },
      { test: (f) => !!f.albumsInclude, describe: (f) => pluralAlbums(f.albumsInclude ?? [], 'target') },
      { test: (f) => !!f.albumsExclude, describe: (f) => ['excluding items', pluralAlbums(f.albumsExclude ?? [], 'selected')] },
      {
          test: (f) => Boolean(f.lowerBoundaryDate ?? f.higherBoundaryDate),
          describe: (f) => {
              const lo = formatDate(f.lowerBoundaryDate);
              const hi = formatDate(f.higherBoundaryDate);
              const parts = [];
              if (f.dateType === 'taken') parts.push('taken');
              else if (f.dateType === 'uploaded') parts.push('uploaded');
              const exclude = f.intervalType === 'exclude';
              if (lo && hi) parts.push(exclude ? `before ${lo} and after ${hi}` : `from ${lo} to ${hi}`);
              else if (lo) parts.push(exclude ? `before ${lo}` : `after ${lo}`);
              else if (hi) parts.push(exclude ? `after ${hi}` : `before ${hi}`);
              return parts;
          },
      },
      { test: (f) => !!f.sortBySize, describe: () => 'sorted by size' },
  ];

  /** Returns an "Error: …" string, or null when the filter is valid. Used by both the preview and the runner. */
  function validateFilter(filter) {
      for (const [field, label] of [['mediaKeyRegex', 'Media Key'], ['fileNameRegex', 'Filename'], ['descriptionRegex', 'Description']]) {
          if (filter[field]) {
              const result = isPatternValid(filter[field]);
              if (result !== true) return `Error: Invalid ${label} regex (${errorMessage(result)})`;
          }
      }
      if (filter.lowerBoundaryDate && filter.higherBoundaryDate && filter.lowerBoundaryDate >= filter.higherBoundaryDate) {
          return 'Error: Invalid Date Interval';
      }
      const lo = parseSize(filter.lowerBoundarySize);
      const hi = parseSize(filter.higherBoundarySize);
      if (lo > 0 && hi > 0 && lo >= hi) return 'Error: Invalid Size Filter';
      const [bS, bW, bN, bE] = ['boundSouth', 'boundWest', 'boundNorth', 'boundEast'].map((k) => parseFloat(filter[k] ?? ''));
      const bounds = [bS, bW, bN, bE];
      const hasSomeBounds = bounds.some((v) => !isNaN(v));
      const hasAllBounds = bounds.every((v) => !isNaN(v));
      if (hasSomeBounds && !hasAllBounds) return 'Error: Bounding Box requires all four coordinates';
      if (hasAllBounds) {
          if (Math.abs(bS) > 90 || Math.abs(bN) > 90 || Math.abs(bW) > 180 || Math.abs(bE) > 180) {
              return 'Error: Bounding Box coordinates are out of range';
          }
          if (bS >= bN) return 'Error: South latitude must be less than North latitude';
      }
      const minW = parseSize(filter.minWidth);
      const maxW = parseSize(filter.maxWidth);
      if (minW > 0 && maxW > 0 && minW >= maxW) return 'Error: Invalid Resolution Filter (Width)';
      const minH = parseSize(filter.minHeight);
      const maxH = parseSize(filter.maxHeight);
      if (minH > 0 && maxH > 0 && minH >= maxH) return 'Error: Invalid Resolution Filter (Height)';
      const minDuration = parseNumber(filter.minDuration);
      const maxDuration = parseNumber(filter.maxDuration);
      if (!isNaN(minDuration) && minDuration < 0) return 'Error: Invalid Duration Filter (Min)';
      if (!isNaN(maxDuration) && maxDuration < 0) return 'Error: Invalid Duration Filter (Max)';
      if (!isNaN(minDuration) && !isNaN(maxDuration) && minDuration >= maxDuration) return 'Error: Invalid Duration Filter';
      return null;
  }
  function generateFilterDescription(filter) {
      const error = validateFilter(filter);
      if (error) return error;
      const parts = ['Filter: All'];
      for (const rule of rules) {
          if (!rule.test(filter)) continue;
          const fragment = rule.describe(filter);
          if (Array.isArray(fragment)) parts.push(...fragment);
          else parts.push(fragment);
      }
      const result = parts.join(' ');
      return result === 'Filter: All media' ? 'Filter: None' : result;
  }

  function getFormData(selector) {
      const form = {};
      const formElement = document.querySelector(selector);
      if (!formElement) return form;
      const formData = new FormData(formElement);
      for (const [key, value] of formData) {
          const strValue = typeof value === 'string' ? value : value.name;
          if (!strValue) continue;
          if (Reflect.has(form, key)) {
              if (!Array.isArray(form[key])) form[key] = [form[key]];
              form[key].push(strValue);
          }
          else {
              form[key] = strValue;
          }
      }
      return form;
  }

  function disableActionBar(disabled) {
      const actions = document.querySelectorAll('.action-bar button, .action-bar input, .action-bar select');
      for (const action of actions) {
          action.disabled = disabled;
      }
  }

  // ════════════════════════════════════════════════════════════
  //  Which actions make sense for which source
  // ════════════════════════════════════════════════════════════
  // In 3.3.0, choosing Trash or Locked as the source silently converted EVERY action into
  // Restore / Unlock. These rules make the mapping explicit instead.
  const SOURCE_ONLY_ACTIONS = {
      trash: ['restoreTrash', 'exportMetadata'],
      lockedFolder: ['unLock', 'exportMetadata'],
  };
  function isActionAllowed(actionId, source) {
      const only = SOURCE_ONLY_ACTIONS[source];
      if (only) return only.includes(actionId);
      if (actionId === 'restoreTrash' || actionId === 'unLock') return false;
      if (actionId === 'removeFromAlbum') return source === 'albums';
      return true;
  }

  // ════════════════════════════════════════════════════════════
  //  Response parsers (Google's undocumented batchexecute JSON)
  // ════════════════════════════════════════════════════════════
  /*
    Notes:
    Add =w417-h174-k-no?authuser=0 to thumbnail URL to set custom size,
    remove 'video' watermark, remove auth requirement.
  */
  function libraryItemParse(itemData) {
      return {
          mediaKey: itemData?.[0],
          timestamp: itemData?.[2],
          timezoneOffset: itemData?.[4],
          creationTimestamp: itemData?.[5],
          dedupKey: itemData?.[3],
          thumb: itemData?.[1]?.[0],
          resWidth: itemData?.[1]?.[1],
          resHeight: itemData?.[1]?.[2],
          isPartialUpload: itemData?.[12]?.[0] === 20,
          isArchived: itemData?.[13],
          isFavorite: itemData?.at(-1)?.[163238866]?.[0],
          duration: itemData?.at(-1)?.[76647426]?.[0],
          descriptionShort: itemData?.at(-1)?.[396644657]?.[0],
          isLivePhoto: Boolean(itemData?.at(-1)?.[146008172]),
          livePhotoDuration: itemData?.at(-1)?.[146008172]?.[1],
          // Code 27 marks items that belong to someone else. Missing data means no marker, i.e. owned.
          // (3.3.0 evaluated `undefined === 0` here and reported such items as NOT owned.)
          isOwned: !containsCode(itemData?.[7], 27),
          geoLocation: {
              coordinates: itemData?.at(-1)?.[129168200]?.[1]?.[0],
              name: itemData?.at(-1)?.[129168200]?.[1]?.[4]?.[0]?.[1]?.[0]?.[0],
          },
      };
  }
  function libraryTimelinePage(data) {
      return {
          items: data?.[0]?.map((itemData) => libraryItemParse(itemData)),
          nextPageId: data?.[1],
          lastItemTimestamp: parseInt(data?.[2]),
      };
  }
  function libraryGenericPage(data) {
      return {
          items: data?.[0]?.map((itemData) => libraryItemParse(itemData)),
          nextPageId: data?.[1],
      };
  }
  function lockedFolderItemParse(itemData) {
      return {
          mediaKey: itemData?.[0],
          timestamp: itemData?.[2],
          creationTimestamp: itemData?.[5],
          dedupKey: itemData?.[3],
          duration: itemData?.at(-1)?.[76647426]?.[0],
      };
  }
  function lockedFolderPage(data) {
      return {
          nextPageId: data?.[0],
          items: data?.[1]?.map((itemData) => lockedFolderItemParse(itemData)),
      };
  }
  function linkParse(itemData) {
      return {
          mediaKey: itemData?.[6],
          linkId: itemData?.[17],
          itemCount: itemData?.[3],
      };
  }
  function linksPage(data) {
      return {
          items: data?.[0]?.map((itemData) => linkParse(itemData)),
          nextPageId: data?.[1],
      };
  }
  function albumParse(itemData) {
      const ext = itemData?.at(-1)?.[72930366];
      return {
          mediaKey: itemData?.[0],
          ownerActorId: itemData?.[6]?.[0],
          title: ext?.[1],
          thumb: itemData?.[1]?.[0],
          itemCount: ext?.[3],
          creationTimestamp: ext?.[2]?.[4],
          modifiedTimestamp: ext?.[2]?.[9],
          timestampRange: [ext?.[2]?.[5], ext?.[2]?.[6]],
          isShared: ext?.[4] ?? false,
          authKey: ext?.[5] ?? undefined,
      };
  }
  function albumsPage(data) {
      return {
          items: data?.[0]?.map((itemData) => albumParse(itemData)),
          nextPageId: data?.[1],
      };
  }
  function partnerSharedItemParse(itemData) {
      return {
          mediaKey: itemData?.[0],
          thumb: itemData?.[1]?.[0],
          resWidth: itemData?.[1]?.[1],
          resHeight: itemData?.[1]?.[2],
          timestamp: itemData?.[2],
          timezoneOffset: itemData?.[4],
          creationTimestamp: itemData?.[5],
          dedupKey: itemData?.[3],
          saved: itemData?.[7]?.[3]?.[0] !== 20,
          isLivePhoto: Boolean(itemData?.at(-1)?.[146008172]),
          livePhotoDuration: itemData?.at(-1)?.[146008172]?.[1],
          duration: itemData?.at(-1)?.[76647426]?.[0],
      };
  }
  function albumItemParse(itemData) {
      return {
          mediaKey: itemData?.[0],
          thumb: itemData?.[1]?.[0],
          resWidth: itemData?.[1]?.[1],
          resHeight: itemData?.[1]?.[2],
          timestamp: itemData?.[2],
          timezoneOffset: itemData?.[4],
          creationTimestamp: itemData?.[5],
          dedupKey: itemData?.[3],
          isLivePhoto: Boolean(itemData?.at(-1)?.[146008172]),
          livePhotoDuration: itemData?.at(-1)?.[146008172]?.[1],
          duration: itemData?.at(-1)?.[76647426]?.[0],
      };
  }
  function trashItemParse(itemData) {
      return {
          mediaKey: itemData?.[0],
          thumb: itemData?.[1]?.[0],
          resWidth: itemData?.[1]?.[1],
          resHeight: itemData?.[1]?.[2],
          timestamp: itemData?.[2],
          timezoneOffset: itemData?.[4],
          creationTimestamp: itemData?.[5],
          dedupKey: itemData?.[3],
          duration: itemData?.at(-1)?.[76647426]?.[0],
      };
  }
  function actorParse(data) {
      return {
          actorId: data?.[0],
          gaiaId: data?.[1],
          name: data?.[11]?.[0],
          gender: data?.[11]?.[2],
          profilePhotoUrl: data?.[12]?.[0],
      };
  }
  function partnerSharedItemsPage(data) {
      return {
          nextPageId: data?.[0],
          items: data?.[1]?.map((itemData) => partnerSharedItemParse(itemData)),
          members: data?.[2]?.map((itemData) => actorParse(itemData)),
          partnerActorId: data?.[4],
          gaiaId: data?.[5],
      };
  }
  function albumItemsPage(data) {
      return {
          items: data?.[1]?.map((itemData) => albumItemParse(itemData)),
          nextPageId: data?.[2],
          mediaKey: data?.[3]?.[0],
          title: data?.[3]?.[1],
          owner: actorParse(data?.[3]?.[5]),
          startTimestamp: data?.[3]?.[2]?.[5],
          endTimestamp: data?.[3]?.[2]?.[6],
          lastActivityTimestamp: data?.[3]?.[2]?.[7],
          creationTimestamp: data?.[3]?.[2]?.[8],
          newestOperationTimestamp: data?.[3]?.[2]?.[9],
          itemCount: data?.[3]?.[21],
          authKey: data?.[3]?.[19],
          members: data?.[3]?.[9]?.map((itemData) => actorParse(itemData)),
      };
  }
  function trashPage(data) {
      return {
          items: data?.[0]?.map((itemData) => trashItemParse(itemData)),
          nextPageId: data?.[1],
      };
  }
  function itemBulkMediaInfoParse(itemData) {
      const tail = itemData?.[1]?.at(-1);
      return {
          mediaKey: itemData?.[0],
          descriptionFull: itemData?.[1]?.[2],
          fileName: itemData?.[1]?.[3],
          timestamp: itemData?.[1]?.[6],
          timezoneOffset: itemData?.[1]?.[7],
          creationTimestamp: itemData?.[1]?.[8],
          size: itemData?.[1]?.[9],
          takesUpSpace: tail?.[0] === undefined ? null : tail[0] === 1,
          spaceTaken: tail?.[1],
          isOriginalQuality: tail?.[2] === undefined ? null : tail[2] === 2,
      };
  }
  function itemInfoExtParse(itemData) {
      const info = itemData?.[0];
      const sourceMap = { 1: 'mobile', 2: 'web', 3: 'shared', 4: 'partnerShared', 7: 'drive', 8: 'pc', 11: 'gmail' };
      const sourceMapSecondary = { 1: 'android', 3: 'ios' };
      const source = [
          info?.[27]?.[0] ? sourceMap[info[27][0]] ?? null : null,
          info?.[27]?.[1]?.[2] ? sourceMapSecondary[info[27][1][2]] ?? null : null,
      ];
      let owner = null;
      if (info?.[27]?.length > 0) {
          owner = actorParse(info?.[27]?.[3]?.[0] ?? info?.[27]?.[4]?.[0]);
      }
      if (!owner?.actorId) owner = actorParse(info?.[28]);
      return {
          mediaKey: info?.[0],
          dedupKey: info?.[11],
          descriptionFull: info?.[1],
          fileName: info?.[2],
          timestamp: info?.[3],
          timezoneOffset: info?.[4],
          size: info?.[5],
          resWidth: info?.[6],
          resHeight: info?.[7],
          cameraInfo: info?.[23],
          albums: info?.[19]?.map((album) => albumParse(album)),
          source,
          takesUpSpace: info?.[30]?.[0] === undefined ? null : info[30][0] === 1,
          spaceTaken: info?.[30]?.[1],
          isOriginalQuality: info?.[30]?.[2] === undefined ? null : info[30][2] === 2,
          // 3.3.0 crashed here when field 12 was missing (`[12].filter` without `?.`)
          savedToYourPhotos: !containsCode(info?.[12], 20),
          owner,
          geoLocation: {
              coordinates: info?.[9]?.[0] ?? info?.[13]?.[0],
              name: info?.[13]?.[2]?.[0]?.[1]?.[0]?.[0],
              mapThumb: itemData?.[1],
          },
          other: info?.[31],
      };
  }
  function itemInfoParse(itemData) {
      const knownKeys = ['15', '76647426', '146008172', '163238866', '225032867', '318563170', '525000000'];
      // extObj's position varies (9 or 15) depending on where the mediaKey came from; locate it by its keys.
      const extObj = itemData?.[0]?.find((x) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).some((k) => knownKeys.includes(k)));
      const space = extObj?.[318563170]?.[0];
      return {
          mediaKey: itemData?.[0]?.[0],
          dedupKey: itemData?.[0]?.[3],
          resWidth: itemData?.[0]?.[1]?.[1],
          resHeight: itemData?.[0]?.[1]?.[2],
          isPartialUpload: itemData?.[0]?.[12]?.[0] === 20,
          timestamp: itemData?.[0]?.[2],
          timezoneOffset: itemData?.[0]?.[4],
          creationTimestamp: itemData?.[0]?.[5],
          downloadUrl: itemData?.[1],
          downloadOriginalUrl: itemData?.[7],
          savedToYourPhotos: extObj?.[163238866]?.length > 0,
          isArchived: itemData?.[0]?.[13],
          takesUpSpace: space?.[0] === undefined ? null : space[0] === 1,
          spaceTaken: space?.[1],
          isOriginalQuality: space?.[2] === undefined ? null : space[2] === 2,
          isFavorite: extObj?.[163238866]?.[0],
          duration: extObj?.[76647426]?.[0],
          isLivePhoto: Boolean(extObj?.[146008172]),
          livePhotoDuration: extObj?.[146008172]?.[1],
          livePhotoVideoDownloadUrl: extObj?.[146008172]?.[3],
          trashTimestamp: extObj?.[225032867]?.[0],
          descriptionFull: itemData?.[10],
          thumb: itemData?.[12],
          cameraInfo: itemData?.[0]?.[1]?.[8]?.[4],
      };
  }
  function bulkMediaInfo(data) {
      return data.map((itemData) => itemBulkMediaInfoParse(itemData));
  }
  function downloadTokenCheckParse(data) {
      const entry = data?.[0]?.[0]?.[0]?.[2]?.[0];
      return {
          fileName: entry?.[0],
          downloadUrl: entry?.[1],
          downloadSize: entry?.[2],
          unzippedSize: entry?.[3],
      };
  }
  function storageQuotaParse(data) {
      return {
          totalUsed: data?.[6]?.[0],
          totalAvailable: data?.[6]?.[1],
          usedByGPhotos: data?.[6]?.[3],
      };
  }
  function remoteMatchParse(itemData) {
      return {
          hash: itemData?.[0],
          mediaKey: itemData?.[1]?.[0],
          thumb: itemData?.[1]?.[1]?.[0],
          resWidth: itemData?.[1]?.[1]?.[1],
          resHeight: itemData?.[1]?.[1]?.[2],
          timestamp: itemData?.[1]?.[2],
          dedupKey: itemData?.[1]?.[3],
          timezoneOffset: itemData?.[1]?.[4],
          creationTimestamp: itemData?.[1]?.[5],
          duration: itemData?.[1]?.at(-1)?.[76647426]?.[0],
          cameraInfo: itemData?.[1]?.[1]?.[8],
      };
  }
  function remoteMatchesParse(data) {
      return data?.[0]?.map((itemData) => remoteMatchParse(itemData)) ?? [];
  }
  const parserRegistry = {
      'lcxiM': libraryTimelinePage,
      'nMFwOc': lockedFolderPage,
      'EzkLib': libraryGenericPage,
      'F2A0H': linksPage,
      'Z5xsfc': albumsPage,
      'snAcKc': albumItemsPage,
      'e9T5je': partnerSharedItemsPage,
      'zy0IHe': trashPage,
      'VrseUb': itemInfoParse,
      'fDcn4b': itemInfoExtParse,
      'EWgK9e': bulkMediaInfo,
      'dnv2s': downloadTokenCheckParse,
      'EzwWhf': storageQuotaParse,
      'swbisb': remoteMatchesParse,
  };
  function parser(data, rpcid) {
      if (!data?.length) return null;
      const parserFn = parserRegistry[rpcid];
      return parserFn ? parserFn(data) : null;
  }

  // ════════════════════════════════════════════════════════════
  //  Low-level API
  // ════════════════════════════════════════════════════════════
  class Api {
      /**
       * Core RPC request with retry and response validation.
       * Retries network errors, empty/garbled bodies, HTTP 429 and 5xx with exponential backoff + jitter.
       * Other HTTP 4xx errors are permanent and fail immediately.
       */
      async makeApiRequest(rpcid, requestData) {
          const wrappedData = [[[rpcid, JSON.stringify(requestData), null, 'generic']]];
          const requestDataString = `f.req=${encodeURIComponent(JSON.stringify(wrappedData))}&at=${encodeURIComponent(windowGlobalData.at)}&`;
          const params = {
              rpcids: rpcid,
              'source-path': window.location.pathname,
              'f.sid': windowGlobalData['f.sid'],
              bl: windowGlobalData.bl,
              pageId: 'none',
              rt: 'c',
          };
          // If in locked folder, send rapt
          if (typeof windowGlobalData.rapt === 'string') params['rapt'] = windowGlobalData.rapt;
          const paramsString = Object.keys(params)
              .map((key) => `${key}=${encodeURIComponent(params[key])}`)
              .join('&');
          const url = `https://photos.google.com${windowGlobalData.path}data/batchexecute?${paramsString}`;
          let lastError = null;
          for (let attempt = 1; attempt <= Api.MAX_RETRIES; attempt++) {
              try {
                  const response = await fetch(url, {
                      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                      body: requestDataString,
                      method: 'POST',
                      credentials: 'include',
                  });
                  if (!response.ok) {
                      const httpError = new Error(`HTTP ${response.status} ${response.statusText}`);
                      httpError.retryable = response.status === 429 || response.status >= 500;
                      throw httpError;
                  }
                  const responseBody = await response.text();
                  if (!responseBody) throw new Error('Empty response body');
                  const jsonLine = responseBody.split('\n').find((line) => line.includes('wrb.fr'));
                  if (!jsonLine) throw new Error('No wrb.fr envelope found in response');
                  const parsedData = JSON.parse(jsonLine);
                  if (!parsedData?.[0]?.[2]) throw new Error('Missing payload in parsed response');
                  return JSON.parse(parsedData[0][2]);
              }
              catch (error) {
                  lastError = error instanceof Error ? error : new Error(String(error));
                  console.error(`[GPTK] ${rpcid} request failed (attempt ${attempt}/${Api.MAX_RETRIES}):`, lastError.message);
                  if (lastError.retryable === false || attempt === Api.MAX_RETRIES) break;
                  const delay = Api.RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 500;
                  await sleep(delay);
              }
          }
          throw lastError ?? new Error(`${rpcid} request failed after ${Api.MAX_RETRIES} attempts`);
      }
      /** Request + optional parse, with consistent error logging. */
      async rpc(rpcid, requestData, parseResponse = true, label = rpcid) {
          try {
              const response = await this.makeApiRequest(rpcid, requestData);
              return parseResponse ? parser(response, rpcid) : response;
          }
          catch (error) {
              console.error(`[GPTK] Error in ${label}:`, error);
              throw error;
          }
      }
      async getItemsByTakenDate(timestamp = null, source = null, pageId = null, pageSize = 500, parseResponse = true) {
          let sourceCode = 3; // both
          if (source === 'library') sourceCode = 1;
          else if (source === 'archive') sourceCode = 2;
          return this.rpc('lcxiM', [pageId, timestamp, pageSize, null, 1, sourceCode], parseResponse, 'getItemsByTakenDate');
      }
      async getItemsByUploadedDate(pageId = null, parseResponse = true) {
          return this.rpc('EzkLib', ['', [[4, 'ra', 0, 0]], pageId], parseResponse, 'getItemsByUploadedDate');
      }
      async search(searchQuery, pageId = null, parseResponse = true) {
          return this.rpc('EzkLib', [searchQuery, null, pageId], parseResponse, 'search');
      }
      async getRemoteMatchesByHash(hashArray, parseResponse = true) {
          return this.rpc('swbisb', [hashArray, null, 3, 0], parseResponse, 'getRemoteMatchesByHash');
      }
      async getFavoriteItems(pageId = null, parseResponse = true) {
          return this.rpc('EzkLib', ['Favorites', [[5, '8', 0, 9]], pageId], parseResponse, 'getFavoriteItems');
      }
      async getTrashItems(pageId = null, parseResponse = true) {
          return this.rpc('zy0IHe', [pageId], parseResponse, 'getTrashItems');
      }
      async getLockedFolderItems(pageId = null, parseResponse = true) {
          return this.rpc('nMFwOc', [pageId], parseResponse, 'getLockedFolderItems');
      }
      async moveItemsToTrash(dedupKeyArray) {
          const response = await this.rpc('XwAOJf', [null, 1, dedupKeyArray, 3], false, 'moveItemsToTrash');
          return response?.[0];
      }
      async restoreFromTrash(dedupKeyArray) {
          const response = await this.rpc('XwAOJf', [null, 3, dedupKeyArray, 2], false, 'restoreFromTrash');
          return response?.[0];
      }
      async getSharedLinks(pageId = null, parseResponse = true) {
          return this.rpc('F2A0H', [pageId, null, 2, null, 3], parseResponse, 'getSharedLinks');
      }
      async getAlbums(pageId = null, pageSize = 100, parseResponse = true) {
          return this.rpc('Z5xsfc', [pageId, null, null, null, 1, null, null, pageSize, [2], 5], parseResponse, 'getAlbums');
      }
      async getAlbumPage(albumMediaKey, pageId = null, authKey = null, parseResponse = true) {
          return this.rpc('snAcKc', [albumMediaKey, pageId, null, authKey], parseResponse, 'getAlbumPage');
      }
      async removeItemsFromAlbum(itemAlbumMediaKeyArray) {
          return this.rpc('ycV3Nd', [itemAlbumMediaKeyArray], false, 'removeItemsFromAlbum');
      }
      async createAlbum(albumName) {
          const response = await this.rpc('OXvT9d', [albumName, null, 2], false, 'createAlbum');
          return response?.[0]?.[0];
      }
      async addItemsToAlbum(mediaKeyArray, albumMediaKey = null, albumName = null) {
          let requestData = null;
          if (albumName) requestData = [mediaKeyArray, null, albumName];
          else if (albumMediaKey) requestData = [mediaKeyArray, albumMediaKey];
          return this.rpc('E1Cajb', requestData, false, 'addItemsToAlbum');
      }
      async addItemsToSharedAlbum(mediaKeyArray, albumMediaKey = null, albumName = null) {
          let requestData = null;
          if (albumName) requestData = [mediaKeyArray, null, albumName];
          else if (albumMediaKey) requestData = [albumMediaKey, [2, null, mediaKeyArray.map((id) => [[id]]), null, null, null, [1]]];
          return this.rpc('laUYf', requestData, false, 'addItemsToSharedAlbum');
      }
      async setAlbumItemOrder(albumMediaKey, albumItemKeys, insertAfter = null) {
          const albumItemKeysArray = albumItemKeys.map((item) => [[item]]);
          const requestData = insertAfter
              ? [albumMediaKey, null, 3, null, albumItemKeysArray, [[insertAfter]]]
              : [albumMediaKey, null, 1, null, albumItemKeysArray];
          return this.rpc('QD9nKf', requestData, false, 'setAlbumItemOrder');
      }
      async setFavorite(dedupKeyArray, action = true) {
          const mappedKeys = dedupKeyArray.map((item) => [null, item]);
          return this.rpc('Ftfh0', [mappedKeys, [action ? 1 : 2]], false, 'setFavorite');
      }
      async setArchive(dedupKeyArray, action = true) {
          const actionCode = action ? 1 : 2;
          const mappedKeys = dedupKeyArray.map((item) => [null, [actionCode], [null, item]]);
          return this.rpc('w7TP3c', [mappedKeys, null, 1], false, 'setArchive');
      }
      async moveToLockedFolder(dedupKeyArray) {
          return this.rpc('StLnCe', [dedupKeyArray, []], false, 'moveToLockedFolder');
      }
      async removeFromLockedFolder(dedupKeyArray) {
          return this.rpc('Pp2Xxe', [dedupKeyArray], false, 'removeFromLockedFolder');
      }
      async getStorageQuota(parseResponse = true) {
          return this.rpc('EzwWhf', [], parseResponse, 'getStorageQuota');
      }
      async getDownloadUrl(mediaKeyArray, authKey = null) {
          const response = await this.rpc('pLFTfd', [mediaKeyArray, null, authKey], false, 'getDownloadUrl');
          return response?.[0];
      }
      async getDownloadToken(mediaKeyArray) {
          const response = await this.rpc('yCLA7', [mediaKeyArray.map((id) => [id])], false, 'getDownloadToken');
          return response?.[0];
      }
      async checkDownloadToken(dlToken, parseResponse = true) {
          return this.rpc('dnv2s', [[dlToken]], parseResponse, 'checkDownloadToken');
      }
      async removeItemsFromSharedAlbum(albumMediaKey, mediaKeyArray) {
          const requestData = [
              [albumMediaKey],
              [mediaKeyArray],
              [[null, null, null, [null, [], []], null, null, null, null, null, null, null, null, null, []]],
          ];
          return this.rpc('LjmOue', requestData, false, 'removeItemsFromSharedAlbum');
      }
      async saveSharedMediaToLibrary(albumMediaKey, mediaKeyArray) {
          return this.rpc('V8RKJ', [mediaKeyArray, null, albumMediaKey], false, 'saveSharedMediaToLibrary');
      }
      async savePartnerSharedMediaToLibrary(mediaKeyArray) {
          return this.rpc('Es7fke', [mediaKeyArray.map((id) => [id])], false, 'savePartnerSharedMediaToLibrary');
      }
      async getPartnerSharedMedia(partnerActorId, gaiaId, pageId, parseResponse = true) {
          const requestData = [pageId, null, [null, [[[2, 1]]], [partnerActorId], [null, gaiaId], 1]];
          return this.rpc('e9T5je', requestData, parseResponse, 'getPartnerSharedMedia');
      }
      async setItemGeoData(dedupKeyArray, center, visible1, visible2, scale, gMapsPlaceId) {
          const mappedKeys = dedupKeyArray.map((dedupKey) => [null, dedupKey]);
          const requestData = [mappedKeys, [2, center, [visible1, visible2], [null, null, scale], gMapsPlaceId]];
          return this.rpc('EtUHOe', requestData, false, 'setItemGeoData');
      }
      async deleteItemGeoData(dedupKeyArray) {
          const mappedKeys = dedupKeyArray.map((dedupKey) => [null, dedupKey]);
          return this.rpc('EtUHOe', [mappedKeys, [1]], false, 'deleteItemGeoData');
      }
      async setItemsTimestamp(items) {
          const requestData = [items.map((item) => [item.dedupKey, item.timestampSec, item.timezoneSec])];
          return this.rpc('DaSgWe', requestData, false, 'setItemsTimestamp');
      }
      async setItemDescription(dedupKey, description) {
          return this.rpc('AQNOFd', [null, description, dedupKey], false, 'setItemDescription');
      }
      async getItemInfo(mediaKey, albumMediaKey = null, authKey = null, parseResponse = true) {
          return this.rpc('VrseUb', [mediaKey, null, authKey, null, albumMediaKey], parseResponse, 'getItemInfo');
      }
      // Only works with mediaKey belonging to your library
      async getItemInfoExt(mediaKey, authKey = null, parseResponse = true) {
          return this.rpc('fDcn4b', [mediaKey, 1, authKey, null, 1], parseResponse, 'getItemInfoExt');
      }
      async getBatchMediaInfo(mediaKeyArray, parseResponse = true) {
          const mappedKeys = mediaKeyArray.map((id) => [id]);
          // prettier-ignore
          const requestData = [[[mappedKeys], [[null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, [], null, null, null, null, null, null, null, null, null, null, []]]]];
          const response = (await this.rpc('EWgK9e', requestData, false, 'getBatchMediaInfo'))?.[0]?.[1];
          return parseResponse ? parser(response, 'EWgK9e') : response;
      }
  }
  Api.MAX_RETRIES = 3;
  Api.RETRY_BASE_DELAY_MS = 2000;

  // ════════════════════════════════════════════════════════════
  //  Date-from-filename parser (exiftool-style)
  // ════════════════════════════════════════════════════════════
  /*
   * Finds the first plausible date in a filename. Separator-agnostic.
   * Supported shapes (examples):
   *   IMG_20230515_143022.jpg            → 2023-05-15 14:30:22
   *   PXL_20230515_143022123.jpg         → 2023-05-15 14:30:22   (ms ignored)
   *   Screenshot_2023-05-15-14-30-22.png → 2023-05-15 14:30:22
   *   2023-05-15 143022.jpg              → 2023-05-15 14:30:22
   *   2023-05-15 00-30-00.jpg            → 2023-05-15 00:30:00   (3.3.0 dropped the minutes)
   *   20230515143022.jpg                 → 2023-05-15 14:30:22
   *   IMG-20230515-WA0001.jpg            → 2023-05-15 00:00:00
   *   2023_05_15_photo.jpg               → 2023-05-15 00:00:00
   * Returned values are the wall-clock time shown in the filename (no time zone).
   */
  function extractDigitSequences(str) {
      const sequences = [];
      const regex = /\d+/g;
      let match;
      while ((match = regex.exec(str)) !== null) {
          sequences.push({ value: match[0], index: match.index });
      }
      return sequences;
  }
  function isValidDate(year, month, day, hour, minute, second) {
      if (year < 1900 || year > 2100) return false;
      if (month < 1 || month > 12) return false;
      if (day < 1 || day > 31) return false;
      if (hour < 0 || hour > 23) return false;
      if (minute < 0 || minute > 59) return false;
      if (second < 0 || second > 59) return false;
      // UTC so that wall-clock times inside a local DST gap are not rejected
      const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }
  function makeParsed(year, month, day, hour = 0, minute = 0, second = 0) {
      return isValidDate(year, month, day, hour, minute, second) ? { year, month, day, hour, minute, second } : null;
  }
  function tryParseTimeSequence(digits) {
      if (!digits || digits.length < 6) return null;
      const hour = parseInt(digits.substring(0, 2), 10);
      const minute = parseInt(digits.substring(2, 4), 10);
      const second = parseInt(digits.substring(4, 6), 10);
      if (hour > 23 || minute > 59 || second > 59) return null;
      return { hour, minute, second };
  }
  /** YYYYMMDD[HH[MM[SS]]] in a single digit run. */
  function tryParseConcatenatedFormat(digits) {
      if (digits.length < 8) return null;
      const n = (a, b) => parseInt(digits.substring(a, b), 10);
      return makeParsed(n(0, 4), n(4, 6), n(6, 8), digits.length >= 10 ? n(8, 10) : 0, digits.length >= 12 ? n(10, 12) : 0, digits.length >= 14 ? n(12, 14) : 0);
  }
  /** YYYY sep M(M) sep D(D) [sep HH sep MM sep SS | sep HHMMSS] */
  function tryParseWithSeparateComponents(sequences, yearIdx) {
      const seq = (k) => sequences[yearIdx + k]?.value;
      const year = parseInt(seq(0), 10);
      const m = seq(1);
      const d = seq(2);
      if (!m || !d || m.length > 2 || d.length > 2) return null;
      const month = parseInt(m, 10);
      const day = parseInt(d, 10);
      const dateOnly = makeParsed(year, month, day);
      if (!dateOnly) return null;
      const t = seq(3);
      if (t && t.length >= 6) {
          const time = tryParseTimeSequence(t);
          if (time) return makeParsed(year, month, day, time.hour, time.minute, time.second) ?? dateOnly;
      }
      else if (t && t.length === 2) {
          const hour = parseInt(t, 10);
          const mi = seq(4);
          const minute = mi?.length === 2 ? parseInt(mi, 10) : 0;
          const s = seq(5);
          const second = mi?.length === 2 && s?.length === 2 ? parseInt(s, 10) : 0;
          return makeParsed(year, month, day, hour, minute, second) ?? dateOnly;
      }
      return dateOnly;
  }
  function tryParseFromSequence(sequences, startIdx) {
      const value = sequences[startIdx].value;
      const len = value.length;
      if (len === 4) return tryParseWithSeparateComponents(sequences, startIdx);
      if (len === 8) {
          const date = tryParseConcatenatedFormat(value);
          if (!date) return null;
          const time = tryParseTimeSequence(sequences[startIdx + 1]?.value);
          return time ? makeParsed(date.year, date.month, date.day, time.hour, time.minute, time.second) ?? date : date;
      }
      if (len > 8 && len < 14) return tryParseConcatenatedFormat(value);
      if (len >= 14 && len <= 17) return tryParseConcatenatedFormat(value.substring(0, 14)); // allow trailing ms
      return null;
  }
  function parseDateFromFilename(filename) {
      const baseName = String(filename).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      const sequences = extractDigitSequences(baseName);
      for (let startIdx = 0; startIdx < sequences.length; startIdx++) {
          const result = tryParseFromSequence(sequences, startIdx);
          if (result) return result;
      }
      return null;
  }
  /** Wall-clock components interpreted as if they were UTC, in ms. */
  function wallClockToUtcMs(parsed) {
      return Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, parsed.second);
  }
  function formatParsedDate(parsed) {
      const pad = (n) => n.toString().padStart(2, '0');
      return `${parsed.year}-${pad(parsed.month)}-${pad(parsed.day)} ${pad(parsed.hour)}:${pad(parsed.minute)}:${pad(parsed.second)}`;
  }

  // ════════════════════════════════════════════════════════════
  //  High-level API operations
  // ════════════════════════════════════════════════════════════
  const apiSettingsDefault = {
      maxConcurrentSingleApiReq: 3,
      maxConcurrentBatchApiReq: 3,
      operationSize: 250,
      lockedFolderOpSize: 100,
      infoSize: 5000,
  };
  function sanitizeSetting(value, fallback, max = Infinity) {
      const n = Math.floor(Number(value));
      return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback;
  }

  class ApiUtils {
      constructor(core, settings) {
          this.api = new Api();
          this.core = core;
          const s = settings ?? apiSettingsDefault;
          const d = apiSettingsDefault;
          this.maxConcurrentSingleApiReq = sanitizeSetting(s.maxConcurrentSingleApiReq, d.maxConcurrentSingleApiReq, 50);
          this.maxConcurrentBatchApiReq = sanitizeSetting(s.maxConcurrentBatchApiReq, d.maxConcurrentBatchApiReq, 10);
          this.operationSize = sanitizeSetting(s.operationSize, d.operationSize, 500);
          this.lockedFolderOpSize = sanitizeSetting(s.lockedFolderOpSize, d.lockedFolderOpSize, 100);
          this.infoSize = sanitizeSetting(s.infoSize, d.infoSize, 10000);
      }
      downloadTextFile(fileName, content, type) {
          const blob = new Blob([content], { type });
          const url = URL.createObjectURL(blob);
          const downloadLink = document.createElement('a');
          downloadLink.href = url;
          downloadLink.download = fileName;
          downloadLink.style.display = 'none';
          document.body.appendChild(downloadLink);
          downloadLink.click();
          downloadLink.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      toCsvValue(value) {
          if (value === undefined || value === null) return '';
          if (value instanceof Date) return isNaN(value.getTime()) ? '' : value.toISOString();
          let text;
          if (typeof value === 'object') text = JSON.stringify(value) ?? '';
          else if (typeof value === 'string') {
              text = value;
              // Neutralise spreadsheet formulas (CSV injection) in user-controlled text such as descriptions
              if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
          }
          else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') text = value.toString();
          else if (typeof value === 'symbol') text = value.description ?? '';
          else text = '';
          return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      }
      /**
       * Runs `apiMethod` over `itemsArray` in chunks with bounded concurrency.
       * A failing chunk is logged and skipped; it no longer aborts the whole run
       * (in 3.3.0 a rejected request propagated out of Promise.race/Promise.all).
       */
      async executeWithConcurrency(apiMethod, operationSize, itemsArray, ...args) {
          const pool = new Set();
          const results = [];
          const chunks = splitArrayIntoChunks(itemsArray, operationSize);
          const maxConcurrent = operationSize === 1 ? this.maxConcurrentSingleApiReq : this.maxConcurrentBatchApiReq;
          const name = (apiMethod.name || 'request').replace(/^bound /, '');
          let failedChunks = 0;
          let failedItems = 0;
          for (const chunk of chunks) {
              if (!this.core.isProcessRunning) break;
              while (pool.size >= maxConcurrent) await Promise.race(pool);
              if (!this.core.isProcessRunning) break;
              if (operationSize !== 1) log(`Processing ${chunk.length} items`);
              const task = (async () => {
                  try {
                      const result = await apiMethod.call(this.api, chunk, ...args);
                      if (Array.isArray(result)) {
                          results.push(...result);
                          if (operationSize === 1 && results.length % 100 === 0) log(`Processed ${results.length} items`);
                      }
                  }
                  catch (error) {
                      failedChunks++;
                      failedItems += chunk.length;
                      log(`${name} failed for ${chunk.length} item(s): ${errorMessage(error)}`, 'error');
                  }
              })();
              pool.add(task);
              void task.finally(() => pool.delete(task));
          }
          await Promise.all(pool);
          if (failedChunks > 0) {
              log(`${name}: ${failedChunks} request(s) failed, ${failedItems} item(s) were not processed`, 'error');
          }
          return results;
      }
      /**
       * Reads every page. A failed page throws (after Api's retries) instead of returning a partial list:
       * a partial "exclude" list (Exclude Albums / Exclude Shared) would let the action hit items it should skip.
       */
      async getAllItems(apiMethod, ...args) {
          const items = [];
          let nextPageId;
          do {
              if (!this.core.isProcessRunning) return items;
              const page = await apiMethod.call(this.api, ...args, nextPageId);
              if (page?.items?.length > 0) {
                  log(`Found ${page.items.length} items`);
                  items.push(...page.items);
              }
              nextPageId = page?.nextPageId;
          } while (nextPageId);
          return items;
      }
      async getAllAlbums() {
          return this.getAllItems(this.api.getAlbums.bind(this.api));
      }
      async getAllSharedLinks() {
          return this.getAllItems(this.api.getSharedLinks.bind(this.api));
      }
      async getAllMediaInSharedLink(sharedLinkId) {
          return this.getAllItems(this.api.getAlbumPage.bind(this.api), sharedLinkId);
      }
      async getAllMediaInAlbum(albumMediaKey) {
          return this.getAllItems(this.api.getAlbumPage.bind(this.api), albumMediaKey);
      }
      async getAllMediaInAlbumWithContext(albumMediaKey) {
          const items = [];
          let title;
          let nextPageId = null;
          do {
              if (!this.core.isProcessRunning) return { title, items };
              try {
                  const page = await this.api.getAlbumPage(albumMediaKey, nextPageId);
                  title ??= page?.title;
                  if (page?.items?.length > 0) {
                      log(`Found ${page.items.length} items`);
                      items.push(...page.items);
                  }
                  nextPageId = page?.nextPageId ?? null;
              }
              catch (error) {
                  log(`Error fetching album page, stopping here: ${errorMessage(error)}`, 'error');
                  break;
              }
          } while (nextPageId);
          return { title, items };
      }
      async getAllTrashItems() {
          return this.getAllItems(this.api.getTrashItems.bind(this.api));
      }
      async getAllFavoriteItems() {
          return this.getAllItems(this.api.getFavoriteItems.bind(this.api));
      }
      async getAllSearchItems(searchQuery) {
          return this.getAllItems(this.api.search.bind(this.api), searchQuery);
      }
      async getAllLockedFolderItems() {
          return this.getAllItems(this.api.getLockedFolderItems.bind(this.api));
      }
      async moveToLockedFolder(mediaItems) {
          log(`Moving ${mediaItems.length} items to locked folder`);
          await this.executeWithConcurrency(this.api.moveToLockedFolder.bind(this.api), this.lockedFolderOpSize, mediaItems.map((item) => item.dedupKey));
      }
      async removeFromLockedFolder(mediaItems) {
          log(`Moving ${mediaItems.length} items out of locked folder`);
          await this.executeWithConcurrency(this.api.removeFromLockedFolder.bind(this.api), this.lockedFolderOpSize, mediaItems.map((item) => item.dedupKey));
      }
      async moveToTrash(mediaItems) {
          log(`Moving ${mediaItems.length} items to trash`);
          await this.executeWithConcurrency(this.api.moveItemsToTrash.bind(this.api), this.operationSize, mediaItems.map((item) => item.dedupKey));
      }
      async restoreFromTrash(trashItems) {
          log(`Restoring ${trashItems.length} items from trash`);
          await this.executeWithConcurrency(this.api.restoreFromTrash.bind(this.api), this.operationSize, trashItems.map((item) => item.dedupKey));
      }
      /**
       * Removes items from their album(s) without trashing them.
       * Only valid for items fetched via the Albums source: their album-scoped
       * `mediaKey` (from getAlbumPage) is the key the removal RPCs expect.
       */
      async removeFromAlbum(mediaItems) {
          log(`Removing ${mediaItems.length} items from album`);
          const itemsByAlbum = new Map();
          for (const item of mediaItems) {
              const albumKey = item.sourceAlbumMediaKey ?? '';
              const group = itemsByAlbum.get(albumKey);
              if (group) group.push(item);
              else itemsByAlbum.set(albumKey, [item]);
          }
          for (const [albumMediaKey, items] of itemsByAlbum) {
              if (!this.core.isProcessRunning) break;
              const itemMediaKeys = items.map((item) => item.mediaKey);
              if (items[0]?.sourceAlbumIsShared) {
                  const removeFromShared = function removeItemsFromSharedAlbum(chunk) {
                      return this.removeItemsFromSharedAlbum(albumMediaKey, chunk);
                  };
                  await this.executeWithConcurrency(removeFromShared, this.operationSize, itemMediaKeys);
              }
              else {
                  await this.executeWithConcurrency(this.api.removeItemsFromAlbum.bind(this.api), this.operationSize, itemMediaKeys);
              }
          }
      }
      async sendToArchive(mediaItems) {
          log(`Sending ${mediaItems.length} items to archive`);
          const filtered = mediaItems.filter((item) => item?.isArchived !== true);
          if (filtered.length === 0) {
              log('All target items are already archived');
              return;
          }
          await this.executeWithConcurrency(this.api.setArchive.bind(this.api), this.operationSize, filtered.map((item) => item.dedupKey), true);
      }
      async unArchive(mediaItems) {
          log(`Removing ${mediaItems.length} items from archive`);
          const filtered = mediaItems.filter((item) => item?.isArchived !== false);
          if (filtered.length === 0) {
              log('All target items are not archived');
              return;
          }
          await this.executeWithConcurrency(this.api.setArchive.bind(this.api), this.operationSize, filtered.map((item) => item.dedupKey), false);
      }
      async setAsFavorite(mediaItems) {
          log(`Setting ${mediaItems.length} items as favorite`);
          const filtered = mediaItems.filter((item) => item?.isFavorite !== true);
          if (filtered.length === 0) {
              log('All target items are already favorite');
              return;
          }
          await this.executeWithConcurrency(this.api.setFavorite.bind(this.api), this.operationSize, filtered.map((item) => item.dedupKey), true);
      }
      async unFavorite(mediaItems) {
          log(`Removing ${mediaItems.length} items from favorites`);
          const filtered = mediaItems.filter((item) => item?.isFavorite !== false);
          if (filtered.length === 0) {
              log('All target items are not favorite');
              return;
          }
          await this.executeWithConcurrency(this.api.setFavorite.bind(this.api), this.operationSize, filtered.map((item) => item.dedupKey), false);
      }
      async addToExistingAlbum(mediaItems, targetAlbum, preserveOrder = false) {
          const existingCount = Number(targetAlbum.itemCount) || 0;
          const remaining = Math.max(0, ApiUtils.ALBUM_ITEM_LIMIT - existingCount);
          if (mediaItems.length <= remaining) {
              await this.addItemsToSingleAlbum(mediaItems, targetAlbum, preserveOrder);
              return;
          }
          const firstBatch = mediaItems.slice(0, remaining);
          const overflow = mediaItems.slice(remaining);
          if (firstBatch.length > 0) {
              log(`Album "${targetAlbum.title}" can accept ${remaining} more items (limit: ${ApiUtils.ALBUM_ITEM_LIMIT})`);
              await this.addItemsToSingleAlbum(firstBatch, targetAlbum, preserveOrder);
          }
          const overflowChunks = splitArrayIntoChunks(overflow, ApiUtils.ALBUM_ITEM_LIMIT);
          for (let i = 0; i < overflowChunks.length; i++) {
              if (!this.core.isProcessRunning) break;
              const chunk = overflowChunks[i];
              const overflowName = `${targetAlbum.title} (${i + 2})`;
              log(`Creating overflow album "${overflowName}" for ${chunk.length} items`);
              const newAlbumMediaKey = await this.api.createAlbum(overflowName);
              if (!newAlbumMediaKey) {
                  log(`Could not create overflow album "${overflowName}"`, 'error');
                  break;
              }
              const overflowAlbum = { title: overflowName, isShared: false, mediaKey: newAlbumMediaKey, itemCount: 0 };
              await this.addItemsToSingleAlbum(chunk, overflowAlbum, preserveOrder);
          }
      }
      async addItemsToSingleAlbum(mediaItems, targetAlbum, preserveOrder) {
          log(`Adding ${mediaItems.length} items to album "${targetAlbum.title}"`);
          const mediaKeyArray = mediaItems.map((item) => item.mediaKey);
          const addItemFunction = targetAlbum.isShared
              ? this.api.addItemsToSharedAlbum.bind(this.api)
              : this.api.addItemsToAlbum.bind(this.api);
          await this.executeWithConcurrency(addItemFunction, this.operationSize, mediaKeyArray, targetAlbum.mediaKey);
          if (!preserveOrder || !this.core.isProcessRunning) return;
          log('Setting album item order');
          const albumItems = await this.getAllMediaInAlbum(targetAlbum.mediaKey);
          const orderMap = new Map(mediaItems.map((item, index) => [item.dedupKey, index]));
          // Only the items we just added are moved. 3.3.0 also re-positioned every item that was
          // already in the album, costing one request per existing item.
          const added = albumItems
              .filter((item) => orderMap.has(item.dedupKey))
              .sort((a, b) => orderMap.get(a.dedupKey) - orderMap.get(b.dedupKey));
          // Each call moves one item to the front, so walk the list backwards.
          let moved = 0;
          for (const item of added.reverse()) {
              if (!this.core.isProcessRunning) break;
              try {
                  await this.api.setAlbumItemOrder(targetAlbum.mediaKey, [item.mediaKey]);
              }
              catch (error) {
                  log(`Could not reorder an item: ${errorMessage(error)}`, 'error');
              }
              moved++;
              if (moved % 100 === 0) log(`Reordered ${moved}/${added.length} items`);
          }
      }
      async addToNewAlbum(mediaItems, targetAlbumName, preserveOrder = false) {
          log(`Creating new album "${targetAlbumName}"`);
          const mediaKey = await this.api.createAlbum(targetAlbumName);
          if (!mediaKey) throw new Error(`Could not create album "${targetAlbumName}"`);
          await this.addToExistingAlbum(mediaItems, { title: targetAlbumName, isShared: false, mediaKey, itemCount: 0 }, preserveOrder);
      }
      async getBatchMediaInfoChunked(mediaItems) {
          log("Getting items' media info");
          return this.executeWithConcurrency(this.api.getBatchMediaInfo.bind(this.api), this.infoSize, mediaItems.map((item) => item.mediaKey));
      }
      async copyOneDescriptionFromOther(mediaItems) {
          const item = mediaItems[0];
          const itemInfoExt = await this.api.getItemInfoExt(item.mediaKey);
          if (!itemInfoExt || itemInfoExt.descriptionFull || !itemInfoExt.other) return [false];
          // Zero-width space: Google rejects a description identical to the "Other" field.
          await this.api.setItemDescription(item.dedupKey, itemInfoExt.other + '\u200B');
          return [true];
      }
      async copyDescriptionFromOther(mediaItems) {
          log(`Copying up to ${mediaItems.length} descriptions from 'Other' field`);
          const results = await this.executeWithConcurrency(this.copyOneDescriptionFromOther.bind(this), 1, mediaItems);
          log(`Copied ${results.filter(Boolean).length} descriptions from 'Other' field`);
      }
      /**
       * Sets each item's date from the date found in its filename.
       * The filename holds local wall-clock time, so the stored UTC timestamp is
       * (wall clock as UTC) − (the item's own time-zone offset). 3.3.0 used the
       * browser's time zone instead, which shifted photos taken in other zones.
       */
      async setTimestampFromFilename(mediaItems, { dryRun = false } = {}) {
          log(`Processing ${mediaItems.length} items to set dates from filenames`);
          const mediaInfoData = await this.getBatchMediaInfoChunked(mediaItems);
          const infoByKey = new Map(mediaInfoData.map((info) => [info.mediaKey, info]));
          const itemsToUpdate = [];
          let noName = 0;
          let unparsed = 0;
          let unchanged = 0;
          for (const item of mediaItems) {
              const info = infoByKey.get(item.mediaKey);
              const fileName = info?.fileName ?? item.fileName;
              if (!fileName) {
                  noName++;
                  continue;
              }
              const parsed = parseDateFromFilename(fileName);
              if (!parsed) {
                  unparsed++;
                  continue;
              }
              const timezoneSec = Math.round((Number(info?.timezoneOffset ?? item.timezoneOffset) || 0) / 1000);
              const timestampSec = Math.floor(wallClockToUtcMs(parsed) / 1000) - timezoneSec;
              const current = Number(info?.timestamp ?? item.timestamp);
              if (Number.isFinite(current) && Math.floor(current / 1000) === timestampSec) {
                  unchanged++;
                  continue;
              }
              itemsToUpdate.push({ dedupKey: item.dedupKey, timestampSec, timezoneSec, fileName, formattedDate: formatParsedDate(parsed) });
          }
          log(`Dates found: ${itemsToUpdate.length + unchanged} | need changing: ${itemsToUpdate.length} | already correct: ${unchanged} | no date in name: ${unparsed} | no filename: ${noName}`);
          if (itemsToUpdate.length === 0) return;
          if (dryRun) {
              const shown = itemsToUpdate.slice(0, 50);
              for (const item of shown) log(`  would set "${item.fileName}" → ${item.formattedDate}`);
              if (itemsToUpdate.length > shown.length) log(`  …and ${itemsToUpdate.length - shown.length} more`);
              return;
          }
          let successCount = 0;
          for (const chunk of splitArrayIntoChunks(itemsToUpdate, this.operationSize)) {
              if (!this.core.isProcessRunning) break;
              try {
                  await this.api.setItemsTimestamp(chunk);
                  successCount += chunk.length;
                  for (const item of chunk) log(`Set date for "${item.fileName}" to ${item.formattedDate}`);
              }
              catch (error) {
                  log(`Failed to set dates for ${chunk.length} items: ${errorMessage(error)}`, 'error');
              }
          }
          log(`Successfully set dates for ${successCount} of ${itemsToUpdate.length} items`);
      }
      async exportMetadata(mediaItems) {
          log(`Fetching metadata for ${mediaItems.length} items`);
          const mediaInfoData = await this.getBatchMediaInfoChunked(mediaItems);
          const infoByKey = new Map(mediaInfoData.map((info) => [info.mediaKey, info]));
          const headers = [
              'mediaKey', 'dedupKey', 'sourceAlbumMediaKey', 'sourceAlbumTitle', 'fileName', 'description',
              'takenAt', 'uploadedAt', 'timezoneOffsetMs', 'width', 'height', 'durationMs', 'livePhotoDurationMs',
              'sizeBytes', 'takesUpSpace', 'spaceTakenBytes', 'isOriginalQuality', 'isArchived', 'isFavorite',
              'isOwned', 'hasLocation', 'locationName', 'latitude', 'longitude', 'thumbnailUrl',
          ];
          const toDate = (ts) => (ts === undefined || ts === null ? undefined : new Date(Number(ts)));
          const rows = mediaItems.map((item) => {
              const info = infoByKey.get(item.mediaKey);
              const coordinates = item.geoLocation?.coordinates ?? [];
              const hasLocation = Array.isArray(coordinates) && coordinates.length > 0;
              return [
                  item.mediaKey,
                  item.dedupKey,
                  item.sourceAlbumMediaKey,
                  item.sourceAlbumTitle,
                  info?.fileName ?? item.fileName,
                  info?.descriptionFull ?? item.descriptionFull ?? item.descriptionShort,
                  toDate(info?.timestamp ?? item.timestamp),
                  toDate(info?.creationTimestamp ?? item.creationTimestamp),
                  info?.timezoneOffset ?? item.timezoneOffset,
                  item.resWidth,
                  item.resHeight,
                  item.duration,
                  item.livePhotoDuration,
                  info?.size ?? item.size,
                  info?.takesUpSpace ?? item.takesUpSpace,
                  info?.spaceTaken ?? item.spaceTaken,
                  info?.isOriginalQuality ?? item.isOriginalQuality,
                  item.isArchived,
                  item.isFavorite,
                  item.isOwned,
                  hasLocation, // 3.3.0 checked `item.geoLocation`, which always exists → always true
                  item.geoLocation?.name,
                  hasLocation ? toDecimalDegrees(coordinates[0]) : undefined,
                  hasLocation ? toDecimalDegrees(coordinates[1]) : undefined,
                  item.thumb,
              ];
          });
          const csv = [headers, ...rows].map((row) => row.map((value) => this.toCsvValue(value)).join(',')).join('\r\n');
          const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
          // BOM so Excel opens non-ASCII filenames/descriptions correctly
          this.downloadTextFile(`gptk-metadata-${stamp}.csv`, `\uFEFF${csv}\r\n`, 'text/csv;charset=utf-8');
          log(`Downloaded metadata for ${mediaItems.length} items`);
      }
  }
  /** Google Photos albums have a hard limit of 20,000 items. */
  ApiUtils.ALBUM_ITEM_LIMIT = 20_000;

  // ════════════════════════════════════════════════════════════
  //  Filters
  // ════════════════════════════════════════════════════════════
  function mediaKeyFilter(mediaItems, filter) {
      log('Filtering by media key');
      const regex = new RegExp(filter.mediaKeyRegex ?? '');
      const exclude = filter.mediaKeyMatchType === 'exclude';
      const result = mediaItems.filter((item) => regex.test(item.mediaKey ?? '') !== exclude);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function fileNameFilter(mediaItems, filter) {
      log('Filtering by filename');
      const regex = new RegExp(filter.fileNameRegex ?? '');
      const exclude = filter.fileNameMatchType === 'exclude';
      const result = mediaItems.filter((item) => regex.test(item.fileName ?? '') !== exclude);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function descriptionFilter(mediaItems, filter) {
      log('Filtering by description');
      const regex = new RegExp(filter.descriptionRegex ?? '');
      const exclude = filter.descriptionMatchType === 'exclude';
      const result = mediaItems.filter((item) => regex.test(item.descriptionFull ?? '') !== exclude);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function sizeFilter(mediaItems, filter) {
      log('Filtering by size');
      let result = mediaItems;
      const hi = parseSize(filter.higherBoundarySize);
      const lo = parseSize(filter.lowerBoundarySize);
      if (hi > 0) result = result.filter((item) => (item.size ?? 0) < hi);
      if (lo > 0) result = result.filter((item) => (item.size ?? 0) > lo);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function resolutionFilter(mediaItems, filter) {
      log('Filtering by resolution');
      let result = mediaItems;
      const minW = parseSize(filter.minWidth);
      const maxW = parseSize(filter.maxWidth);
      const minH = parseSize(filter.minHeight);
      const maxH = parseSize(filter.maxHeight);
      if (minW > 0) result = result.filter((item) => (item.resWidth ?? 0) >= minW);
      if (maxW > 0) result = result.filter((item) => (item.resWidth ?? 0) <= maxW);
      if (minH > 0) result = result.filter((item) => (item.resHeight ?? 0) >= minH);
      if (maxH > 0) result = result.filter((item) => (item.resHeight ?? 0) <= maxH);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function durationFilter(mediaItems, filter) {
      log('Filtering by duration');
      let result = mediaItems;
      const minDuration = parseNumber(filter.minDuration);
      const maxDuration = parseNumber(filter.maxDuration);
      if (!isNaN(minDuration)) result = result.filter((item) => item.duration !== undefined && item.duration >= minDuration * 1000);
      if (!isNaN(maxDuration)) result = result.filter((item) => item.duration !== undefined && item.duration <= maxDuration * 1000);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function qualityFilter(mediaItems, filter) {
      log('Filtering by quality');
      let result = mediaItems;
      if (filter.quality === 'original') result = mediaItems.filter((item) => item.isOriginalQuality === true);
      else if (filter.quality === 'storage-saver') result = mediaItems.filter((item) => item.isOriginalQuality === false);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function spaceFilter(mediaItems, filter) {
      log('Filtering by space');
      let result = mediaItems;
      if (filter.space === 'consuming') result = mediaItems.filter((item) => item.takesUpSpace === true);
      else if (filter.space === 'non-consuming') result = mediaItems.filter((item) => item.takesUpSpace === false);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function dateBounds(filter) {
      const lo = new Date(filter.lowerBoundaryDate ?? '').getTime();
      const hi = new Date(filter.higherBoundaryDate ?? '').getTime();
      return [isNaN(lo) ? -Infinity : lo, isNaN(hi) ? Infinity : hi];
  }
  function filterByDate(mediaItems, filter) {
      log('Filtering by date');
      const [lo, hi] = dateBounds(filter);
      const key = filter.dateType === 'uploaded' ? 'creationTimestamp' : 'timestamp';
      const exclude = filter.intervalType === 'exclude';
      const result = mediaItems.filter((item) => {
          const inRange = item[key] >= lo && item[key] <= hi;
          return exclude ? !inRange : inRange;
      });
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function filterByMediaType(mediaItems, filter) {
      log('Filtering by media type');
      let result = mediaItems;
      if (filter.type === 'video') result = mediaItems.filter((item) => item.duration);
      else if (filter.type === 'image') result = mediaItems.filter((item) => !item.duration);
      else if (filter.type === 'live') result = mediaItems.filter((item) => item.isLivePhoto);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function filterFavorite(mediaItems, filter) {
      log('Filtering favorites');
      let result = mediaItems;
      // Unknown status no longer counts as "favorite" (3.3.0 used `!== false`).
      if (filter.favorite === 'true') result = mediaItems.filter((item) => Boolean(item.isFavorite));
      else if (filter.favorite === 'false' || filter.excludeFavorites) result = mediaItems.filter((item) => !item.isFavorite);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function filterByLocation(mediaItems, filter) {
      log('Filtering by location');
      let result = mediaItems;
      if (filter.hasLocation === 'true') result = result.filter((item) => item.geoLocation?.coordinates?.length);
      else if (filter.hasLocation === 'false') result = result.filter((item) => !item.geoLocation?.coordinates?.length);
      const south = parseFloat(filter.boundSouth ?? '');
      const west = parseFloat(filter.boundWest ?? '');
      const north = parseFloat(filter.boundNorth ?? '');
      const east = parseFloat(filter.boundEast ?? '');
      if (![south, west, north, east].some(isNaN)) {
          log(`Filtering by bounding box: S${south} W${west} N${north} E${east}`);
          result = result.filter((item) => {
              const coords = item.geoLocation?.coordinates;
              if (!coords?.length) return false;
              const lat = toDecimalDegrees(coords[0]);
              const lng = toDecimalDegrees(coords[1]);
              if (lat === undefined || lng === undefined) return false;
              if (lat < south || lat > north) return false;
              // Boxes crossing the antimeridian have west > east
              return west <= east ? lng >= west && lng <= east : lng >= west || lng <= east;
          });
      }
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function filterOwned(mediaItems, filter) {
      log('Filtering owned');
      let result = mediaItems;
      if (filter.owned === 'true') result = mediaItems.filter((item) => item.isOwned !== false);
      else if (filter.owned === 'false') result = mediaItems.filter((item) => item.isOwned === false);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function filterByUploadStatus(mediaItems, filter) {
      log('Filtering by upload status');
      let result = mediaItems;
      if (filter.uploadStatus === 'full') result = mediaItems.filter((item) => item.isPartialUpload === false);
      else if (filter.uploadStatus === 'partial') result = mediaItems.filter((item) => item.isPartialUpload === true);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }
  function filterArchived(mediaItems, filter) {
      log('Filtering archived');
      let result = mediaItems;
      if (filter.archived === 'true') result = mediaItems.filter((item) => Boolean(item.isArchived));
      else if (filter.archived === 'false') result = mediaItems.filter((item) => !item.isArchived);
      log(`Item count after filtering: ${result.length}`);
      return result;
  }

  // ════════════════════════════════════════════════════════════
  //  Core: fetch → filter → act
  // ════════════════════════════════════════════════════════════
  class Core {
      constructor() {
          this.isProcessRunning = false;
          this.api = new Api();
          this.apiUtils = new ApiUtils(this);
          /** Set by the UI so it can refresh when a run starts or ends. */
          this.onStateChange = null;
          this.actionHandlers = {
              restoreTrash: async (p) => this.apiUtils.restoreFromTrash(p.mediaItems),
              unLock: async (p) => this.apiUtils.removeFromLockedFolder(p.mediaItems),
              lock: async (p) => this.apiUtils.moveToLockedFolder(p.mediaItems),
              toExistingAlbum: async (p) => {
                  if (!p.targetAlbum) throw new Error('No target album specified');
                  await this.apiUtils.addToExistingAlbum(p.mediaItems, p.targetAlbum, p.preserveOrder);
              },
              toNewAlbum: async (p) => {
                  if (!p.newTargetAlbumName) throw new Error('No album name specified');
                  await this.apiUtils.addToNewAlbum(p.mediaItems, p.newTargetAlbumName, p.preserveOrder);
              },
              toTrash: async (p) => this.apiUtils.moveToTrash(p.mediaItems),
              removeFromAlbum: async (p) => this.apiUtils.removeFromAlbum(p.mediaItems),
              toArchive: async (p) => this.apiUtils.sendToArchive(p.mediaItems),
              unArchive: async (p) => this.apiUtils.unArchive(p.mediaItems),
              toFavorite: async (p) => this.apiUtils.setAsFavorite(p.mediaItems),
              unFavorite: async (p) => this.apiUtils.unFavorite(p.mediaItems),
              copyDescFromOther: async (p) => this.apiUtils.copyDescriptionFromOther(p.mediaItems),
              setDateFromFilename: async (p) => this.apiUtils.setTimestampFromFilename(p.mediaItems),
              exportMetadata: async (p) => this.apiUtils.exportMetadata(p.mediaItems),
          };
      }
      notifyState() {
          try {
              this.onStateChange?.();
          }
          catch (error) {
              console.error('[GPTK] UI update failed', error);
          }
      }
      async getAndFilterMedia(filter, source) {
          const mediaItems = await this.fetchMediaItems(source, filter);
          log(`Found items: ${mediaItems.length}`);
          if (!this.isProcessRunning || !mediaItems?.length) return mediaItems;
          return this.applyFilters(mediaItems, filter, source);
      }
      async fetchMediaItems(source, filter) {
          const sourceHandlers = {
              library: async () => {
                  log('Reading library');
                  return filter.dateType === 'uploaded'
                      ? this.getLibraryItemsByUploadDate(filter)
                      : this.getLibraryItemsByTakenDate(filter);
              },
              search: async () => {
                  log('Reading search results');
                  return this.apiUtils.getAllSearchItems(filter.searchQuery ?? '');
              },
              trash: async () => {
                  log('Getting trash items');
                  return this.apiUtils.getAllTrashItems();
              },
              lockedFolder: async () => {
                  log('Getting locked folder items');
                  return this.apiUtils.getAllLockedFolderItems();
              },
              favorites: async () => {
                  log('Getting favorite items');
                  return this.apiUtils.getAllFavoriteItems();
              },
              sharedLinks: async () => {
                  log('Getting shared links');
                  const sharedLinks = await this.apiUtils.getAllSharedLinks();
                  if (!sharedLinks?.length) {
                      log('No shared links found', 'error');
                      return [];
                  }
                  log(`Shared Links Found: ${sharedLinks.length}`);
                  const items = [];
                  // one link at a time: firing every link in parallel triggered rate limiting
                  for (const sharedLink of sharedLinks) {
                      if (!this.isProcessRunning) break;
                      log('Getting shared link items');
                      items.push(...await this.apiUtils.getAllMediaInSharedLink(sharedLink.linkId));
                  }
                  return items;
              },
              albums: async () => {
                  if (!filter.albumsInclude) throw new Error('No target album selected');
                  const albumMediaKeys = Array.isArray(filter.albumsInclude) ? filter.albumsInclude : [filter.albumsInclude];
                  // Only trust a known boolean isShared; unknown values are resolved by re-fetching albums.
                  const sharedByAlbumKey = new Map((getFromStorage('albums') ?? [])
                      .filter((album) => typeof album.isShared === 'boolean')
                      .map((album) => [album.mediaKey, album.isShared]));
                  if (albumMediaKeys.some((key) => !sharedByAlbumKey.has(key))) {
                      for (const album of await this.apiUtils.getAllAlbums()) {
                          if (typeof album.isShared === 'boolean') sharedByAlbumKey.set(album.mediaKey, album.isShared);
                      }
                  }
                  const items = [];
                  for (const albumMediaKey of albumMediaKeys) {
                      if (!this.isProcessRunning) break;
                      log('Getting album items');
                      const { title, items: albumItems } = await this.apiUtils.getAllMediaInAlbumWithContext(albumMediaKey);
                      for (const item of albumItems) {
                          items.push({
                              ...item,
                              sourceAlbumMediaKey: albumMediaKey,
                              sourceAlbumTitle: title,
                              sourceAlbumIsShared: sharedByAlbumKey.get(albumMediaKey) ?? false,
                          });
                      }
                  }
                  return items;
              },
          };
          const handler = sourceHandlers[source];
          if (!handler) {
              log(`Unknown source: ${source}`, 'error');
              return [];
          }
          const mediaItems = (await handler()) ?? [];
          log('Source read complete');
          return mediaItems;
      }
      async applyFilters(mediaItems, filter, source) {
          let filteredItems = mediaItems;
          const filtersToApply = [
              { condition: !!filter.mediaKeyRegex, method: () => mediaKeyFilter(filteredItems, filter) },
              { condition: source !== 'library' && Boolean(filter.lowerBoundaryDate ?? filter.higherBoundaryDate), method: () => filterByDate(filteredItems, filter) },
              { condition: !!filter.albumsExclude, method: () => this.excludeAlbumItems(filteredItems, filter) },
              { condition: !!filter.excludeShared, method: () => this.excludeSharedItems(filteredItems) },
              { condition: !!filter.owned, method: () => filterOwned(filteredItems, filter) },
              { condition: Boolean(filter.hasLocation ?? filter.boundSouth ?? filter.boundWest ?? filter.boundNorth ?? filter.boundEast), method: () => filterByLocation(filteredItems, filter) },
              { condition: !!filter.uploadStatus, method: () => filterByUploadStatus(filteredItems, filter) },
              { condition: !!filter.archived, method: () => filterArchived(filteredItems, filter) },
              { condition: Boolean(filter.favorite ?? filter.excludeFavorites), method: () => filterFavorite(filteredItems, filter) },
              { condition: !!filter.type, method: () => filterByMediaType(filteredItems, filter) },
              { condition: Boolean(filter.minWidth ?? filter.maxWidth ?? filter.minHeight ?? filter.maxHeight), method: () => resolutionFilter(filteredItems, filter) },
              { condition: Boolean(filter.minDuration ?? filter.maxDuration), method: () => durationFilter(filteredItems, filter) },
          ];
          for (const { condition, method } of filtersToApply) {
              if (!this.isProcessRunning) return filteredItems;
              if (condition && filteredItems.length) filteredItems = await method();
          }
          const needsInfo = filter.space ?? filter.quality ?? filter.lowerBoundarySize ?? filter.higherBoundarySize ?? filter.fileNameRegex ?? filter.descriptionRegex ?? filter.sortBySize;
          if (filteredItems.length && needsInfo && this.isProcessRunning) {
              // fetched once, reused by every info-based filter and by sort-by-size
              filteredItems = await this.extendMediaItemsWithMediaInfo(filteredItems);
              const extendedFilters = [
                  { condition: !!filter.fileNameRegex, method: () => fileNameFilter(filteredItems, filter) },
                  { condition: !!filter.descriptionRegex, method: () => descriptionFilter(filteredItems, filter) },
                  { condition: !!filter.space, method: () => spaceFilter(filteredItems, filter) },
                  { condition: !!filter.quality, method: () => qualityFilter(filteredItems, filter) },
                  { condition: Boolean(filter.lowerBoundarySize ?? filter.higherBoundarySize), method: () => sizeFilter(filteredItems, filter) },
              ];
              for (const { condition, method } of extendedFilters) {
                  if (condition && filteredItems.length) filteredItems = method();
              }
              if (filter.sortBySize) filteredItems.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
          }
          return filteredItems;
      }
      async excludeAlbumItems(mediaItems, filter) {
          const albumMediaKeys = Array.isArray(filter.albumsExclude) ? filter.albumsExclude : [filter.albumsExclude ?? ''];
          const excludeKeys = new Set();
          for (const albumMediaKey of albumMediaKeys) {
              log('Getting album items to exclude');
              for (const item of await this.apiUtils.getAllMediaInAlbum(albumMediaKey)) excludeKeys.add(item.dedupKey);
          }
          log('Excluding album items');
          const result = mediaItems.filter((mediaItem) => !excludeKeys.has(mediaItem.dedupKey));
          log(`Item count after filtering: ${result.length}`);
          return result;
      }
      async excludeSharedItems(mediaItems) {
          log('Getting shared links items to exclude');
          const excludeKeys = new Set();
          for (const sharedLink of await this.apiUtils.getAllSharedLinks()) {
              if (!this.isProcessRunning) break;
              for (const item of await this.apiUtils.getAllMediaInSharedLink(sharedLink.linkId)) excludeKeys.add(item.dedupKey);
          }
          log('Excluding shared items');
          const result = mediaItems.filter((mediaItem) => !excludeKeys.has(mediaItem.dedupKey));
          log(`Item count after filtering: ${result.length}`);
          return result;
      }
      async extendMediaItemsWithMediaInfo(mediaItems) {
          const mediaInfoData = await this.apiUtils.getBatchMediaInfoChunked(mediaItems);
          const infoByKey = new Map(mediaInfoData.map((info) => [info.mediaKey, info]));
          return mediaItems.map((item) => ({ ...item, ...infoByKey.get(item.mediaKey) }));
      }
      /**
       * Pages through the timeline (newest first).
       * - Include range: starts at the upper bound and stops once past the lower bound.
       * - Exclude range / no range: full scan with an in-memory filter (3.3.0's cursor-jumping
       *   exclude mode mixed timestamp and page-token pagination and was unreliable).
       * Stops on an empty response instead of looping forever.
       */
      async getLibraryItemsByTakenDate(filter) {
          let source = null;
          if (filter.archived === 'true') source = 'archive';
          else if (filter.archived === 'false') source = 'library';
          const [lo, hi] = dateBounds(filter);
          const hasRange = lo !== -Infinity || hi !== Infinity;
          const include = filter.intervalType !== 'exclude';
          const inRange = (t) => t >= lo && t <= hi;
          const keep = !hasRange ? () => true : include ? inRange : (t) => !inRange(t);
          const mediaItems = [];
          let nextPageId = null;
          let nextPageTimestamp = hasRange && include && hi !== Infinity ? hi : null;
          while (this.isProcessRunning) {
              const page = await this.api.getItemsByTakenDate(nextPageTimestamp, source, nextPageId);
              if (!page) break;
              const raw = page.items ?? [];
              const prevTimestamp = nextPageTimestamp;
              nextPageId = page.nextPageId ?? null;
              nextPageTimestamp = Number.isFinite(page.lastItemTimestamp) ? page.lastItemTimestamp - 1 : null;
              const kept = raw.filter((item) => keep(item.timestamp));
              if (kept.length) {
                  log(`Found ${kept.length} items`);
                  mediaItems.push(...kept);
              }
              if (!raw.length && !nextPageId) break;
              if (hasRange && include) {
                  if (nextPageTimestamp !== null && nextPageTimestamp < lo) break; // passed the lower bound
                  if (!nextPageId && (nextPageTimestamp === null || nextPageTimestamp === prevTimestamp)) break; // no progress possible
              }
              else if (!nextPageId) {
                  break;
              }
          }
          return mediaItems;
      }
      async getLibraryItemsByUploadDate(filter) {
          const [lo, hi] = dateBounds(filter);
          const include = filter.intervalType !== 'exclude';
          const mediaItems = [];
          let nextPageId = null;
          do {
              if (!this.isProcessRunning) return mediaItems;
              const mediaPage = await this.api.getItemsByUploadedDate(nextPageId);
              if (!mediaPage) break;
              nextPageId = mediaPage.nextPageId ?? null;
              const items = mediaPage.items ?? [];
              if (!items.length) continue;
              const inRange = (item) => item.creationTimestamp >= lo && item.creationTimestamp <= hi;
              const pageItems = items.filter((item) => (include ? inRange(item) : !inRange(item)));
              if (pageItems.length) {
                  log(`Found ${pageItems.length} items`);
                  mediaItems.push(...pageItems);
              }
              // newest uploads first: once the page's oldest upload is below the range, stop
              if (include && items[items.length - 1].creationTimestamp < lo) break;
          } while (nextPageId);
          return mediaItems;
      }
      /** Logs a short preview of what an action would touch, without changing anything. */
      async previewItems(actionId, mediaItems) {
          log(`DRY RUN: ${mediaItems.length} item(s) match. Nothing was changed.`, 'warn');
          if (actionId === 'setDateFromFilename') {
              await this.apiUtils.setTimestampFromFilename(mediaItems, { dryRun: true });
              return;
          }
          const sample = mediaItems.slice(0, 25);
          let names = new Map();
          try {
              const info = await this.apiUtils.getBatchMediaInfoChunked(sample);
              names = new Map(info.map((i) => [i.mediaKey, i.fileName]));
          }
          catch {
              // names are optional in the preview
          }
          for (const item of sample) {
              const when = item.timestamp ? new Date(item.timestamp).toLocaleString() : 'unknown date';
              log(`  ${names.get(item.mediaKey) ?? item.fileName ?? item.mediaKey}  (${when})`);
          }
          if (mediaItems.length > sample.length) log(`  …and ${mediaItems.length - sample.length} more`);
      }
      /**
       * @param options.dryRun  find + list only
       * @param options.confirm (count) => boolean, called after matching and before acting
       */
      async actionWithFilter(action, filter, source, targetAlbum, newTargetAlbumName, apiSettings, options = {}) {
          const { dryRun = false, confirm = null } = options;
          const actionId = typeof action === 'string' ? action : action.elementId;
          if (this.isProcessRunning) {
              log('Another task is already running', 'error');
              return;
          }
          if (!isActionAllowed(actionId, source)) {
              log(`Action "${actionId}" is not available for source "${source}"`, 'error');
              return;
          }
          const validationError = validateFilter(filter);
          if (validationError) {
              log(validationError, 'error');
              return;
          }
          this.isProcessRunning = true;
          this.apiUtils = new ApiUtils(this, apiSettings ?? apiSettingsDefault);
          this.notifyState();
          const startTime = Date.now();
          try {
              const mediaItems = await this.getAndFilterMedia(filter, source);
              if (!this.isProcessRunning) {
                  log('Stopped', 'warn');
                  return;
              }
              if (!mediaItems?.length) {
                  log('No items to process');
                  return;
              }
              if (dryRun) {
                  await this.previewItems(actionId, mediaItems);
                  log(`Dry run finished in ${timeToHHMMSS(Date.now() - startTime)}`, 'success');
                  return;
              }
              if (confirm && !confirm(mediaItems.length)) {
                  log('Cancelled. Nothing was changed.', 'warn');
                  return;
              }
              await this.executeAction(actionId, {
                  mediaItems,
                  source,
                  targetAlbum,
                  newTargetAlbumName,
                  preserveOrder: Boolean(filter.sortBySize),
              });
              if (this.isProcessRunning) log(`Task completed in ${timeToHHMMSS(Date.now() - startTime)}`, 'success');
              else log('Stopped before completion; some items may already have been processed', 'warn');
          }
          catch (error) {
              log((error instanceof Error ? error.stack : String(error)) ?? 'Unknown error', 'error');
          }
          finally {
              this.isProcessRunning = false;
              this.notifyState();
          }
      }
      async executeAction(action, params) {
          const actionId = typeof action === 'string' ? action : action.elementId;
          if (!isActionAllowed(actionId, params.source)) {
              throw new Error(`Action "${actionId}" is not available for source "${params.source}"`);
          }
          log(`Items to process: ${params.mediaItems.length}`);
          const handler = this.actionHandlers[actionId];
          if (!handler) throw new Error(`Unknown action: ${actionId}`);
          await handler(params);
      }
  }

  const core = new Core();
  const apiUtils = new ApiUtils(core);
  unsafeWindow.gptkApi = new Api();
  unsafeWindow.gptkCore = core;
  unsafeWindow.gptkApiUtils = apiUtils;

  // ════════════════════════════════════════════════════════════
  //  UI
  // ════════════════════════════════════════════════════════════
  function currentSource() {
      return document.querySelector('input[name="source"]:checked')?.id ?? 'library';
  }
  function updateUI() {
      function toggleVisibility(element, show) {
          // '' restores the stylesheet's display (3.3.0 forced 'block', breaking inline radio labels)
          element.style.display = show ? '' : 'none';
          for (const node of element.querySelectorAll('input, select, button, textarea')) node.disabled = !show;
      }
      function filterPreviewUpdate() {
          const previewElement = document.querySelector('.filter-preview span');
          if (!previewElement) return;
          try {
              previewElement.textContent = generateFilterDescription(getFormData('.filters-form'));
          }
          catch {
              previewElement.textContent = 'Failed to generate description';
          }
          refreshPreviewToggleSafe();
      }
      const source = currentSource();
      const isActiveTab = (tabName) => source === tabName;
      function lockedFolderTabState() {
          const lockedFolderTab = document.getElementById('lockedFolder');
          if (lockedFolderTab && !window.location.href.includes('lockedfolder')) {
              lockedFolderTab.disabled = true;
              if (lockedFolderTab.parentNode instanceof HTMLElement) {
                  lockedFolderTab.parentNode.title = 'To process items in the locked folder, you must open GPTK while in it';
              }
          }
      }
      const filter = getFormData('.filters-form');
      const favoritesOnly = filter.favorite === 'true';
      const favoritesExcluded = filter.excludeFavorites === 'true' || filter.favorite === 'false';
      const archivedOnly = filter.archived === 'true';
      const archivedExcluded = filter.archived === 'false';
      function updateActionButtonStates() {
          const extraDisabled = {
              unArchive: archivedExcluded,
              toFavorite: favoritesOnly || isActiveTab('favorites'),
              unFavorite: favoritesExcluded,
              toArchive: archivedOnly,
          };
          const buttonToAction = { showExistingAlbumForm: 'toExistingAlbum', showNewAlbumForm: 'toNewAlbum' };
          for (const button of document.querySelectorAll('.action-buttons button')) {
              const actionId = buttonToAction[button.id] ?? button.id;
              if (actionId === 'removeFromAlbum') continue; // soft-disabled below
              button.disabled = !isActionAllowed(actionId, source) || Boolean(extraDisabled[actionId]);
          }
          // Soft-disabled so the hint tooltip still shows on hover.
          const removeFromAlbumBtn = document.getElementById('removeFromAlbum');
          if (removeFromAlbumBtn) {
              const allowed = isActionAllowed('removeFromAlbum', source);
              removeFromAlbumBtn.disabled = false;
              removeFromAlbumBtn.classList.toggle('not-applicable', !allowed);
              removeFromAlbumBtn.setAttribute('aria-disabled', String(!allowed));
              removeFromAlbumBtn.title = allowed ? 'Remove items from their album' : 'Source must be Albums to remove items from an album';
          }
      }
      function updateFilterVisibility() {
          const q = (sel) => document.querySelector(sel);
          const filterElements = {
              livePhotoType: q('.type input[value=live]')?.parentNode,
              includeAlbums: q('.include-albums'),
              owned: q('.owned'),
              location: q('.location'),
              search: q('.search'),
              favorite: q('.favorite'),
              quality: q('.quality'),
              size: q('.size'),
              resolution: q('.resolution'),
              filename: q('.filename'),
              description: q('.description'),
              space: q('.space'),
              excludeAlbums: q('.exclude-albums'),
              uploadStatus: q('.upload-status'),
              archive: q('.archive'),
              excludeShared: q('.exclude-shared'),
              excludeFavorite: q('.exclude-favorites'),
          };
          const show = (key, visible) => {
              if (filterElements[key]) toggleVisibility(filterElements[key], visible);
          };
          const libraryLike = ['library', 'search', 'favorites'].some(isActiveTab);
          const notTrash = !isActiveTab('trash');
          show('includeAlbums', isActiveTab('albums'));
          show('owned', libraryLike);
          show('uploadStatus', libraryLike);
          show('archive', libraryLike);
          show('search', isActiveTab('search'));
          show('favorite', isActiveTab('search'));
          show('livePhotoType', notTrash);
          show('quality', notTrash);
          show('size', notTrash);
          show('resolution', notTrash);
          show('location', notTrash);
          show('filename', notTrash);
          show('description', notTrash);
          show('space', notTrash);
          show('excludeAlbums', notTrash && !isActiveTab('lockedFolder'));
          show('excludeShared', notTrash && !isActiveTab('sharedLinks'));
          show('excludeFavorite', isActiveTab('library'));
      }
      lockedFolderTabState();
      const stopBtn = document.getElementById('stopProcess');
      if (core.isProcessRunning) {
          disableActionBar(true);
          if (stopBtn) stopBtn.style.display = 'block';
      }
      else {
          if (stopBtn) stopBtn.style.display = 'none';
          disableActionBar(false);
          updateActionButtonStates();
      }
      updateFilterVisibility();
      filterPreviewUpdate();
      highlightActiveFilters();
  }
  function hasChangedFromDefault(container) {
      for (const input of container.querySelectorAll('input[type="text"], input[type="input"], input[type="number"], input[type="datetime-local"]')) {
          if (input.value.trim() !== input.defaultValue.trim()) return true;
      }
      for (const input of container.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
          if (input.checked !== input.defaultChecked) return true;
      }
      for (const select of container.querySelectorAll('select')) {
          for (const option of select.options) {
              if (option.selected !== option.defaultSelected) return true;
          }
      }
      return false;
  }
  function highlightActiveFilters() {
      const filtersForm = document.querySelector('.filters-form');
      if (!filtersForm) return;
      for (const details of filtersForm.querySelectorAll('details')) {
          details.classList.toggle('filter-active', hasChangedFromDefault(details));
      }
      for (const fieldset of filtersForm.querySelectorAll(':scope > fieldset')) {
          fieldset.classList.toggle('filter-active', hasChangedFromDefault(fieldset));
      }
  }

  const version = `v${GPTK_VERSION}`;
  function htmlTemplatePrep(template) {
      return template.replace('%version%', version).replace('%homepage%', HOMEPAGE);
  }

  // Trusted Types: use our own named policy. 3.3.0 tried to create the page-wide 'default'
  // policy, which throws if the page already has one and then the UI never loads.
  let htmlPolicy = null;
  function toTrustedHTML(html) {
      const tt = window.trustedTypes;
      if (!tt?.createPolicy) return html;
      if (!htmlPolicy) {
          for (const name of ['gptk-html', 'default']) {
              try {
                  htmlPolicy = tt.createPolicy(name, { createHTML: (s) => s });
                  break;
              }
              catch {
                  // try the next name
              }
          }
          htmlPolicy ??= { createHTML: (s) => s };
      }
      return htmlPolicy.createHTML(html);
  }

  function insertToolbarButton() {
      const selector = () => (window.location.href.includes('lockedfolder') ? '.c9yG5b' : '.J3TAe');
      const tryInsert = () => {
          if (document.getElementById('gptk-button')) return true;
          const host = document.querySelector(selector());
          if (!host) return false;
          host.insertAdjacentHTML('afterbegin', toTrustedHTML(htmlTemplatePrep(buttonHtml)));
          document.getElementById('gptk-button')?.addEventListener('click', showMainMenu);
          return true;
      };
      tryInsert();
      // Google re-renders its toolbar on navigation; put the button back when that happens.
      let scheduled = false;
      const observer = new MutationObserver(() => {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => {
              scheduled = false;
              tryInsert();
          });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
          if (!document.getElementById('gptk-button')) {
              log('Toolbar button could not be placed (Google may have changed the page layout). Open GPTK from your userscript manager menu instead.', 'warn');
          }
      }, 20000);
  }
  function insertUi() {
      document.body.insertAdjacentHTML('afterbegin', toTrustedHTML(htmlTemplatePrep(gptkMainTemplate)));
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
      insertToolbarButton();
      baseListenersSetUp();
  }
  function isMenuOpen() {
      return document.getElementById('gptk')?.style.display === 'flex';
  }
  function showMainMenu() {
      const overlay = document.querySelector('.overlay');
      const gptk = document.getElementById('gptk');
      if (gptk) gptk.style.display = 'flex';
      if (overlay) overlay.style.display = 'block';
      document.body.style.overflow = 'hidden';
      updateUI();
  }
  function hideMainMenu() {
      const overlay = document.querySelector('.overlay');
      const gptk = document.getElementById('gptk');
      if (gptk) gptk.style.display = 'none';
      if (overlay) overlay.style.display = 'none';
      document.body.style.overflow = '';
  }
  /** Collapses a long filter description to two lines and shows a Show more / Show less button when needed. */
  function refreshPreviewToggle() {
      const box = document.querySelector('.filter-preview');
      const text = box?.querySelector('.fp-text');
      const btn = box?.querySelector('.fp-toggle');
      if (!box || !text || !btn) return;
      text.title = text.textContent ?? '';
      const wasExpanded = box.classList.contains('expanded');
      box.classList.remove('expanded');
      const overflowing = text.scrollHeight > text.clientHeight + 1;
      const expanded = wasExpanded && overflowing;
      box.classList.toggle('expanded', expanded);
      box.classList.toggle('overflowing', overflowing);
      btn.textContent = expanded ? 'Show less' : 'Show more';
  }
  function previewToggleListeners() {
      document.querySelector('.fp-toggle')?.addEventListener('click', () => {
          const box = document.querySelector('.filter-preview');
          const btn = document.querySelector('.fp-toggle');
          if (!box || !btn) return;
          const expanded = box.classList.toggle('expanded');
          btn.textContent = expanded ? 'Show less' : 'Show more';
      });
      window.addEventListener('resize', debounce(refreshPreviewToggle, 100));
  }

  const refreshPreviewToggleSafe = () => { try { refreshPreviewToggle(); } catch { /* cosmetic */ } };

  function baseListenersSetUp() {
      const root = document.getElementById('gptk');
      // scoped to our window instead of every 'change' event on the Google Photos page
      root?.addEventListener('change', updateUI);
      root?.addEventListener('input', debounce(updateUI, 150));
      core.onStateChange = updateUI;
      previewToggleListeners();
      document.querySelector('#hide')?.addEventListener('click', hideMainMenu);
      document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && isMenuOpen()) hideMainMenu();
      });
  }

  function addAlbums(albums) {
      function addAlbumsAsOptions(albumList, albumSelects, addEmpty = false) {
          for (const albumSelect of albumSelects) {
              if (!albumList?.length) {
                  const option = document.createElement('option');
                  option.textContent = 'No Albums';
                  option.value = '';
                  albumSelect.appendChild(option);
                  continue;
              }
              for (const album of albumList) {
                  if (parseInt(String(album.itemCount ?? 0)) === 0 && !addEmpty) continue;
                  const option = document.createElement('option');
                  option.value = album.mediaKey;
                  option.title = `Name: ${album.title}\nItems: ${album.itemCount}`;
                  option.textContent = album.title ?? '';
                  if (album.isShared) option.classList.add('shared');
                  albumSelect.appendChild(option);
              }
          }
      }
      const albumSelectsMultiple = document.querySelectorAll('.albums-select[multiple]');
      const albumSelectsSingle = document.querySelectorAll('.dropdown.albums-select');
      for (const albumSelect of [...albumSelectsMultiple, ...albumSelectsSingle]) {
          while (albumSelect.options.length > 0) albumSelect.remove(0);
      }
      for (const select of albumSelectsSingle) {
          const option = document.createElement('option');
          option.value = '';
          option.textContent = 'Select Album';
          select.appendChild(option);
      }
      addAlbumsAsOptions(albums, Array.from(albumSelectsSingle), true);
      addAlbumsAsOptions(albums, Array.from(albumSelectsMultiple), false);
      updateUI();
  }

  const actions = [
      { elementId: 'toExistingAlbum', targetId: 'existingAlbum' },
      { elementId: 'toNewAlbum', targetId: 'newAlbumName' },
      { elementId: 'removeFromAlbum' },
      { elementId: 'toTrash' },
      { elementId: 'restoreTrash' },
      { elementId: 'toArchive' },
      { elementId: 'unArchive' },
      { elementId: 'toFavorite' },
      { elementId: 'unFavorite' },
      { elementId: 'lock' },
      { elementId: 'unLock' },
      { elementId: 'copyDescFromOther' },
      { elementId: 'setDateFromFilename' },
      { elementId: 'exportMetadata' },
  ];
  const actionWarnings = {
      setDateFromFilename: 'WARNING: This overwrites the photos\' dates and cannot be undone. Try Dry run first.',
      toTrash: 'Items go to Google Photos Trash and can be restored from there until Google empties it.',
      removeFromAlbum: 'Items are removed from the album only; they stay in your library.',
      copyDescFromOther: 'Only items without an existing description are changed.',
  };
  function userConfirmation(action, filter, count) {
      const sourceLabel = document.querySelector('input[name="source"]:checked+label');
      const actionElement = document.getElementById(action.elementId);
      const lines = [
          `Account: ${windowGlobalData.account}`,
          `Source: ${sourceLabel?.textContent?.trim() ?? 'Unknown'}`,
          generateFilterDescription(filter),
          `Action: ${actionElement?.title ?? action.elementId}`,
          '',
          `Matched items: ${count.toLocaleString()}`,
      ];
      if (actionWarnings[action.elementId]) lines.push('', actionWarnings[action.elementId]);
      return window.confirm(`${lines.join('\n')}\n\nProceed?`);
  }
  async function runAction(actionId) {
      if (core.isProcessRunning) return;
      const action = actions.find((a) => a.elementId === actionId);
      if (!action) return;
      const source = currentSource();
      if (!isActionAllowed(actionId, source)) {
          log(actionId === 'removeFromAlbum' ? 'Remove from album requires the Albums source' : `"${actionId}" is not available for this source`, 'error');
          return;
      }
      let targetAlbum;
      let newTargetAlbumName;
      if (actionId === 'toExistingAlbum') {
          const albumMediaKey = document.getElementById(action.targetId)?.value;
          targetAlbum = (getFromStorage('albums') ?? []).find((album) => album.mediaKey === albumMediaKey);
          if (!targetAlbum) {
              log('Select a target album first (press Refresh if the list is empty)', 'error');
              return;
          }
      }
      else if (actionId === 'toNewAlbum') {
          newTargetAlbumName = document.getElementById(action.targetId)?.value?.trim();
          if (!newTargetAlbumName) {
              log('Enter a name for the new album', 'error');
              return;
          }
      }
      const filtersForm = document.querySelector('.filters-form');
      if (filtersForm && !filtersForm.checkValidity()) {
          filtersForm.reportValidity();
          return;
      }
      const filter = getFormData('.filters-form');
      const validationError = validateFilter(filter);
      if (validationError) {
          log(validationError, 'error');
          return;
      }
      const apiSettings = getFormData('.settings-form');
      const dryRun = document.getElementById('dryRun')?.checked ?? false;
      const actionEl = document.getElementById(actionId);
      disableActionBar(true);
      actionEl?.classList.add('running');
      try {
          await core.actionWithFilter(action, filter, source, targetAlbum, newTargetAlbumName, apiSettings, {
              dryRun,
              confirm: (count) => userConfirmation(action, filter, count),
          });
      }
      finally {
          actionEl?.classList.remove('running');
          updateUI();
          showActionButtons();
      }
  }
  function showContainer(selector) {
      const actionButtons = document.querySelector('.action-buttons');
      const container = document.querySelector(selector);
      if (actionButtons) actionButtons.style.display = 'none';
      if (container) container.style.display = 'flex';
  }
  function showActionButtons() {
      const actionButtons = document.querySelector('.action-buttons');
      if (actionButtons) actionButtons.style.display = 'flex';
      for (const sel of ['.to-existing-container', '.to-new-container']) {
          const el = document.querySelector(sel);
          if (el) el.style.display = 'none';
      }
  }
  function actionsListenersSetUp() {
      for (const action of actions) {
          const actionElement = document.getElementById(action.elementId);
          if (!actionElement) continue;
          if (actionElement.tagName.toLowerCase() === 'form') {
              actionElement.addEventListener('submit', (event) => {
                  event.preventDefault();
                  void runAction(actionElement.id);
              });
          }
          else {
              actionElement.addEventListener('click', (event) => {
                  event.preventDefault();
                  if (actionElement.classList.contains('not-applicable')) return;
                  void runAction(actionElement.id);
              });
          }
      }
      document.querySelector('#showExistingAlbumForm')?.addEventListener('click', () => showContainer('.to-existing-container'));
      document.querySelector('#showNewAlbumForm')?.addEventListener('click', () => showContainer('.to-new-container'));
      for (const button of document.querySelectorAll('.return')) button.addEventListener('click', showActionButtons);
  }

  function albumSelectsControlsSetUp() {
      const closestSelect = (button) => button.parentNode?.parentNode?.querySelector('select');
      const bind = (name, fn) => {
          for (const button of document.querySelectorAll(`[name="${name}"]`)) {
              button.addEventListener('click', () => {
                  const select = closestSelect(button);
                  if (select) {
                      for (const option of select.options) fn(option);
                  }
                  updateUI();
              });
          }
      };
      bind('selectAll', (option) => {
          if (option.value) option.selected = true;
      });
      bind('selectShared', (option) => {
          if (option.value) option.selected = option.classList.contains('shared');
      });
      bind('selectNonShared', (option) => {
          if (option.value) option.selected = !option.classList.contains('shared');
      });
      bind('resetAlbumSelection', (option) => {
          option.selected = false;
      });
      for (const refreshAlbumsButton of document.querySelectorAll('.refresh-albums')) {
          refreshAlbumsButton.addEventListener('click', () => void refreshAlbums());
      }
  }
  async function refreshAlbums() {
      // 3.3.0 allowed this during a running task and then cleared the running flag at the end.
      if (core.isProcessRunning) {
          log('Wait for the current task to finish before refreshing albums', 'warn');
          return;
      }
      core.isProcessRunning = true;
      updateUI();
      try {
          log('Refreshing albums');
          const albums = await apiUtils.getAllAlbums();
          addAlbums(albums);
          saveToStorage('albums', albums);
          log(`Albums refreshed (${albums.length})`);
      }
      catch (e) {
          log(`Error refreshing albums: ${errorMessage(e)}`, 'error');
      }
      finally {
          core.isProcessRunning = false;
          updateUI();
      }
  }

  function controlButtonsListeners() {
      document.getElementById('clearLog')?.addEventListener('click', () => {
          const logContainer = document.getElementById('logArea');
          if (logContainer) logContainer.replaceChildren();
      });
      document.getElementById('stopProcess')?.addEventListener('click', () => {
          log('Stopping the process (in-flight requests will finish first)', 'warn');
          core.isProcessRunning = false;
      });
  }

  function advancedSettingsListenersSetUp() {
      const inputs = {};
      for (const key of Object.keys(apiSettingsDefault)) {
          inputs[key] = document.querySelector(`.settings-form input[name="${key}"]`);
      }
      const restoredSettings = getFromStorage('apiSettings') ?? {};
      for (const [key, input] of Object.entries(inputs)) {
          if (input) input.value = String(restoredSettings[key] ?? apiSettingsDefault[key]);
      }
      document.querySelector('.settings-form')?.addEventListener('submit', (event) => {
          event.preventDefault();
          saveToStorage('apiSettings', getFormData('.settings-form'));
          log('Api settings saved');
      });
      document.querySelector('.settings-form button[name="default"]')?.addEventListener('click', (event) => {
          event.preventDefault();
          saveToStorage('apiSettings', apiSettingsDefault);
          for (const [key, input] of Object.entries(inputs)) {
              if (input) input.value = String(apiSettingsDefault[key]);
          }
          log('Default api settings restored');
      });
  }

  function filterListenersSetUp() {
      for (const resetButton of document.querySelectorAll('[name="dateReset"]')) {
          resetButton.addEventListener('click', () => {
              const input = resetButton.parentNode?.querySelector('input');
              if (input) input.value = '';
              resetButton.classList.add('clicked');
              setTimeout(() => resetButton.classList.remove('clicked'), 500);
              updateUI();
          });
      }
      document.querySelector('#filterResetButton')?.addEventListener('click', () => {
          document.querySelector('.filters-form')?.reset();
          updateUI();
      });
  }

  function initUI() {
      try {
          GM_registerMenuCommand('Open GPTK window', showMainMenu);
      }
      catch (error) {
          console.warn('[GPTK] Could not register menu command', error);
      }
      insertUi();
      actionsListenersSetUp();
      filterListenersSetUp();
      controlButtonsListeners();
      albumSelectsControlsSetUp();
      advancedSettingsListenersSetUp();
      updateUI();
      const cachedAlbums = getFromStorage('albums');
      if (cachedAlbums) {
          log('Cached Albums Restored');
          addAlbums(cachedAlbums);
      }
      window.addEventListener('beforeunload', (e) => {
          if (core.isProcessRunning) {
              e.preventDefault();
              e.returnValue = ''; // required by Chrome/Firefox to actually show the prompt
          }
      });
  }

  try {
      initUI();
  }
  catch (error) {
      console.error('[GPTK] Failed to initialise UI', error);
  }

})();

// ════════════════════════════════════════════════════════════
//  DUPLICATE FINDER (was a separate script; uses unsafeWindow.gptkApi set above)
// ════════════════════════════════════════════════════════════
(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const STORE = 'gpdf:v1';
  const PAGE = 20;

  /* ------------------------------------------------------------------ helpers */
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
    return el;
  };
  const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (ms, offMs) => { if (!ms) return '—'; const d = new Date(ms + (offMs || 0)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
  const fmtBytes = (b) => b == null ? '—' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB';
  const chunks = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  const pool = async (list, n, fn) => { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < list.length) { const k = i++; await fn(list[k], k); } })); };
  const thumb = (u, s) => u ? u.replace(/=[^/]*$/, '') + `=w${s}-h${s}` : '';
  const lower = (s) => (s || '').toLowerCase();
  const stemOf = (n) => lower(n).replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)$/, '').replace(/[_ -](copy|edited)$/, '');
  const pop = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
  const load = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (e) { return {}; } };
  const save = (o) => { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) { /* storage full or blocked */ } };

  /* fingerprint cache in IndexedDB: dedupKey -> [hi, lo] */
  const idb = (() => {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise(res => { try { const r = indexedDB.open('gpdf', 1); r.onupgradeneeded = () => r.result.createObjectStore('fp'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } }));
    return {
      async getAll() { const db = await open(); const out = new Map(); if (!db) return out; return new Promise(res => { try { const rq = db.transaction('fp').objectStore('fp').openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { out.set(c.key, c.value); c.continue(); } else res(out); }; rq.onerror = () => res(out); } catch (e) { res(out); } }); },
      async put(entries) { const db = await open(); if (!db || !entries.length) return; return new Promise(res => { try { const t = db.transaction('fp', 'readwrite'); const st = t.objectStore('fp'); for (const [k, v] of entries) st.put(v, k); t.oncomplete = t.onerror = () => res(); } catch (e) { res(); } }); },
    };
  })();

  function gmBlob(url) {
    return new Promise((res, rej) => {
      GM_xmlhttpRequest({ method: 'GET', url, responseType: 'blob', timeout: 20000,
        onload: r => (r.status >= 200 && r.status < 300 && r.response ? res(r.response) : rej(new Error('HTTP ' + r.status))),
        onerror: () => rej(new Error('network')), ontimeout: () => rej(new Error('timeout')) });
    });
  }
  const cvA = document.createElement('canvas'); cvA.width = 9; cvA.height = 8;
  const ctxA = cvA.getContext('2d', { willReadFrequently: true });
  async function fingerprint(url) {
    const bmp = await createImageBitmap(await gmBlob(thumb(url, 64)));
    ctxA.clearRect(0, 0, 9, 8); ctxA.imageSmoothingQuality = 'high'; ctxA.drawImage(bmp, 0, 0, 9, 8); bmp.close && bmp.close();
    const d = ctxA.getImageData(0, 0, 9, 8).data; const g = new Float32Array(72);
    for (let i = 0; i < 72; i++) g[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    let hi = 0, lo = 0, bit = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++, bit++) { const b = g[y * 9 + x] < g[y * 9 + x + 1] ? 1 : 0; if (bit < 32) hi = (hi | (b << bit)) >>> 0; else lo = (lo | (b << (bit - 32))) >>> 0; }
    return [hi, lo];
  }

  /* ------------------------------------------------------------------ styles */
  const css = `
  #gpdf{position:fixed;inset:0;z-index:2147483000;background:#f4f5f7;color:#1c2128;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;flex-direction:column}
  #gpdf *{box-sizing:border-box}
  #gpdf .top,#gpdf .bar{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:10px 20px;background:#fff;border-bottom:1px solid #dde1e6}
  #gpdf h1{font-size:18px;margin:0 10px 0 0}
  #gpdf .btn{border:1px solid #c9ced6;background:#fff;border-radius:6px;padding:7px 12px;font:inherit;font-weight:600;cursor:pointer;color:inherit}
  #gpdf .btn:disabled{opacity:.45;cursor:not-allowed}
  #gpdf .btn.primary{background:#1a73e8;border-color:#1a73e8;color:#fff}
  #gpdf .btn.danger{background:#c5221f;border-color:#c5221f;color:#fff}
  #gpdf select,#gpdf input[type=text]{font:inherit;padding:5px 8px;border:1px solid #c9ced6;border-radius:6px;background:#fff;color:inherit}
  #gpdf label{display:inline-flex;gap:6px;align-items:center}
  #gpdf .muted{color:#5f6874;font-size:13px}
  #gpdf .tab{border:0;background:none;padding:5px 10px;border-radius:5px;font:inherit;cursor:pointer;color:#5f6874}
  #gpdf .tab[aria-selected=true]{background:#e8eaed;color:#1c2128;font-weight:600}
  #gpdf .main{flex:1;overflow:auto;padding:16px 20px 60px}
  #gpdf .msg{padding:10px 14px;border-radius:6px;background:#fff;border:1px solid #dde1e6;margin-bottom:12px}
  #gpdf .prog{height:6px;background:#e8eaed;border-radius:3px;overflow:hidden;margin-top:8px}#gpdf .prog i{display:block;height:100%;background:#1a73e8;width:0}
  #gpdf .group{background:#fff;border:1px solid #dde1e6;border-radius:8px;margin-bottom:14px;padding:12px 14px}
  #gpdf .group.dup{border-left:4px solid #c5221f}#gpdf .group.notdup{border-left:4px solid #188038}#gpdf .group.done{opacity:.6}
  #gpdf .ghead{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;margin-bottom:10px}
  #gpdf .chip{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:99px;border:1px solid currentColor}
  #gpdf .c-same{color:#c5221f}#gpdf .c-moment{color:#b06000}#gpdf .c-looks{color:#1a73e8}#gpdf .c-name{color:#5f6874}
  #gpdf .tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
  #gpdf .tile{border:2px solid #e3e6ea;border-radius:6px;overflow:hidden;display:flex;flex-direction:column}
  #gpdf .tile.keep{border-color:#188038}#gpdf .tile.drop img{opacity:.45}
  #gpdf .tile img{width:100%;aspect-ratio:1;object-fit:contain;background:#e8eaed;display:block;cursor:zoom-in}
  #gpdf .tile .info{padding:6px 8px;font-size:12px;flex:1}
  #gpdf .tile .nm{font-weight:600;word-break:break-all}
  #gpdf .tile .best{color:#188038;font-weight:700}
  #gpdf .tile .kb{border:0;border-top:1px solid #e3e6ea;background:#fafbfc;padding:7px 8px;font:inherit;font-weight:600;cursor:pointer;text-align:left;color:inherit}
  #gpdf .tile.keep .kb{color:#188038}
  #gpdf .pager{display:flex;gap:8px;align-items:center;justify-content:center;margin:10px 0}
  #gpdf .lb{position:fixed;inset:0;background:#000d;display:grid;place-items:center;z-index:2147483001;cursor:zoom-out}
  #gpdf .lb img{max-width:92vw;max-height:88vh}
  @media (prefers-color-scheme: dark){
    #gpdf{background:#1b1c1f;color:#e3e3e3}#gpdf .top,#gpdf .bar,#gpdf .group,#gpdf .msg,#gpdf .btn,#gpdf select{background:#26272b;border-color:#3c4043;color:#e3e3e3}
    #gpdf .tile{border-color:#3c4043}#gpdf .tile .kb{background:#202124;border-color:#3c4043}#gpdf .tab[aria-selected=true]{background:#3c4043;color:#fff}
    #gpdf .tile img{background:#303134}#gpdf .btn.primary{background:#8ab4f8;border-color:#8ab4f8;color:#202124}}`;

  /* ------------------------------------------------------------------ state */
  const S = { items: [], groups: [], albums: [], filter: 'open', page: 0, opts: { source: 'library', type: 'both', same: true, moment: true, looks: true, thr: 6 },
    keepAlbums: true, oldestDate: false, log: [] };
  let root, bar, main, scanning = false;
  const api = () => W.gptkApi;

  function open() {
    if (!api()) { alert('Google Photos Toolkit (GPTK) is not loaded yet. Install/enable it and reload this page.'); return; }
    if (root) { root.style.display = 'flex'; return; }
    const style = h('style'); style.textContent = css;
    root = h('div', { id: 'gpdf' }, style);
    bar = h('div', { class: 'bar' }); main = h('div', { class: 'main' });
    root.append(renderTop(), bar, main);
    document.body.append(root);
    renderAll();
    S.albumsReady = loadAlbumList(); // scan() waits for it, so album carry-over never runs on a half-loaded list
  }
  function renderTop() {
    const o = S.opts;
    const src = h('select', { onchange: e => { o.source = e.target.value; } }, h('option', { value: 'library' }, 'Whole library'));
    S.srcSelect = src;
    const type = h('select', { onchange: e => { o.type = e.target.value; } }, h('option', { value: 'both' }, 'Photos & videos'), h('option', { value: 'photo' }, 'Photos'), h('option', { value: 'video' }, 'Videos'));
    const chk = (k, label) => h('label', {}, h('input', { type: 'checkbox', checked: o[k], onchange: e => { o[k] = e.target.checked; } }), label);
    const thr = h('select', { onchange: e => { o.thr = +e.target.value; } }, h('option', { value: 3 }, 'strict'), h('option', { value: 6, selected: true }, 'normal'), h('option', { value: 10 }, 'loose'));
    S.status = h('span', { class: 'muted' });
    return h('div', { class: 'top' }, h('h1', {}, 'Duplicate Finder'), src, type,
      chk('same', 'Same name + size'), chk('moment', 'Same moment'), chk('looks', 'Look-alike'), h('label', {}, 'strictness', thr),
      h('button', { class: 'btn primary', onclick: scan }, 'Scan'), S.status, h('span', { style: 'flex:1' }),
      h('button', { class: 'btn', onclick: () => { root.style.display = 'none'; } }, 'Close'));
  }
  async function loadAlbumList() {
    try {
      let pid = null; const out = [];
      do { const p = await api().getAlbums(pid); if (!p) break; pid = p.nextPageId || null; out.push(...(p.items || []).filter(a => !a.isShared)); } while (pid);
      S.albums = out;
      for (const a of out.sort((x, y) => lower(x.title).localeCompare(lower(y.title)))) S.srcSelect.append(h('option', { value: a.mediaKey }, `Album: ${a.title} (${a.itemCount ?? '?'})`));
    } catch (e) {
      // without the list, "add kept photo to the albums of removed copies" would silently do nothing; apply() refuses instead
      S.albumsFailed = true; console.error('[duplicate finder] album list', e);
      S.status.textContent = 'Could not read your album list. Reload the page before removing duplicates.';
    }
  }

  /* ------------------------------------------------------------------ scan */
  const setStatus = (t, frac) => {
    clear(main).append(h('div', { class: 'msg' }, t, frac != null ? h('div', { class: 'prog' }, h('i', { style: `width:${Math.round(frac * 100)}%` })) : null));
  };
  async function scan() {
    if (scanning) return; scanning = true;
    const o = { ...S.opts }, A = api();
    try {
      // 1. items
      let list = [];
      if (o.source === 'library') {
        let pid = null, ts = null;
        do {
          const p = await A.getItemsByTakenDate(ts, null, pid); if (!p) break;
          pid = p.nextPageId || null; ts = Number.isFinite(p.lastItemTimestamp) ? p.lastItemTimestamp - 1 : null;
          list.push(...(p.items || [])); setStatus(`Reading your library… ${list.length.toLocaleString()} items`);
        } while (pid);
      } else {
        let pid = null;
        do { const p = await A.getAlbumPage(o.source, pid); if (!p) break; pid = p.nextPageId || null; list.push(...(p.items || [])); setStatus(`Reading the album… ${list.length}`); } while (pid);
        // album items carry album-scoped keys: find their library entries by dedupKey
        const want = new Set(list.map(i => i.dedupKey)); const lib = new Map(); let pid2 = null, ts = null;
        do { const p = await A.getItemsByTakenDate(ts, null, pid2); if (!p) break; pid2 = p.nextPageId || null; ts = Number.isFinite(p.lastItemTimestamp) ? p.lastItemTimestamp - 1 : null;
          for (const it of p.items || []) if (want.has(it.dedupKey)) lib.set(it.dedupKey, it); setStatus(`Matching album photos to your library… ${lib.size}/${want.size}`); } while (pid2 && lib.size < want.size);
        list = [...lib.values()];
      }
      const seen = new Set(); list = list.filter(i => !seen.has(i.mediaKey) && seen.add(i.mediaKey));
      list = list.filter(i => o.type === 'both' || (o.type === 'video') === !!i.duration);
      if (!list.length) { setStatus('No photos found for that choice.'); return; }
      // 2. names + sizes
      const info = new Map(); let done = 0;
      await pool(chunks(list.map(i => i.mediaKey), 1000), 3, async c => {
        let r = null; for (let t = 0; t < 3 && !r; t++) { try { r = await A.getBatchMediaInfo(c); } catch (e) { await new Promise(z => setTimeout(z, 1500)); } }
        for (const x of r || []) info.set(x.mediaKey, x);
        done += c.length; setStatus(`Reading file names and sizes… ${done.toLocaleString()}/${list.length.toLocaleString()}`, done / list.length);
      });
      S.items = list.map((it, i) => { const m = info.get(it.mediaKey) || {}; return { i, k: it.mediaKey, d: it.dedupKey, thumb: it.thumb, w: it.resWidth, h: it.resHeight,
        t: it.timestamp, tz: it.timezoneOffset ?? m.timezoneOffset ?? 0, up: it.creationTimestamp, video: !!it.duration, fav: !!it.isFavorite,
        name: m.fileName || '', size: m.size ?? null, orig: m.isOriginalQuality, dh: null }; });
      // 3. look-alike fingerprints (cached)
      if (o.looks) {
        const cache = await idb.getAll(); const need = [], fresh = [];
        for (const it of S.items) { const c = cache.get(it.d); if (c) it.dh = c; else if (it.thumb) need.push(it); }
        let n = 0, failed = 0;
        await pool(need, 8, async it => {
          try { it.dh = await fingerprint(it.thumb); fresh.push([it.d, it.dh]); } catch (e) { failed++; }
          if (++n % 25 === 0 || n === need.length) setStatus(`Fingerprinting thumbnails… ${n.toLocaleString()}/${need.length.toLocaleString()} (${(S.items.length - need.length).toLocaleString()} remembered from last time)`, n / need.length);
          if (fresh.length >= 500) await idb.put(fresh.splice(0));
        });
        await idb.put(fresh);
        if (failed) console.warn(`[duplicate finder] ${failed} thumbnails could not be read`);
      }
      // 4. albums each item is in (to carry them over to the kept photo)
      setStatus('Reading albums…');
      await S.albumsReady;
      S.inAlbums = new Map(); S.albumTitle = {};
      await pool(S.albums, 3, async a => {
        S.albumTitle[a.mediaKey] = a.title; let pid = null;
        do { const p = await A.getAlbumPage(a.mediaKey, pid); if (!p) break; pid = p.nextPageId || null;
          for (const it of p.items || []) (S.inAlbums.get(it.dedupKey) || S.inAlbums.set(it.dedupKey, new Set()).get(it.dedupKey)).add(a.mediaKey); } while (pid);
      });
      setStatus('Grouping…');
      await group(o);
      S.filter = 'open'; S.page = 0;
      S.status.textContent = `${S.items.length.toLocaleString()} items scanned · ${S.groups.length} groups`;
      scanning = false;
      renderAll();
    } catch (e) { setStatus('Scan failed: ' + (e.message || e)); console.error(e); }
    finally { scanning = false; }
  }

  async function group(o) {
    const F = S.items, n = F.length, par = new Int32Array(n).map((_, i) => i);
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const why = new Map();
    const link = (a, b, r) => { const ra = find(a), rb = find(b); if (ra !== rb) par[ra] = rb; why.set(a, (why.get(a) || new Set()).add(r)); why.set(b, (why.get(b) || new Set()).add(r)); };
    const aspect = it => (it.w && it.h ? it.w / it.h : 0);
    const sameAspect = (a, b) => { const x = aspect(a), y = aspect(b); return !x || !y || Math.abs(x - y) / Math.max(x, y) < 0.05 || Math.abs(x - 1 / y) / Math.max(x, 1 / y) < 0.05; };
    if (o.same) { const m = new Map(); F.forEach((f, i) => { if (!f.name || f.size == null) return; const key = lower(f.name) + '|' + f.size; if (m.has(key)) link(m.get(key), i, 'same'); else m.set(key, i); }); }
    if (o.moment) {
      const m = new Map(); F.forEach((f, i) => { if (!f.t) return; const key = Math.floor(f.t / 1000) + '|' + f.video; (m.get(key) || m.set(key, []).get(key)).push(i); });
      for (const a of m.values()) if (a.length > 1 && a.length <= 30) for (let x = 0; x < a.length; x++) for (let y = x + 1; y < a.length; y++) if (sameAspect(F[a[x]], F[a[y]])) link(a[x], a[y], 'moment');
    }
    if (o.looks) {
      const idx = []; F.forEach((f, i) => { if (f.dh) { const b = pop(f.dh[0]) + pop(f.dh[1]); if (b >= 6 && b <= 58) idx.push(i); } });
      const H = new Uint32Array(idx.map(i => F[i].dh[0])), L = new Uint32Array(idx.map(i => F[i].dh[1]));
      for (let x = 0; x < idx.length; x++) {
        // every photo vs every other: ~8 s at 60k photos, so yield now and then to keep the tab responsive
        if (x % 500 === 499) { setStatus(`Comparing look-alikes… ${x.toLocaleString()}/${idx.length.toLocaleString()}`, x / idx.length); await new Promise(z => setTimeout(z, 0)); }
        for (let y = x + 1; y < idx.length; y++)
          if (pop(H[x] ^ H[y]) + pop(L[x] ^ L[y]) <= o.thr && sameAspect(F[idx[x]], F[idx[y]])) link(idx[x], idx[y], 'looks');
      }
    }
    const gm = new Map();
    for (let i = 0; i < n; i++) { if (!why.has(i)) continue; const r = find(i); (gm.get(r) || gm.set(r, []).get(r)).push(i); }
    const saved = load().decisions || {};
    S.groups = [...gm.values()].filter(g => g.length > 1).map(ids => {
      ids.sort((a, b) => rank(F[a], F[b]));
      const reasons = new Set(); ids.forEach(i => why.get(i).forEach(r => reasons.add(r)));
      if (new Set(ids.map(i => stemOf(F[i].name))).size === 1) reasons.add('name');
      const sig = ids.map(i => F[i].d).sort().join(',');
      const g = { ids, reasons: [...reasons], sig, keep: new Set([ids[0]]), status: 'open' };
      const sv = saved[sig]; if (sv) { g.status = sv.s; if (sv.k) { const k = ids.filter(i => sv.k.includes(F[i].d)); if (k.length) g.keep = new Set(k); } }
      return g;
    }).sort((a, b) => (b.reasons.includes('same') - a.reasons.includes('same')) || b.ids.length - a.ids.length);
  }
  function rank(a, b) {
    const px = x => (x.w || 0) * (x.h || 0);
    return (px(b) - px(a)) || ((b.size || 0) - (a.size || 0)) || ((b.orig ? 1 : 0) - (a.orig ? 1 : 0)) || ((a.t || 9e15) - (b.t || 9e15)) || ((a.up || 9e15) - (b.up || 9e15)) ||
      ((/\(\d+\)/.test(a.name) ? 1 : 0) - (/\(\d+\)/.test(b.name) ? 1 : 0));
  }
  function persist() {
    const st = load(); st.decisions = st.decisions || {};
    for (const g of S.groups) { if (g.status === 'open') delete st.decisions[g.sig]; else st.decisions[g.sig] = { s: g.status, k: [...g.keep].map(i => S.items[i].d) }; }
    save(st);
  }

  /* ------------------------------------------------------------------ render */
  const REASON = { same: ['c-same', 'Same name + size'], moment: ['c-moment', 'Same moment'], looks: ['c-looks', 'Look-alike'], name: ['c-name', 'Same name'] };
  // a confirmed group with nothing kept (last "Keep" un-ticked) is skipped: never trash every copy
  function toTrash() { const out = []; for (const g of S.groups) if (g.status === 'dup' && g.keep.size) for (const i of g.ids) if (!g.keep.has(i)) out.push({ it: S.items[i], g }); return out; }
  function renderAll() { renderBar(); renderList(); }
  function renderBar() {
    if (!bar) return;
    const c = s => S.groups.filter(g => s === 'all' || g.status === s).length;
    const tab = (k, l) => h('button', { class: 'tab', 'aria-selected': String(S.filter === k), onclick: () => { S.filter = k; S.page = 0; renderAll(); } }, `${l} ${c(k)}`);
    const tt = toTrash(); const bytes = tt.reduce((s, x) => s + (x.it.size || 0), 0);
    clear(bar).append(...[tab('open', 'To review'), tab('dup', 'Duplicates'), tab('notdup', 'Not duplicates'), tab('done', 'Removed'), tab('all', 'All'),
      h('span', { style: 'flex:1' }),
      h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: S.keepAlbums, onchange: e => { S.keepAlbums = e.target.checked; } }), 'Add kept photo to the albums of removed copies'),
      h('label', { class: 'muted' }, h('input', { type: 'checkbox', checked: S.oldestDate, onchange: e => { S.oldestDate = e.target.checked; } }), 'Give kept photo the oldest date taken'),
      S.log.length ? h('button', { class: 'btn', onclick: downloadLog }, 'Download log') : null,
      h('button', { class: 'btn danger', disabled: !tt.length, onclick: apply }, `Move ${tt.length} to trash (${fmtBytes(bytes)})`)].filter(Boolean));
  }
  function renderList() {
    if (!main || scanning) return;
    clear(main);
    if (!S.groups.length) { main.append(h('div', { class: 'msg' }, S.items.length ? 'No duplicates found with these checks.' : 'Choose what to scan and press Scan. Look-alike checking fetches a small thumbnail of every photo the first time; later scans reuse them.')); return; }
    const list = S.groups.filter(g => S.filter === 'all' || g.status === S.filter);
    if (!list.length) { main.append(h('div', { class: 'msg' }, S.filter === 'open' ? 'All groups reviewed. See the Duplicates tab, then press "Move to trash".' : 'Nothing here.')); return; }
    const pages = Math.ceil(list.length / PAGE); S.page = Math.min(S.page, pages - 1);
    const pager = () => h('div', { class: 'pager' }, h('button', { class: 'btn', disabled: S.page === 0, onclick: () => { S.page--; renderList(); main.scrollTop = 0; } }, '← Prev'),
      h('span', { class: 'muted' }, `Page ${S.page + 1} of ${pages} · ${list.length} groups`), h('button', { class: 'btn', disabled: S.page >= pages - 1, onclick: () => { S.page++; renderList(); main.scrollTop = 0; } }, 'Next →'));
    main.append(pager());
    for (const g of list.slice(S.page * PAGE, (S.page + 1) * PAGE)) main.append(renderGroup(g));
    main.append(pager());
  }
  function renderGroup(g) {
    const F = g.ids.map(i => S.items[i]);
    const maxPx = Math.max(...F.map(f => (f.w || 0) * (f.h || 0))), maxSz = Math.max(...F.map(f => f.size || 0)), minT = Math.min(...F.map(f => f.t || 9e15));
    const differ = (vals) => new Set(vals).size > 1;
    const head = h('div', { class: 'ghead' }, ...g.reasons.map(r => h('span', { class: 'chip ' + REASON[r][0] }, REASON[r][1])),
      h('span', { class: 'muted' }, `${F.length} items`), h('span', { style: 'flex:1' }));
    if (g.status === 'done') head.append(h('span', { class: 'muted' }, 'Extra copies moved to trash'));
    else {
      head.append(h('button', { class: 'btn', onclick: () => { g.status = g.status === 'notdup' ? 'open' : 'notdup'; persist(); renderAll(); } }, g.status === 'notdup' ? 'Undo "not duplicates"' : 'Not duplicates'));
      head.append(h('button', { class: g.status === 'dup' ? 'btn' : 'btn primary', onclick: () => { if (!g.keep.size) { alert('Choose at least one to keep.'); return; } g.status = g.status === 'dup' ? 'open' : 'dup'; persist(); renderAll(); } }, g.status === 'dup' ? 'Undo' : 'Duplicates: keep selected'));
    }
    const tiles = h('div', { class: 'tiles' });
    F.forEach((f, n) => {
      const id = g.ids[n], keep = g.keep.has(id);
      const albums = [...(S.inAlbums?.get(f.d) || [])].map(a => S.albumTitle[a]).filter(Boolean);
      const best = (cond) => cond ? h('span', { class: 'best' }, ' ▲') : null;
      tiles.append(h('div', { class: 'tile ' + (g.status === 'notdup' ? '' : keep ? 'keep' : g.status === 'dup' || g.status === 'done' ? 'drop' : '') },
        h('img', { src: thumb(f.thumb, 360), alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onclick: () => lightbox(f) }),
        h('div', { class: 'info' },
          h('div', { class: 'nm' }, f.name || '(no name)'),
          h('div', {}, `${f.w && f.h ? `${f.w}×${f.h}` : '—'}`, best(differ(F.map(x => (x.w || 0) * (x.h || 0))) && (f.w || 0) * (f.h || 0) === maxPx), ` · ${fmtBytes(f.size)}`, best(differ(F.map(x => x.size)) && f.size === maxSz)),
          h('div', { class: 'muted' }, 'Taken ', fmtDate(f.t, f.tz), best(differ(F.map(x => x.t)) && f.t === minT)),
          h('div', { class: 'muted' }, 'Uploaded ', fmtDate(f.up, f.tz)),
          f.video ? h('div', { class: 'muted' }, 'Video') : null,
          albums.length ? h('div', { class: 'muted' }, 'Albums: ' + albums.join(', ')) : null,
          h('a', { href: `https://photos.google.com/photo/${f.k}`, target: '_blank', rel: 'noopener', class: 'muted' }, 'Open in Google Photos')),
        g.status === 'done' ? null : h('button', { class: 'kb', onclick: () => { if (g.keep.has(id)) g.keep.delete(id); else g.keep.add(id); if (g.status === 'notdup') g.status = 'open'; persist(); const fresh = renderGroup(g); el.replaceWith(fresh); renderBar(); } },
          keep ? 'Keep ✓' : (g.status === 'dup' ? 'Will be trashed' : 'Keep this one'), id === g.ids[0] ? h('span', { class: 'muted' }, '  (suggested)') : null)));
    });
    const el = h('div', { class: 'group ' + g.status }, head, tiles);
    return el;
  }
  function lightbox(f) {
    const lb = h('div', { class: 'lb', onclick: () => lb.remove() }, h('img', { src: thumb(f.thumb, 1600), alt: f.name, referrerpolicy: 'no-referrer' }));
    root.append(lb);
  }

  /* ------------------------------------------------------------------ apply */
  async function apply() {
    // a running scan has already replaced S.items, so the old groups' indices would point at different photos
    if (scanning) { alert('Wait for the scan to finish.'); return; }
    const tt = toTrash(); if (!tt.length) return;
    if (S.keepAlbums && S.albumsFailed) { alert('Your album list could not be read, so kept photos cannot be added to the albums of removed copies.\nReload the page and scan again, or untick "Add kept photo to the albums of removed copies".'); return; }
    const groups = [...new Set(tt.map(x => x.g))];
    if (!confirm(`Move ${tt.length} duplicate(s) from ${groups.length} group(s) to Google Photos trash?` +
      (S.keepAlbums ? '\nKept photos will first be added to the albums the removed copies were in.' : '') +
      (S.oldestDate ? '\nKept photos will get the oldest date taken in their group.' : '') + '\nYou can restore them from the trash for 60 days.')) return;
    const A = api(); let ok = 0, fail = 0;
    for (const g of groups) {
      const keep = [...g.keep].map(i => S.items[i]), drop = g.ids.filter(i => !g.keep.has(i)).map(i => S.items[i]);
      try {
        if (S.keepAlbums) {
          const need = new Set(); drop.forEach(d => (S.inAlbums?.get(d.d) || []).forEach(a => need.add(a)));
          for (const a of need) { const missing = keep.filter(k => !(S.inAlbums?.get(k.d) || new Set()).has(a)).map(k => k.k); if (missing.length) await A.addItemsToAlbum(missing, a); }
        }
        if (S.oldestDate) {
          const all = [...keep, ...drop].filter(x => x.t); const old = all.reduce((p, c) => (c.t < p.t ? c : p), all[0]);
          const upd = keep.filter(k => old && k.t > old.t).map(k => ({ dedupKey: k.d, timestampSec: Math.floor(old.t / 1000), timezoneSec: Math.round((old.tz || 0) / 1000) }));
          if (upd.length) await A.setItemsTimestamp(upd);
        }
        await A.moveItemsToTrash(drop.map(d => d.d));
        g.status = 'done'; ok += drop.length;
        S.log.push({ at: new Date().toISOString(), kept: keep.map(k => k.name + ' [' + k.k + ']').join(' | '), removed: drop.map(d => d.name + ' [' + d.k + ']').join(' | '), reasons: g.reasons.join(' ') });
      } catch (e) { fail += drop.length; console.error('[duplicate finder]', e); }
    }
    persist(); renderAll();
    alert(`Moved ${ok} to trash.` + (fail ? ` ${fail} failed and are still marked as duplicates.` : ''));
  }
  function downloadLog() {
    const q = s => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['when', 'kept', 'moved_to_trash', 'matched_by'].join(',')].concat(S.log.map(r => [r.at, r.kept, r.removed, r.reasons].map(q).join(',')));
    const a = h('a', { href: URL.createObjectURL(new Blob([rows.join('\r\n')], { type: 'text/csv' })), download: 'duplicate_finder_log.csv' });
    document.body.append(a); a.click(); a.remove();
  }

  /* ------------------------------------------------------------------ launcher */
  function addButton() {
    if (document.getElementById('gpdf-btn')) return;
    const style = h('style'); style.textContent = '#gpdf-btn{position:fixed;right:20px;bottom:20px;z-index:2147482000;background:#1a73e8;color:#fff;border:0;border-radius:24px;padding:10px 16px;font:600 14px/1 system-ui,sans-serif;box-shadow:0 2px 8px #0004;cursor:pointer}';
    document.head.append(style);
    document.body.append(h('button', { id: 'gpdf-btn', onclick: open, title: 'Find duplicate photos (needs Google Photos Toolkit)' }, 'Find duplicates'));
  }
  const wait = setInterval(() => { if (document.body) { clearInterval(wait); addButton(); } }, 500);
})();
