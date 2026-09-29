const $ = id => document.getElementById(id);
const chatBox = $("chat"), input = $("input"), sendBtn = $("sendBtn"), micBtn = $("mic");
const subjectSel = $("subject"), speakToggle = $("speakToggle"), welcome = $("welcome"), statusEl = $("status");

let lang = "en";
let history = [];
let busy = false;
let controller = null;

// ---------- small helpers ----------
function setStatus(text, ms = 0) {
    statusEl.textContent = text;
    if (ms) setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ""; }, ms);
}
function nearBottom() { return chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 140; }
function scrollDown() { chatBox.scrollTop = chatBox.scrollHeight; }

// ---------- tiny markdown -> safe HTML (no external library) ----------
function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function inline(s) {
    return s.replace(/`([^`]+)`/g, "<code>$1</code>")
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}
function blocks(text) {
    let out = "", list = null;
    const close = () => { if (list) { out += `</${list}>`; list = null; } };
    esc(text).split("\n").forEach(line => {
        let m;
        if ((m = line.match(/^#{1,6}\s+(.*)/))) { close(); out += `<h4>${inline(m[1])}</h4>`; }
        else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); out += "<ul>"; list = "ul"; } out += `<li>${inline(m[1])}</li>`; }
        else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); out += "<ol>"; list = "ol"; } out += `<li>${inline(m[1])}</li>`; }
        else if (/^\s*-{3,}\s*$/.test(line)) { close(); out += "<hr>"; }
        else if (!line.trim()) { close(); }
        else { close(); out += `<p>${inline(line)}</p>`; }
    });
    close();
    return out;
}
function markdown(text) {
    return text.split("```").map((part, i) => {
        if (i % 2 === 1) {
            const nl = part.indexOf("\n");
            const code = nl >= 0 ? part.slice(nl + 1) : "";
            return `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
        }
        return blocks(part);
    }).join("");
}
function addCopyButtons(el) {
    el.querySelectorAll("pre:not([data-c])").forEach(pre => {
        pre.dataset.c = "1";
        const b = document.createElement("button");
        b.className = "copy"; b.textContent = "Copy";
        b.onclick = () => { navigator.clipboard.writeText(pre.innerText.replace(/^Copy\n?/, "")); b.textContent = "Copied ✓"; setTimeout(() => b.textContent = "Copy", 1500); };
        pre.appendChild(b);
    });
}

// ---------- messages ----------
function addUser(text) {
    const row = document.createElement("div");
    row.className = "row user";
    row.innerHTML = `<div class="bubble"></div>`;
    row.firstChild.textContent = text;
    chatBox.appendChild(row);
    scrollDown();
}
function addAI() {
    const row = document.createElement("div");
    row.className = "row ai";
    row.innerHTML = `<div class="avatar">🎓</div><div class="bubble"><span class="dots"><span></span><span></span><span></span></span></div>`;
    chatBox.appendChild(row);
    scrollDown();
    return row.querySelector(".bubble");
}

// ---------- voice OUTPUT (speaks sentence by sentence while text streams) ----------
let spokenIdx = 0;
function pickVoice(code) {
    const vs = speechSynthesis.getVoices();
    return vs.find(v => v.lang.replace("_", "-").toLowerCase() === code.toLowerCase())
        || vs.find(v => v.lang.toLowerCase().startsWith(code.slice(0, 2).toLowerCase()));
}
function say(text) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang === "ta" ? "ta-IN" : "en-IN";
    const v = pickVoice(u.lang);
    if (v) u.voice = v;
    speechSynthesis.speak(u);
}
function speakProgress(full, final) {
    if (!speakToggle.checked) return;
    const rest = full.slice(spokenIdx);
    let cut;
    if (final) cut = rest.length;
    else {
        let last = -1, m; const re = /[.!?।:]\s|\n/g;
        while ((m = re.exec(rest))) last = m.index + m[0].length;
        if (last < 0) return;
        cut = last;
    }
    let seg = rest.slice(0, cut);
    if ((seg.split("```").length - 1) % 2 === 1) {          // unfinished code block
        if (final) seg = seg.replace(/```[\s\S]*$/, " ");
        else { const k = seg.lastIndexOf("```"); if (k <= 0) return; seg = seg.slice(0, k); cut = k; }
    }
    spokenIdx += cut;
    const clean = seg.replace(/```[\s\S]*?```/g, " ")
        .replace(/`([^`]*)`/g, "$1").replace(/^\s*[-•*]\s+/gm, "").replace(/^#+\s*/gm, "")
        .replace(/https?:\/\/\S+/g, "").replace(/[*_#>|~]/g, "").trim();
    if (clean.length > 1) say(clean);
}
function stopSpeech() { speechSynthesis.cancel(); }
function checkTamilVoice() {
    if (lang === "ta" && speechSynthesis.getVoices().length && !pickVoice("ta-IN"))
        setStatus("Tamil voice not found on this device. Install Tamil speech in Windows Settings > Time & Language > Speech.", 9000);
}

// ---------- send + stream ----------
async function sendMessage(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    welcome.style.display = "none";
    stopSpeech(); spokenIdx = 0;
    addUser(text);
    input.value = "";
    const body = addAI();

    busy = true; sendBtn.textContent = "■"; sendBtn.title = "Stop";
    controller = new AbortController();
    let full = "", videos = [], failed = false, scheduled = false;

    const render = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            const stick = nearBottom();
            body.innerHTML = markdown(full);
            addCopyButtons(body);
            if (stick) scrollDown();
        });
    };

    try {
        const res = await fetch("/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({ message: text, subject: subjectSel.value, language: lang, history }),
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                const msg = JSON.parse(line);
                if (msg.t) { full += msg.t; render(); speakProgress(full, false); }
                else if (msg.videos) videos = msg.videos;
                else if (msg.error) { failed = true; full += (full ? "\n\n" : "") + "⚠️ " + msg.error; render(); }
            }
        }
    } catch (e) {
        if (e.name !== "AbortError") { failed = true; full += (full ? "\n\n" : "") + "⚠️ Network error: " + e.message; }
    }

    body.innerHTML = full ? markdown(full) : "<p>…</p>";
    addCopyButtons(body);
    if (!failed) speakProgress(full, true);

    if (videos.length) {
        const box = document.createElement("div");
        box.className = "videos";
        videos.forEach(v => {
            const a = document.createElement("a");
            a.href = v.url; a.target = "_blank"; a.rel = "noopener";
            a.textContent = "▶ " + v.title;
            box.appendChild(a);
        });
        body.appendChild(box);
    }
    if (!failed && full) {
        history.push({ role: "user", content: text }, { role: "assistant", content: full });
        history = history.slice(-12);
    }
    busy = false; sendBtn.textContent = "➤"; sendBtn.title = "Send";
    if (nearBottom()) scrollDown();
}

// ---------- voice INPUT (shows words live, sends automatically) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null, listening = false;
if (SR) {
    recog = new SR();
    recog.interimResults = true;
    recog.onresult = e => {
        let t = "", isFinal = false;
        for (let i = e.resultIndex; i < e.results.length; i++) {
            t += e.results[i][0].transcript;
            if (e.results[i].isFinal) isFinal = true;
        }
        input.value = t;
        if (isFinal) sendMessage(t);
    };
    recog.onend = () => { listening = false; micBtn.classList.remove("listening"); setStatus(""); };
    recog.onerror = e => { listening = false; micBtn.classList.remove("listening"); setStatus("Mic error: " + e.error, 4000); };
    micBtn.onclick = () => {
        if (listening) { recog.stop(); return; }
        stopSpeech();
        recog.lang = lang === "ta" ? "ta-IN" : "en-IN";
        recog.start();
        listening = true;
        micBtn.classList.add("listening");
        setStatus(lang === "ta" ? "கேட்கிறேன்… பேசுங்கள்" : "Listening… speak now");
    };
} else {
    micBtn.disabled = true;
    micBtn.title = "Voice input needs Chrome or Edge";
}

// ---------- controls ----------
document.querySelectorAll("#langSeg button").forEach(b => {
    b.onclick = () => {
        lang = b.dataset.lang;
        document.querySelectorAll("#langSeg button").forEach(x => x.classList.toggle("on", x === b));
        input.placeholder = lang === "ta" ? "உங்கள் கேள்வியைக் கேளுங்கள்..." : "Ask your question...";
        checkTamilVoice();
    };
});
document.querySelectorAll(".chip").forEach(c => c.onclick = () => sendMessage(c.dataset.q));
sendBtn.onclick = () => {
    if (busy) { controller.abort(); stopSpeech(); }
    else sendMessage(input.value);
};
input.addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(input.value); });
speakToggle.onchange = () => { if (!speakToggle.checked) stopSpeech(); };
speechSynthesis.onvoiceschanged = () => {};