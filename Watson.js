const os = require("os")
const {
    askChatGPT,
    analyzeImage,
    editImage,
    generateImage,
    detectImagePrompt,
} = require("./ai")
const {
    buildAgentArtifact,
    detectAgentArtifactRequest,
} = require("./agentArtifacts")

const botName = "Watson Bot"
const startedAt = Date.now()
const MAX_HISTORY = 16
const chatSessions = new Map()
const aiCooldowns = new Map()
const aiInFlight = new Set()
const groupAiLastReply = new Map()

function getAiCooldownMs() {
    const minutes = Number(process.env.AI_RATE_LIMIT_COOLDOWN_MINUTES)
    if (Number.isFinite(minutes) && minutes >= 0) return minutes * 60 * 1000
    return 3 * 60 * 1000
}

function getMessageText(msg) {
    const message = msg.message || {}
    const viewOnce = message.viewOnceMessage?.message || message.viewOnceMessageV2?.message
    const content = viewOnce || message

    return (
        content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        content.buttonsResponseMessage?.selectedButtonId ||
        content.listResponseMessage?.singleSelectReply?.selectedRowId ||
        content.templateButtonReplyMessage?.selectedId ||
        ""
    ).trim()
}

function getMessageContent(msg) {
    const message = msg.message || {}
    const viewOnce = message.viewOnceMessage?.message || message.viewOnceMessageV2?.message
    return viewOnce || message
}

function getMentionedJids(msg) {
    const content = getMessageContent(msg)
    return (
        content.extendedTextMessage?.contextInfo?.mentionedJid ||
        content.imageMessage?.contextInfo?.mentionedJid ||
        content.videoMessage?.contextInfo?.mentionedJid ||
        []
    )
}

function normalizeJidUser(jid) {
    return String(jid || "").split("@")[0].split(":")[0]
}

function lidToPhoneJid(jid) {
    const user = normalizeJidUser(jid)
    if (!user || !/^\d+$/.test(user)) return null
    return `${user}@s.whatsapp.net`
}

function getBotJid(watson) {
    return watson?.user?.id || watson?.authState?.creds?.me?.id || ""
}

function getBotMentionNames(watson) {
    return [
        "watson",
        "bot",
        "squers ai",
        watson?.user?.name,
    ].filter(Boolean)
}

function isBotMentioned(watson, msg, text = "") {
    const botUser = normalizeJidUser(getBotJid(watson))
    const mentionedUsers = getMentionedJids(msg).map(normalizeJidUser)
    if (botUser && mentionedUsers.includes(botUser)) return true

    if (mentionedUsers.length && process.env.GROUP_REPLY_ON_ANY_MENTION !== "false") {
        return true
    }

    const lower = String(text || "").toLowerCase()
    return getBotMentionNames(watson).some((name) => {
        const normalized = String(name || "").toLowerCase().replace(/^@/, "").trim()
        return normalized && lower.includes(normalized)
    })
}

function cleanBotMentionText(watson, msg, text = "") {
    let cleaned = String(text || "")
    const botUser = normalizeJidUser(getBotJid(watson))
    const mentionedUsers = getMentionedJids(msg).map(normalizeJidUser)
    const usersToRemove = [botUser, ...mentionedUsers].filter(Boolean)

    for (const user of usersToRemove) {
        cleaned = cleaned.replace(new RegExp(`@${user}\\b`, "g"), "")
    }

    for (const name of getBotMentionNames(watson)) {
        const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        cleaned = cleaned.replace(new RegExp(`@?${escaped}`, "ig"), "")
    }

    return cleaned.replace(/\s+/g, " ").trim()
}

function getMessageKind(msg) {
    const content = getMessageContent(msg)

    if (content.conversation || content.extendedTextMessage?.text) return "text"
    if (content.imageMessage) return "image"
    if (content.videoMessage) return "video"
    if (content.audioMessage) return "audio"
    if (content.stickerMessage) return "sticker"
    if (content.documentMessage) return "document"
    if (content.contactMessage || content.contactsArrayMessage) return "contact"
    if (content.locationMessage || content.liveLocationMessage) return "location"
    if (content.reactionMessage) return "reaction"
    if (content.pollCreationMessage || content.pollCreationMessageV2) return "poll"
    if (content.buttonsResponseMessage || content.listResponseMessage || content.templateButtonReplyMessage) return "interactive"
    return Object.keys(content).length ? "message" : "empty"
}

function describeNonTextInput(kind) {
    const labels = {
        audio: "User mengirim voice note/audio. Bot belum bisa transkrip audio, tapi tetap balas natural.",
        sticker: "User mengirim sticker. Tanggapi santai seperti manusia melihat sticker di chat.",
        document: "User mengirim dokumen. Bot belum membaca isi dokumen, minta user jelaskan atau kirim teks/gambar kalau perlu.",
        contact: "User mengirim kontak. Tanggapi natural dan tanyakan perlu diapakan kontak itu.",
        location: "User mengirim lokasi. Tanggapi natural dan tanyakan user ingin dibantu apa terkait lokasi itu.",
        reaction: "User mengirim reaction. Balas singkat dan natural.",
        poll: "User mengirim polling. Tanggapi natural dan tanyakan konteksnya.",
        video: "User mengirim video. Bot belum menganalisis video, tapi tetap balas natural.",
        message: "User mengirim pesan yang belum dikenali formatnya. Tetap balas natural dan minta konteks bila perlu.",
    }

    return labels[kind] || labels.message
}

function getQuotedMessage(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
}

