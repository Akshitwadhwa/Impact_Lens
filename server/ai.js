const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SHOTS = ["selfie", "portrait", "wide", "detail", "group", "unknown"];
const LIGHTS = ["low", "daylight", "night", "flash", "unknown"];
const ROLES = ["before", "after", "during", "unknown"];

export function aiReady() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim());
}

export function localProfile(prompt = "") {
  const text = String(prompt).trim();
  const title = text.split(/[.!?\n]/)[0].replace(/^we\s+/i, "").slice(0, 62) || "Untitled evidence intake";
  return {
    projectName: title,
    eventName: title,
    date: "To be confirmed from source media",
    location: "To be confirmed from source media",
    goal: text,
    summary: "",
    tags: ["event evidence", "time & location", "review required"],
    source: "local"
  };
}

export async function interpretBrief(prompt = "") {
  const text = String(prompt).trim().slice(0, 2000);
  if (!text) throw new Error("Describe the event first.");
  if (!aiReady()) return localProfile(text);

  const parsed = await chatJson([
    {
      role: "system",
      content: "You turn a field-evidence brief into a project plan. Reply with JSON only: {\"projectName\",\"eventName\",\"location\",\"date\",\"summary\",\"tags\"}. projectName and eventName are short titles, max 62 characters. location and date are taken from the brief, or \"To be confirmed from source media\" when absent. summary is one sentence. tags is an array of up to 3 short labels."
    },
    { role: "user", content: text }
  ]);

  const fallback = localProfile(text);
  return {
    projectName: clip(parsed.projectName, 62) || fallback.projectName,
    eventName: clip(parsed.eventName, 62) || fallback.eventName,
    location: clip(parsed.location, 120) || fallback.location,
    date: clip(parsed.date, 80) || fallback.date,
    goal: text,
    summary: clip(parsed.summary, 280),
    tags: cleanTags(parsed.tags).slice(0, 3),
    source: "openai"
  };
}

export async function describePhoto(imageUrl) {
  if (!aiReady()) throw new Error("Add OPENAI_API_KEY to .env to label photos.");
  const dataUrl = await fetchAsDataUrl(imageUrl);
  const parsed = await chatJson([
    {
      role: "system",
      content: `Look at one field photo and reply with JSON only: {"shot","light","role","caption","confidence"}. shot is one of ${SHOTS.join(", ")}. light is one of ${LIGHTS.join(", ")}. role is one of ${ROLES.join(", ")} and means before the change, after the change, during the activity, or unknown. caption is one sentence about what is visible. confidence is a number from 0 to 1.`
    },
    {
      role: "user",
      content: [
        { type: "text", text: "Label this field photo." },
        { type: "image_url", image_url: { url: dataUrl, detail: "low" } }
      ]
    }
  ]);

  const shot = pick(parsed.shot, SHOTS, "unknown");
  const light = pick(parsed.light, LIGHTS, "unknown");
  const role = pick(parsed.role, ROLES, "unknown");
  const confidence = clampScore(parsed.confidence);
  return {
    shot,
    light,
    role,
    caption: clip(parsed.caption, 220),
    confidence,
    tags: [shot !== "unknown" ? `shot-${shot}` : "", light !== "unknown" ? `light-${light}` : "", role !== "unknown" ? `role-${role}` : ""].filter(Boolean)
  };
}

export async function planAsk(prompt, assets) {
  const text = String(prompt).trim().slice(0, 500);
  if (!text) throw new Error("Ask for the photos you want.");
  const catalog = assets.slice(0, 40).map((asset) => ({
    id: asset.publicId,
    shot: asset.shot || "",
    light: asset.light || "",
    role: asset.role || "",
    caption: asset.caption || "",
    tags: (asset.tags || []).slice(0, 8),
    filename: asset.originalFilename || ""
  }));

  if (!aiReady()) {
    return { ...keywordPlan(text), answer: "ChatGPT is not connected, so this used the saved labels and file names.", source: "local" };
  }

  const parsed = await chatJson([
    {
      role: "system",
      content: "You choose field photos for a request. Reply with JSON only: {\"answer\",\"publicIds\",\"shot\",\"light\",\"role\",\"instagram\",\"brighten\"}. publicIds must be copied from the catalog. shot, light, and role are empty or one allowed label. instagram is true when the user wants a social post, story, or campaign image. brighten is true when they want low-light photos improved. answer is one sentence that starts with \"These are your\" and names what they asked for, such as \"These are your candid shots.\""
    },
    { role: "user", content: JSON.stringify({ request: text, catalog }) }
  ]);

  const allowed = new Set(catalog.map((item) => item.id));
  const publicIds = Array.isArray(parsed.publicIds) ? parsed.publicIds.map(String).filter((id) => allowed.has(id)).slice(0, 12) : [];
  return {
    answer: clip(parsed.answer, 320) || "These are the closest photos in this project.",
    publicIds,
    shot: pick(parsed.shot, ["", ...SHOTS.filter((item) => item !== "unknown")], ""),
    light: pick(parsed.light, ["", ...LIGHTS.filter((item) => item !== "unknown")], ""),
    role: pick(parsed.role, ["", ...ROLES.filter((item) => item !== "unknown")], ""),
    instagram: Boolean(parsed.instagram),
    brighten: Boolean(parsed.brighten),
    source: "openai"
  };
}

function keywordPlan(prompt) {
  const text = prompt.toLowerCase();
  return {
    answer: "",
    publicIds: [],
    shot: SHOTS.find((item) => item !== "unknown" && text.includes(item)) || "",
    light: text.includes("low light") || text.includes("dark") ? "low" : LIGHTS.find((item) => item !== "unknown" && text.includes(item)) || "",
    role: ROLES.find((item) => item !== "unknown" && text.includes(item)) || "",
    instagram: /instagram|campaign|story|reel|post/.test(text),
    brighten: /bright|enhance|fix|low light|dark/.test(text),
    source: "local"
  };
}

async function chatJson(messages) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages
    }),
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || "ChatGPT could not answer.";
    if (response.status === 401) throw new Error("OpenAI rejected the API key in .env.");
    throw new Error(message);
  }
  const content = data?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("ChatGPT returned a response that was not JSON.");
  }
}

async function fetchAsDataUrl(imageUrl) {
  const response = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error("Could not read the photo preview.");
  const type = String(response.headers.get("content-type") || "image/jpeg").split(";")[0];
  if (!type.startsWith("image/")) throw new Error("The preview was not an image.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 4_000_000) throw new Error("The photo preview was too large to label.");
  return `data:${type};base64,${bytes.toString("base64")}`;
}

function clip(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanTags(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  return list.map((tag) => clip(tag, 32)).filter(Boolean);
}

function pick(value, allowed, fallback = "") {
  const text = String(value || "").toLowerCase().trim();
  return allowed.includes(text) ? text : fallback;
}

function clampScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return 0.5;
  return Math.min(1, Math.max(0, score > 1 ? score / 100 : score));
}
