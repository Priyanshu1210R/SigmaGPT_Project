import "./Sidebar.css";
import { useContext, useEffect } from "react";
import { MyContext } from "./MyContext.jsx";
import { useAuth } from "./AuthContext.jsx";
import { useTheme } from "./ThemeContext.jsx";
import { v1 as uuidv1 } from "uuid";
import logo from "./assets/blacklogo.png";

const BACKEND = "https://sigmagpt-project-backend.onrender.com";

function Sidebar() {
  const { allThreads, setAllThreads, currThreadId, setNewChat, setPrompt, setReply, setCurrThreadId, setPrevChats, setImage } = useContext(MyContext);
  const { token } = useAuth();
  const { theme, toggleTheme } = useTheme();

  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const getAllThreads = async () => {
    try {
      const response = await fetch(`${BACKEND}/api/thread`, { headers: authHeaders });
      const res = await response.json();
      const filteredData = res.map(thread => ({ threadId: thread.threadId, title: thread.title }));
      setAllThreads(filteredData);
    } catch (err) {
      console.log(err);
    }
  };

  useEffect(() => {
    getAllThreads();
  }, [currThreadId]);

  const createNewChat = () => {
    setNewChat(true);
    setPrompt("");
    setReply(null);
    setCurrThreadId(uuidv1());
    setPrevChats([]);
    setImage(null);
  };

  const changeThread = async (newThreadId) => {
    setCurrThreadId(newThreadId);
    setImage(null);
    try {
      const response = await fetch(`${BACKEND}/api/thread/${newThreadId}`, { headers: authHeaders });
      const res = await response.json();
      setPrevChats(res.messages);
      setNewChat(false);
      setReply(null);
    } catch (err) {
      console.log(err);
    }
  };

  const deleteThread = async (threadId) => {
    try {
      await fetch(`${BACKEND}/api/thread/${threadId}`, { method: "DELETE", headers: authHeaders });
      setAllThreads(prev => prev.filter(thread => thread.threadId !== threadId));
      if (threadId === currThreadId) createNewChat();
    } catch (err) {
      console.log(err);
    }
  };

  return (
    <section className="sidebar">
      <button onClick={createNewChat}>
        <img src={logo} alt="gpt logo" className="logo" />
        <span><i className="fa-solid fa-pen-to-square"></i></span>
      </button>

      <ul className="history">
        {allThreads?.map((thread, idx) => (
          <li key={idx}
            onClick={() => changeThread(thread.threadId)}
            className={thread.threadId === currThreadId ? "highlighted" : " "}
          >
            {thread.title}
            <i className="fa-solid fa-trash"
              onClick={(e) => {
                e.stopPropagation();
                deleteThread(thread.threadId);
              }}
            ></i>
          </li>
        ))}
      </ul>

      <div className="sign">
        <button
          className="themeToggle"
          onClick={toggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          <i className={theme === "dark" ? "fa-solid fa-moon" : "fa-solid fa-sun"}></i>
          <span>{theme === "dark" ? "Dark mode" : "Light mode"}</span>
        </button>
        <p>Think Beyond Limits</p>
      </div>
    </section>
  );
}

export default Sidebar;
