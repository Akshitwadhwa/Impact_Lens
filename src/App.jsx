import { useEffect, useMemo, useRef, useState } from "react";

const icons = {
  spark: "✦",
  upload: "↑",
  folder: "▣",
  location: "⌖",
  media: "▧",
  event: "◌",
  arrow: "→",
  check: "✓",
  alert: "!"
};

const defaultBrief = "";

function inferProfile(prompt) {
  const title = prompt
    .trim()
    .split(/[.!?\n]/)[0]
    .replace(/^we\s+/i, "")
    .slice(0, 62) || "Untitled evidence intake";
  return {
    projectName: title,
    eventName: title,
    date: "To be confirmed from source media",
    location: "To be confirmed from source media",
    goal: prompt.trim(),
    tags: ["event evidence", "time & location", "review required"]
  };
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

function formatWhen(value) {
  if (!value || /confirm|unknown/i.test(String(value))) return "Date unconfirmed";
  const exif = String(value).match(/^(\d{4}):(\d{2}):(\d{2})/);
  const parsed = exif ? new Date(`${exif[1]}-${exif[2]}-${exif[3]}T00:00:00`) : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function explainCloudinaryError(message) {
  if (/cloud_name mismatch/i.test(message || "")) {
    return "Cloudinary rejected the cloud name. Copy it again from the console, with no spaces.";
  }
  return message;
}

function formatPlace(value) {
  if (!value || /confirm|unknown/i.test(String(value))) return "Location unconfirmed";
  return value;
}

function makeFolders(files) {
  const groups = new Map();
  files.forEach((file) => {
    const parts = (file.webkitRelativePath || file.name).split("/");
    const name = parts.length > 1 ? parts[0] : "Selected media";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(file);
  });
  return [...groups.entries()].map(([name, groupedFiles]) => ({
    id: `${name}-${Date.now()}-${Math.random()}`,
    name,
    files: groupedFiles,
    prompt: "Describe what this folder contains, such as ‘before-cleanup shoreline images’.",
    status: "ready",
    uploaded: 0
  }));
}

function App() {
  const [screen, setScreen] = useState("dashboard");
  const [projects, setProjects] = useState([]);
  const [brief, setBrief] = useState(defaultBrief);
  const [profile, setProfile] = useState(null);
  const [folders, setFolders] = useState([]);
  const [cloudinaryReady, setCloudinaryReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [intakeState, setIntakeState] = useState("idle");
  const [intakeResult, setIntakeResult] = useState(null);
  const [reviewAssets, setReviewAssets] = useState([]);
  const [pair, setPair] = useState({ before: null, after: null });
  const inputRef = useRef(null);

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then((data) => setCloudinaryReady(Boolean(data.cloudinaryReady)))
      .catch(() => setCloudinaryReady(false));
  }, []);

  const totals = useMemo(
    () => ({
      projects: projects.length,
      assets: projects.reduce((sum, project) => sum + project.assets, 0),
      events: projects.reduce((sum, project) => sum + project.events, 0)
    }),
    [projects]
  );

  function createProfile() {
    if (!brief.trim()) {
      setNotice("Describe the event first so we can create an evidence plan.");
      return;
    }
    setProfile(inferProfile(brief));
    setNotice("Event profile created. Review it, then add your hard-drive folders.");
  }

  function onFolderSelect(event) {
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;
    setFolders((existing) => [...existing, ...makeFolders(selected)]);
    event.target.value = "";
  }

  function updateFolder(id, update) {
    setFolders((current) => current.map((folder) => (folder.id === id ? { ...folder, ...update } : folder)));
  }

  async function uploadFolder(folder) {
    if (!profile) {
      setNotice("Create the event profile before starting an upload.");
      return;
    }
    updateFolder(folder.id, { status: "uploading" });

    try {
      const body = new FormData();
      folder.files.forEach((file) => body.append("files", file));
      body.append("profile", JSON.stringify(profile));
      body.append("sourceFolder", folder.name);
      body.append("folderBrief", folder.prompt);
      const response = await fetch("/api/upload", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed");
      updateFolder(folder.id, { status: "complete", uploaded: data.uploaded });
      return data;
    } catch (error) {
      updateFolder(folder.id, { status: "error" });
      setNotice(error.message);
      throw error;
    }
  }

  async function startIntake() {
    if (!profile || !folders.length || intakeState === "uploading") return;
    if (!cloudinaryReady) {
      setNotice("Add valid Cloudinary credentials in .env before starting an intake.");
      return;
    }
    setIntakeState("uploading");
    try {
      let uploaded = 0;
      const assets = [];
      for (const folder of folders) {
        const result = await uploadFolder(folder);
        uploaded += result.uploaded;
        assets.push(...(result.assets || []));
      }
      setReviewAssets(assets);
      setIntakeResult({ uploaded, folderCount: folders.length, profile, taggingStatus: assets[0]?.taggingStatus });
      setIntakeState("complete");
      setScreen("review");
    } catch {
      setIntakeState("idle");
    }
  }

  function addProjectToDashboard() {
    if (!profile) return;
    const assets = intakeResult?.uploaded || folders.reduce((total, folder) => total + (folder.uploaded || folder.files.length), 0);
    setProjects((current) => [
      {
        id: String(Date.now()),
        name: profile.projectName,
        location: profile.location,
        progress: folders.some((folder) => folder.status === "ready" || folder.status === "uploading") ? 55 : 78,
        assets,
        events: 1,
        color: "coral",
        status: "Evidence intake",
        date: "Created just now"
      },
      ...current
    ]);
    setScreen("dashboard");
    setNotice(`${profile.projectName} is now on your dashboard.`);
  }

  function assignPair(role, asset) {
    setPair((current) => {
      const next = { ...current, [role]: asset };
      if (role === "before" && current.after?.publicId === asset.publicId) next.after = null;
      if (role === "after" && current.before?.publicId === asset.publicId) next.before = null;
      return next;
    });
  }

  async function reviewTag(asset, signal, action) {
    const response = await fetch("/api/assets/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicId: asset.publicId,
        resourceType: asset.resourceType,
        tag: signal.tag,
        action,
        suggestedTags: asset.suggestedTags
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not update that tag.");
    const suggestedTags = data.suggestedTags || "";
    const patch = (item) => item.publicId !== asset.publicId ? item : {
      ...item,
      suggestedTags,
      suggestions: parseSuggestions(suggestedTags),
      needsReview: Boolean(suggestedTags),
      tags: action === "accept" ? [...new Set([...(item.tags || []), signal.tag])] : item.tags
    };
    setReviewAssets((current) => current.map(patch));
    return patch(asset);
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setScreen("dashboard")} aria-label="ImpactLens home">
          <span className="brand-mark">◒</span><span>impact<span>lens</span></span>
        </button>
        <div className="workspace-label">WORKSPACE</div>
        <nav>
          <button className={screen === "dashboard" ? "nav-item active" : "nav-item"} onClick={() => setScreen("dashboard")}>
            <span>⌂</span> Overview
          </button>
          <button className="nav-item"><span>▦</span> Projects <em>{projects.length}</em></button>
          <button className="nav-item"><span>⌖</span> Evidence map</button>
          <button className={screen === "library" || screen === "compare" ? "nav-item active" : "nav-item"} onClick={() => setScreen("library")}>
            <span>◫</span> Media library
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="cloud-status"><span className={cloudinaryReady ? "status-dot online" : "status-dot"}></span>{cloudinaryReady ? "Cloudinary connected" : "Cloudinary setup required"}</div>
          <button className="help-link">? Help center</button>
          <div className="user-card"><span className="avatar">YOU</span><div><strong>Your workspace</strong><small>Impact team</small></div><span>⌄</span></div>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div><p className="eyebrow">SUSTAINABILITY MEDIA INTELLIGENCE</p><h1>{screen === "dashboard" ? "Your evidence workspace." : screen === "review" ? "Evidence review." : screen === "library" ? "Search field evidence." : screen === "compare" ? "Show the change." : "Create an evidence intake."}</h1></div>
          {screen === "dashboard" ? <button className="primary" onClick={() => setScreen("intake")}> <span>{icons.spark}</span> New intake</button> : <button className="ghost" onClick={() => setScreen(screen === "compare" ? "library" : "dashboard")}>{screen === "compare" ? "← Library" : "← Dashboard"}</button>}
        </header>

        {notice && <div className="notice"><span>{icons.spark}</span>{notice}<button onClick={() => setNotice("")}>×</button></div>}

        {screen === "dashboard" ? (
          <Dashboard totals={totals} projects={projects} onNew={() => setScreen("intake")} />
        ) : screen === "review" ? (
          <EvidenceWorkspace result={intakeResult} folders={folders} assets={reviewAssets} onDashboard={addProjectToDashboard} onLibrary={() => setScreen("library")} onCompare={() => setScreen("compare")} onAssign={assignPair} onReviewTag={reviewTag} />
        ) : screen === "library" ? (
          <MediaLibrary pair={pair} onAssign={assignPair} onCompare={() => setScreen("compare")} onReviewTag={reviewTag} onNotice={setNotice} />
        ) : screen === "compare" ? (
          <CompareView pair={pair} onLibrary={() => setScreen("library")} />
        ) : (
          <Intake
            brief={brief}
            setBrief={setBrief}
            profile={profile}
            createProfile={createProfile}
            folders={folders}
            inputRef={inputRef}
            onFolderSelect={onFolderSelect}
            cloudinaryReady={cloudinaryReady}
            intakeState={intakeState}
            startIntake={startIntake}
          />
        )}
      </section>
    </main>
  );
}

function Dashboard({ totals, projects, onNew }) {
  return <div className="dashboard fade-in">
    <section className="hero-card">
      <div className="hero-copy"><span className="mini-pill">FIELD MEDIA, MADE USEFUL</span><h2>Turn scattered evidence into <i>impact stories.</i></h2><p>Describe an event, import folders from a hard drive, and let your team review AI-ready media evidence in one place.</p><button className="primary" onClick={onNew}>Start an evidence intake <span>{icons.arrow}</span></button></div>
      <div className="hero-orbit"><div className="orbit-core">✦<small>AI</small></div><span className="orbit-item one">⌖</span><span className="orbit-item two">▧</span><span className="orbit-item three">✓</span><svg viewBox="0 0 260 260" aria-hidden="true"><circle cx="130" cy="130" r="92"/><circle cx="130" cy="130" r="58"/></svg></div>
    </section>
    <section className="metrics-grid">
      <Metric label="Active projects" value={totals.projects} icon="◌" accent="aqua" note="In this workspace" />
      <Metric label="Evidence assets" value={totals.assets.toLocaleString()} icon="▧" accent="lime" note="Uploaded and indexed" />
      <Metric label="Verified events" value={totals.events} icon="✓" accent="violet" note="Ready for review" />
    </section>
    <section className="section-heading"><div><p className="eyebrow">ACTIVE PROJECTS</p><h2>Evidence in motion</h2></div><button className="text-button">View all projects {icons.arrow}</button></section>
    <section className="project-grid">{projects.length ? projects.map((project) => <ProjectCard project={project} key={project.id} />) : <div className="empty-projects"><span>◌</span><div><strong>No active projects yet</strong><p>Create your first evidence intake to begin organizing field media.</p></div><button className="outline" onClick={onNew}>Create intake</button></div>}</section>
  </div>;
}

function Metric({ label, value, icon, accent, note }) {
  return <article className={`metric-card ${accent}`}><div className="metric-icon">{icon}</div><p>{label}</p><strong>{value}</strong><small>{note}</small></article>;
}

function ProjectCard({ project }) {
  return <article className={`project-card ${project.color}`}><div className="project-visual"><span className="visual-ring"></span><span className="visual-leaf">✦</span><div className="project-status">{project.status === "Review needed" ? "!" : "●"} {project.status}</div></div><div className="project-info"><p className="location">{icons.location} {project.location}</p><h3>{project.name}</h3><div className="project-stats"><span>{icons.media} {project.assets} assets</span><span>{icons.event} {project.events} events</span></div><div className="progress-line"><span style={{ width: `${project.progress}%` }}></span></div><footer><small>{project.date}</small><button>Open project {icons.arrow}</button></footer></div></article>;
}

function Intake({ brief, setBrief, profile, createProfile, folders, inputRef, onFolderSelect, cloudinaryReady, intakeState, startIntake }) {
  return <div className="intake fade-in">
    <section className="intake-intro"><p className="eyebrow">NEW EVIDENCE INTAKE</p><h2>Start with the story. We’ll handle the evidence.</h2><p>Describe the event once, then add the folders you received from the field.</p></section>
    <section className="intake-conversation">
      <div className="assistant-orb">✦</div>
      <div className="assistant-message"><strong>What should I look for?</strong><span>Include the activity, location, date, people, and the proof you need for your report.</span></div>
      <div className="chat-composer"><textarea value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="Describe the activity, location, date, participants, and evidence goals…" /><button className="send-button" onClick={createProfile} aria-label="Create event plan">↑</button></div>
    </section>
    <section className={`plan-bar ${profile ? "ready" : ""}`}>
      {profile ? <><div className="plan-status"><span>✓</span><div><small>EVENT PLAN READY</small><strong>{profile.eventName} <i>·</i> {profile.location}</strong></div></div><div className="plan-signals">{profile.tags.slice(0, 3).map((tag) => <span key={tag}>#{tag}</span>)}</div></> : <><span className="plan-spark">✦</span><p>Your AI event plan will appear here — ready to guide tagging, location matching, and evidence discovery.</p></>}
    </section>
    <section className={`upload-stage ${profile ? "unlocked" : "locked"}`}>
      <input ref={inputRef} type="file" multiple webkitdirectory="" directory="" onChange={onFolderSelect} hidden />
      <div className="upload-copy"><p className="eyebrow">MEDIA BATCH</p><h2>Add your field folders.</h2><p>Drop in mixed photos and videos from the hard drive. We keep the folder names as source context and organize the rest from the event plan.</p></div>
      {folders.length === 0 ? <button className="upload-drop" disabled={!profile} onClick={() => inputRef.current?.click()}><span className="upload-symbol">↑</span><strong>Select a folder</strong><small>Images and video · original files are untouched</small></button> : <div className="batch-summary"><div className="batch-stats"><span className="batch-icon">▣</span><div><strong>{folders.reduce((sum, folder) => sum + folder.files.length, 0)} files ready</strong><small>{folders.length} source folder{folders.length === 1 ? "" : "s"} · {cloudinaryReady ? "Cloudinary connected" : "Cloudinary setup required"}</small></div></div><div className="batch-folders">{folders.map((folder) => <span key={folder.id}>{folder.name} <b>{folder.files.length}</b></span>)}</div><button className="outline" onClick={() => inputRef.current?.click()}>Add folder</button></div>}
      {folders.length > 0 && <button className="primary intake-button" disabled={intakeState === "uploading" || !cloudinaryReady} onClick={startIntake}>{intakeState === "uploading" ? "Organizing your media…" : cloudinaryReady ? "Start smart intake" : "Connect Cloudinary to continue"} <span>{intakeState === "uploading" ? "◌" : icons.arrow}</span></button>}
    </section>
  </div>;
}

function EvidenceWorkspace({ result, folders, assets, onDashboard, onLibrary, onCompare, onAssign, onReviewTag }) {
  const profile = result?.profile;
  const uncertain = assets.filter((asset) => asset.suggestions?.length);
  const applied = [...new Set(assets.flatMap((asset) => asset.signals?.filter((signal) => signal.status === "applied").map((signal) => signal.tag) || asset.tags || []))];
  return <div className="review-workspace fade-in">
    <section className="review-hero"><div><p className="eyebrow">EVIDENCE WORKSPACE</p><span className="review-kicker">✓ Intake complete</span><h2>Your media is ready for <i>evidence review.</i></h2><p>{result?.uploaded || 0} assets from {result?.folderCount || 0} source folder{result?.folderCount === 1 ? "" : "s"} are tagged from what is in the frame. Confirm the uncertain signals, then search or compare them.</p></div><div className="review-metric"><strong>{uncertain.length}</strong><span>need a decision</span><small>{result?.taggingStatus === "unavailable" ? "Auto-tagging add-on unavailable" : "Visual tags read"}</small></div></section>
    <section className="review-grid"><article className="review-card primary-review"><p className="eyebrow">VISUAL SIGNALS</p><h3>{profile?.eventName || "Field event"}</h3><p className="review-location">⌖ {formatPlace(profile?.location)}</p><div className="review-tags">{applied.length ? applied.map((tag) => <span key={tag}>#{tag}</span>) : <span>Tags appear here after Cloudinary reads each image</span>}</div></article><article className="review-card"><p className="eyebrow">WHAT YOU CAN DO NEXT</p><div className="review-check"><span>01</span><p><strong>Confirm uncertain tags</strong><small>Keep the ones that match the event. Skip the rest.</small></p></div><div className="review-check"><span>02</span><p><strong>Search the library</strong><small>Find assets by tag, project, date, or a short description.</small></p></div><div className="review-check"><span>03</span><p><strong>Pair before and after</strong><small>Slide between two assets and export a campaign image.</small></p></div></article></section>
    <TagQueue assets={uncertain} onAssign={onAssign} onReviewTag={onReviewTag} />
    <section className="source-strip"><div><p className="eyebrow">SOURCE FOLDERS</p><strong>{folders.map((folder) => folder.name).join(" · ") || "No folders"}</strong></div><span>{result?.uploaded || 0} media items</span></section>
    <div className="review-actions"><p>Confirmed tags stay on the Cloudinary asset. Uncertain ones stay in the review queue until you decide.</p><div className="action-row"><button className="outline" onClick={onLibrary}>Open media library</button><button className="outline" onClick={onCompare}>Before and after</button><button className="primary" onClick={onDashboard}>Open project dashboard {icons.arrow}</button></div></div>
  </div>;
}

function TagQueue({ assets, onAssign, onReviewTag }) {
  if (!assets.length) {
    return <section className="queue-empty"><strong>No uncertain tags in this intake.</strong><p>High-confidence visual tags were applied automatically. Open the library to search them.</p></section>;
  }
  return <section className="queue-block">
    <div className="section-heading"><div><p className="eyebrow">REVIEW QUEUE</p><h2>Uncertain visual tags</h2></div></div>
    <div className="queue-list">{assets.map((asset) => <SuggestionCard key={asset.publicId} asset={asset} onAssign={onAssign} onReviewTag={onReviewTag} />)}</div>
  </section>;
}

function SuggestionCard({ asset, onAssign, onReviewTag }) {
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");

  async function decide(signal, action) {
    setPending(signal.tag);
    setError("");
    try {
      await onReviewTag(asset, signal, action);
    } catch (reason) {
      setError(reason.message);
    } finally {
      setPending("");
    }
  }

  return <article className="suggestion-card">
    <img src={asset.previewUrl || asset.secureUrl} alt={asset.originalFilename || asset.publicId} />
    <div>
      <strong>{asset.originalFilename || asset.publicId.split("/").pop()}</strong>
      <small>{formatPlace(asset.location)} · {formatWhen(asset.date)}</small>
      <div className="suggest-row">{(asset.suggestions || []).map((signal) => <span key={signal.tag} className="suggest-chip"><b>{signal.tag}</b><em>{signal.confidence == null ? "" : `${Math.round(signal.confidence * 100)}%`}</em><button disabled={pending === signal.tag} onClick={() => decide(signal, "accept")}>Keep</button><button disabled={pending === signal.tag} onClick={() => decide(signal, "dismiss")}>Skip</button></span>)}</div>
      {error && <small className="error">{error}</small>}
      <div className="pair-actions"><button className="outline" onClick={() => onAssign("before", asset)}>Use as before</button><button className="outline" onClick={() => onAssign("after", asset)}>Use as after</button></div>
    </div>
  </article>;
}

function MediaLibrary({ pair, onAssign, onCompare, onReviewTag, onNotice }) {
  const [filters, setFilters] = useState({ q: "", project: "", tag: "", from: "", to: "", review: false });
  const [draft, setDraft] = useState(filters);
  const [assets, setAssets] = useState([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useMemo(() => async (nextFilters, nextCursor = "", append = false) => {
    setLoading(true);
    setError("");
    const params = new URLSearchParams();
    if (nextFilters.q) params.set("q", nextFilters.q);
    if (nextFilters.project) params.set("project", nextFilters.project);
    if (nextFilters.tag) params.set("tag", nextFilters.tag);
    if (nextFilters.from) params.set("from", nextFilters.from);
    if (nextFilters.to) params.set("to", nextFilters.to);
    if (nextFilters.review) params.set("review", "1");
    if (nextCursor) params.set("cursor", nextCursor);
    try {
      const response = await fetch(`/api/library?${params.toString()}`);
      const data = await response.json();
      if (!response.ok) throw new Error(explainCloudinaryError(data.error || "Search failed"));
      setAssets((current) => append ? [...current, ...(data.assets || [])] : (data.assets || []));
      setTotal(data.total || 0);
      setCursor(data.nextCursor || "");
    } catch (reason) {
      if (!append) setAssets([]);
      setError(reason.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filters);
  }, [filters, load]);

  function search(event) {
    event.preventDefault();
    setFilters(draft);
  }

  async function decide(asset, signal, action) {
    try {
      const updated = await onReviewTag(asset, signal, action);
      setAssets((current) => current.map((item) => item.publicId === asset.publicId ? { ...item, ...updated } : item));
    } catch (reason) {
      onNotice(reason.message);
    }
  }

  return <div className="library fade-in">
    <form className="library-toolbar" onSubmit={search}>
      <label>Search<input value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} placeholder="cleanup, shoreline, volunteers…" /></label>
      <label>Project<input value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value })} placeholder="Project name" /></label>
      <label>Tag<input value={draft.tag} onChange={(event) => setDraft({ ...draft, tag: event.target.value })} placeholder="waste" /></label>
      <label>From<input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
      <label>To<input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      <label className="check-field"><input type="checkbox" checked={draft.review} onChange={(event) => setDraft({ ...draft, review: event.target.checked })} />Needs review</label>
      <button className="primary" type="submit">Search</button>
    </form>
    <PairTray pair={pair} onCompare={onCompare} />
    {error && <div className="library-error">{error}</div>}
    <div className="library-meta"><span>{loading ? "Searching Cloudinary…" : error ? "Search did not finish" : `${total || assets.length} matching assets`}</span><small>Search matches tags, file names, places, and the event brief.</small></div>
    <section className="asset-grid">
      {assets.map((asset) => <AssetCard key={asset.publicId} asset={asset} pair={pair} onAssign={onAssign} onReviewTag={decide} />)}
    </section>
    {!loading && !error && assets.length === 0 && <div className="queue-empty"><strong>No evidence matches this search.</strong><p>Run an intake, or clear a filter. Assets show up here after Cloudinary accepts the upload.</p></div>}
    {cursor && <button className="outline load-more" onClick={() => load(filters, cursor, true)} disabled={loading}>Load more</button>}
  </div>;
}

function PairTray({ pair, onCompare }) {
  return <div className="pair-tray">
    <div><small>BEFORE</small><strong>{pair.before ? (pair.before.originalFilename || pair.before.publicId.split("/").pop()) : "Choose a before asset"}</strong></div>
    <div><small>AFTER</small><strong>{pair.after ? (pair.after.originalFilename || pair.after.publicId.split("/").pop()) : "Choose an after asset"}</strong></div>
    <button className="primary" disabled={!pair.before || !pair.after} onClick={onCompare}>Compare {icons.arrow}</button>
  </div>;
}

function AssetCard({ asset, pair, onAssign, onReviewTag }) {
  const before = pair.before?.publicId === asset.publicId;
  const after = pair.after?.publicId === asset.publicId;
  return <article className={`asset-card ${asset.needsReview ? "needs-review" : ""} ${before ? "is-before" : ""} ${after ? "is-after" : ""}`}>
    <div className="asset-thumb">{asset.resourceType === "video" ? <video src={asset.secureUrl} poster={asset.previewUrl} muted /> : <img src={asset.previewUrl || asset.secureUrl} alt="" />}<span>{before ? "Before" : after ? "After" : asset.resourceType}</span></div>
    <div className="asset-copy">
      <strong>{asset.originalFilename || asset.event || asset.publicId.split("/").pop()}</strong>
      <small>{formatPlace(asset.location)}</small>
      <small>{formatWhen(asset.date)}</small>
      <div className="review-tags">{(asset.tags || []).slice(0, 4).map((tag) => <span key={tag}>#{tag}</span>)}</div>
      {!!asset.suggestions?.length && <div className="suggest-row">{asset.suggestions.map((signal) => <span key={signal.tag} className="suggest-chip"><b>{signal.tag}</b><em>{signal.confidence == null ? "" : `${Math.round(signal.confidence * 100)}%`}</em><button onClick={() => onReviewTag(asset, signal, "accept")}>Keep</button><button onClick={() => onReviewTag(asset, signal, "dismiss")}>Skip</button></span>)}</div>}
      <div className="pair-actions"><button className={before ? "outline complete" : "outline"} onClick={() => onAssign("before", asset)}>Before</button><button className={after ? "outline complete" : "outline"} onClick={() => onAssign("after", asset)}>After</button></div>
    </div>
  </article>;
}

function CompareView({ pair, onLibrary }) {
  const [position, setPosition] = useState(52);
  const stageRef = useRef(null);
  const [stageWidth, setStageWidth] = useState(860);
  const [campaignUrl, setCampaignUrl] = useState("");
  const [campaignError, setCampaignError] = useState("");

  useEffect(() => {
    if (!stageRef.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setStageWidth(entry.contentRect.width));
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [pair.before, pair.after]);

  useEffect(() => {
    if (!pair.before || !pair.after || pair.before.resourceType !== "image" || pair.after.resourceType !== "image") {
      setCampaignUrl("");
      return undefined;
    }
    let cancel = false;
    setCampaignError("");
    fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ beforePublicId: pair.before.publicId, afterPublicId: pair.after.publicId })
    })
      .then((response) => response.json().then((data) => ({ ok: response.ok, data })))
      .then(({ ok, data }) => {
        if (cancel) return;
        if (!ok) throw new Error(data.error || "Could not build the campaign image.");
        setCampaignUrl(data.campaignUrl || "");
      })
      .catch((reason) => {
        if (!cancel) setCampaignError(reason.message);
      });
    return () => { cancel = true; };
  }, [pair.before, pair.after]);

  if (!pair.before || !pair.after) {
    return <div className="compare-screen fade-in"><div className="queue-empty"><strong>Choose two assets first.</strong><p>Open the media library and mark one photo as before and one as after.</p><button className="primary" onClick={onLibrary}>Go to media library</button></div></div>;
  }

  return <div className="compare-screen fade-in">
    <div className="compare-stage" ref={stageRef}>
      <MediaFrame asset={pair.after} label="After" />
      <div className="compare-before" style={{ width: `${position}%` }}>
        <MediaFrame asset={pair.before} label="Before" width={stageWidth} />
      </div>
      <input type="range" min="2" max="98" value={position} aria-label="Drag to reveal the after asset" onChange={(event) => setPosition(Number(event.target.value))} />
    </div>
    <div className="compare-meta">
      <article><p className="eyebrow">BEFORE</p><h3>{pair.before.originalFilename || pair.before.publicId.split("/").pop()}</h3><p>{formatPlace(pair.before.location)}</p><small>{formatWhen(pair.before.date)}</small></article>
      <article><p className="eyebrow">AFTER</p><h3>{pair.after.originalFilename || pair.after.publicId.split("/").pop()}</h3><p>{formatPlace(pair.after.location)}</p><small>{formatWhen(pair.after.date)}</small></article>
    </div>
    <section className="campaign-card">
      <div><p className="eyebrow">CAMPAIGN IMAGE</p><h3>Side-by-side proof</h3><p>Cloudinary builds this from the two originals. The source files stay unchanged.</p></div>
      {pair.before.resourceType !== "image" || pair.after.resourceType !== "image" ? <p className="campaign-note">The slider plays video. The exported campaign image is available for photo pairs.</p> : campaignError ? <p className="campaign-note">{campaignError}</p> : campaignUrl ? <a href={campaignUrl} target="_blank" rel="noreferrer"><img src={campaignUrl} alt="Before and after campaign composite" /></a> : <p className="campaign-note">Building the campaign image…</p>}
    </section>
  </div>;
}

function MediaFrame({ asset, width }) {
  const style = width ? { width, maxWidth: "none" } : undefined;
  if (asset.resourceType === "video") return <video src={asset.secureUrl} poster={asset.previewUrl} style={style} muted playsInline autoPlay loop />;
  return <img src={asset.secureUrl || asset.previewUrl} alt="" style={style} />;
}

export default App;