function getMediaSource(msg) {
    const quotedMessage = getQuotedMessage(msg)
    const sourceMessage = quotedMessage ? { message: quotedMessage, key: msg.key } : msg
    const message = sourceMessage.message || {}
    const viewOnce = message.viewOnceMessage?.message || message.viewOnceMessageV2?.message
    const content = viewOnce || message

    if (content.imageMessage) return { sourceMessage }
    if (content.videoMessage) return { sourceMessage }

    return null
}

function getMessageMimeType(msg) {
    const sourceMessage = msg?.message ? msg : { message: msg }
    const message = sourceMessage.message || {}
    const viewOnce = message.viewOnceMessage?.message || message.viewOnceMessageV2?.message
    const content = viewOnce || message

    return (
        content.imageMessage?.mimetype ||
        content.videoMessage?.mimetype ||
        "image/jpeg"
    )
}

function formatUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60

    return `${hours} jam ${minutes} menit ${seconds} detik`
}

function menuText(pushname, prefix) {
    return [
        `Halo ${pushname}, saya ${botName}.`,
        "",
        "Menu cepat:",
        `${prefix}menu - tampilkan menu`,
        `${prefix}halo - sapaan singkat`,
        `${prefix}ping - cek respon bot`,
        `${prefix}info - info bot`,
        `${prefix}quote - kata-kata random`,
        `${prefix}ai pertanyaan - tanya AI`,
        `${prefix}gpt pertanyaan - alias tanya AI`,
        `${prefix}gambar deskripsi - buat gambar`,
        `${prefix}img deskripsi - alias buat gambar`,
        `${prefix}ilustrasi topik - kirim file peta ide/dilema`,
        `${prefix}mockup website ide - kirim file HTML ilustrasi website`,
        `${prefix}pdf topik - buat dan kirim file PDF`,
        `${prefix}word topik - buat dan kirim Microsoft Word .docx`,
        `${prefix}simulasi roket - buat simulasi HTML interaktif`,
        `${prefix}railway nodejs - buat railway.json`,
        `${prefix}github nodejs - buat GitHub Actions workflow`,
        `${prefix}agent jenis + topik - buat file: pdf, word, json, csv, html, md, env, kode`,
        `${prefix}lihat/analisis - balas/kirim gambar untuk dianalisis`,
        `${prefix}edit instruksi - edit gambar (opsional NanoBanana)`,
        `${prefix}reset - hapus riwayat chat AI`,
        `${prefix}owner - kontak owner`,
        `${prefix}sticker - balas gambar/video pendek dengan command ini`,
        "",
        "Chat natural (tanpa !):",
        "Ketik apa saja - bot adaptif (gaul/formal). Balas semua di chat pribadi & grup.",
        "Contoh: oy / hay / lagi ngapain / buatin gw gambar kucing",
        "menu / reset - tanpa prefix",
        "",
        `Ketik ${prefix}help nama_perintah untuk bantuan singkat.`,
    ].join("\n")
}

function getSession(jid) {
    if (!chatSessions.has(jid)) chatSessions.set(jid, [])
    return chatSessions.get(jid)
}

function pushSession(jid, role, content) {
    const session = getSession(jid)
    session.push({ role, content })
    while (session.length > MAX_HISTORY) session.shift()
}

function clearSession(jid) {
    chatSessions.delete(jid)
}

async function safeAction(label, action) {
    try {
        return await action()
    } catch (error) {
        console.error(`${label}:`, error.message || error)
        return null
    }
}

function sendOptions(watson, msg, options = {}) {
    const jid = msg.key.remoteJid
    const base = { ...options }

    if (jid?.endsWith("@g.us") && typeof watson.cachedGroupMetadata === "function") {
        base.cachedGroupMetadata = watson.cachedGroupMetadata
    }

    return base
}

async function sendReply(watson, msg, text) {
    const jid = msg.key.remoteJid
    const isGroup = jid.endsWith("@g.us")

    if (isGroup) {
        const groupOptions = () => sendOptions(watson, msg, { useUserDevicesCache: false })

        const firstGroupResult = await safeAction("Gagal mengirim balasan grup", () => watson.sendMessage(
            jid,
            { text },
            groupOptions(),
        ))
        if (firstGroupResult) return firstGroupResult

        await safeAction("Gagal reset sender key grup", () => watson.resetGroupSenderKey?.(jid))
        await safeAction("Gagal refresh metadata grup", () => watson.refreshGroupMetadata?.(jid))

        const shortText = text.length > 3500 ? `${text.slice(0, 3500)}\n\n...` : text
        const retryGroupResult = await safeAction("Gagal mengirim balasan grup setelah reset", () => watson.sendMessage(
            jid,
            { text: shortText },
            groupOptions(),
        ))
        if (retryGroupResult) return retryGroupResult

        return null
    }

    return null
}

async function sendImageReply(watson, msg, buffer, caption) {
    const jid = msg.key.remoteJid

    const quotedResult = await safeAction("Gagal mengirim gambar quote", () => watson.sendMessage(
        jid,
        { image: buffer, caption },
        sendOptions(watson, msg, { quoted: msg }),
    ))

    if (quotedResult) return quotedResult

    return safeAction("Gagal mengirim gambar tanpa quote", () => watson.sendMessage(
        jid,
        { image: buffer, caption },
        sendOptions(watson, msg),
    ))
}

async function sendDocumentReply(watson, msg, buffer, fileName, mimetype, caption) {
    const jid = msg.key.remoteJid
    const content = {
        document: buffer,
        fileName,
        mimetype,
        caption,
    }

    const quotedResult = await safeAction("Gagal mengirim dokumen quote", () => watson.sendMessage(
        jid,
        content,
        sendOptions(watson, msg, { quoted: msg }),
    ))

    if (quotedResult) return quotedResult

    return safeAction("Gagal mengirim dokumen tanpa quote", () => watson.sendMessage(
        jid,
        content,
        sendOptions(watson, msg),
    ))
}

