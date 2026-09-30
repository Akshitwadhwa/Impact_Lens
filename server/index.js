import "dotenv/config";
import express from "express";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { aiReady, describePhoto, interpretBrief, planAsk } from "./ai.js";
import { createEvent, findOrCreateEvent, getAsset, listAssets, listProjectAssets, listProjects, saveAsset, updateAssetInsight, updateAssetReview } from "./db.js";

const app = express();
const port = process.env.PORT || 3001;
const cloudinaryReady = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (cloudinaryReady) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1000, fileSize: 100 * 1024 * 1024 }
});

const APPLIED_CONFIDENCE = 0.72;
const UNCERTAIN_CONFIDENCE = 0.4;
const VISION_LIMIT = 10;
const visionCounts = new Map();

app.use(express.json());

let libraryReady = null;
function ensureLibrary() {
  if (!libraryReady) {
    libraryReady = importCloudinaryLibrary().catch((error) => {
      libraryReady = null;
      console.error("Could not copy existing Cloudinary assets into SQLite:", error?.error?.message || error.message);
    });
  }
  return libraryReady;
}

if (process.env.VERCEL) {
  app.use(async (_request, _response, next) => {
    await ensureLibrary();
    next();
  });
}

let statusCache = null;
let statusCheckedAt = 0;

app.get("/api/status", async (_request, response) => {
  const autoTagging = process.env.ENABLE_AUTO_TAGGING === "true";
  if (!cloudinaryReady) {
    return response.json({ cloudinaryReady: false, autoTagging, aiReady: aiReady() });
  }
  if (statusCache && Date.now() - statusCheckedAt < 20000) {
    return response.json(statusCache);
  }
  try {
    await cloudinary.api.ping();
    statusCache = { cloudinaryReady: true, autoTagging, aiReady: aiReady() };
  } catch (error) {
    const message = error?.error?.message || error.message || "Cloudinary rejected these credentials.";
    statusCache = {
      cloudinaryReady: false,
      autoTagging,
      aiReady: aiReady(),
      error: /cloud_name mismatch/i.test(message)
        ? "Cloudinary rejected the cloud name. Copy it again from the console, with no spaces."
        : message
    };
  }
  statusCheckedAt = Date.now();
  response.json(statusCache);
});

function cleanSegment(value = "untitled") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80) || "untitled";
}

function assertPublicId(value) {
  const id = String(value || "");
  if (!/^[A-Za-z0-9_./-]+$/.test(id) || id.includes("..")) {
    throw new Error("That asset id is not valid.");
  }
  return id;
}

function readContext(context) {
  if (!context) return {};
  if (context.custom && typeof context.custom === "object") return context.custom;
  return context;
}

function normalizeConfidence(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return score > 1 ? score / 100 : score;
}

function readSignals(result) {
  const rows = result?.info?.categorization?.google_tagging?.data || [];
  return rows
    .map((row) => {
      const confidence = normalizeConfidence(row.confidence);
      const status = confidence >= APPLIED_CONFIDENCE ? "applied" : confidence >= UNCERTAIN_CONFIDENCE ? "uncertain" : "hidden";
      return { tag: String(row.tag || "").trim(), confidence, status };
    })
    .filter((row) => row.tag && row.status !== "hidden");
}

function serializeSuggestions(signals) {
  return signals
    .filter((signal) => signal.status === "uncertain")
    .map((signal) => `${signal.tag.replace(/[|=]/g, " ")}:${signal.confidence.toFixed(2)}`)
    .join("|")
    .slice(0, 500);
}

function visibleTags(tags = []) {
  return tags.filter((tag) => tag !== "impactlens" && tag !== "needs-review" && !tag.startsWith("project-") && !tag.startsWith("event-") && !tag.startsWith("folder-"));
}

