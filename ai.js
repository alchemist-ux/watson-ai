require("./env")
const { getEnv } = require("./env")
const { generateImage, editImage } = require("./imageProviders")

const defaultOpenRouterModel = "openrouter/free"
const defaultGeminiModel = "gemini-2.5-flash-lite"
const defaultAimlApiModel = "gpt-4o-mini"
const blockedModels = new Map()
const shortErrorText = "bot sedang error"

function getAiProvider() {
    const provider = (getEnv("AI_PROVIDER") || "auto").toLowerCase()
    if (["aimlapi", "openrouter", "gemini", "auto"].includes(provider)) return provider
    return "auto"
}

function isDailyFreeLimitError(message) {
    return /free-models-per-day|add 10 credits|daily limit/i.test(String(message || ""))
}

function isQuotaOrRateLimitError(message, status) {
    const lower = String(message || "").toLowerCase()
    return status === 429 || /quota|rate limit|too many requests|insufficient|credit|billing/i.test(lower)
}

function isModelUnavailableError(message) {
    return /not found|not supported|does not exist|invalid model|model_not_found|no endpoints found/i.test(String(message || ""))
}

function isTransientProviderError(message, status) {
    return status === 400 || status === 502 || status === 503 || status === 504 || /provider returned error|upstream|overloaded|temporarily/i.test(String(message || ""))
}

function isModelBlocked(model) {
    const expiresAt = blockedModels.get(model)
    if (!expiresAt) return false
    if (Date.now() > expiresAt) {
        blockedModels.delete(model)
        return false
    }
    return true
}

function blockModel(model, minutes = 10) {
    blockedModels.set(model, Date.now() + minutes * 60 * 1000)
}

function getUnblockedOrDefault(models) {
    const unblocked = [...new Set(models)].filter((model) => !isModelBlocked(model))
    if (unblocked.length) return unblocked
    return ["openrouter/free"]
}

function missingOpenRouterKeyMessage() {
    return shortErrorText
}

function missingGeminiKeyMessage() {
    return shortErrorText
}

function missingAimlApiKeyMessage() {
    return shortErrorText
}

function detectToneFromHistory(history = []) {
    const recentUserText = history
        .filter((entry) => entry.role === "user")
        .slice(-4)
        .map((entry) => entry.content)
        .join(" ")
        .toLowerCase()

    if (/\b(gw|gue|lu|loe|bro|gan|min|bang|cuy|wkwk|anjir|gak|ngga|udah|banget)\b/.test(recentUserText)) return "gaul"
    if (/\b(anda|bapak|ibu|mohon|terima kasih|dengan hormat)\b/.test(recentUserText)) return "formal"
    return "santai"
}