async function withTyping(watson, jid, action) {
    const refreshMs = 4000
    let active = true

    const pulseTyping = async () => {
        while (active) {
            await safeAction("Gagal mengirim status mengetik", () => watson.sendPresenceUpdate("composing", jid))
            await new Promise((resolve) => setTimeout(resolve, refreshMs))
        }
    }

    pulseTyping()
    try {
        return await action()
    } finally {
        active = false
        await safeAction("Gagal reset status mengetik", () => watson.sendPresenceUpdate("paused", jid))
    }
}

function isAiRateLimitAnswer(text) {
    return /rate limit|quota|kuota|too many requests|credit|billing/i.test(String(text || ""))
}

function getCooldownUntil(jid) {
    return aiCooldowns.get(jid) || 0
}

function setAiCooldown(jid) {
    aiCooldowns.set(jid, Date.now() + getAiCooldownMs())
}

function getGroupAiMinIntervalMs() {
    const seconds = Number(process.env.GROUP_AI_MIN_INTERVAL_SECONDS)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    return 8 * 1000
}

function shouldThrottleGroupAi(jid) {
    if (!jid?.endsWith("@g.us")) return false
    const minInterval = getGroupAiMinIntervalMs()
    if (!minInterval) return false

    const lastReplyAt = groupAiLastReply.get(jid) || 0
    return Date.now() - lastReplyAt < minInterval
}

function markGroupAiReply(jid) {
    if (jid?.endsWith("@g.us")) groupAiLastReply.set(jid, Date.now())
}

function localFallbackReply(prompt, pushname) {
    const text = String(prompt || "").trim()
    const lower = text.toLowerCase()

    if (/\b(api ai sendiri|api sendiri|kayak open ai|seperti openai|seperti open ai)\b/i.test(lower)) {
        return "bot sedang error"
    }

    if (/\b(cara|gimana|bagaimana|jelaskan|jelasin|tutorial|langkah|buat|membuat|bikin|coding|kode|api|server|backend|frontend)\b/i.test(lower)) {
        return "bot sedang error"
    }

    if (/sticker|reaction|audio|voice note|dokumen|lokasi|kontak|video/i.test(text)) {
        return "bot sedang error"
    }

    if (/^(p|ping|tes|test|halo|hai|hi|hello|oy|oi|woy|woi)\b/i.test(lower)) {
        return `Iya ${pushname}, ada apa?`
    }

    if (/\?$/.test(text) || /^(apa|siapa|kenapa|mengapa|gimana|bagaimana|kapan|dimana|di mana)\b/i.test(lower)) {
        return "bot sedang error"
    }

    if (/\b(gambar|foto|edit|analisis|lihat|ocr)\b/i.test(lower)) {
        return "bot sedang error"
    }

    const replies = [
        "bot sedang error",
    ]

    return replies[Math.floor(Math.random() * replies.length)]
}

function fastLocalReply(prompt, pushname) {
    const text = String(prompt || "").trim()
    const lower = text.toLowerCase()

    if (/^(p|ping|tes|test)$/i.test(lower)) {
        return "aktif"
    }

    if (/^(halo|hai|hi|hello|hey|hay|oy|oi|woy|woi)\b/i.test(lower)) {
        return `Iya ${pushname}, ada apa?`
    }

    if (/^(makasih|terima kasih|thanks|thank you|thx)\b/i.test(lower)) {
        return "sama-sama"
    }

    if (/^(siapa kamu|kamu siapa|ini siapa)\??$/i.test(lower)) {
        return "Aku Watson, bot WhatsApp yang bisa bantu jawab pertanyaan, bikin gambar, dan buat file."
    }

    if (/^(apa itu roket|jelaskan roket)\??$/i.test(lower)) {
        return "Roket adalah kendaraan yang bergerak dengan mendorong gas panas ke belakang, sehingga tubuh roket terdorong ke depan sesuai prinsip aksi-reaksi."
    }

    return null
}

function slugifyFileName(text, fallback = "ilustrasi") {
    const slug = String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48)

    return slug || fallback
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function stripArtifactCommand(text) {
    return String(text || "")
        .replace(/^!?\s*(?:ilustrasi|ilustrasikan|visualisasi|visualisasikan|peta|file|dokumen|mockup|wireframe)\s*/i, "")
        .replace(/^(?:tolong|coba|bantu|buatkan?|bikinkan?|buatin)\s+/i, "")
        .trim()
}

function detectArtifactRequest(text) {
    const trimmed = String(text || "").trim()
    if (!trimmed) return null

    const isWebsite = /\b(website|web|landing page|homepage|portfolio|toko online|dashboard|aplikasi|app)\b/i.test(trimmed)
    const asksFile = /\b(kirim file|jadi file|file html|html|mockup|wireframe|prototype|template)\b/i.test(trimmed)
    const asksIllustration = /\b(ilustrasi|ilustrasikan|visualisasi|visualisasikan|gambarkan|peta(?:kan)?|flow|alur|skenario|dilema|pilihan|opsi)\b/i.test(trimmed)

    if (isWebsite && asksFile) {
        return { type: "website", prompt: stripArtifactCommand(trimmed) || trimmed }
    }

    if (asksIllustration) {
        return { type: isWebsite ? "website" : "scenario", prompt: stripArtifactCommand(trimmed) || trimmed }
    }

    return null
}

