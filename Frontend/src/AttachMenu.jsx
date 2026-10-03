import "./AttachMenu.css";
import { useContext, useEffect, useRef, useState } from "react";
import { MyContext } from "./MyContext.jsx";
import { useAuth } from "./AuthContext.jsx";
import { BACKEND } from "./config.js";

const MAX_DOC_MB = 15;
const ACCEPTED = ".pdf,.txt,.md";

// Per-thread knowledge base for RAG: upload notes/PDFs, see indexing status,
// remove them. Chat retrieval (server-side) automatically pulls from whatever's
// "ready" here for the current thread — there's no separate "use documents" toggle.
function AttachMenu({ onPickImage, imageDisabled = false }) {
  const { currThreadId, documents, setDocuments } = useContext(MyContext);
  const { token } = useAuth();
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  // "closed" | "menu" (choose what to attach) | "docs" (document list + upload)
  const [mode, setMode] = useState("closed");
  const wrapRef = useRef(null);

  const authHeader = { Authorization: `Bearer ${token}` };

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${BACKEND}/api/documents/${currThreadId}`, { headers: authHeader });
      if (!res.ok) return;
      setDocuments(await res.json());
    } catch (err) {
      console.log(err);
    }
  };

  useEffect(() => {
    fetchDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currThreadId]);

  // Uploads are indexed in the background (server returns 202 right away), so keep polling while
  // anything is queued/processing. One list request covers every pending document; the interval backs
  // off (1.5s -> 6s) to stay well inside the API's per-IP rate limit, and pauses while the tab is hidden.
  const hasPending = documents.some((d) => d.status === "queued" || d.status === "processing");
  useEffect(() => {
    if (!hasPending) return;
    let cancelled = false;
    let timer;
    let delay = 1500;
    const poll = async () => {
      if (cancelled) return;
      if (!document.hidden) await fetchDocuments();
      delay = Math.min(Math.round(delay * 1.3), 6000);
      if (!cancelled) timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPending, currThreadId, token]);

  // Close the popover when clicking outside it.
  useEffect(() => {
    if (mode === "closed") return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setMode("closed");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [mode]);

  const handlePick = () => fileInputRef.current?.click();

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    setError("");
    const okType = /\.(pdf|txt|md)$/i.test(file.name);
    if (!okType) return setError("Only PDF, .txt, or .md files are supported.");
    if (file.size > MAX_DOC_MB * 1024 * 1024) return setError(`File must be under ${MAX_DOC_MB}MB.`);

    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${BACKEND}/api/documents/${currThreadId}/upload`, {
        method: "POST",
        headers: authHeader, // no Content-Type — browser sets the multipart boundary itself
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || data.error || "Upload failed. Please try again.");
      } else {
        // 202 Accepted: the file is queued; the polling effect above tracks it to "ready"/"failed".
        setDocuments((prev) => [
          {
            _id: data.id,
            fileName: data.fileName,
            status: data.status,
            stage: data.stage,
            progress: data.progress,
            chunkCount: 0,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
        setMode("docs");
      }
    } catch (err) {
      console.log(err);
      setError("Couldn't reach the server. Please try again.");
    }
    setUploading(false);
  };

  const handleDelete = async (docId) => {
    setDocuments((prev) => prev.filter((d) => d._id !== docId)); // optimistic
    try {
      await fetch(`${BACKEND}/api/documents/${currThreadId}/${docId}`, { method: "DELETE", headers: authHeader });
    } catch (err) {
      console.log(err);
      fetchDocuments(); // revert on failure by re-syncing with the server
    }
  };

  const readyCount = documents.filter((d) => d.status === "ready").length;

  const menuItems = (
    <div className="attachMenu">
      <button
        type="button"
        className="attachItem"
        disabled={imageDisabled}
        onClick={() => { setMode("closed"); onPickImage?.(); }}
      >
        <i className="fa-solid fa-image"></i>
        <span>Scan an image</span>
      </button>
      <button type="button" className="attachItem" onClick={() => setMode("docs")}>
        <i className="fa-solid fa-book"></i>
        <span>Notes / documents</span>
        {documents.length > 0 && <span className="docsBadge">{readyCount}/{documents.length}</span>}
      </button>
    </div>
  );

  return (
    <div className="docsWrap" ref={wrapRef}>
      <input type="file" accept={ACCEPTED} ref={fileInputRef} style={{ display: "none" }} onChange={handleFileSelect} />

      <button
        id="attach"
        type="button"
        onClick={() => setMode((m) => (m === "closed" ? "menu" : "closed"))}
        title="Attach an image or documents"
        className={mode !== "closed" ? "active" : ""}
      >
        <i className="fa-solid fa-paperclip"></i>
        {documents.length > 0 && <span className="attachDot"></span>}
      </button>

      {mode === "menu" && menuItems}

      {mode === "docs" && (
        <div className="docsPopover">
          <div className="docsPopoverTitle">
            <button type="button" className="docsBack" onClick={() => setMode("menu")} title="Back">
              <i className="fa-solid fa-chevron-left"></i>
            </button>
            {documents.length === 0
              ? "Add notes for this chat"
              : `${readyCount}/${documents.length} document${documents.length === 1 ? "" : "s"} ready`}
          </div>

          {documents.map((doc) => (
            <div className="docRow" key={doc._id}>
              <i className={`fa-solid ${doc.mimeType === "application/pdf" || /\.pdf$/i.test(doc.fileName || "") ? "fa-file-pdf" : "fa-file-lines"} docIcon`}></i>
              <span className="docName" title={doc.fileName}>{doc.fileName}</span>
              {(doc.status === "queued" || doc.status === "processing") && (
                <span className="docStatus processing">
                  <i className="fa-solid fa-circle-notch fa-spin"></i>{" "}
                  {doc.stage || "Indexing"}
                  {doc.status === "processing" && doc.progress > 0 && doc.progress < 100 ? ` ${doc.progress}%` : "…"}
                </span>
              )}
              {doc.status === "ready" && <span className="docStatus ready">{doc.chunkCount} chunks</span>}
              {doc.status === "failed" && <span className="docStatus failed" title={doc.error}>Failed</span>}
              <button className="docDelete" onClick={() => handleDelete(doc._id)} title="Remove" type="button">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
          ))}

          <button className="docUploadBtn" onClick={handlePick} disabled={uploading} type="button">
            {uploading ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-plus"></i>}
            {uploading ? " Uploading…" : " Upload PDF / .txt / .md"}
          </button>
          {error && <p className="docsError">{error}</p>}
        </div>
      )}
    </div>
  );
}

export default AttachMenu;