function buildSystemInstruction(userName, history = []) {
    const tone = detectToneFromHistory(history)
    const toneGuide = {
        gaul: "Pakai bahasa gaul Indonesia yang natural secukupnya. Jangan lebay.",
        formal: "Pakai bahasa sopan, jelas, dan ringkas.",
        santai: "Santai dan ringan seperti chat teman dekat.",
    }[tone]

    return [
        `Kamu Watson, teman ngobrol di WhatsApp. Nama lawan bicara: ${userName}.`,
        "Jawab dengan bahasa Indonesia yang natural, ramah, dan nyambung.",
        toneGuide,
        "Gaya utama: singkat, to the point, tidak banyak basa-basi.",
        "Jangan mulai dengan 'Tentu', 'Baik', 'Siap', 'Sebagai AI', atau pembuka template lain.",
        "Jangan menjelaskan aturan/gaya jawabanmu. Jangan menulis catatan seperti 'Note:' atau terjemahan tambahan jika tidak diminta.",
        "Kalau pertanyaan sederhana, jawab 1-3 kalimat saja.",
        "Kalau butuh penjelasan, beri poin penting saja. Jangan terlalu panjang kecuali diminta detail.",
        "Kalau user bertanya cara membuat, menjelaskan, coding, API, bisnis, belajar, atau langkah teknis, langsung jawab isi pertanyaannya dengan langkah praktis.",
        "Jangan membalas pertanyaan instruksional dengan respons pendek seperti 'Paham', 'Iya, lanjut', 'Oke', atau 'Mau dibantu apa?'.",
        "Jangan menganggap koreksi user sebagai curhat. Kalau user mengoreksi maksudnya, perbaiki jawaban dan jawab pertanyaan aslinya.",
        "Kalau user menulis 'lah', 'nggak', 'bukan itu', atau nada kesal, jangan defensif. Langsung luruskan dan beri jawaban yang diminta.",
        "Kalau user cuma ngobrol santai, balas santai dan pendek.",
        "Kalau user minta pendapat, beri pendapat yang jelas tanpa muter-muter.",
        "Kalau user minta kode, tulis kode yang bisa langsung dipakai dan penjelasan minimal.",
        "Kalau user bertanya lore, cerita game, karakter, film, anime, sejarah, atau pengetahuan umum, jawab sebagai penjelasan biasa. Jangan mengubahnya menjadi tugas coding, simulasi, file, atau UI kecuali user jelas meminta dibuatkan file/aplikasi.",
        "Jangan membuat link palsu, placeholder seperti your-repo, atau instruksi template yang tidak diminta.",
        "Jangan menulis kalimat rusak atau terjemahan mentah. Kalau tidak yakin, jawab singkat dengan bagian yang kamu tahu dan beri tahu bahwa detailnya bisa dibahas lanjut.",
        "Jangan mengarang fakta spesifik seperti angka, tanggal, nama orang, versi, lokasi, atau sumber kalau tidak yakin. Lebih baik bilang 'aku belum yakin' daripada menebak.",
        "Untuk pertanyaan faktual, bedakan mana yang pasti, mana yang perkiraan. Jangan pakai referensi atau kutipan kecuali benar-benar diminta dan kamu yakin.",
        "Kalau konteks user kurang jelas, beri jawaban paling mungkin secara singkat dan tanyakan detail lanjutan hanya jika benar-benar perlu.",
        "Kalau user ingin mengilustrasikan masalah, bantu ubah menjadi peta situasi, opsi, konsekuensi, dan langkah berikutnya.",
        "Kalau user ingin membuat website/aplikasi, bantu gambarkan struktur halaman, alur user, komponen, dan contoh file bila diminta.",
        "Kalau user minta gambar, arahkan memakai command !gambar atau kalimat 'buat gambar ...'.",
    ].join("\n")
}

function buildChatMessages(prompt, userName = "pengguna", history = []) {
    const messages = [{ role: "system", content: buildSystemInstruction(userName, history) }]

    for (const entry of history) {
        if (!entry?.role || !entry?.content) continue
        messages.push({
            role: entry.role === "assistant" ? "assistant" : "user",
            content: entry.content,
        })
    }

    messages.push({ role: "user", content: prompt })
    return messages
}

function extractChatCompletionText(data) {
    const message = data?.choices?.[0]?.message
    if (typeof message?.content === "string" && message.content.trim()) return message.content.trim()

    if (Array.isArray(message?.content)) {
        const texts = message.content
            .map((part) => part?.text || part?.content)
            .filter((text) => typeof text === "string" && text.trim())

        if (texts.length) return texts.join("\n")
    }

    if (message?.reasoning || message?.reasoning_details) {
        return null
    }

    return null
}

function isLowQualityAnswer(text) {
    const value = String(text || "").trim()
    if (!value) return true

    const lower = value.toLowerCase()
    const brokenPatterns = [
        /your-repo/,
        /kode generak/,
        /kalimat pendapatan/,
        /jangan nibra/,
        /tidak bilmu/,
        /tidak saya tidak bilmu/,
        /minta tahu cepat apa adalah/,
        /uang dengan jumlah data proses/,
        /catatan-angkat/,
    ]

    if (brokenPatterns.some((pattern) => pattern.test(lower))) return true

    const fakeLinkLike = /\]\(https?:\/\/github\.com\/your-repo/i.test(value)
    if (fakeLinkLike) return true

    const words = lower.split(/\s+/).filter(Boolean)
    const oddWords = words.filter((word) => /(?:bilmu|telos|nibra|generak|kebar|haruslah)/i.test(word))
    if (words.length >= 12 && oddWords.length >= 2) return true

    return false
}

function getOpenRouterModelCandidates() {
    const fromEnv = getEnv("OPENROUTER_MODEL")
    const models = [
        fromEnv,
        "openrouter/free",
    ].filter(Boolean)

    return getUnblockedOrDefault(models)
}

function getOpenRouterVisionModelCandidates() {
    const fromEnv = getEnv("OPENROUTER_VISION_MODEL")
    const models = [
        fromEnv,
        "google/gemma-4-31b-it:free",
        "google/gemma-4-26b-a4b-it:free",
        "nvidia/nemotron-nano-12b-v2-vl:free",
        "openrouter/free",
    ].filter(Boolean)

    return getUnblockedOrDefault(models)
}