function detectHelpTopic(text) {
    const trimmed = String(text || "").trim()
    const match = trimmed.match(/^(?:help|bantuan|cara pakai|gimana pakai|fitur)\s*(.*)$/i)
    return match?.[1]?.trim().toLowerCase() || null
}

function helpTopicText(topic, prefix) {
    if (/gambar|foto|image|img/.test(topic)) {
        return [
            "Fitur gambar:",
            `${prefix}gambar kucing lucu di taman`,
            "Atau tanpa prefix: buatin gambar logo toko kopi modern",
        ].join("\n")
    }

    if (/pdf|word|docx|dokumen|file/.test(topic)) {
        return [
            "Fitur dokumen:",
            `${prefix}pdf proposal usaha kopi`,
            `${prefix}word surat izin sekolah`,
            "Atau tanpa prefix: buat dokumen word laporan kegiatan pramuka",
        ].join("\n")
    }

    if (/analisis|lihat|ocr/.test(topic)) {
        return [
            "Analisis gambar:",
            "Kirim gambar dengan caption: analisis gambar ini",
            `Atau balas gambar dengan: ${prefix}lihat jelaskan isi gambar`,
        ].join("\n")
    }

    return null
}

function isQuestionLike(text) {
    const trimmed = String(text || "").trim().toLowerCase()
    return /^(apa|siapa|kenapa|mengapa|bagaimana|gimana|kapan|di mana|dimana|jelaskan|terangkan|what|who|why|how)\b/.test(trimmed)
}

function buildScenarioArtifact(prompt, pushname) {
    const topic = String(prompt || "").trim() || "situasi yang sedang kamu hadapi"
    const title = `Peta Situasi - ${topic.slice(0, 80)}`
    const content = [
        title,
        "=".repeat(Math.min(title.length, 80)),
        "",
        `Untuk: ${pushname}`,
        `Topik: ${topic}`,
        "",
        "1. Inti Situasi",
        `   Kamu sedang menghadapi situasi: ${topic}`,
        "   Tujuan file ini adalah memecah masalah menjadi bagian yang lebih mudah dipilih.",
        "",
        "2. Opsi Yang Terlihat",
        "   A. Pilih jalur yang terasa paling aman.",
        "      Cocok kalau kamu butuh stabilitas dan risiko kecil.",
        "   B. Pilih jalur yang membuka peluang lebih besar.",
        "      Cocok kalau kamu siap belajar, mencoba, dan menerima risiko.",
        "   C. Tunda keputusan sebentar sambil mencari data tambahan.",
        "      Cocok kalau informasi yang kamu punya masih kurang.",
        "",
        "3. Pertanyaan Penentu",
        "   - Apa konsekuensi terburuk dari tiap opsi?",
        "   - Opsi mana yang masih bisa diperbaiki kalau ternyata salah?",
        "   - Keputusan mana yang akan tetap kamu hormati 6 bulan dari sekarang?",
        "   - Apakah kamu memilih karena takut, atau karena memang itu arah yang kamu mau?",
        "",
        "4. Peta Keputusan Singkat",
        "   Kalau risikonya besar dan datanya kurang -> cari data dulu.",
        "   Kalau risikonya kecil dan manfaatnya jelas -> coba langkah kecil.",
        "   Kalau dua opsi sama-sama berat -> pilih yang paling selaras dengan tujuan jangka panjang.",
        "",
        "5. Langkah 24 Jam",
        "   - Tulis 3 fakta, bukan asumsi.",
        "   - Tulis 2 opsi utama.",
        "   - Pilih 1 eksperimen kecil yang bisa dilakukan tanpa merusak semuanya.",
        "",
        "Catatan:",
        "File ini bukan keputusan final. Ini peta awal supaya pikiran kamu tidak muter di tempat yang sama.",
    ].join("\n")

    return {
        fileName: `${slugifyFileName(topic, "peta-situasi")}.txt`,
        mimetype: "text/plain",
        buffer: Buffer.from(content, "utf8"),
        caption: "Aku buatin file peta situasinya. Buka file ini buat lihat opsi, konsekuensi, dan langkah awal.",
    }
}

