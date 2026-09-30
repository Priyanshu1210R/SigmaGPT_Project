import './App.css';
import Sidebar from "./Sidebar.jsx";
import ChatWindow from "./ChatWindow.jsx";
import AuthPage from "./AuthPage.jsx";
import { MyContext } from "./MyContext.jsx";
import { useAuth } from "./AuthContext.jsx";
import { useState } from 'react';
import { v1 as uuidv1 } from "uuid";

function App() {
  const { user, authLoading } = useAuth();

  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState(null);
  const [currThreadId, setCurrThreadId] = useState(uuidv1());
  const [prevChats, setPrevChats] = useState([]);
  const [newChat, setNewChat] = useState(true);
  const [allThreads, setAllThreads] = useState([]);
  const [image, setImage] = useState(null); // { dataUrl, name } of the image attached to the next message
  const [streamingText, setStreamingText] = useState(""); // reply text as it arrives, token by token
  const [isStreaming, setIsStreaming] = useState(false);
  const [documents, setDocuments] = useState([]); // uploaded knowledge docs for the current thread (RAG)
  const [streamingCitations, setStreamingCitations] = useState(null); // sources for the in-flight reply, if any

  const providerValues = {
    prompt, setPrompt,
    reply, setReply,
    currThreadId, setCurrThreadId,
    newChat, setNewChat,
    prevChats, setPrevChats,
    allThreads, setAllThreads,
    image, setImage,
    streamingText, setStreamingText,
    isStreaming, setIsStreaming,
    documents, setDocuments,
    streamingCitations, setStreamingCitations,
  };

  if (authLoading) {
    return (
      <div className="app" style={{ justifyContent: "center", alignItems: "center", height: "100vh" }}>
        <i className="fa-solid fa-circle-notch fa-spin" style={{ fontSize: "2rem", color: "#ececee" }}></i>
      </div>
    );
  }

  if (!user) {
    return <AuthPage />;
  }

  return (
    <div className='app'>
      <MyContext.Provider value={providerValues}>
        <Sidebar />
        <ChatWindow />
      </MyContext.Provider>
    </div>
  );
}

export default App;