async function requestAimlApi(bodyBase) {
    const apiKey = getEnv("AIMLAPI_API_KEY")
    if (!apiKey) return { ok: false, text: missingAimlApiKeyMessage() }

    const model = getEnv("AIMLAPI_MODEL") || defaultAimlApiModel
    if (isModelBlocked(`aimlapi:${model}`)) return { ok: false, text: shortErrorText }

    const timeoutMs = Number(getEnv("AIMLAPI_TIMEOUT_MS")) || 7000
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const baseUrl = (getEnv("AIMLAPI_BASE_URL") || "https://api.aimlapi.com/v1").replace(/\/+$/, "")

    try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                ...bodyBase,
                model,
                max_tokens: Number(getEnv("AIMLAPI_MAX_TOKENS")) || Number(getEnv("OPENROUTER_MAX_TOKENS")) || 700,
                temperature: Number(getEnv("AIMLAPI_TEMPERATURE")) || Number(getEnv("OPENROUTER_TEMPERATURE")) || 0.5,
            }),
            signal: controller.signal,
        })

        const data = await response.json().catch(() => ({}))
        if (response.ok) {
            const text = extractChatCompletionText(data)
            if (text && !isLowQualityAnswer(text)) return { ok: true, text }
            blockModel(`aimlapi:${model}`, 3)
            return { ok: false, text: shortErrorText }
        }

        const message = data.error?.message || data.message || `error ${response.status}`
        if (isQuotaOrRateLimitError(message, response.status)) {
            blockModel(`aimlapi:${model}`, 5)
        } else if (isModelUnavailableError(message)) {
            blockModel(`aimlapi:${model}`, 10)
        } else if (isTransientProviderError(message, response.status)) {
            blockModel(`aimlapi:${model}`, 3)
        }

        return { ok: false, text: shortErrorText }
    } catch (error) {
        return { ok: false, text: shortErrorText }
    } finally {
        clearTimeout(timeout)
    }
}

async function requestOpenRouter(bodyBase, models = getOpenRouterModelCandidates()) {
    const apiKey = getEnv("OPENROUTER_API_KEY")
    if (!apiKey) return { ok: false, text: missingOpenRouterKeyMessage() }
    if (!models.length) return { ok: false, text: shortErrorText }

    let lastError = ""

    for (const model of models) {
        const controller = new AbortController()
        const timeoutMs = Number(getEnv("OPENROUTER_TIMEOUT_MS")) || 30000
        const timeout = setTimeout(() => controller.abort(), timeoutMs)

        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${apiKey}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": getEnv("OPENROUTER_SITE_URL") || "http://localhost",
                    "X-OpenRouter-Title": getEnv("OPENROUTER_APP_NAME") || "Watson WhatsApp Bot",
                    "X-Title": getEnv("OPENROUTER_APP_NAME") || "Watson WhatsApp Bot",
                },
                body: JSON.stringify({
                    include_reasoning: false,
                    reasoning: { exclude: true },
                    ...bodyBase,
                    model,
                }),
                signal: controller.signal,
            })

            const data = await response.json().catch(() => ({}))
            if (response.ok) {
                const text = extractChatCompletionText(data)
                if (text && !isLowQualityAnswer(text)) return { ok: true, text }
                if (text) {
                    lastError = shortErrorText
                    blockModel(model, 3)
                    continue
                }
                lastError = shortErrorText
                continue
            }

            const message = data.error?.message || data.message || `error ${response.status}`
            lastError = message

            if (isQuotaOrRateLimitError(message, response.status)) {
                if (isDailyFreeLimitError(message)) {
                    blockModel(model, model === "openrouter/free" ? 0.5 : 60)
                } else {
                    blockModel(model, model === "openrouter/free" ? 0.5 : 5)
                }
                continue
            }

            if (isModelUnavailableError(message)) {
                blockModel(model, 10)
                continue
            }

            if (isTransientProviderError(message, response.status)) {
                blockModel(model, 3)
                continue
            }

            return { ok: false, text: shortErrorText }
        } catch (error) {
            lastError = error.name === "AbortError"
                ? shortErrorText
                : error.message || String(error)
        } finally {
            clearTimeout(timeout)
        }
    }

    return { ok: false, text: shortErrorText }
}