function buildWebsiteArtifact(prompt, pushname) {
    const idea = String(prompt || "").trim() || "website baru"
    const safeIdea = escapeHtml(idea)
    const fileName = `${slugifyFileName(idea, "mockup-website")}.html`
    const html = `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Mockup - ${safeIdea}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; color: #18212f; background: #f5f7fb; }
    header { padding: 18px 24px; background: #101828; color: white; display: flex; justify-content: space-between; align-items: center; }
    nav span { margin-left: 16px; color: #d0d5dd; font-size: 14px; }
    .hero { padding: 56px 24px; background: linear-gradient(135deg, #e0f2fe, #fef3c7); }
    .hero h1 { margin: 0 0 12px; max-width: 760px; font-size: 38px; line-height: 1.1; }
    .hero p { max-width: 680px; font-size: 18px; line-height: 1.5; }
    .actions { margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap; }
    .btn { padding: 12px 16px; border-radius: 8px; border: 0; background: #2563eb; color: white; font-weight: 700; }
    .btn.secondary { background: white; color: #18212f; border: 1px solid #d0d5dd; }
    .section { padding: 32px 24px; max-width: 1080px; margin: auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    .card { background: white; border: 1px solid #e4e7ec; border-radius: 8px; padding: 18px; }
    .card h3 { margin: 0 0 8px; }
    footer { padding: 24px; text-align: center; color: #667085; }
  </style>
</head>
<body>
  <header>
    <strong>${safeIdea}</strong>
    <nav><span>Fitur</span><span>Alur</span><span>Kontak</span></nav>
  </header>
  <main>
    <section class="hero">
      <h1>Ilustrasi awal untuk ${safeIdea}</h1>
      <p>Ini mockup HTML sederhana dari ide yang kamu kirim. Pakai sebagai gambaran struktur halaman sebelum masuk desain detail dan coding serius.</p>
      <div class="actions">
        <button class="btn">Mulai</button>
        <button class="btn secondary">Lihat Detail</button>
      </div>
    </section>
    <section class="section">
      <h2>Struktur Utama</h2>
      <div class="grid">
        <article class="card">
          <h3>Masalah User</h3>
          <p>Jelaskan masalah utama yang diselesaikan website ini.</p>
        </article>
        <article class="card">
          <h3>Solusi</h3>
          <p>Tampilkan fitur atau layanan yang menjadi jawaban dari masalah itu.</p>
        </article>
        <article class="card">
          <h3>Alur</h3>
          <p>Buat langkah jelas: datang, paham, pilih, lalu aksi.</p>
        </article>
      </div>
    </section>
    <section class="section">
      <h2>Checklist Lanjutan</h2>
      <ul>
        <li>Tentukan target user.</li>
        <li>Tulis 3 fitur utama.</li>
        <li>Buat halaman: Home, Detail, Kontak.</li>
        <li>Tambahkan form atau tombol aksi utama.</li>
      </ul>
    </section>
  </main>
  <footer>Dibuat oleh Watson untuk ${escapeHtml(pushname)}.</footer>
</body>
</html>`

    return {
        fileName,
        mimetype: "text/html",
        buffer: Buffer.from(html, "utf8"),
        caption: "Aku buatin file HTML mockup-nya. Buka file ini di browser untuk lihat ilustrasi awal websitenya.",
    }
}

function buildArtifact(request, pushname) {
    if (request.type === "website") return buildWebsiteArtifact(request.prompt, pushname)
    return buildScenarioArtifact(request.prompt, pushname)
}

async function handleAgentArtifactRequest(watson, msg, request, pushname) {
    await sendReply(watson, msg, `Oke ${pushname}, aku susun file ${request.type || "dokumen"} dulu...`)

    const artifact = await buildAgentArtifact(
        request,
        pushname,
        (prompt) => askChatGPT(prompt, pushname, getSession(msg.key.remoteJid)),
    )

    const sent = await sendDocumentReply(
        watson,
        msg,
        artifact.buffer,
        artifact.fileName,
        artifact.mimetype,
        artifact.caption,
    )

    if (!sent) {
        await sendReply(watson, msg, "bot sedang error")
    }
}

async function handleArtifactRequest(watson, msg, request, pushname) {
    await sendReply(watson, msg, `Oke ${pushname}, aku buat file ilustrasinya dulu...`)

    const artifact = buildArtifact(request, pushname)
    const sent = await sendDocumentReply(
        watson,
        msg,
        artifact.buffer,
        artifact.fileName,
        artifact.mimetype,
        artifact.caption,
    )

    if (!sent) {
        await sendReply(watson, msg, "bot sedang error")
    }
}

async function handleAiChat(watson, msg, prompt, pushname, jid) {
    const history = getSession(jid)
    const instant = fastLocalReply(prompt, pushname)
    if (instant) {
        pushSession(jid, "user", prompt)
        pushSession(jid, "assistant", instant)
        await sendReply(watson, msg, instant)
        return
    }

    if (aiInFlight.has(jid)) {
        await sendReply(watson, msg, "tunggu sebentar")
        return
    }

    if (shouldThrottleGroupAi(jid)) {
        await sendReply(watson, msg, "tunggu sebentar")
        return
    }

    if (Date.now() < getCooldownUntil(jid)) {
        await sendReply(watson, msg, "tunggu sebentar")
        return
    }

    aiInFlight.add(jid)
    try {
        const answer = await askChatGPT(prompt, pushname, history)
        const trimmed = isAiRateLimitAnswer(answer)
            ? "tunggu sebentar"
            : answer.slice(0, 3900)

        if (isAiRateLimitAnswer(answer) || trimmed === "bot sedang error") {
            setAiCooldown(jid)
        }

        pushSession(jid, "user", prompt)
        pushSession(jid, "assistant", trimmed)
        markGroupAiReply(jid)

        await sendReply(watson, msg, trimmed)
    } finally {
        aiInFlight.delete(jid)
    }
}

function isPrivateChat(jid) {
    if (!jid || typeof jid !== "string") return false
    if (jid.endsWith("@g.us") || jid.endsWith("@broadcast")) return false
    return true
}

function isNaturalChatEnabled() {
    return process.env.NATURAL_CHAT !== "false"
}

function isGroupNaturalChatEnabled() {
    return process.env.NATURAL_CHAT_GROUPS !== "false"
}

function shouldReplyNaturally(body, jid) {
    const trimmed = String(body || "").trim()
    if (!isNaturalChatEnabled()) return false

    if (isPrivateChat(jid)) return false

    if (jid.endsWith("@g.us")) {
        return isGroupNaturalChatEnabled()
    }

    return true
}

async function handleNaturalShortcuts(watson, msg, body, pushname, jid, prefix) {
    const lower = body.toLowerCase().trim()

    const helpTopic = detectHelpTopic(body)
    const helpText = helpTopic ? helpTopicText(helpTopic, prefix) : null
    if (helpText) {
        await sendReply(watson, msg, helpText)
        return true
    }

    if (lower === "menu" || lower === "help" || lower === "bantuan") {
        await sendReply(watson, msg, menuText(pushname, prefix))
        return true
    }

    if (lower === "reset" || lower === "clear" || lower === "hapus riwayat") {
        clearSession(jid)
        await sendReply(watson, msg, "Oke, riwayat obrolan kita sudah dihapus. Mau ngobrol apa lagi?")
        return true
    }

    return false
}