function readCapture(metadata = {}) {
  const capturedAt = metadata.DateTimeOriginal || metadata.CreateDate || metadata.DateTime || "";
  const lat = metadata.GPSLatitude;
  const lng = metadata.GPSLongitude;
  const gps = lat && lng ? `${lat}, ${lng}` : "";
  return { capturedAt, gps };
}

function previewUrl(publicId, resourceType) {
  if (resourceType === "video") {
    return cloudinary.url(publicId, {
      resource_type: "video",
      format: "jpg",
      secure: true,
      transformation: [{ width: 720, height: 480, crop: "fill", quality: "auto" }]
    });
  }
  return cloudinary.url(publicId, {
    resource_type: resourceType === "raw" ? "image" : resourceType,
    secure: true,
    transformation: [{ width: 960, height: 640, crop: "fill", quality: "auto", fetch_format: "auto", gravity: "auto" }]
  });
}

function shapeAsset(result, extras = {}) {
  const context = readContext(result.context);
  const capture = readCapture(result.image_metadata || {});
  const signals = extras.signals || [];
  const suggestions = extras.suggestedTags ?? context.suggested_tags ?? serializeSuggestions(signals);
  return {
    originalFilename: extras.originalFilename || result.original_filename || result.filename || "",
    assetId: result.asset_id,
    publicId: result.public_id,
    secureUrl: result.secure_url,
    previewUrl: previewUrl(result.public_id, result.resource_type),
    resourceType: result.resource_type,
    tags: visibleTags(result.tags || []),
    project: context.project_name || "",
    event: context.event_name || "",
    location: capture.gps || context.event_location || "",
    date: capture.capturedAt || context.event_date || result.created_at || "",
    createdAt: result.created_at || "",
    signals,
    suggestedTags: suggestions,
    suggestions: String(suggestions || "")
      .split("|")
      .map((part) => {
        const [tag, confidence] = part.split(":");
        const score = Number(confidence);
        if (!tag) return null;
        return { tag, confidence: Number.isFinite(score) ? score : null, status: "uncertain" };
      })
      .filter(Boolean),
    taggingStatus: extras.taggingStatus || (signals.length ? "ready" : "none"),
    needsReview: (result.tags || []).includes("needs-review") || signals.some((signal) => signal.status === "uncertain")
  };
}

function applyReading(asset, reading) {
  const confident = reading.confidence >= 0.6;
  const applied = confident ? reading.tags : [];
  const suggested = confident ? [] : reading.tags.map((tag) => `${tag}:${reading.confidence.toFixed(2)}`);
  const suggestedTags = [asset.suggestedTags, ...suggested].filter(Boolean).join("|");
  return {
    ...asset,
    caption: reading.caption,
    shot: reading.shot,
    light: reading.light,
    role: reading.role,
    tags: [...new Set([...(asset.tags || []), ...applied])],
    suggestedTags,
    suggestions: String(suggestedTags).split("|").filter(Boolean).map((part) => {
      const [tag, confidence] = part.split(":");
      const score = Number(confidence);
      return { tag, confidence: Number.isFinite(score) ? score : null, status: "uncertain" };
    }),
    needsReview: asset.needsReview || Boolean(suggestedTags)
  };
}

async function labelPhoto(asset) {
  const preview = asset.previewUrl || asset.secureUrl;
  if (!preview) return null;
  const reading = await describePhoto(preview);
  const labeled = applyReading(asset, reading);
  if (reading.confidence >= 0.6 && reading.tags.length && cloudinaryReady) {
    await cloudinary.uploader.add_tag(reading.tags, [asset.publicId], { resource_type: "image" });
  }
  updateAssetInsight(asset.publicId, labeled);
  return labeled;
}

function instagramSet(publicId, brighten) {
  const sized = (width, height) => cloudinary.url(publicId, {
    resource_type: "image",
    secure: true,
    transformation: [
      ...(brighten ? [{ effect: "improve" }] : []),
      { width, height, crop: "fill", gravity: "auto", quality: "auto", fetch_format: "jpg" }
    ]
  });
  return { post: sized(1080, 1350), square: sized(1080, 1080), story: sized(1080, 1920) };
}

