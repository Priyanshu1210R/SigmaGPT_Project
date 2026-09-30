import "./Documents.css";
import { useContext, useEffect, useRef, useState } from "react";
import { MyContext } from "./MyContext.jsx";
import { useAuth } from "./AuthContext.jsx";
import { BACKEND } from "./config.js";

const MAX_DOC_MB = 15;
const ACCEPTED = ".pdf,.txt,.md";

// Per-thread knowledge base for RAG: upload notes/PDFs, see indexing status,
// remove them. Chat retrieval (server-side) automatically pulls from whatever's
// "ready" here for the current thread — there's no separate "use documents" toggle.
function Documents() {
  const { currThreadId, documents, setDocuments } = useContext(MyContext);
  const { token } = useAuth();
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
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

  // Close the popover when clicking outside it.
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setExpanded(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [expanded]);

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
        setError(data.error || "Upload failed. Please try again.");
      } else {
        setDocuments((prev) => [
          { _id: data.id, fileName: data.fileName, status: data.status, chunkCount: data.chunkCount, createdAt: new Date().toISOString() },
          ...prev,
        ]);
        setExpanded(true);
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

  return (
    <div className="docsWrap" ref={wrapRef}>
      <input type="file" accept={ACCEPTED} ref={fileInputRef} style={{ display: "none" }} onChange={handleFileSelect} />

      <button
        id="attachDoc"
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title="Add notes / documents for this chat"
        className={expanded ? "active" : ""}
      >
        <i className="fa-solid fa-book"></i>
        {documents.length > 0 && <span className="docsBadge">{readyCount}/{documents.length}</span>}
      </button>

      {expanded && (
        <div className="docsPopover">
          <div className="docsPopoverTitle">
            {documents.length === 0
              ? "Add notes for this chat"
              : `${readyCount}/${documents.length} document${documents.length === 1 ? "" : "s"} ready`}
          </div>

          {documents.map((doc) => (
            <div className="docRow" key={doc._id}>
              <i className={`fa-solid ${doc.mimeType === "application/pdf" || /\.pdf$/i.test(doc.fileName || "") ? "fa-file-pdf" : "fa-file-lines"} docIcon`}></i>
              <span className="docName" title={doc.fileName}>{doc.fileName}</span>
              {doc.status === "processing" && <span className="docStatus processing"><i className="fa-solid fa-circle-notch fa-spin"></i> Indexing…</span>}
              {doc.status === "ready" && <span className="docStatus ready">{doc.chunkCount} chunks</span>}
              {doc.status === "failed" && <span className="docStatus failed" title={doc.error}>Failed</span>}
              <button className="docDelete" onClick={() => handleDelete(doc._id)} title="Remove" type="button">
                <i className="fa-solid fa-xmark"></i>
              </button>
            </div>
          ))}

          <button className="docUploadBtn" onClick={handlePick} disabled={uploading} type="button">
            {uploading ? <i className="fa-solid fa-circle-notch fa-spin"></i> : <i className="fa-solid fa-plus"></i>}
            {uploading ? " Uploading & indexing…" : " Upload PDF / .txt / .md"}
          </button>
          {error && <p className="docsError">{error}</p>}
        </div>
      )}
    </div>
  );
}

export default Documents;