async function handleImageGeneration(watson, msg, prompt, pushname) {
    await sendReply(watson, msg, `Oke ${pushname}, gambar sedang dibikin mohon tunggu`)

    const result = await generateImage(prompt)

    if (!result.ok) {
        await sendReply(watson, msg, result.error)
        return
    }

    const caption = [
        "Gambar berhasil dibuat!",
        
        
        `${result.revisedPrompt}`,
    ].filter(Boolean).join("\n")

    const sent = await sendImageReply(watson, msg, result.buffer, caption.slice(0, 900))
    if (!sent) {
        await sendReply(watson, msg, "bot sedang error")
    }
}

async function downloadImageFromMessage(downloadMediaMessage, media) {
    if (!downloadMediaMessage) {
        throw new Error("Downloader media belum tersedia. Pastikan index.js mengirim downloadMediaMessage.")
    }

    const buffer = await downloadMediaMessage(media.sourceMessage, "buffer", {})
    if (!Buffer.isBuffer(buffer) || buffer.length < 1000) {
        throw new Error("Gambar kosong atau gagal diunduh.")
    }
    return buffer
}

async function handleImageAnalysis(watson, msg, prompt, pushname, downloadMediaMessage) {
    const media = getMediaSource(msg)
    if (!media) {
        await sendReply(watson, msg, "bot sedang error")
        return
    }

    try {
        const mimeType = getMessageMimeType(media.sourceMessage)
        if (!mimeType.startsWith("image/")) {
            await sendReply(watson, msg, "bot sedang error")
            return
        }

        const buffer = await downloadImageFromMessage(downloadMediaMessage, media)
        const answer = await analyzeImage(prompt, buffer, mimeType, pushname)
        if (isAiRateLimitAnswer(answer)) {
            setAiCooldown(msg.key.remoteJid)
            await sendReply(watson, msg, "bot sedang error")
            return
        }

        await sendReply(watson, msg, answer.slice(0, 3900))
    } catch (error) {
        await sendReply(watson, msg, `bot sedang error`)
    }
}

async function handleImageEdit(watson, msg, prompt, pushname, downloadMediaMessage) {
    const media = getMediaSource(msg)
    if (!media) {
        await sendReply(watson, msg, "bot sedang error")
        return
    }

    const cleanPrompt = String(prompt || "").trim()
    if (!cleanPrompt) {
        await sendReply(watson, msg, "bot sedang error")
        return
    }

    await sendReply(watson, msg, `Oke ${pushname}, gambar sedang diedit...`)

    try {
        const mimeType = getMessageMimeType(media.sourceMessage)
        if (!mimeType.startsWith("image/")) {
            await sendReply(watson, msg, "bot sedang error")
            return
        }

        const buffer = await downloadImageFromMessage(downloadMediaMessage, media)
        const result = await editImage(cleanPrompt, buffer, mimeType)

        if (!result.ok) {
            await sendReply(watson, msg, result.error)
            return
        }

        const caption = [
            "Gambar berhasil diedit!",
            `${result.revisedPrompt}`,
        ].filter(Boolean).join("\n")

        const sent = await sendImageReply(watson, msg, result.buffer, caption.slice(0, 900))
        if (!sent) {
            await sendReply(watson, msg, "bot sedang error")
        }
    } catch (error) {
        await sendReply(watson, msg, `bot sedang error`)
    }
}

function detectImageEditPrompt(text) {
    const trimmed = String(text || "").trim()
    const match = trimmed.match(/^(?:edit|ubah|ganti|perbaiki|retouch|hapus|hilangkan|tambahkan)\s+(?:gambar|foto|image|ini)?\s*(.+)$/i)
    return match?.[1]?.trim() || null
}

function detectImageAnalysisPrompt(text) {
    const trimmed = String(text || "").trim()
    if (!trimmed) return "Analisis gambar ini."
    if (/^(?:analisis|analyze|lihat|cek|jelaskan|deskripsikan|baca|ocr)(?:\s+(?:gambar|foto|image|ini))?\s*$/i.test(trimmed)) {
        return "Analisis gambar ini. Jelaskan isi gambar, objek penting, dan teks yang terlihat."
    }

    const match = trimmed.match(/^(?:analisis|analyze|lihat|cek|jelaskan|deskripsikan|baca|ocr)\s+(?:gambar|foto|image|ini)?\s*(.*)$/i)
    if (match) return match[1]?.trim() || "Analisis gambar ini."
    return null
}