function uploadToCloudinary(file, options) {
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(options, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      })
      .end(file.buffer);
  });
}

function taggingUnavailable(error) {
  const message = `${error?.message || ""} ${error?.error?.message || ""}`.toLowerCase();
  return message.includes("categor") || message.includes("add-on") || message.includes("addon") || message.includes("google") || message.includes("not allowed");
}

app.post("/api/interpret", async (request, response) => {
  try {
    const profile = await interpretBrief(request.body?.prompt || "");
    response.json({ profile });
  } catch (error) {
    response.status(400).json({ error: error.message || "Could not read that brief." });
  }
});

app.post("/api/ai/label", async (request, response) => {
  if (!aiReady()) return response.status(503).json({ error: "Add OPENAI_API_KEY to .env to label photos." });
  const project = String(request.body?.project || "").trim();
  if (!project) return response.status(400).json({ error: "Open a project before labeling photos." });

  try {
    const photos = listProjectAssets(project, { images: true, unlabeled: true, limit: VISION_LIMIT });
    const assets = [];
    for (const photo of photos) {
      const labeled = await labelPhoto(photo);
      if (labeled) assets.push(labeled);
    }
    response.json({ labeled: assets.length, assets });
  } catch (error) {
    console.error("Photo labeling failed:", error);
    response.status(502).json({ error: error.message || "Could not label those photos." });
  }
});

app.post("/api/ai/ask", async (request, response) => {
  const project = String(request.body?.project || "").trim();
  const prompt = String(request.body?.prompt || "").trim();
  if (!project) return response.status(400).json({ error: "Open a project before asking for photos." });

  try {
    const catalog = listProjectAssets(project, { limit: 40 });
    const plan = await planAsk(prompt, catalog);
    let chosen = catalog.filter((asset) => plan.publicIds.includes(asset.publicId));
    if (!chosen.length) {
      chosen = catalog.filter((asset) => {
        if (plan.shot && asset.shot !== plan.shot) return false;
        if (plan.light && asset.light !== plan.light) return false;
        if (plan.role && asset.role !== plan.role) return false;
        return Boolean(plan.shot || plan.light || plan.role);
      });
    }
    if (!chosen.length && (plan.shot || plan.light || plan.role) && !catalog.some((asset) => asset.caption || asset.shot || asset.light)) {
      return response.json({
        answer: "Label this project's photos first. Then ask again for low light, a shot type, or an Instagram set.",
        source: plan.source,
        instagram: false,
        assets: []
      });
    }
    if (!chosen.length) chosen = catalog.slice(0, 8);
    const assets = chosen.slice(0, 8).map((asset) => (
      plan.instagram && asset.resourceType === "image" ? { ...asset, instagram: instagramSet(asset.publicId, plan.brighten || asset.light === "low") } : asset
    ));
    response.json({ answer: plan.answer, source: plan.source, instagram: plan.instagram, assets });
  } catch (error) {
    console.error("Project ask failed:", error);
    response.status(502).json({ error: error.message || "Could not answer that request." });
  }
});

app.post("/api/events", (request, response) => {
  const id = createEvent(request.body || {});
  response.status(201).json({ id });
});

app.get("/api/projects", (_request, response) => {
  response.json({ projects: listProjects() });
});

