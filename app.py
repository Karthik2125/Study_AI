import os
import json
import time
import requests
from urllib.parse import quote
from flask import Flask, render_template, request, Response, stream_with_context
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
GEMINI_KEY = os.getenv("GEMINI_API_KEY")
YOUTUBE_KEY = os.getenv("YOUTUBE_API_KEY")

# Preferred model first. Others are added automatically if it runs out of quota.
MODELS = ["gemini-3.8-flash"]

LANGUAGES = {"en": "English", "ta": "Tamil"}
VIDEO_WORDS = ["video", "reference", "link", "youtube", "tutorial",
               "வீடியோ", "லிங்க்"]

_model_cache = []


def build_system_prompt(subject, lang):
    return f"""You are a friendly, patient {subject} tutor for a student.
Reply ONLY in {LANGUAGES[lang]}. (Keep code and technical terms in English.)
Rules:
- Start answering immediately, no long introduction.
- Explain step by step, from simple to advanced.
- Give a short real-world example for every concept.
- Show code examples in code blocks when relevant.
- Keep answers under about 150 words unless the student asks for more detail,
  because they will be read aloud.
- End with one small practice question for the student.
- If the question is not about {subject}, politely guide the student back."""


def get_models():
    """Ask Google which Flash models this key can use (cached)."""
    if _model_cache:
        return _model_cache
    try:
        r = requests.get(
            "https://generativelanguage.googleapis.com/v1beta/models",
            headers={"x-goog-api-key": GEMINI_KEY},
            timeout=10,
        )
        skip = ("image", "tts", "live", "audio", "robotics", "computer", "embedding")
        for m in r.json().get("models", []):
            name = m["name"].replace("models/", "")
            if ("generateContent" in m.get("supportedGenerationMethods", [])
                    and "flash" in name
                    and not any(s in name for s in skip)):
                _model_cache.append(name)
    except Exception as e:
        print("Model list error:", e)
    return _model_cache


def stream_gemini(system_prompt, history, message):
    """Yield the answer piece by piece as Gemini writes it."""
    if not GEMINI_KEY:
        raise Exception("GEMINI_API_KEY is missing in the .env file")

    contents = []
    for h in history:
        role = "model" if h["role"] == "assistant" else "user"
        contents.append({"role": role, "parts": [{"text": h["content"]}]})
    contents.append({"role": "user", "parts": [{"text": message}]})

    body = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
    }

    models = MODELS + [m for m in get_models() if m not in MODELS]
    last_error = "Gemini error"

    for model in models:
        for attempt in range(2):
            r = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse",
                headers={"x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json"},
                json=body,
                stream=True,
                timeout=60,
            )
            if r.status_code == 200:
                print("Answering with:", model)
                for raw in r.iter_lines():
                    if not raw:
                        continue
                    line = raw.decode("utf-8")
                    if not line.startswith("data:"):
                        continue
                    try:
                        payload = json.loads(line[5:].strip())
                        parts = payload["candidates"][0]["content"]["parts"]
                    except (KeyError, IndexError, ValueError):
                        continue
                    text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
                    if text:
                        yield text
                return

            try:
                last_error = r.json().get("error", {}).get("message", "Gemini error")
            except ValueError:
                last_error = "Gemini error"
            print(f"{model} failed ({r.status_code})")
            if r.status_code in (500, 503):
                time.sleep(1)      # server busy: retry same model once
                continue
            break                  # quota (429) or not found: try next model
    raise Exception(last_error)


def search_videos(query, lang):
    # No YouTube key: give a YouTube search link instead
    if not YOUTUBE_KEY:
        return [{
            "title": "Search YouTube: " + query,
            "url": "https://www.youtube.com/results?search_query=" + quote(query),
        }]
    try:
        r = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "q": query,
                "type": "video",
                "maxResults": 3,
                "relevanceLanguage": lang,
                "key": YOUTUBE_KEY,
            },
            timeout=10,
        )
        items = r.json().get("items", [])
        return [
            {
                "title": i["snippet"]["title"],
                "url": "https://www.youtube.com/watch?v=" + i["id"]["videoId"],
            }
            for i in items
        ]
    except Exception as e:
        print("YouTube error:", e)
        return []


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json()
    message = data["message"]
    subject = data.get("subject", "Python")
    lang = data.get("language", "en")
    history = data.get("history", [])

    def generate():
        try:
            for piece in stream_gemini(build_system_prompt(subject, lang), history, message):
                yield json.dumps({"t": piece}, ensure_ascii=False) + "\n"
        except Exception as e:
            yield json.dumps({"error": str(e)}, ensure_ascii=False) + "\n"
            return

        if any(w in message.lower() for w in VIDEO_WORDS):
            query = f"{subject} {message} tutorial"
            if lang == "ta":
                query += " tamil"
            yield json.dumps({"videos": search_videos(query, lang)}, ensure_ascii=False) + "\n"

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    app.run(debug=True, port=8000)