async function handleNaturalMessage(watson, msg, body, pushname, jid, prefix, downloadMediaMessage) {
    if (await handleNaturalShortcuts(watson, msg, body, pushname, jid, prefix)) {
        return true
    }

    if (getMediaSource(msg)) {
        const editPrompt = detectImageEditPrompt(body)
        if (editPrompt) {
            await withTyping(watson, jid, () => handleImageEdit(watson, msg, editPrompt, pushname, downloadMediaMessage))
            return true
        }

        const analysisPrompt = detectImageAnalysisPrompt(body) || body
        await withTyping(watson, jid, () => handleImageAnalysis(watson, msg, analysisPrompt, pushname, downloadMediaMessage))
        return true
    }

    const messageKind = getMessageKind(msg)
    if (!String(body || "").trim() && messageKind !== "empty") {
        if (["reaction", "message", "interactive"].includes(messageKind)) {
            return false
        }

        if (["sticker", "contact", "location", "poll"].includes(messageKind)) {
            await sendReply(watson, msg, localFallbackReply(describeNonTextInput(messageKind), pushname))
            return true
        }

        if (["audio", "document", "video"].includes(messageKind)) {
            await sendReply(watson, msg, describeNonTextInput(messageKind))
            return true
        }

        return false
    }

    const artifactRequest = detectArtifactRequest(body)
    const agentArtifactRequest = detectAgentArtifactRequest(body)
    if (agentArtifactRequest) {
        await withTyping(watson, jid, () => handleAgentArtifactRequest(watson, msg, agentArtifactRequest, pushname))
        return true
    }

    const explicitImageRequest = /\b(gambar|foto|image|picture|pic|wallpaper|poster|avatar|banner)\b/i.test(String(body || ""))
    if (artifactRequest && !explicitImageRequest) {
        await withTyping(watson, jid, () => handleArtifactRequest(watson, msg, artifactRequest, pushname))
        return true
    }

    const imagePrompt = detectImagePrompt(body)
    if (imagePrompt) {
        await withTyping(watson, jid, () => handleImageGeneration(watson, msg, imagePrompt, pushname))
        return true
    }

    if (artifactRequest) {
        await withTyping(watson, jid, () => handleArtifactRequest(watson, msg, artifactRequest, pushname))
        return true
    }

    if (shouldReplyNaturally(body, jid)) {
        await withTyping(watson, jid, () => handleAiChat(watson, msg, body, pushname, jid))
        return true
    }

    return false
}