function buildGeminiContents(prompt, history = []) {
    const contents = []

    for (const entry of history) {
        if (!entry?.role || !entry?.content) continue
        contents.push({
            role: entry.role === "assistant" ? "model" : "user",
            parts: [{ text: entry.content }],
        })
    }

    contents.push({
        role: "user",
        parts: [{ text: prompt }],
    })

    return contents
}

function extractGeminiText(data) {
    const parts = data?.candidates?.[0]?.content?.parts
    if (!Array.isArray(parts)) return null

    const texts = parts
        .map((part) => part?.text)
        .filter((text) => typeof text === "string" && text.trim())

    return texts.length ? texts.join("\n").trim() : null
}

async function askGemini(prompt, userName = "pengguna", history = []) {
    const apiKey = getEnv("GEMINI_API_KEY") || getEnv("GOOGLE_API_KEY")
    if (!apiKey) return { ok: false, text: missingGeminiKeyMessage() }

    const model = getEnv("GEMINI_MODEL") || defaultGeminiModel
    const timeoutMs = Number(getEnv("GEMINI_TIMEOUT_MS")) || 30000
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": apiKey,
                },
                body: JSON.stringify({
                    systemInstruction: {
                        parts: [{ text: buildSystemInstruction(userName, history) }],
                    },
                    contents: buildGeminiContents(prompt, history),
                    generationConfig: {
                        maxOutputTokens: Number(getEnv("GEMINI_MAX_TOKENS")) || 1000,
                        temperature: Number(getEnv("GEMINI_TEMPERATURE")) || 0.7,
                    },
                }),
                signal: controller.signal,
            },
        )

        const data = await response.json().catch(() => ({}))
        if (response.ok) {
            const text = extractGeminiText(data)
            if (text && !isLowQualityAnswer(text)) return { ok: true, text }
            return { ok: false, text: shortErrorText }
        }

        return { ok: false, text: shortErrorText }
    } catch (error) {
        return {
            ok: false,
            text: error.name === "AbortError"
                ? shortErrorText
                : shortErrorText,
        }
    } finally {
        clearTimeout(timeout)
    }
}

function getProviderOrder(provider) {
    if (provider === "aimlapi") return ["aimlapi", "gemini", "openrouter"]
    if (provider === "gemini") return ["gemini", "aimlapi", "openrouter"]
    if (provider === "openrouter") return ["openrouter", "aimlapi", "gemini"]
    return ["aimlapi", "gemini", "openrouter"]
}

async function requestTextProvider(provider, bodyBase, prompt, userName, history) {
    if (provider === "aimlapi") return requestAimlApi(bodyBase)
    if (provider === "gemini") return askGemini(prompt, userName, history)
    if (provider === "openrouter") return requestOpenRouter(bodyBase)
    return { ok: false, text: shortErrorText }
}

async function askWatsonAI(prompt, userName = "pengguna", history = []) {
    const bodyBase = {
        messages: buildChatMessages(prompt, userName, history),
        max_tokens: Number(getEnv("OPENROUTER_MAX_TOKENS")) || 1200,
        temperature: Number(getEnv("OPENROUTER_TEMPERATURE")) || 0.8,
    }

    const provider = getAiProvider()
    const providers = getProviderOrder(provider)

    for (const providerName of providers) {
        const result = await requestTextProvider(providerName, bodyBase, prompt, userName, history)
        if (result.ok) return result.text
        console.warn(`[AI] ${providerName} gagal, coba fallback berikutnya`)
    }

    return shortErrorText
}

async function askOpenRouter(prompt, userName = "pengguna", history = []) {
    const bodyBase = {
        messages: buildChatMessages(prompt, userName, history),
        max_tokens: Number(getEnv("OPENROUTER_MAX_TOKENS")) || 1200,
        temperature: Number(getEnv("OPENROUTER_TEMPERATURE")) || 0.8,
    }

    const result = await requestOpenRouter(bodyBase)
    return result.ok ? result.text : shortErrorText
}

async function askAimlApi(prompt, userName = "pengguna", history = []) {
    const bodyBase = {
        messages: buildChatMessages(prompt, userName, history),
        max_tokens: Number(getEnv("AIMLAPI_MAX_TOKENS")) || 700,
        temperature: Number(getEnv("AIMLAPI_TEMPERATURE")) || 0.5,
    }

    const result = await requestAimlApi(bodyBase)
    return result.ok ? result.text : shortErrorText
}

