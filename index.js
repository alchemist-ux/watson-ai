const pino = require("pino")
const chalk = require("chalk")
const readline = require("readline")
const qrcode = require("qrcode-terminal")
require("./env")
const handleCommand = require("./Watson")

const sessionFolder = "./WatsonSesi"
const prefix = "!"
const reconnectDelayMs = 5000
const groupMetadataCache = new Map()

function isForbiddenError(error) {
    const text = String(error?.message || error || "").toLowerCase()
    return text.includes("forbidden") || text.includes("status code: 403")
}

function envFlag(name, fallback = false) {
    const value = String(process.env[name] || "").trim().toLowerCase()
    if (!value) return fallback
    return ["1", "true", "yes", "y", "on"].includes(value)
}

function normalizePairingPhoneNumber(value) {
    const digits = String(value || "").replace(/\D/g, "")
    if (!digits) return ""
    if (digits.startsWith("0")) return `62${digits.slice(1)}`
    if (digits.startsWith("8")) return `62${digits}`
    return digits
}

function maskPhoneNumber(value) {
    const digits = normalizePairingPhoneNumber(value)
    if (digits.length <= 7) return digits
    return `${digits.slice(0, 4)}***${digits.slice(-3)}`
}

const usePairingCode = envFlag("USE_PAIRING_CODE", false)

process.on("unhandledRejection", (error) => {
    console.error(chalk.red("Unhandled rejection:"), error)
})

process.on("uncaughtException", (error) => {
    console.error(chalk.red("Uncaught exception:"), error)
})

function question(prompt) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    })

    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close()
            resolve(answer)
        })
    })
}

