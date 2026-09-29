# ImpactLens

An initial full-stack application for the Cloudinary sustainability-media challenge. It provides:

- an active-project dashboard;
- a single chat-style event brief that creates a structured evidence profile;
- hard-drive folder selection and one batch intake action;
- a batch-upload endpoint that attaches Cloudinary tags and contextual metadata;
- an automatic redirect to an evidence-review workspace after intake;
- configuration checks before any upload begins.

## Run locally

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and add your Cloudinary credentials.
3. Start the frontend and API server: `npm run dev`
4. Open the Vite URL shown in the terminal, usually `http://localhost:5173`.

Cloudinary secrets stay in `.env` and are only used by `server/index.js`; they are never sent to the browser.

## Real upload behavior

Choose **New intake**, describe the event in the chat-style prompt, select one or more source folders, and choose **Start smart intake**. When the batch is done, the app takes the user to the evidence-review workspace. Assets are placed in a Cloudinary folder like:

`impactlens/<project>/<event>/<source-folder>`

Each asset receives application tags plus context fields for event name, project, date, location, folder brief, and evidence goal. Set `ENABLE_AUTO_TAGGING=true` only after enabling Cloudinary's Google Auto Tagging add-on for the account.

This initial implementation keeps uploads at 100 MB per asset and uses an in-memory server upload. For a production bulk-importer, move to direct signed/chunked uploads with durable job records and webhook-based processing.
