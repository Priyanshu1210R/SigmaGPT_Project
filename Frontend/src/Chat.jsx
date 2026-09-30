import "./Chat.css";
import React, { useContext, useState } from "react";
import { MyContext } from "./MyContext.jsx";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

// Renders the [1] [2] ... source excerpts a RAG reply cited, collapsed by default.
// `citations` is the array the backend sent (see routes/chat.js's "citations" SSE event) —
// same order as the [n] markers the model was instructed to use inline.
function Sources({ citations }) {
    const [open, setOpen] = useState(false);
    if (!citations?.length) return null;

    return (
        <div className="sourcesBlock">
            <button className="sourcesToggle" onClick={() => setOpen(o => !o)} type="button">
                <i className="fa-solid fa-book-open"></i> {citations.length} source{citations.length > 1 ? "s" : ""}
                <i className={`fa-solid fa-chevron-${open ? "up" : "down"}`}></i>
            </button>
            {open && (
                <ol className="sourcesList">
                    {citations.map((c, i) => (
                        <li key={i}>
                            <span className="sourceFile">[{i + 1}] {c.fileName}</span>
                            <span className="sourceSnippet">{c.text.length > 220 ? c.text.slice(0, 220) + "…" : c.text}</span>
                        </li>
                    ))}
                </ol>
            )}
        </div>
    );
}

function Chat() {
    const { newChat, prevChats, streamingText, isStreaming, streamingCitations } = useContext(MyContext);

    // While a reply is streaming in, prevChats doesn't have the final message yet
    // (it's appended only once the stream finishes) — show the live text as its own bubble.
    const finishedChats = isStreaming ? prevChats : prevChats.slice(0, -1);
    const lastSaved = prevChats[prevChats.length - 1];

    return (
        <>
            {newChat && <h1>Start a New Chat!</h1>}
            <div className="chats">
                {
                    finishedChats?.map((chat, idx) =>
                        <div className={chat.role === "user" ? "userDiv" : "gptDiv"} key={idx}>
                            {
                                chat.role === "user" ?
                                <div className="userMessage">
                                    {chat.image && <img src={chat.image} alt="attached" className="chatImage" />}
                                    {chat.content && <p className="userMessageText">{chat.content}</p>}
                                </div> :
                                <>
                                    <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{chat.content}</ReactMarkdown>
                                    <Sources citations={chat.citations} />
                                </>
                            }
                        </div>
                    )
                }

                {
                    isStreaming ? (
                        <div className="gptDiv" key="streaming">
                            <Sources citations={streamingCitations} />
                            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                                {streamingText || "\u200b"}
                            </ReactMarkdown>
                            <span className="streamingCursor" aria-hidden="true" />
                        </div>
                    ) : (
                        !isStreaming && prevChats.length > 0 && lastSaved?.role === "model" && (
                            <div className="gptDiv" key="non-typing">
                                <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{lastSaved.content}</ReactMarkdown>
                                <Sources citations={lastSaved.citations} />
                            </div>
                        )
                    )
                }
            </div>
        </>
    )
}

export default Chat;