function imageBufferToDataUrl(buffer, mimeType = "image/jpeg") {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return ""
    return `data:${mimeType};base64,${buffer.toString("base64")}`
}

async function analyzeImage(prompt, imageBuffer, mimeType = "image/jpeg", userName = "pengguna") {
    const dataUrl = imageBufferToDataUrl(imageBuffer, mimeType)
    if (!dataUrl) return shortErrorText

    const bodyBase = {
        messages: [
            {
                role: "system",
                content: [
                    buildSystemInstruction(userName, []),
                    "User mengirim gambar. Analisis gambar dengan teliti.",
                    "Jawab singkat tapi informatif: objek utama, konteks, teks yang terlihat, dan jawaban sesuai pertanyaan user.",
                ].join("\n"),
            },
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: prompt || "Analisis gambar ini.",
                    },
                    {
                        type: "image_url",
                        image_url: { url: dataUrl },
                    },
                ],
            },
        ],
        max_tokens: Number(getEnv("OPENROUTER_VISION_MAX_TOKENS")) || 700,
        temperature: 0.4,
    }

    const result = await requestOpenRouter(bodyBase, getOpenRouterVisionModelCandidates())
    if (result.ok) return result.text

    return shortErrorText
}

const CODE_DEV_KEYWORDS = /\b(html|css|javascript|js|typescript|react|vue|angular|node\.?js|python|java|php|website|web\s*site|frontend|backend|api|kode|coding|program|script|database|sql)\b/i
const IMAGE_KEYWORD = /\b(gambar|foto|ilustrasi|image|picture|pic|wallpaper|poster|avatar|banner|logo|stiker|sticker|thumbnail|cover)\b/i
const IMAGE_INTENT_PATTERNS = [
    /^(?:buat(?:kan)?|generate|ciptakan)\s+(?:gambar|image|ilustrasi|foto|picture|logo|poster|banner|avatar|thumbnail|cover)\s*(?:dari|tentang|of)?\s*(.+)$/i,
    /^(?:gambar|image|foto|logo|poster|banner|avatar|thumbnail|cover)\s*[:]\s*(.+)$/i,
    /^!?(?:gambar|img|image|dalle)\s+(.+)$/i,
    /^(?:buatin|bikinin|buatkin|bikinkan)\s+(?:gw|gue|gua|aku|saya)?\s*(?:gambar|foto|pic|image|logo|poster|banner|avatar|thumbnail|cover)\s+(.+)$/i,
    /^(?:minta|mau|pengen|ingin)\s+(?:gambar|foto|ilustrasi|logo|poster|banner|avatar|thumbnail|cover)\s+(?:dari|tentang)?\s*(.+)$/i,
    /^(?:gambar|foto|ilustrasi|logo|poster|banner|avatar|thumbnail|cover)\s+(?:dong\s+|ya\s+|deh\s+)?(.+)$/i,
]

function cleanImagePrompt(prompt) {
    return String(prompt || "")
        .replace(/^(?:gw|gue|gua|aku|saya)\s+/i, "")
        .replace(/^(?:gambar|foto|pic|image|logo|poster|banner|avatar|thumbnail|cover)\s+/i, "")
        .trim()
}

function detectImagePrompt(text) {
    const trimmed = String(text || "").trim()
    if (!trimmed || CODE_DEV_KEYWORDS.test(trimmed)) return null

    if (!IMAGE_KEYWORD.test(trimmed)) {
        const commandOnly = trimmed.match(/^!?(?:gambar|img|image|dalle)\s+(.+)$/i)
        return commandOnly?.[1] ? cleanImagePrompt(commandOnly[1]) : null
    }

    for (const pattern of IMAGE_INTENT_PATTERNS) {
        const match = trimmed.match(pattern)
        if (match?.[1]?.trim()) return cleanImagePrompt(match[1])
    }

    return null
}

function shouldAutoChat(text) {
    const trimmed = String(text || "").trim()
    return Boolean(trimmed && !detectImagePrompt(trimmed))
}

function isCasualGreeting(text) {
    return /^(oy|oi|hey|hay|hai|hi|halo|hello|yo|woy|woi|p|ping|test|tes)[\s!?.]*$/i.test(String(text || "").trim())
}

module.exports = {
    askChatGPT: askWatsonAI,
    askWatsonAI,
    askOpenRouter,
    askAimlApi,
    askGemini,
    analyzeImage,
    generateImage,
    editImage,
    detectImagePrompt,
    shouldAutoChat,
    isCasualGreeting,
}
