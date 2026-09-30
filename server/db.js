import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const dataDir = process.env.VERCEL ? "/tmp" : path.resolve("data");
mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, "impactlens.sqlite"));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL,
    event_name TEXT NOT NULL,
    location TEXT,
    event_date TEXT,
    evidence_goal TEXT,
    summary TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id),
    public_id TEXT NOT NULL UNIQUE,
    secure_url TEXT,
    preview_url TEXT,
    resource_type TEXT,
    source_folder TEXT,
    original_filename TEXT,
    location TEXT,
    captured_at TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    suggested_tags TEXT NOT NULL DEFAULT '',
    needs_review INTEGER NOT NULL DEFAULT 0,
    caption TEXT,
    shot TEXT,
    light TEXT,
    role TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

for (const [table, column, type] of [
  ["events", "summary", "TEXT"],
  ["assets", "caption", "TEXT"],
  ["assets", "shot", "TEXT"],
  ["assets", "light", "TEXT"],
  ["assets", "role", "TEXT"]
]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function parseSuggestions(value = "") {
  return String(value)
    .split("|")
    .map((part) => {
      const [tag, confidence] = part.split(":");
      const score = Number(confidence);
      if (!tag) return null;
      return { tag, confidence: Number.isFinite(score) ? score : null, status: "uncertain" };
    })
    .filter(Boolean);
}

export function findOrCreateEvent(profile = {}) {
  const projectName = profile.projectName || "Impact project";
  const eventName = profile.eventName || "Unassigned event";
  const existing = db.prepare(`
    SELECT id FROM events
    WHERE project_name = ? AND event_name = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(projectName, eventName);
  if (existing) return Number(existing.id);
  return createEvent({ ...profile, projectName, eventName });
}

export function createEvent(profile = {}) {
  const result = db.prepare(`
    INSERT INTO events (project_name, event_name, location, event_date, evidence_goal, summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    profile.projectName || "Impact project",
    profile.eventName || "Unassigned event",
    profile.location || "",
    profile.date || "",
    profile.goal || "",
    profile.summary || ""
  );
  return Number(result.lastInsertRowid);
}

export function saveAsset(eventId, asset, sourceFolder) {
  db.prepare(`
    INSERT INTO assets (
      event_id, public_id, secure_url, preview_url, resource_type, source_folder,
      original_filename, location, captured_at, tags, suggested_tags, needs_review,
      caption, shot, light, role
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(public_id) DO UPDATE SET
      event_id = excluded.event_id,
      secure_url = excluded.secure_url,
      preview_url = excluded.preview_url,
      resource_type = excluded.resource_type,
      source_folder = excluded.source_folder,
      original_filename = excluded.original_filename,
      location = excluded.location,
      captured_at = excluded.captured_at,
      tags = excluded.tags,
      suggested_tags = excluded.suggested_tags,
      needs_review = excluded.needs_review,
      caption = CASE WHEN excluded.caption != '' THEN excluded.caption ELSE assets.caption END,
      shot = CASE WHEN excluded.shot != '' THEN excluded.shot ELSE assets.shot END,
      light = CASE WHEN excluded.light != '' THEN excluded.light ELSE assets.light END,
      role = CASE WHEN excluded.role != '' THEN excluded.role ELSE assets.role END
  `).run(
    eventId,
    asset.publicId,
    asset.secureUrl || "",
    asset.previewUrl || "",
    asset.resourceType || "image",
    sourceFolder || "",
    asset.originalFilename || "",
    asset.location || "",
    asset.date || "",
    JSON.stringify(asset.tags || []),
    asset.suggestedTags || "",
    asset.needsReview ? 1 : 0,
    asset.caption || "",
    asset.shot || "",
    asset.light || "",
    asset.role || ""
  );
}

export function updateAssetInsight(publicId, insight) {
  db.prepare(`
    UPDATE assets
    SET caption = ?, shot = ?, light = ?, role = ?, tags = ?, suggested_tags = ?, needs_review = ?
    WHERE public_id = ?
  `).run(
    insight.caption || "",
    insight.shot || "",
    insight.light || "",
    insight.role || "",
    JSON.stringify(insight.tags || []),
    insight.suggestedTags || "",
    insight.needsReview ? 1 : 0,
    publicId
  );
}

export function updateAssetReview(publicId, { tags, suggestedTags }) {
  db.prepare(`
    UPDATE assets
    SET tags = ?, suggested_tags = ?, needs_review = ?
    WHERE public_id = ?
  `).run(JSON.stringify(tags), suggestedTags, suggestedTags ? 1 : 0, publicId);
}

export function getAsset(publicId) {
  return db.prepare("SELECT tags, suggested_tags FROM assets WHERE public_id = ?").get(publicId);
}

function rowToAsset(row) {
  const tags = JSON.parse(row.tags || "[]");
  const suggestedTags = row.suggested_tags || "";
  return {
    originalFilename: row.original_filename || "",
    publicId: row.public_id,
    secureUrl: row.secure_url || "",
    previewUrl: row.preview_url || row.secure_url || "",
    resourceType: row.resource_type || "image",
    tags,
    project: row.project_name || "",
    event: row.event_name || "",
    location: row.location || "",
    date: row.captured_at || row.created_at || "",
    suggestedTags,
    suggestions: parseSuggestions(suggestedTags),
    needsReview: Boolean(row.needs_review),
    caption: row.caption || "",
    shot: row.shot || "",
    light: row.light || "",
    role: row.role || ""
  };
}

export function listProjectAssets(projectName, { images = false, unlabeled = false, limit = 40 } = {}) {
  const where = ["e.project_name LIKE ?"];
  const params = [`%${String(projectName).slice(0, 80)}%`];
  if (images) where.push("a.resource_type = 'image'");
  if (unlabeled) where.push("(a.caption IS NULL OR a.caption = '')");
  return db.prepare(`
    SELECT a.*, e.project_name, e.event_name
    FROM assets a
    JOIN events e ON e.id = a.event_id
    WHERE ${where.join(" AND ")}
    ORDER BY a.id DESC
    LIMIT ?
  `).all(...params, limit).map(rowToAsset);
}

export function listAssets(query = {}) {
  const where = [];
  const params = [];
  if (query.project) {
    where.push("e.project_name LIKE ?");
    params.push(`%${String(query.project).slice(0, 80)}%`);
  }
  if (query.tag) {
    where.push("a.tags LIKE ?");
    params.push(`%${String(query.tag).slice(0, 80)}%`);
  }
  if (query.review === "1" || query.review === "true") where.push("a.needs_review = 1");
  if (query.kind === "image" || query.kind === "video") {
    where.push("a.resource_type = ?");
    params.push(query.kind);
  }
  if (query.from) {
    where.push("date(a.created_at) >= date(?)");
    params.push(String(query.from).slice(0, 10));
  }
  if (query.to) {
    where.push("date(a.created_at) <= date(?)");
    params.push(String(query.to).slice(0, 10));
  }
  const tokens = String(query.q || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2)
    .slice(0, 6);
  if (tokens.length) {
    const clause = tokens.map(() => "(a.original_filename LIKE ? OR a.tags LIKE ? OR a.location LIKE ? OR a.source_folder LIKE ? OR a.captured_at LIKE ? OR a.caption LIKE ? OR a.shot LIKE ? OR a.light LIKE ?)").join(" OR ");
    where.push(`(${clause})`);
    tokens.forEach((token) => {
      const like = `%${token}%`;
      params.push(like, like, like, like, like, like, like, like);
    });
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM assets a
    JOIN events e ON e.id = a.event_id
    ${clause}
  `).get(...params).count);
  const offset = Number(query.cursor) || 0;
  const rows = db.prepare(`
    SELECT a.*, e.project_name, e.event_name
    FROM assets a
    JOIN events e ON e.id = a.event_id
    ${clause}
    ORDER BY CASE WHEN a.captured_at = '' OR a.captured_at LIKE '%confirm%' THEN 1 ELSE 0 END, a.captured_at DESC, a.id DESC
    LIMIT 30 OFFSET ?
  `).all(...params, offset);

  return {
    total,
    nextCursor: offset + rows.length < total ? String(offset + rows.length) : "",
    assets: rows.map(rowToAsset)
  };
}

export function listProjects() {
  const rows = db.prepare(`
    SELECT
      e.project_name AS name,
      e.location AS location,
      COUNT(DISTINCT e.id) AS events,
      COUNT(a.id) AS assets,
      SUM(CASE WHEN a.needs_review = 1 THEN 1 ELSE 0 END) AS review_count,
      MAX(e.created_at) AS created_at
    FROM events e
    LEFT JOIN assets a ON a.event_id = e.id
    GROUP BY e.project_name
    ORDER BY created_at DESC
  `).all();

  return rows.map((row) => {
    const created = row.created_at ? new Date(`${String(row.created_at).replace(" ", "T")}Z`) : null;
    const reviewCount = Number(row.review_count || 0);
    return {
      id: row.name,
      name: row.name,
      location: row.location || "Location unconfirmed",
      assets: Number(row.assets || 0),
      events: Number(row.events || 0),
      progress: reviewCount ? 55 : 78,
      color: "coral",
      status: reviewCount ? "Review needed" : "Evidence intake",
      date: created && !Number.isNaN(created.getTime())
        ? created.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
        : "Saved"
    };
  });
}