async function connectToWhatsApp() {
    console.log(chalk.blue("Menyiapkan koneksi WhatsApp..."))

    const baileysModule = await import("baileys")
    const baileys = baileysModule
    const {
        Browsers,
        downloadMediaMessage,
        DisconnectReason,
        fetchLatestBaileysVersion,
        makeCacheableSignalKeyStore,
        useMultiFileAuthState,
    } = baileys
    const makeWASocket = baileysModule.default || baileys.makeWASocket

    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder)
    const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 2413, 1],
        isLatest: false,
    }))

    console.log(chalk.gray(`Versi WhatsApp Web: ${version.join(".")} (${isLatest ? "latest" : "fallback"})`))

    const watson = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: !usePairingCode,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        version,
        browser: Browsers.ubuntu("Chrome"),
        markOnlineOnConnect: true,
    })

    const refreshGroupMetadata = async (jid) => {
        if (!jid || !jid.endsWith("@g.us")) return undefined

        const cached = groupMetadataCache.get(jid)
        if (cached && Date.now() - cached.cachedAt < 10 * 60 * 1000) {
            return cached.metadata
        }

        const metadata = await watson.groupMetadata(jid)
        groupMetadataCache.set(jid, { metadata, cachedAt: Date.now() })
        return metadata
    }

    const cachedGroupMetadata = async (jid) => {
        const cached = groupMetadataCache.get(jid)
        if (cached) return cached.metadata

        try {
            return await refreshGroupMetadata(jid)
        } catch (error) {
            if (!isForbiddenError(error)) {
                console.error(chalk.yellow(`Gagal refresh metadata grup ${jid}:`), error.message || error)
            }
            return undefined
        }
    }

    watson.cachedGroupMetadata = cachedGroupMetadata
    watson.refreshGroupMetadata = async (jid) => {
        groupMetadataCache.delete(jid)
        return refreshGroupMetadata(jid)
    }
    watson.resetGroupSenderKey = async (jid) => {
        if (!jid || !jid.endsWith("@g.us")) return
        await state.keys.set({ "sender-key-memory": { [jid]: null } })
    }

    if (usePairingCode && !state.creds.registered) {
        let phoneNumber = normalizePairingPhoneNumber(process.env.PAIRING_PHONE_NUMBER)

        if (!phoneNumber) {
            if (!process.stdin.isTTY) {
                throw new Error("PAIRING_PHONE_NUMBER belum diisi. Isi variable Railway, contoh: 6281234567890.")
            }

            phoneNumber = normalizePairingPhoneNumber(await question(chalk.green("Masukkan nomor WhatsApp diawali 62: ")))
        }

        console.log(chalk.gray(`Meminta pairing code untuk ${maskPhoneNumber(phoneNumber)}...`))
        const code = await watson.requestPairingCode(phoneNumber)
        console.log(chalk.cyan(`Pairing code: ${code}`))
    }

    watson.ev.on("creds.update", saveCreds)

    watson.ev.on("groups.update", (updates) => {
        for (const update of updates || []) {
            if (!update?.id) continue
            const existing = groupMetadataCache.get(update.id)?.metadata || { id: update.id, participants: [] }
            groupMetadataCache.set(update.id, {
                metadata: { ...existing, ...update },
                cachedAt: Date.now(),
            })
        }
    })

    watson.ev.on("group-participants.update", async ({ id }) => {
        try {
            await refreshGroupMetadata(id)
        } catch (error) {
            if (!isForbiddenError(error)) {
                console.log(chalk.yellow(`Gagal update participant grup ${id}: ${error.message || error}`))
            }
        }
    })

    watson.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
        if (qr && !usePairingCode) {
            console.log(chalk.yellow("Scan QR ini lewat WhatsApp > Perangkat tertaut."))
            qrcode.generate(qr, { small: true })
        }

        if (connection === "open") {
            console.log(chalk.green("Bot berhasil terhubung ke WhatsApp."))
            watson.groupFetchAllParticipating()
                .then((groups) => {
                    for (const [jid, metadata] of Object.entries(groups || {})) {
                        groupMetadataCache.set(jid, { metadata, cachedAt: Date.now() })
                    }
                    console.log(chalk.gray(`Cache metadata grup: ${groupMetadataCache.size} grup`))
                })
                .catch((error) => {
                    console.log(chalk.yellow(`Gagal cache metadata grup: ${error.message || error}`))
                })
            return
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = ![
                DisconnectReason.loggedOut,
                401,
                403,
                405,
            ].includes(statusCode)

            console.log(chalk.red(`Koneksi terputus (${statusCode || "unknown"}).`))

            if (shouldReconnect) {
                console.log(chalk.yellow(`Mencoba menyambung ulang dalam ${reconnectDelayMs / 1000} detik...`))
                setTimeout(connectToWhatsApp, reconnectDelayMs)
            } else {
                console.log(chalk.red("WhatsApp menolak sesi/koneksi ini. Tutup bot, hapus folder WatsonSesi, lalu jalankan npm start dan scan QR ulang."))
            }
        }
    })

    watson.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return

        for (const msg of messages) {
            const isGroup = msg.key.remoteJid?.endsWith("@g.us")
            if (!isGroup) continue
            if (!msg.message || (msg.key.fromMe && !isGroup)) continue

            try {
                if (msg.key.remoteJid?.endsWith("@g.us")) {
                    await cachedGroupMetadata(msg.key.remoteJid).catch((error) => {
                        if (!isForbiddenError(error)) {
                            console.log(chalk.yellow(`Gagal ambil metadata grup ${msg.key.remoteJid}: ${error.message || error}`))
                        }
                    })
                }

                await handleCommand(watson, msg, { prefix, downloadMediaMessage })
            } catch (error) {
                console.error(chalk.red("Gagal memproses pesan:"), error)
                try {
                    await watson.sendMessage(msg.key.remoteJid, {
                        text: "Maaf, ada error saat memproses pesan. Coba lagi sebentar ya.",
                    }, msg.key.remoteJid?.endsWith("@g.us") ? { cachedGroupMetadata } : {})
                } catch (sendError) {
                    console.error(chalk.red("Gagal mengirim pesan error:"), sendError.message || sendError)
                }
            }
        }
    })
}

connectToWhatsApp().catch((error) => {
    console.error(chalk.red("Bot gagal dijalankan:"), error)
})