app.post("/api/upload", upload.array("files", 1000), async (request, response) => {
  if (!cloudinaryReady) {
    return response.status(503).json({
      error: "Cloudinary is not configured. Add the three CLOUDINARY_* values to .env."
    });
  }

  const files = request.files || [];
  if (!files.length) return response.status(400).json({ error: "No files received." });

  const profile = JSON.parse(request.body.profile || "{}");
  const folderBrief = request.body.folderBrief || "";
  const eventId = Number(request.body.eventId) || createEvent(profile);
  const project = cleanSegment(profile.projectName || "impact-project");
  const event = cleanSegment(profile.eventName || "unassigned-event");
  const sourceFolder = cleanSegment(request.body.sourceFolder || "import");
  const tags = ["impactlens", `project-${project}`, `event-${event}`, `folder-${sourceFolder}`];
  const context = {
    event_name: profile.eventName || "Unassigned event",
    project_name: profile.projectName || "Impact project",
    event_date: profile.date || "unknown",
    event_location: profile.location || "unknown",
    folder_brief: folderBrief.slice(0, 900),
    evidence_goal: (profile.goal || "").slice(0, 900)
  };

  try {
    const results = [];
    let visionBudget = visionCounts.get(eventId) || 0;
    let taggingStatus = process.env.ENABLE_AUTO_TAGGING === "true" ? "ready" : "disabled";
    for (const file of files) {
      const resourceType = file.mimetype.startsWith("video/") ? "video" : "image";
      const options = {
        resource_type: resourceType,
        folder: `impactlens/${project}/${event}/${sourceFolder}`,
        tags: [...tags],
        context: { ...context },
        use_filename: true,
        unique_filename: true
      };
      if (resourceType === "image") options.image_metadata = true;

      if (process.env.ENABLE_AUTO_TAGGING === "true" && resourceType === "image") {
        options.categorization = "google_tagging";
        options.auto_tagging = APPLIED_CONFIDENCE;
      }

      let result;
      try {
        result = await uploadToCloudinary(file, options);
      } catch (error) {
        if (!options.categorization || !taggingUnavailable(error)) throw error;
        taggingStatus = "unavailable";
        delete options.categorization;
        delete options.auto_tagging;
        result = await uploadToCloudinary(file, options);
      }

      const signals = readSignals(result);
      const suggestedTags = serializeSuggestions(signals);
      if (suggestedTags) {
        await cloudinary.uploader.add_context({ suggested_tags: suggestedTags }, [result.public_id], { resource_type: result.resource_type });
        await cloudinary.uploader.add_tag("needs-review", [result.public_id], { resource_type: result.resource_type });
        result.tags = [...(result.tags || []), "needs-review"];
        result.context = { ...(result.context || {}), suggested_tags: suggestedTags };
      }

      const asset = shapeAsset(result, {
        originalFilename: file.originalname,
        signals,
        suggestedTags,
        taggingStatus: signals.length ? "ready" : taggingStatus
      });
      let stored = asset;
      if (aiReady() && resourceType === "image" && visionBudget < VISION_LIMIT) {
        try {
          const labeled = await labelPhoto(asset);
          if (labeled) {
            stored = labeled;
            visionBudget += 1;
          }
        } catch (error) {
          console.error("OpenAI vision failed:", error.message);
        }
      }
      saveAsset(eventId, stored, request.body.sourceFolder || "");
      results.push(stored);
    }
    visionCounts.set(eventId, visionBudget);
    response.json({ uploaded: results.length, taggingStatus, eventId, assets: results });
  } catch (error) {
    console.error("Cloudinary upload failed:", error);
    response.status(502).json({ error: error.message || "Cloudinary upload failed." });
  }
});

app.get("/api/library", (request, response) => {
  try {
    response.json(listAssets(request.query));
  } catch (error) {
    console.error("Library query failed:", error);
    response.status(500).json({ error: "Could not read the evidence library." });
  }
});

