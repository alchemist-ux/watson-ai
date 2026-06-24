require("./env")
const fs = require("fs")
const path = require("path")
const vm = require("vm")
const { getEnv } = require("./env")
let settled = false

function writeResult(result) {
    if (settled) return
    settled = true
    process.stdout.write(JSON.stringify(result))
}

function normalizeError(error) {
    if (!error) return "error tidak diketahui"
    if (typeof error === "string") return error
    if (error.message) return error.message
    try {
        return JSON.stringify(error)
    } catch {
        return String(error)
    }
}

process.on("uncaughtException", (error) => {
    writeResult({ ok: false, error: normalizeError(error), code: error?.code || "uncaught_exception" })
    setTimeout(() => process.exit(0), 25)
})

process.on("unhandledRejection", (error) => {
    writeResult({ ok: false, error: normalizeError(error), code: error?.code || "unhandled_rejection" })
    setTimeout(() => process.exit(0), 25)
})

function loadPuter() {
    const authToken = getEnv("PUTER_AUTH_TOKEN")
    if (!authToken) {
        throw new Error("ERROR 404")
    }

    const puterPath = path.join(__dirname, "node_modules", "@heyputer", "puter.js", "dist", "puter.cjs")
    const code = fs.readFileSync(puterPath, "utf8")
    const context = {}

    for (const name of Object.getOwnPropertyNames(globalThis)) {
        try {
            context[name] = globalThis[name]
        } catch {
            // ignore
        }
    }

    context.globalThis = context
    vm.runInNewContext(code, vm.createContext(context))
    context.puter.setAuthToken(authToken)
    return context.puter
}

function dataUrlToBase64(dataUrl) {
    const match = String(dataUrl || "").match(/^data:image\/[^;]+;base64,(.+)$/)
    return match?.[1] || null
}

async function downloadImageUrl(url) {
    const response = await fetch(url, { redirect: "follow" })
    if (!response.ok) throw new Error(`Gagal mengunduh gambar (${response.status})`)
    return Buffer.from(await response.arrayBuffer()).toString("base64")
}

async function main() {
    const input = JSON.parse(process.argv[2] || "{}")
    const puter = loadPuter()
    const prompt = String(input.prompt || "").slice(0, 4000)
    const options = {
        driver: input.provider,
        model: input.model,
        quality: input.quality,
        prompt,
    }

    Object.keys(options).forEach((key) => {
        if (options[key] === undefined || options[key] === null || options[key] === "") delete options[key]
    })

    const result = await puter.ai.txt2img(options, Boolean(input.testMode))

    const value = typeof result === "string" ? result : result?.src || result?.url || result?.data
    let base64 = null

    if (typeof value === "string" && value.startsWith("data:image/")) {
        base64 = dataUrlToBase64(value)
    } else if (typeof value === "string" && value.startsWith("http")) {
        base64 = await downloadImageUrl(value)
    }

    if (!base64) throw new Error("server tidak mengirim data gambar yang bisa dibaca.")

    writeResult({ ok: true, base64 })
}

main()
    .catch((error) => {
        writeResult({ ok: false, error: normalizeError(error), code: error?.code || "worker_error" })
    })
    .finally(() => {
        setTimeout(() => process.exit(0), 25)
    })
