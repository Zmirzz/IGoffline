# IGoffline Direct

A frontend-only Instagram Direct archive viewer that recreates the familiar DM layout offline. Import the JSON files from your Instagram data download and browse every conversation without logging in. All parsing, search, and rendering happens locally in the browser; nothing is uploaded anywhere.

## Features
- **Inbox-style layout** – Conversation list, avatars, previews, and timestamps arranged just like Instagram Direct.
- **Drag & drop imports** – Drop the whole `messages` folder or individual `message_X.json` files; folders are flattened automatically.
- **Identity aware bubbles** – Pick your account name and messages will snap to the right-hand styling for “you”.
- **Message details** – Inline rendering for text, links, stories, calls, reactions, and attachment summaries (photos, videos, GIFs, audio, files).
- **Quick filtering** – Search the thread list by participant or title to jump straight to the conversation you need.
- **Merged export** – Repack the normalised conversations into a single JSON snapshot for safekeeping or sharing with another device.

## Getting Started
1. Request your Instagram data export, unzip the download locally, and locate the `messages/inbox` folder.
2. Open `index.html` in a modern browser (Chromium, Firefox, Safari 15+).
3. Drag the `messages` folder—or any subset of `message_X.json` files—onto the window, or click **Import archive** to browse for them.
4. Choose your account name in the picker so the viewer knows which side of the conversation is “you”.
5. Click a thread on the left to review the full history; use the search field to filter by participant or title.
6. Use **Export merged JSON** whenever you want to save the in-memory representation.

> **Tip**: Huge archives import faster if you load them in batches (e.g. a few thousand messages at a time). You can drop additional files later and the viewer will merge them into existing threads.

## Project Structure
```
.
├── index.html      # Application shell and layout
├── styles.css      # DM-inspired styling
└── src
    └── app.js      # Import logic, normalisation, rendering, and export helpers
```

## Data Expectations
- Works with the JSON structure produced by Instagram’s official “Download Your Information” tool.
- Each `message_X.json` file inside `messages/inbox/<thread>/` is parsed and merged by its `thread_path`.
- Media files (photos, videos, etc.) are referenced via their export-relative paths. They are not loaded automatically, but the viewer highlights their presence so you can open them manually if needed.

## Extending
- Add ZIP support by bundling a decompression library (e.g. `fflate`, `JSZip`) and feeding the JSON entries into `ingestFiles`.
- For richer media previews, use the stored `uri` values to fetch blobs via the File System Access API or by hosting the extracted media alongside the app.

## Browser Support
Latest Chrome/Edge, Firefox, and Safari 15+ are recommended. Mobile browsers with limited File System APIs may not support folder drops.

## License
This project is provided as-is with no explicit license. Adapt and extend it to suit your personal archive workflow.
