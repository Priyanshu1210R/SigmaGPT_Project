import "./ChatWindow.css";
import Chat from "./Chat.jsx";
import { MyContext } from "./MyContext.jsx";
import { useAuth } from "./AuthContext.jsx";
import { useContext, useState, useEffect } from "react";
import { ScaleLoader } from "react-spinners";

const BACKEND = "https://sigmagpt-project-backend.onrender.com";
const FREE_LIMIT = 20;

function ChatWindow() {
  const { prompt, setPrompt, reply, setReply, currThreadId, setPrevChats, setNewChat } = useContext(MyContext);
  const { token, user, setUser, logout, updateProfile, upgradeToPremium } = useAuth();
  const [loading, setLoading] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  // ---- Modal state ----
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);

  // ---- Settings form ----
  const [settingsForm, setSettingsForm] = useState({ username: "", email: "", currentPassword: "", newPassword: "", confirmPassword: "" });
  const [settingsError, setSettingsError] = useState("");
  const [settingsSuccess, setSettingsSuccess] = useState("");
  const [settingsLoading, setSettingsLoading] = useState(false);

  // ---- Upgrade state ----
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeError, setUpgradeError] = useState("");
  const [upgradeSuccess, setUpgradeSuccess] = useState("");

  // ---- Usage limit modal ----
  const [showLimitModal, setShowLimitModal] = useState(false);

  // Prefill settings form when user is loaded
  useEffect(() => {
    if (user) {
      setSettingsForm(f => ({ ...f, username: user.username || "", email: user.email || "" }));
    }
  }, [user]);

  // ---- Chat ----
  const getReply = async () => {
    if (!prompt.trim()) return;

    // Client-side guard
    if (!user?.isPremium && (user?.usageCount ?? 0) >= FREE_LIMIT) {
      setShowLimitModal(true);
      return;
    }

    setLoading(true);
    setNewChat(false);

    try {
      const response = await fetch(`${BACKEND}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: prompt, threadId: currThreadId }),
      });
      const res = await response.json();

      if (response.status === 403 && res.error === "FREE_LIMIT_REACHED") {
        setShowLimitModal(true);
        setLoading(false);
        return;
      }

      // Update usageCount in context
      if (res.usageCount !== undefined) {
        setUser(prev => ({ ...prev, usageCount: res.usageCount, isPremium: res.isPremium }));
      }

      setReply(res.reply);
    } catch (err) {
      console.log(err);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (prompt && reply) {
      setPrevChats(prevChats => ([
        ...prevChats,
        { role: "user", content: prompt },
        { role: "model", content: reply },
      ]));
    }
    setPrompt("");
  }, [reply]);

  // ---- Dropdown ----
  const handleProfileClick = () => setIsOpen(!isOpen);
  const handleLogout = () => { setIsOpen(false); logout(); };

  const openSettings = () => {
    setIsOpen(false);
    setSettingsError(""); setSettingsSuccess("");
    setSettingsForm({ username: user?.username || "", email: user?.email || "", currentPassword: "", newPassword: "", confirmPassword: "" });
    setShowSettings(true);
  };

  const openUpgrade = () => {
    setIsOpen(false);
    setUpgradeError(""); setUpgradeSuccess("");
    setShowUpgrade(true);
  };

  // ---- Settings submit ----
  const handleSettingsSubmit = async () => {
    setSettingsError(""); setSettingsSuccess("");
    if (!settingsForm.username.trim()) return setSettingsError("Name cannot be empty.");
    if (!settingsForm.email.trim()) return setSettingsError("Email cannot be empty.");
    if (settingsForm.newPassword && settingsForm.newPassword !== settingsForm.confirmPassword)
      return setSettingsError("New passwords do not match.");
    setSettingsLoading(true);
    try {
      await updateProfile({
        username: settingsForm.username,
        email: settingsForm.email,
        currentPassword: settingsForm.currentPassword || undefined,
        newPassword: settingsForm.newPassword || undefined,
      });
      setSettingsSuccess("Profile updated successfully!");
      setSettingsForm(f => ({ ...f, currentPassword: "", newPassword: "", confirmPassword: "" }));
    } catch (err) {
      setSettingsError(err.message);
    }
    setSettingsLoading(false);
  };

  // ---- Upgrade submit ----
  const handleUpgrade = async () => {
    setUpgradeError(""); setUpgradeSuccess("");
    setUpgradeLoading(true);
    try {
      await upgradeToPremium();
      setUpgradeSuccess("🎉 You're now on the Premium plan! Unlimited messages unlocked.");
    } catch (err) {
      setUpgradeError(err.message);
    }
    setUpgradeLoading(false);
  };

  const usageCount = user?.usageCount ?? 0;
  const isPremium = user?.isPremium ?? false;

  return (
    <div className="chatWindow">
      {/* ---- Navbar ---- */}
      <div className="navbar">
        <span>SigmaGPT <i className="fa-solid fa-chevron-down"></i></span>
        <div className="navRight">
          {!isPremium && (
            <div className="usageBadge" title={`${FREE_LIMIT - usageCount} free messages left`}>
              {usageCount}/{FREE_LIMIT}
            </div>
          )}
          {isPremium && <div className="premiumBadge"><i className="fa-solid fa-crown"></i> Premium</div>}
          <div className="userIconDiv" onClick={handleProfileClick}>
            <span className="userIcon"><i className="fa-solid fa-user"></i></span>
          </div>
        </div>
      </div>

      {/* ---- Dropdown ---- */}
      {isOpen && (
        <div className="dropDown">
          <div className="dropDownItem userInfo">
            <i className="fa-solid fa-circle-user"></i>
            <div>
              <span className="userName">{user?.username}</span>
              <span className="userEmail">{user?.email}</span>
            </div>
          </div>
          <div className="dropDownDivider"></div>
          <div className="dropDownItem" onClick={openSettings}><i className="fa-solid fa-gear"></i> Settings</div>
          <div className="dropDownItem" onClick={openUpgrade}><i className="fa-solid fa-cloud-arrow-up"></i> Upgrade plan</div>
          <div className="dropDownDivider"></div>
          <div className="dropDownItem logout" onClick={handleLogout}>
            <i className="fa-solid fa-arrow-right-from-bracket"></i> Log out
          </div>
        </div>
      )}

      <Chat />
      <ScaleLoader color="#fff" loading={loading} />

      <div className="chatInput">
        <div className="inputBox">
          <input
            placeholder={!isPremium && usageCount >= FREE_LIMIT ? "Upgrade to continue chatting..." : "Ask anything"}
            value={prompt}
            disabled={!isPremium && usageCount >= FREE_LIMIT}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" ? getReply() : ""}
          />
          <div id="submit" onClick={getReply}>
            <i className="fa-solid fa-paper-plane"></i>
          </div>
        </div>
        <p className="info">SigmaGPT can make mistakes. Check important info. See Cookie Preferences.</p>
      </div>

      {/* ========== SETTINGS MODAL ========== */}
      {showSettings && (
        <div className="modalOverlay" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <h2><i className="fa-solid fa-gear"></i> Settings</h2>
              <button className="modalClose" onClick={() => setShowSettings(false)}><i className="fa-solid fa-xmark"></i></button>
            </div>

            <div className="modalSection">
              <label>Display Name</label>
              <input
                className="modalInput"
                value={settingsForm.username}
                onChange={e => setSettingsForm(f => ({ ...f, username: e.target.value }))}
                placeholder="Your name"
              />
            </div>

            <div className="modalSection">
              <label>Email Address</label>
              <input
                className="modalInput"
                type="email"
                value={settingsForm.email}
                onChange={e => setSettingsForm(f => ({ ...f, email: e.target.value }))}
                placeholder="your@email.com"
              />
            </div>

            <div className="modalDivider"></div>
            <p className="modalSectionTitle">Change Password <span className="optional">(optional)</span></p>

            <div className="modalSection">
              <label>Current Password</label>
              <input
                className="modalInput"
                type="password"
                value={settingsForm.currentPassword}
                onChange={e => setSettingsForm(f => ({ ...f, currentPassword: e.target.value }))}
                placeholder="Enter current password"
              />
            </div>

            <div className="modalSection">
              <label>New Password</label>
              <input
                className="modalInput"
                type="password"
                value={settingsForm.newPassword}
                onChange={e => setSettingsForm(f => ({ ...f, newPassword: e.target.value }))}
                placeholder="Min. 6 characters"
              />
            </div>

            <div className="modalSection">
              <label>Confirm New Password</label>
              <input
                className="modalInput"
                type="password"
                value={settingsForm.confirmPassword}
                onChange={e => setSettingsForm(f => ({ ...f, confirmPassword: e.target.value }))}
                placeholder="Repeat new password"
              />
            </div>

            {settingsError && <p className="modalError">{settingsError}</p>}
            {settingsSuccess && <p className="modalSuccess">{settingsSuccess}</p>}

            <button className="modalBtn" onClick={handleSettingsSubmit} disabled={settingsLoading}>
              {settingsLoading ? <i className="fa-solid fa-circle-notch fa-spin"></i> : "Save Changes"}
            </button>
          </div>
        </div>
      )}

      {/* ========== UPGRADE MODAL ========== */}
      {showUpgrade && (
        <div className="modalOverlay" onClick={() => setShowUpgrade(false)}>
          <div className="modal upgradeModal" onClick={e => e.stopPropagation()}>
            <div className="modalHeader">
              <h2><i className="fa-solid fa-crown"></i> Upgrade to Premium</h2>
              <button className="modalClose" onClick={() => setShowUpgrade(false)}><i className="fa-solid fa-xmark"></i></button>
            </div>

            {isPremium ? (
              <div className="premiumActive">
                <i className="fa-solid fa-circle-check"></i>
                <p>You're already on the <strong>Premium plan</strong>. Enjoy unlimited messages!</p>
              </div>
            ) : (
              <>
                <div className="planCard">
                  <div className="planBadge">Most Popular</div>
                  <div className="planPrice">₹199<span>/lifetime</span></div>
                  <ul className="planFeatures">
                    <li><i className="fa-solid fa-check"></i> Unlimited messages (currently {usageCount}/{FREE_LIMIT} used)</li>
                    <li><i className="fa-solid fa-check"></i> Priority AI responses</li>
                    <li><i className="fa-solid fa-check"></i> Full conversation history</li>
                    <li><i className="fa-solid fa-check"></i> Early access to new features</li>
                  </ul>
                </div>

                <p className="planNote">Free plan: {FREE_LIMIT - usageCount} messages remaining. After that, upgrade is required.</p>

                {upgradeError && <p className="modalError">{upgradeError}</p>}
                {upgradeSuccess && <p className="modalSuccess">{upgradeSuccess}</p>}

                {!upgradeSuccess && (
                  <button className="modalBtn upgradeBtn" onClick={handleUpgrade} disabled={upgradeLoading}>
                    {upgradeLoading
                      ? <i className="fa-solid fa-circle-notch fa-spin"></i>
                      : <><i className="fa-solid fa-crown"></i> Upgrade Now — ₹199</>
                    }
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ========== LIMIT REACHED MODAL ========== */}
      {showLimitModal && (
        <div className="modalOverlay" onClick={() => setShowLimitModal(false)}>
          <div className="modal limitModal" onClick={e => e.stopPropagation()}>
            <div className="limitIcon"><i className="fa-solid fa-lock"></i></div>
            <h2>Free Limit Reached</h2>
            <p>You've used all <strong>{FREE_LIMIT} free messages</strong>. Upgrade to Premium to keep chatting without limits.</p>
            <button className="modalBtn upgradeBtn" onClick={() => { setShowLimitModal(false); setShowUpgrade(true); }}>
              <i className="fa-solid fa-crown"></i> Upgrade for ₹199
            </button>
            <button className="modalBtnSecondary" onClick={() => setShowLimitModal(false)}>Maybe later</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatWindow;
