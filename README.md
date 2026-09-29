# Study AI (Voice + Tamil/English + YouTube links)

## 1. Get your API keys
- Anthropic key: https://console.anthropic.com  (API Keys)
- YouTube key: https://console.cloud.google.com -> enable "YouTube Data API v3" -> Credentials -> Create API key

Open the `.env` file and paste both keys (no quotes, no spaces).

## 2. Install
    python -m venv venv
    venv\Scripts\activate          (Windows)
    source venv/bin/activate       (Mac/Linux)
    pip install -r requirements.txt

## 3. Run
    python app.py
Open http://127.0.0.1:5000 in Chrome.

## Notes
- Never share `.env` or upload it to GitHub.
- Tamil voice output needs a Tamil voice installed on your device.
- Set a spending limit in the Anthropic console.