module.exports = async (watson, msg, options = {}) => {
    const prefix = options.prefix || "!"
    const downloadMediaMessage = options.downloadMediaMessage
    const body = getMessageText(msg)
    const sender = msg.key.remoteJid
    const pushname = msg.pushName || "teman"
    const messageKind = getMessageKind(msg)

    const hasMedia = Boolean(getMediaSource(msg))
    if (!body && !hasMedia && messageKind === "empty") return

    const isGroup = sender.endsWith("@g.us")
    const rawBody = String(body || "").trim()
    const rawIsCommand = rawBody.toLowerCase().startsWith(prefix)
    const mentioned = isGroup ? isBotMentioned(watson, msg, body) : false

    if (isGroup && !rawIsCommand && !mentioned) return

    const effectiveBody = isGroup && mentioned ? cleanBotMentionText(watson, msg, body) : body
    const lowerBody = effectiveBody.toLowerCase()

    if (!lowerBody.startsWith(prefix)) {
        const handled = await handleNaturalMessage(watson, msg, effectiveBody, pushname, sender, prefix, downloadMediaMessage)
        if (handled) {
            const chatType = isPrivateChat(sender) ? "chat" : "grup"
            const preview = String(effectiveBody || "").trim() || `[${messageKind}]`
            console.log(`[${new Date().toLocaleString("id-ID")}] ${sender} (${chatType}): ${preview.slice(0, 80)}`)
        }
        return
    }

    const args = effectiveBody.slice(prefix.length).trim().split(/\s+/).filter(Boolean)
    const command = (args.shift() || "").toLowerCase()
    const text = args.join(" ")

    console.log(`[${new Date().toLocaleString("id-ID")}] ${sender} menjalankan: ${command}`)

    await withTyping(watson, sender, async () => {
        switch (command) {
            case "":
            case "menu":
            case "help":
                if (text) {
                    await sendReply(watson, msg, `Bantuan untuk ${prefix}${text}: coba ketik ${prefix}menu untuk daftar perintah yang tersedia.`)
                    break
                }
                await sendReply(watson, msg, menuText(pushname, prefix))
                break

            case "halo":
                await sendReply(watson, msg, `Halo juga, ${pushname}. Ada yang bisa Watson bantu?`)
                break

            case "ping":
                await sendReply(watson, msg, `Pong. Bot aktif selama ${formatUptime(Date.now() - startedAt)}.`)
                break

            case "info":
                await sendReply(watson, msg, [
                    botName,
                    `Platform: ${os.platform()} ${os.arch()}`,
                    `Node.js: ${process.version}`,
                    `Uptime: ${formatUptime(Date.now() - startedAt)}`,
                    `Riwayat chat aktif: ${chatSessions.size} user`,
                ].join("\n"))
                break

            case "quotes": {
                const quotes = [
                    "You gayniggajew",
                    "FUCK YEAH I'm gay",
                    "I stand with israel",
                    "long live united states of america, the land of free",
                ]
                const quote = quotes[Math.floor(Math.random() * quotes.length)]
                await sendReply(watson, msg, quote)
                break
            }

            case "ai":
            case "gpt":
            case "chatgpt":
                if (!text && !getMediaSource(msg)) {
                    await sendReply(watson, msg, `Tulis pertanyaannya. Contoh: ${prefix}ai jelaskan apa itu fotosintesis`)
                    break
                }
                if (getMediaSource(msg)) {
                    await handleImageAnalysis(watson, msg, text || "Analisis gambar ini.", pushname, downloadMediaMessage)
                    break
                }
                await handleAiChat(watson, msg, text, pushname, sender)
                break

            case "lihat":
            case "analisis":
            case "analyze":
            case "ocr":
                await handleImageAnalysis(watson, msg, text || "Analisis gambar ini.", pushname, downloadMediaMessage)
                break

            case "edit":
            case "ubah":
            case "retouch":
                await handleImageEdit(watson, msg, text, pushname, downloadMediaMessage)
                break

            case "gambar":
            case "img":
            case "image":
            case "dalle":
            case "generate":
                if (!text) {
                    await sendReply(
                        watson,
                        msg,
                        [
                            `Tulis deskripsi gambarnya.`,
                            `Contoh: ${prefix}gambar kucing lucu bermain bola di taman`,
                            `Atau tanpa prefix: buat gambar kucing lucu`,
                        ].join("\n"),
                    )
                    break
                }
                await handleImageGeneration(watson, msg, text, pushname)
                break

            case "ilustrasi":
            case "ilustrasikan":
            case "visualisasi":
            case "simulasi":
            case "file":
            case "dokumen":
            case "mockup":
            case "wireframe": {
                if (!text) {
                    await sendReply(watson, msg, [
                        "Tulis yang mau dibuat jadi file.",
                        `Contoh: ${prefix}ilustrasi saya sedang berada di 2 dilema antara kerja dan kuliah`,
                        `Contoh: ${prefix}mockup website toko sepatu modern`,
                        `Contoh: ${prefix}simulasi roket sederhana dengan slider`,
                    ].join("\n"))
                    break
                }

                const wantsSimulation = /\b(simulasi|simulation|simulator|simulasikan|simulasikanlah)\b/i.test(command + " " + text)
                const type = wantsSimulation
                    ? "simulation"
                    : /mockup|wireframe|website|web|html|landing/i.test(command + " " + text)
                        ? "website"
                        : "scenario"
                if (type === "simulation") {
                    await handleAgentArtifactRequest(watson, msg, { type, prompt: text }, pushname)
                    break
                }
                await handleArtifactRequest(watson, msg, { type, prompt: text }, pushname)
                break
            }

            case "agent":
            case "buatfile":
            case "pdf":
            case "word":
            case "docx":
            case "railway":
            case "github":
            case "workflow":
            case "json":
            case "csv":
            case "html":
            case "md":
            case "markdown":
            case "env":
            case "kode":
            case "script": {
                const typeByCommand = {
                    agent: null,
                    buatfile: null,
                    pdf: "pdf",
                    word: "docx",
                    docx: "docx",
                    railway: "railway",
                    github: "github",
                    workflow: "github",
                    json: "json",
                    csv: "csv",
                    html: "html",
                    md: "markdown",
                    markdown: "markdown",
                    env: "env",
                    kode: "code",
                    script: "code",
                }

                let request = typeByCommand[command]
                    ? { type: typeByCommand[command], prompt: text || command }
                    : detectAgentArtifactRequest(text || command)

                if (text && /\b(simulasi|simulation|simulator|simulasikan|simulasikanlah)\b/i.test(text)) {
                    request = { type: "simulation", prompt: text }
                }

                if (!request && text) {
                    const parts = text.trim().split(/\s+/)
                    const first = (parts.shift() || "").toLowerCase()
                    const mappedType = {
                        pdf: "pdf",
                        word: "docx",
                        docx: "docx",
                        railway: "railway",
                        github: "github",
                        workflow: "github",
                        json: "json",
                        csv: "csv",
                        html: "html",
                        md: "markdown",
                        markdown: "markdown",
                        env: "env",
                        kode: "code",
                        script: "code",
                        txt: "text",
                    }[first]
                    if (mappedType) request = { type: mappedType, prompt: parts.join(" ") || first }
                }

                if (!request && /\b(simulasi|simulation|simulator|simulasikan|simulasikanlah)\b/i.test(text || command)) {
                    request = { type: "simulation", prompt: text || command }
                }

                if (!request) {
                    await sendReply(watson, msg, [
                        "Tulis jenis file dan topiknya.",
                        `Contoh: ${prefix}pdf proposal usaha kopi`,
                        `Contoh: ${prefix}word laporan kegiatan sekolah`,
                        `Contoh: ${prefix}simulasi roket sederhana`,
                        `Contoh: ${prefix}railway nodejs bot whatsapp`,
                        `Contoh: ${prefix}github nodejs ci`,
                    ].join("\n"))
                    break
                }

                await handleAgentArtifactRequest(watson, msg, request, pushname)
                break
            }

            case "reset":
            case "clear":
                clearSession(sender)
                await sendReply(watson, msg, "Riwayat chat AI kamu sudah dihapus. Mulai obrolan baru ya.")
                break

            case "owner":
                await sendReply(watson, msg, "Owner belum disetel. Edit command owner di file Watson.js untuk menaruh nomor atau kontak kamu.")
                break

            case "gw":
                if (text.toLowerCase() === "keren ga") {
                    await sendReply(watson, msg, "Keren. Tinggal botnya kita poles sampai makin niat.")
                    break
                }
                await sendReply(watson, msg, `Maksudnya ${prefix}gw keren ga?`)
                break

            case "sticker":
            case "stiker": {
                if (!downloadMediaMessage) {
                    await sendReply(watson, msg, "Downloader media belum tersedia. Pastikan index.js mengirim downloadMediaMessage.")
                    break
                }

                const media = getMediaSource(msg)
                if (!media) {
                    await sendReply(watson, msg, `Kirim atau balas gambar/video pendek dengan ${prefix}sticker.`)
                    break
                }

                try {
                    const buffer = await downloadMediaMessage(media.sourceMessage, "buffer", {})
                    const sent = await safeAction("Gagal mengirim stiker", () => watson.sendMessage(
                        sender,
                        { sticker: buffer },
                        sendOptions(watson, msg),
                    ))
                    if (!sent) {
                        await sendReply(watson, msg, "Gagal membuat stiker. Coba kirim media yang lebih kecil.")
                    }
                } catch (error) {
                    await sendReply(watson, msg, `bot sedang error`)
                }
                break
            }

            default:
                await sendReply(watson, msg, `Command ${prefix}${command} belum ada. Ketik ${prefix}menu untuk lihat fitur yang tersedia.`)
                break
        }
    })
}