app.post("/api/assets/tags", async (request, response) => {
  if (!cloudinaryReady) {
    return response.status(503).json({ error: "Cloudinary is not configured." });
  }

  try {
    const publicId = assertPublicId(request.body.publicId);
    const resourceType = request.body.resourceType === "video" ? "video" : "image";
    const tag = String(request.body.tag || "").trim().slice(0, 60);
    const action = request.body.action === "accept" ? "accept" : "dismiss";
    if (!tag) return response.status(400).json({ error: "A tag is required." });

    if (action === "accept") {
      await cloudinary.uploader.add_tag(tag, [publicId], { resource_type: resourceType });
    }

    const remaining = String(request.body.suggestedTags || "")
      .split("|")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .filter((entry) => entry.split(":")[0].toLowerCase() !== tag.toLowerCase());
    const suggestedTags = remaining.join("|");
    if (suggestedTags) {
      await cloudinary.uploader.add_context({ suggested_tags: suggestedTags }, [publicId], { resource_type: resourceType });
    } else {
      await cloudinary.uploader.add_context({ suggested_tags: "" }, [publicId], { resource_type: resourceType });
      await cloudinary.uploader.remove_tag("needs-review", [publicId], { resource_type: resourceType });
    }

    const stored = getAsset(publicId);
    const tags = stored ? JSON.parse(stored.tags || "[]") : [];
    const nextTags = action === "accept" ? [...new Set([...tags, tag])] : tags;
    updateAssetReview(publicId, { tags: nextTags, suggestedTags });

    response.json({ ok: true, suggestedTags, action, tag });
  } catch (error) {
    console.error("Tag update failed:", error);
    response.status(502).json({ error: error?.error?.message || error.message || "Could not update that tag." });
  }
});

app.post("/api/compare", (request, response) => {
  if (!cloudinaryReady) {
    return response.status(503).json({ error: "Cloudinary is not configured." });
  }

  try {
    const beforePublicId = assertPublicId(request.body.beforePublicId);
    const afterPublicId = assertPublicId(request.body.afterPublicId);
    const overlayId = afterPublicId.replace(/\//g, ":");
    const campaignUrl = cloudinary.url(beforePublicId, {
      resource_type: "image",
      secure: true,
      transformation: [
        { width: 640, height: 720, crop: "fill", gravity: "auto" },
        { width: 1280, height: 720, crop: "pad", gravity: "west", background: "rgb:0A1112" },
        { overlay: overlayId, width: 640, height: 720, crop: "fill", gravity: "auto" },
        { flags: "layer_apply", gravity: "east" },
        { overlay: { font_family: "Arial", font_size: 32, font_weight: "bold", text: "BEFORE" }, color: "#EAF3F0" },
        { flags: "layer_apply", gravity: "north_west", x: 28, y: 28 },
        { overlay: { font_family: "Arial", font_size: 32, font_weight: "bold", text: "AFTER" }, color: "#EAF3F0" },
        { flags: "layer_apply", gravity: "north_east", x: 28, y: 28 }
      ]
    });
    response.json({ campaignUrl });
  } catch (error) {
    response.status(400).json({ error: error.message || "Could not build the comparison." });
  }
});

async function importCloudinaryLibrary() {
  if (!cloudinaryReady) return;
  let cursor = "";
  let imported = 0;
  do {
    let search = cloudinary.search
      .expression("tags=impactlens")
      .sort_by("created_at", "desc")
      .with_field("context")
      .with_field("tags")
      .with_field("image_metadata")
      .max_results(50);
    if (cursor) search = search.next_cursor(cursor);
    const result = await search.execute();
    for (const resource of result.resources || []) {
      const asset = shapeAsset(resource);
      const eventId = findOrCreateEvent({
        projectName: asset.project || "Impact project",
        eventName: asset.event || "Unassigned event",
        location: asset.location || "",
        date: asset.date || "",
        goal: ""
      });
      const parts = String(asset.publicId || "").split("/");
      saveAsset(eventId, asset, parts.length > 3 ? parts[parts.length - 2] : "");
      imported += 1;
    }
    cursor = result.next_cursor || "";
  } while (cursor);
  if (imported) console.log(`Saved ${imported} Cloudinary assets in SQLite.`);
}

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`ImpactLens API listening on http://localhost:${port}`);
    console.log(cloudinaryReady ? "Cloudinary upload mode is ready." : "Cloudinary credentials are not configured.");
    ensureLibrary();
  });
}

export default app;
