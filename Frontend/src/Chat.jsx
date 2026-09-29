import "./Chat.css";
import React, { useContext } from "react";
import { MyContext } from "./MyContext.jsx";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

function Chat() {
    const { newChat, prevChats, streamingText, isStreaming } = useContext(MyContext);

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
                                <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{chat.content}</ReactMarkdown>
                            }
                        </div>
                    )
                }

                {
                    isStreaming ? (
                        <div className="gptDiv" key="streaming">
                            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
                                {streamingText || "\u200b"}
                            </ReactMarkdown>
                            <span className="streamingCursor" aria-hidden="true" />
                        </div>
                    ) : (
                        !isStreaming && prevChats.length > 0 && lastSaved?.role === "model" && (
                            <div className="gptDiv" key="non-typing">
                                <ReactMarkdown rehypePlugins={[rehypeHighlight]}>{lastSaved.content}</ReactMarkdown>
                            </div>
                        )
                    )
                }
            </div>
        </>
    )
}

export default Chat;
